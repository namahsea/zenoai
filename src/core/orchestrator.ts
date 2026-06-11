import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import chalk from 'chalk';
import Table from 'cli-table3';
import boxen from 'boxen';
import ora from 'ora';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { analyse } from './analyst.js';
import { saveReport } from './cache.js';
import { runPreflight, rollback } from './preflight.js';
import { runPlanner } from './planner.js';
import { runReviewer } from './reviewer.js';
import { runValidator } from './validator.js';
import type { ValidatorResult } from './validator.js';
import { runCritic } from './critic.js';
import { runLargeFileAdvisor } from './largeFileAdvisor.js';
import { runPrePlannerGate, runRefactorGate } from './refactorGate.js';
import { confirm } from '@inquirer/prompts';
import { runDiffer } from './differ.js';
import type { ZenoConfig } from '../config.js';
import type { HealthReport, RiskLevel, HealthLabel } from '../types.js';
import { classifySelectedFiles } from './refactorViability.js';

export interface RunOptions {
  role: string;
  action: string;
  config: ZenoConfig;
}

const SYSTEM_PROMPT = `You are a senior software engineer performing a rigorous codebase health review. You will receive a structural summary of project files. Return ONLY a valid JSON object — no markdown, no backticks, no preamble — with exactly this structure:

{
  "score": <integer 1–10>,
  "label": <one of: "Critical" | "Concerning" | "Fair" | "Good">,
  "summary": <one sentence describing the overall codebase health>,
  "files": [
    {
      "path": <relative file path>,
      "risk": <one of: "Critical" | "High" | "Medium" | "Low">,
      "legibility": <integer 1–10>,
      "consequence": <one plain-English sentence: what actually breaks or becomes dangerous>
    }
  ],
  "observations": [
    <observation one>,
    <observation two>,
    <observation three>
  ],
  "actions": [
    {
      "instruction": <what to do>,
      "rationale": <why this gives the highest value at lowest risk>
    }
  ],
  "start": <one sentence — the single most important place to begin>
}

Rules:
- score must be an integer between 1 and 10.
- label must match score exactly: 1–3 → Critical, 4–5 → Concerning, 6–7 → Fair, 8–10 → Good.
- files must contain between 3 and 5 entries, ordered by risk descending.
- observations must contain exactly 3 items, referencing actual filenames or patterns from the provided files.
- actions must contain exactly 3 items, ranked highest-value lowest-risk first.
- Return only the JSON object. No markdown fences, no backticks, no explanation.
- Risk levels must reflect real-world consequence, not just file size:
  - Critical: the file poses immediate production risk if changed or broken — auth, payments, data writes, webhooks.
  - High: the file is complex and untested; changes are likely to introduce bugs that reach production.
  - Medium: the file has quality issues but changes carry lower risk.
  - Low: minor issues, safe to modify.
  Do not assign Critical based on line count alone. A 200-line auth file with no tests is more Critical than a 600-line utility with no tests.
- The "start" field must always recommend the highest-consequence action, not the easiest one. Prioritise files that handle payments, auth, data writes, or external APIs. Never recommend starting with logging cleanup or formatting changes when untested critical business logic exists in the codebase.`;

async function callAI(config: ZenoConfig, userMessage: string): Promise<string> {
  const { provider, apiKey } = config;

  if (provider === 'anthropic') {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });
    const block = response.content[0];
    if (block.type !== 'text') throw new Error('Unexpected response type from Anthropic');
    return block.text;
  }

  if (provider === 'gemini') {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-pro',
      systemInstruction: SYSTEM_PROMPT,
    });
    const result = await model.generateContent(userMessage);
    return result.response.text();
  }

  if (provider === 'openai') {
    const client = new OpenAI({ apiKey });
    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 1500,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
    });
    const text = response.choices[0]?.message?.content;
    if (!text) throw new Error('Empty response from OpenAI');
    return text;
  }

  if (provider === 'openrouter') {
    const client = new OpenAI({
      apiKey,
      baseURL: 'https://openrouter.ai/api/v1',
    });
    const response = await client.chat.completions.create({
      model: 'deepseek/deepseek-v3.2',
      max_tokens: 1500,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
    });
    const text = response.choices[0]?.message?.content;
    if (!text) throw new Error('Empty response from OpenRouter');
    return text;
  }

  throw new Error(`Unknown provider: ${provider}`);
}


function riskColor(risk: RiskLevel): string {
  switch (risk) {
    case 'Critical': return chalk.red(risk);
    case 'High':     return chalk.hex('#EF9F27')(risk);
    case 'Medium':   return chalk.yellow(risk);
    case 'Low':      return chalk.green(risk);
  }
}

function scoreChalk(label: HealthLabel): (text: string) => string {
  switch (label) {
    case 'Critical':
    case 'Concerning': return chalk.red;
    case 'Fair':       return chalk.yellow;
    case 'Good':       return chalk.green;
  }
}

function actionSlug(action: string): string {
  return action.toLowerCase().replace(/\s+/g, '-');
}

function isReadOnlyReportAction(role: string, action: string): boolean {
  return (
    (role === 'Senior Developer' && action === 'Eyeball it') ||
    (role === 'EM' && (action === 'How bad is it' || action === 'Triage it'))
  );
}

export async function runOrchestrator(opts: RunOptions): Promise<void> {
  const normalizedAction = actionSlug(opts.action);
  console.log(chalk.dim(`role: ${opts.role}  |  action: ${normalizedAction}\n`));

  if (isReadOnlyReportAction(opts.role, opts.action)) {
    const root = process.cwd();

    const MAX_SEND = 50;

    process.stdout.write(chalk.yellow('Analysing project… '));
    const { reports: allFiles, skipped } = await analyse(root);

    // foundTotal counts everything before the send cap is applied
    const foundTotal = allFiles.length + skipped.length;
    const files = allFiles.slice(0, MAX_SEND);

    // Guard 4: only auto-generated files (more specific, checked before Guard 3)
    if (files.length === 0 && skipped.every(s => s.reason === 'auto-generated')) {
      console.log(chalk.red('\n⚠  Only auto-generated files found — no source code to analyse.'));
      console.log(chalk.red('   Make sure you are running Zeno from your project root.\n'));
      process.exit(1);
    }

    // Guard 3: zero files found
    if (files.length === 0) {
      console.log(chalk.red('\n⚠  No JavaScript or TypeScript files found.'));
      console.log(chalk.red('   Make sure you are running Zeno from your project root.\n'));
      process.exit(1);
    }

    // Guard 6: majority of files unreadable
    const unreadableCount = skipped.filter(s => s.reason === 'unreadable').length;
    if (unreadableCount > 0 && unreadableCount / (foundTotal) > 0.5) {
      console.log(chalk.red(`\n⚠  Most files could not be read (${unreadableCount} skipped as unreadable).`));
      console.log(chalk.red('   Check file permissions and try again.\n'));
      process.exit(1);
    }

    // Guard 5: large codebase warning (non-fatal)
    if (foundTotal > 100) {
      console.log(chalk.yellow(`⚠  Large codebase detected (${foundTotal} files found).`));
      console.log(chalk.yellow('   Zeno is sending the 50 highest-risk files for analysis.'));
      console.log(chalk.yellow('   For best results, consider running from a specific subdirectory.\n'));
    }

    // Track files dropped by the send cap so they appear in the transparency log
    if (allFiles.length > MAX_SEND) {
      for (const f of allFiles.slice(MAX_SEND)) {
        skipped.push({ path: f.path, reason: `cap reached (${MAX_SEND} file limit)` });
      }
    }

    let summary = `found (${foundTotal}) → sending (${files.length})`;
    if (allFiles.length > MAX_SEND) summary += ` (capped at ${MAX_SEND})`;
    console.log(chalk.dim(summary));
    for (const s of skipped) {
      console.log(chalk.dim(`  skipped: ${s.path} (${s.reason})`));
    }
    console.log('');

    if (files.length < 3) {
      let hasPkgJson = false;
      try { await access(join(root, 'package.json')); hasPkgJson = true; } catch { /* not found */ }
      if (hasPkgJson) {
        console.log(chalk.hex('#FFA500')(`Warning: only ${files.length} file${files.length === 1 ? '' : 's'} found — this may be incomplete. Make sure you are running zenoai from your project root.\n`));
      }
    }

    const LATE_MESSAGES = [
      'mapping dependencies…',
      'weighing your risks…',
      'cross-referencing patterns…',
      'finishing your report…',
      'almost there…',
    ];

    function buildSpinnerText(elapsed: number, lateMsg: string): string {
      let phase: string;
      if (elapsed < 5)       phase = 'working…';
      else if (elapsed < 10) phase = "this one's taking a moment…";
      else                   phase = lateMsg;
      return chalk.bold.white('Zeno') + chalk.dim(' — ') + chalk.hex('#FFB86C')(phase);
    }

    let elapsed = 0;
    let lateMsg = LATE_MESSAGES[0];
    let lateTimer: ReturnType<typeof setTimeout> | null = null;

    function scheduleNextMessage(): void {
      const delay = 2000 + Math.random() * 6000; // 2s – 8s, different every time
      lateTimer = setTimeout(() => {
        lateMsg = LATE_MESSAGES[Math.floor(Math.random() * LATE_MESSAGES.length)];
        scheduleNextMessage();
      }, delay);
    }

    const spinner = ora({ text: buildSpinnerText(0, lateMsg), color: 'yellow' }).start();

    const tickInterval = setInterval(() => {
      elapsed += 1;
      if (elapsed === 10) scheduleNextMessage();
      spinner.text = buildSpinnerText(elapsed, lateMsg);
    }, 1000);

    function clearSpinnerTimers(): void {
      clearInterval(tickInterval);
      if (lateTimer) clearTimeout(lateTimer);
    }

    const userMessage = `Project file summary (${files.length} files):\n\n${JSON.stringify(files, null, 2)}`;

    let raw: string;
    try {
      raw = await callAI(opts.config, userMessage);
      clearSpinnerTimers();
      spinner.succeed(chalk.bold.white('Zeno') + chalk.dim(` — done (${elapsed}s)`));
    } catch (err) {
      clearSpinnerTimers();
      spinner.fail(chalk.red('failed'));
      console.log('');
      const msg = err instanceof Error ? err.message : String(err);
      const lower = msg.toLowerCase();
      if (lower.includes('credit balance') || lower.includes('400')) {
        console.error(chalk.red('Your API key has no credits. Top up your account at the provider and try again.'));
      } else if (lower.includes('invalid') || lower.includes('401')) {
        console.error(chalk.red('Your API key looks incorrect. Run zenoai reset to enter a new one.'));
      } else if (lower.includes('429')) {
        console.error(chalk.red('You have hit the rate limit. Wait a moment and try again.'));
      } else {
        console.error(chalk.red('Something went wrong. Check your API key and internet connection and try again.'));
      }
      process.exit(1);
    }


    let report: HealthReport;
    try {
      const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
      report = JSON.parse(cleaned) as HealthReport;
    } catch {
      console.warn(chalk.yellow('Warning: could not parse structured report — showing raw output'));
      console.log(raw);
      process.exit(1);
    }

    printReport(report, root, files.length, normalizedAction);
    await saveReport(report, root, files.length);

    process.exit(0);
  }

  console.log(chalk.yellow('running…'));
  // TODO: other role/action combinations
  process.exit(0);
}

function printReport(report: HealthReport, root: string, fileCount: number, action: string): void {
  const now = new Date();
  const date = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  const datetime = `${date}, ${time}`;
  const labelFn = scoreChalk(report.label);

  // ── Header ──────────────────────────────────────────────────────────────────
  console.log(chalk.bold.white('━━━  ZENOAI — CODEBASE HEALTH REPORT  ━━━'));
  console.log(chalk.dim(`Directory : ${root}`));
  console.log(chalk.dim(`Files     : ${fileCount}`));
  console.log(chalk.dim(`Action    : ${action}`));
  console.log(chalk.dim(`Date      : ${datetime}\n`));

  // ── Health Score ─────────────────────────────────────────────────────────────
  console.log(chalk.bold('Health Score'));
  console.log(`  ${chalk.bold(labelFn(`${report.score} / 10`))}  ${labelFn(`[${report.label}]`)}`);
  console.log(`  ${chalk.dim(report.summary)}\n`);

  // ── Risky Files table ────────────────────────────────────────────────────────
  if (report.files && report.files.length > 0) {
    console.log(chalk.bold('Risky Files'));

    const table = new Table({
      head: [
        chalk.bold.white('File'),
        chalk.bold.white('Risk'),
        chalk.bold.white('Legibility'),
        chalk.bold.white('Consequence'),
      ],
      colWidths: [36, 12, 12, 48],
      wordWrap: true,
      style: { head: [], border: ['dim'] },
    });

    for (const f of report.files) {
      table.push([
        chalk.cyan(f.path),
        riskColor(f.risk),
        legibilityColor(f.legibility),
        chalk.dim(f.consequence),
      ]);
    }

    console.log(table.toString());
    console.log('');
  }

  // ── Observations ─────────────────────────────────────────────────────────────
  if (report.observations && report.observations.length > 0) {
    console.log(chalk.bold('Observations'));
    report.observations.forEach((obs, i) => {
      console.log(`  ${chalk.dim(`${i + 1}.`)} ${obs}`);
    });
    console.log('');
  }

  // ── Suggested Actions ─────────────────────────────────────────────────────────
  if (report.actions && report.actions.length > 0) {
    console.log(chalk.bold('Suggested Actions'));
    report.actions.forEach((item, i) => {
      console.log(`  ${chalk.white.bold(`${i + 1}.`)} ${item.instruction}`);
      console.log(`     ${chalk.dim(item.rationale)}`);
    });
    console.log('');
  }

  // ── Start Here ────────────────────────────────────────────────────────────────
  if (report.start) {
    const box = boxen(chalk.bold.white('Where to start\n\n') + report.start, {
      padding: { top: 0, bottom: 0, left: 2, right: 2 },
      borderStyle: 'round',
      borderColor: 'yellow',
      dimBorder: false,
    });
    console.log(box);
    console.log('');
  }

  console.log(chalk.bold.white('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
}

function legibilityColor(score: number): string {
  if (score >= 8) return chalk.green(String(score));
  if (score >= 5) return chalk.yellow(String(score));
  return chalk.red(String(score));
}

function printNoStrongTargetsMessage(
  action: 'humanise' | 'slim' | 'stress-test',
  skippedFiles: Array<{ path: string; reason: string }> = [],
): void {
  console.log(chalk.yellow(`No strong ${action} targets found.`));
  const skippedText = skippedFiles.map(s => `${s.path} ${s.reason}`).join('\n').toLowerCase();

  if (action === 'humanise' || action === 'slim') {
    const recommendations: string[] = [];
    if (skippedText.includes('high-consequence') || skippedText.includes('server integration')) {
      recommendations.push('Try Stress test it for routes, webhooks, auth, payment, or server integration flows.');
    }
    if (skippedText.includes('too large')) {
      recommendations.push('Use Split it later for large components or route modules.');
    }
    if (skippedText.includes('framework shell') || skippedText.includes('configuration file')) {
      recommendations.push('Framework shell and config files usually need tests or feature work, not readability cleanup.');
    }
    if (recommendations.length === 0) {
      recommendations.push('Try a different action or a narrower project directory with more local business logic.');
    }

    console.log(chalk.dim('Most remaining files are already too small, framework shells, config/integration files, high-consequence without tests, or better suited for splitting.'));
    for (const recommendation of recommendations) {
      console.log(chalk.dim(recommendation));
    }
    return;
  }

  console.log(chalk.dim('No useful test targets were found after local safety filters. Try a different project area or reset .zeno-history.json.'));
}

function printViabilitySummary(
  viability: ReturnType<typeof classifySelectedFiles>,
): void {
  if (viability.advisoryOnly.length > 0) {
    console.log(chalk.dim('\nSplit it candidates:'));
    for (const filePath of viability.advisoryOnly) {
      console.log(chalk.dim(`  - ${filePath}`));
    }
  }

  if (viability.riskyUntestedVisual.length > 0) {
    console.log(chalk.dim('\nNeeds tests first:'));
    for (const filePath of viability.riskyUntestedVisual) {
      console.log(chalk.dim(`  - ${filePath}`));
    }
  }

  if (viability.weakCleanupTarget.length > 0) {
    console.log(chalk.dim('\nWeak Humanise targets:'));
    for (const filePath of viability.weakCleanupTarget) {
      console.log(chalk.dim(`  - ${filePath}`));
    }
  }
}

export async function runPhase2(
  projectPath: string,
  action: 'humanise' | 'slim' | 'stress-test',
  persona: string,
): Promise<void> {
  // Step 1 — preflight
  const preflight = await runPreflight();
  if (!preflight.passed) {
    console.error(chalk.red('Cannot start — ' + preflight.errors.join(', ')));
    process.exit(1);
  }

  // Step 2 — analyst
  const spinner = ora('Analysing codebase...').start();
  const { reports, graph } = await analyse(projectPath);
  const reportByPath = new Map(reports.map(report => [report.path, report]));
  spinner.succeed(`Found ${reports.length} files`);

  spinner.start('Filtering safe candidates...');
  const preGate = await runPrePlannerGate(reports, action);
  spinner.succeed(`Eligible ${preGate.eligibleReports.length} files after local gating`);

  if (preGate.skippedFiles.length > 0) {
    console.log(chalk.dim(`ⓘ ${preGate.skippedFiles.length} files excluded before planning.`));
    for (const skipped of preGate.skippedFiles.slice(0, 8)) {
      console.log(chalk.dim(`  skipped before planning: ${skipped.path} (${skipped.reason})`));
    }
    if (preGate.skippedFiles.length > 8) {
      console.log(chalk.dim(`  ...and ${preGate.skippedFiles.length - 8} more`));
    }
    console.log('');
  }

  if (preGate.eligibleReports.length === 0) {
    printNoStrongTargetsMessage(action, preGate.skippedFiles);
    await rollback(preflight.manifestPath);
    process.exit(0);
  }

  // Step 3 — planner
  spinner.start('Planning safe refactor order...');
  const plan = await runPlanner(graph, preGate.eligibleReports, action);
  spinner.succeed(`Selected ${plan.selectedFiles.length} files to refactor`);

  if (plan.selectedFiles.length === 0) {
    printNoStrongTargetsMessage(action, preGate.skippedFiles);
    await rollback(preflight.manifestPath);
    process.exit(0);
  }

  const viability = classifySelectedFiles(plan.selectedFiles, reportByPath);
  if (action === 'humanise' && viability.refactorable.length === 0) {
    console.log(chalk.yellow('No safe Humanise targets found before paid model calls.'));
    printViabilitySummary(viability);
    console.log(chalk.dim('\nRecommended next action: run Split it for large components, or Stress test it for risky untested components.'));
    await rollback(preflight.manifestPath);
    process.exit(0);
  }

  if (action === 'humanise' && viability.refactorable.length === 1 && plan.selectedFiles.length > 3) {
    console.log(chalk.yellow(`Only 1 safe Humanise target found out of ${plan.selectedFiles.length} selected files.`));
    printViabilitySummary(viability);
    const continueWithSingleTarget = await confirm({
      message: `Continue with ${viability.refactorable[0]} only?`,
      default: false,
    });
    if (!continueWithSingleTarget) {
      console.log(chalk.yellow('\nRun cancelled. Cleaning up...'));
      await rollback(preflight.manifestPath);
      console.log(chalk.yellow('Branch removed. Your repo is unchanged.'));
      process.exit(0);
    }
    plan.selectedFiles = viability.refactorable;
  }

  const { loadHistory } = await import('./history.js');
  const runHistory = await loadHistory(process.cwd());
  const skippedCount = runHistory.actions[action]?.skipped?.length ?? 0;

  if (skippedCount > 0) {
    console.log(chalk.dim(`ⓘ ${skippedCount} files previously flagged as too complex — skipped.`));
    console.log(chalk.dim(`  To retry: remove them from .zeno-history.json`));
  }

  // [COST_DISPLAY] — comment out this entire block when subscription model is active
  const estimatedCost = (plan.selectedFiles.length * 0.18).toFixed(2);

  console.log(chalk.cyan('\nFiles selected for refactoring:'));
  plan.selectedFiles.forEach((f, i) => {
    console.log(chalk.white(`  ${i + 1}. ${f}`));
  });

  console.log('');
  console.log(chalk.yellow(`Estimated max API cost: ~$${estimatedCost} (${plan.selectedFiles.length} files × 3 calls)`));
  console.log(chalk.dim('Actual cost may be lower when files are skipped locally.'));

  const proceedWithCost = await confirm({ message: 'Proceed with this run?', default: true });

  if (!proceedWithCost) {
    console.log(chalk.yellow('\nRun cancelled. Cleaning up...'));
    await rollback(preflight.manifestPath);
    console.log(chalk.yellow('Branch removed. Your repo is unchanged.'));
    process.exit(0);
  }
  // [/COST_DISPLAY]

  // Step 4 — reviewer + validator + critic loop
  const results: ValidatorResult[] = [];
  for (const filePath of plan.selectedFiles) {
    const fileReport = reportByPath.get(filePath);
    const gateDecision = await runRefactorGate(filePath, action, fileReport);

    if (gateDecision.kind === 'large-file-advisory') {
      spinner.start(`Preparing split advisory for ${basename(filePath)}...`);
      const advisory = await runLargeFileAdvisor(filePath, action, fileReport);
      spinner.warn(`Skipped ${basename(filePath)}: ${advisory.reason}`);
      results.push({
        filePath,
        status: 'skipped' as const,
        confidenceScore: 0,
        skipReason: advisory.reason,
        largeFileAdvisory: advisory,
      });
      continue;
    }

    if (gateDecision.kind === 'skip') {
      spinner.warn(`Skipped ${basename(filePath)}: ${gateDecision.reason}`);
      results.push({
        filePath,
        status: 'skipped' as const,
        confidenceScore: 0,
        skipReason: gateDecision.reason,
      });
      continue;
    }

    spinner.start(`Reviewing ${basename(filePath)}...`);
    const reviewed = await runReviewer(filePath, action);

    if (reviewed.skip) {
      const skippedResult: ValidatorResult = {
        filePath,
        status: 'skipped' as const,
        confidenceScore: 0,
        skipReason: reviewed.skipReason ?? 'reviewer skipped this file',
      };

      spinner.warn(`Skipped ${basename(filePath)}: ${skippedResult.skipReason}`);
      results.push(skippedResult);
      continue;
    }

    spinner.start(`Validating ${basename(filePath)}...`);
    const validated = await runValidator(filePath, reviewed.changes, action);
    if (validated.status === 'skipped') {
      spinner.warn(`Skipped ${basename(filePath)}: ${validated.skipReason}`);
      results.push(validated);
      continue;
    }

    spinner.start(`Critiquing ${basename(filePath)} boundaries...`);
    const critiqued = await runCritic(validated, reviewed.changes, action);
    if (critiqued.status === 'skipped') {
      spinner.warn(`Skipped ${basename(filePath)}: ${critiqued.skipReason}`);
    } else {
      spinner.succeed(`${basename(filePath)} — score ${critiqued.confidenceScore}`);
    }
    results.push(critiqued);
  }

  // Step 5 — differ
  const manifest = JSON.parse(await readFile(preflight.manifestPath, 'utf8')) as Record<string, unknown>;
  manifest['action'] = action;
  manifest['persona'] = persona;
  await writeFile(preflight.manifestPath, JSON.stringify(manifest, null, 2));

  await runDiffer(results, manifest as unknown as Parameters<typeof runDiffer>[1], preflight.manifestPath);
}
