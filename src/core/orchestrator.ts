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
import { runStaticSplit } from './splitter.js';
import { runSecurityCheck } from './securityCheck.js';
import { runShipReadinessScan } from './shipReadinessScan.js';
import { ZENO_MODELS } from './models.js';
import type { ZenoConfig } from '../config.js';
import type { HealthReport, RiskLevel, HealthLabel } from '../types.js';
import { classifySelectedFiles } from './refactorViability.js';
import { MAX_AUTONOMOUS_REFACTOR_LINES } from './refactorLimits.js';
import { healthTone, riskTone, theme } from './theme.js';

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
- files must contain between 1 and 5 entries, ordered by risk descending. Do not invent files to reach a minimum count.
- observations must contain exactly 3 items, referencing actual filenames or patterns from the provided files.
- actions must contain exactly 3 items, ranked highest-value lowest-risk first.
- Return only the JSON object. No markdown fences, no backticks, no explanation.
- Risk levels must reflect what can break if this code is changed, not how unattractive the file looks:
  - Critical: reserve for auth bypass, payment failure, data loss, security exposure, irreversible writes, production outage, or similarly severe user/business impact.
  - High: important user-facing flows, external APIs, email/webhooks, environment secrets, form submission, or business logic where failure reaches users but is usually reversible.
  - Medium: complex, large, or hard-to-maintain code where failure is localized, recoverable, or easy to detect.
  - Low: isolated, presentational, cosmetic, or straightforward code with low behavioral consequence.
  Do not assign Critical for file size, lack of tests, browser globals, missing exports, or general messiness alone. Those can raise maintainability risk, but Critical requires severe consequence.
- Treat Zeno as a refactor judgment system, not a generic code generator. Recommended actions should identify the smallest safe improvement, not broad rewrites.
- Suggested actions should prefer bounded changes such as adding tests, extracting pure helpers, isolating validation, or naming risky boundaries. Avoid recommending large rewrites unless the provided summary makes them clearly safer than incremental work.
- When a file has risky behavior, mention boundaries that should not be touched in the action or rationale, such as auth checks, webhook verification, mutation order, environment variable names, retry behavior, response status behavior, or permission checks.
- It is acceptable to recommend skipping a file when a refactor would be mostly cosmetic or the safe next step is tests/observability instead of code movement.
- The "start" field must always recommend the highest-consequence safe next step, not the easiest one. Prioritise tests or small protective changes around payments, auth, data writes, webhooks, external APIs, environment secrets, and critical user flows. Never recommend logging cleanup or formatting changes when untested business logic exists.`;

const SHIP_READINESS_PROMPT = `You are Zeno, a launch-readiness and code-ownership reviewer for JavaScript and TypeScript projects, especially AI-generated or vibe-coded apps.

You will receive:
1. compact file metadata, and
2. a deterministic ship-readiness scan with repo facts.

Return ONLY a valid JSON object. No markdown, no backticks, no preamble.

Use exactly this structure:

{
  "score": <integer 1-10>,
  "label": <one of: "Critical" | "Concerning" | "Fair" | "Good">,
  "summary": <one sentence>,
  "reviewIntent": "ship_readiness",
  "projectType": <one of: "landing_page" | "saas_app" | "dashboard" | "ecommerce_payment_app" | "auth_app" | "backend_api" | "cli_tooling" | "unknown">,
  "confidence": <one of: "High" | "Medium" | "Low">,
  "founderSummary": <2-3 plain-English sentences for a founder>,
  "hardBlockers": [
    {
      "issue": <specific problem>,
      "evidence": <specific scan evidence or file reference>,
      "risk": <what breaks for real users or production>,
      "suggestedFix": <smallest practical fix>,
      "severity": <one of: "Critical" | "High" | "Medium" | "Low">
    }
  ],
  "softBlockers": [
    {
      "issue": <specific problem>,
      "evidence": <specific scan evidence or file reference>,
      "risk": <launch quality risk>,
      "suggestedFix": <smallest practical fix>,
      "severity": <one of: "Critical" | "High" | "Medium" | "Low">
    }
  ],
  "codeOwnershipRisks": [
    {
      "issue": <specific maintainability risk>,
      "evidence": <specific scan evidence or file reference>,
      "risk": <why future changes become risky>,
      "suggestedFix": <smallest practical fix>,
      "severity": <one of: "Critical" | "High" | "Medium" | "Low">
    }
  ],
  "evidence": [
    <short evidence bullet>
  ],
  "privatePreview": { "answer": <"Yes" | "Maybe" | "No">, "reason": <one sentence> },
  "publicLaunch": { "answer": <"Yes" | "Maybe" | "No">, "reason": <one sentence> },
  "paidTraffic": { "answer": <"Yes" | "Maybe" | "No">, "reason": <one sentence> },
  "files": [
    {
      "path": <relative file path>,
      "risk": <one of: "Critical" | "High" | "Medium" | "Low">,
      "legibility": <integer 1-10>,
      "consequence": <one plain-English sentence>
    }
  ],
  "observations": [<exactly 3 observations>],
  "actions": [
    { "instruction": <what to do>, "rationale": <why> }
  ],
  "start": <single safest next step>
}

Rules:
- The review is about launch readiness first, code health second.
- Prioritise real user launch blockers before refactoring advice.
- Do not recommend refactoring first if a main CTA, form, route, build/lint status, or payment/auth/data path is broken or unverified.
- Every hardBlocker, softBlocker, and codeOwnershipRisk must cite evidence from the deterministic scan or file metadata.
- If something is inferred, say "appears" or "not detected" instead of claiming certainty.
- For landing_page projects, prioritise CTA behavior, form submission, mobile readiness, metadata/social preview, analytics, performance, copy/brand consistency, and accessibility basics.
- For saas_app, auth_app, ecommerce_payment_app, dashboard, or backend_api projects, prioritise auth, permissions, data writes, payment flow, webhooks, error states, tests, and security.
- Hard blocker means real users cannot complete the main flow, production can break, or launch would be misleading or unsafe.
- Soft blocker means launch quality is weaker but the main flow can still work.
- Code ownership risk means future changes become dangerous or expensive.
- Score/label mapping: 1-3 Critical, 4-5 Concerning, 6-7 Fair, 8-10 Good.
- Keep lists concise: at most 5 hardBlockers, 5 softBlockers, 5 codeOwnershipRisks, and 6 evidence bullets.
- files should contain 1-5 highest-risk files. Do not invent files.
- observations must contain exactly 3 items.
- actions must contain exactly 3 items.
- start must be the safest next step for launch readiness, not broad cleanup.`;

function modelForProvider(provider: ZenoConfig['provider']): string {
  return ZENO_MODELS[provider];
}

async function callAI(config: ZenoConfig, userMessage: string, systemPrompt = SYSTEM_PROMPT, maxTokens = 1500): Promise<string> {
  const { provider, apiKey } = config;

  if (provider === 'anthropic') {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: ZENO_MODELS.anthropic,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });
    const block = response.content[0];
    if (block.type !== 'text') throw new Error('Unexpected response type from Anthropic');
    return block.text;
  }

  if (provider === 'gemini') {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: ZENO_MODELS.gemini,
      systemInstruction: systemPrompt,
    });
    const result = await model.generateContent(userMessage);
    return result.response.text();
  }

  if (provider === 'openai') {
    const client = new OpenAI({ apiKey });
    const response = await client.responses.create({
      model: ZENO_MODELS.openai,
      max_output_tokens: maxTokens,
      input: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    });
    const text = response.output_text;
    if (!text) throw new Error('Empty response from OpenAI');
    return text;
  }

  if (provider === 'openrouter') {
    const client = new OpenAI({
      apiKey,
      baseURL: 'https://openrouter.ai/api/v1',
    });
    const response = await client.chat.completions.create({
      model: ZENO_MODELS.openrouter,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
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
  return riskTone(risk)(risk);
}

function scoreChalk(label: HealthLabel): (text: string) => string {
  return healthTone(label);
}

function actionSlug(action: string): string {
  return action.toLowerCase().replace(/\s+/g, '-');
}

function isReadOnlyReportAction(role: string, action: string): boolean {
  return (
    (role === 'Senior Developer' && action === 'Eyeball it') ||
    (role === 'EM' && (action === 'How bad is it' || action === 'Triage it')) ||
    (role === 'Engineering Manager' && action === 'Tell me if this is safe to ship') ||
    (role === 'Security Reviewer' && action === 'Check for security risks')
  );
}

function isShipReadinessAction(action: string): boolean {
  return action === 'Tell me if this is safe to ship';
}

function shipAnswer(report: HealthReport): { answer: string; risk: string; color: (text: string) => string } {
  if (report.score >= 8) return { answer: 'Safe to ship', risk: 'Low risk', color: theme.success };
  if (report.score >= 6) return { answer: 'Ship with caution', risk: 'Medium risk', color: chalk.hex('#FBBF24') };
  if (report.score >= 4) return { answer: 'Not yet', risk: 'High risk', color: theme.caution };
  return { answer: 'Do not ship', risk: 'Critical risk', color: theme.danger };
}

export async function runOrchestrator(opts: RunOptions): Promise<void> {
  const normalizedAction = actionSlug(opts.action);
  console.log(chalk.dim(`action: ${normalizedAction}\n`));

  if (opts.action === 'Check for security risks') {
    const root = process.cwd();
    const spinner = ora('Finding files to scan...').start();
    const { reports } = await analyse(root);
    spinner.succeed(`Found ${reports.length} files`);
    await runSecurityCheck(reports);
    process.exit(0);
  }

  if (isReadOnlyReportAction(opts.role, opts.action)) {
    const root = process.cwd();

    const MAX_SEND = 50;

    const analyseSpinner = ora('Analysing project...').start();
    const { reports: allFiles, skipped } = await analyse(root);
    analyseSpinner.succeed(`Found ${allFiles.length} files`);

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
        console.log(theme.info(`Note: Zeno found ${files.length} JavaScript/TypeScript source file${files.length === 1 ? '' : 's'} to review.`));
        console.log(theme.muted('  For small apps or landing pages, that may be expected.\n'));
      }
    }

    console.log(theme.heading('AI review'));
    console.log(theme.muted(`  Provider : ${opts.config.provider}`));
    console.log(theme.muted(`  Model    : ${modelForProvider(opts.config.provider)}`));
    console.log(theme.muted('  Calls    : 1 model call\n'));

    const proceedWithReview = await confirm({ message: 'Proceed with this AI review?', default: true });
    if (!proceedWithReview) {
      console.log(chalk.yellow('\nRun cancelled. No model call was made.'));
      process.exit(0);
    }
    console.log('');

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
      return theme.heading('Zeno') + theme.muted(' — ') + theme.caution(phase);
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

    const shipScan = isShipReadinessAction(opts.action)
      ? await runShipReadinessScan(root, allFiles)
      : null;

    const userMessage = isShipReadinessAction(opts.action)
      ? `Review intent: ship_readiness

Project file summary (${files.length} files):
${JSON.stringify(files, null, 2)}

Deterministic ship-readiness scan:
${JSON.stringify(shipScan, null, 2)}`
      : `Project file summary (${files.length} files):\n\n${JSON.stringify(files, null, 2)}`;

    let raw: string;
    try {
      raw = await callAI(
        opts.config,
        userMessage,
        isShipReadinessAction(opts.action) ? SHIP_READINESS_PROMPT : SYSTEM_PROMPT,
        isShipReadinessAction(opts.action) ? 2800 : 1500,
      );
      clearSpinnerTimers();
      spinner.succeed(theme.heading('Zeno') + theme.muted(` — done (${elapsed}s)`));
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

    if (isShipReadinessAction(opts.action)) {
      printShipReadinessReport(report, root, files.length);
    } else {
      printReport(report, root, files.length, normalizedAction);
    }
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
  console.log(theme.title('━━━  ZENOAI — CODEBASE HEALTH REPORT  ━━━'));
  console.log(theme.muted(`Directory : ${root}`));
  console.log(theme.muted(`Files     : ${fileCount}`));
  console.log(theme.muted(`Action    : ${action}`));
  console.log(theme.muted(`Date      : ${datetime}\n`));

  // ── Health Score ─────────────────────────────────────────────────────────────
  console.log(theme.heading('Health Score'));
  console.log(`  ${chalk.bold(labelFn(`${report.score} / 10`))}  ${labelFn(`[${report.label}]`)}`);
  console.log(`  ${theme.muted(report.summary)}\n`);

  // ── Risky Files table ────────────────────────────────────────────────────────
  if (report.files && report.files.length > 0) {
    console.log(theme.heading('Risky Files'));

    const table = new Table({
      head: [
        theme.heading('File'),
        theme.heading('Risk'),
        theme.heading('Legibility'),
        theme.heading('Consequence'),
      ],
      colWidths: [36, 12, 12, 48],
      wordWrap: true,
      style: { head: [], border: ['dim'] },
    });

    for (const f of report.files) {
      table.push([
        theme.file(f.path),
        riskColor(f.risk),
        legibilityColor(f.legibility),
        theme.muted(f.consequence),
      ]);
    }

    console.log(table.toString());
    console.log('');
  }

  // ── Observations ─────────────────────────────────────────────────────────────
  if (report.observations && report.observations.length > 0) {
    console.log(theme.heading('Observations'));
    report.observations.forEach((obs, i) => {
      console.log(`  ${theme.muted(`${i + 1}.`)} ${theme.text(obs)}`);
    });
    console.log('');
  }

  // ── Suggested Actions ─────────────────────────────────────────────────────────
  if (report.actions && report.actions.length > 0) {
    console.log(theme.heading('Suggested Actions'));
    report.actions.forEach((item, i) => {
      console.log(`  ${theme.heading(`${i + 1}.`)} ${theme.text(item.instruction)}`);
      console.log(`     ${theme.muted(item.rationale)}`);
    });
    console.log('');
  }

  // ── Start Here ────────────────────────────────────────────────────────────────
  if (report.start) {
    const box = boxen(theme.heading('Where to start\n\n') + theme.text(report.start), {
      padding: { top: 0, bottom: 0, left: 2, right: 2 },
      borderStyle: 'round',
      borderColor: '#F59E0B',
      dimBorder: false,
    });
    console.log(box);
    console.log('');
  }

  console.log(theme.divider('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
}

function printShipReadinessReport(report: HealthReport, root: string, fileCount: number): void {
  const now = new Date();
  const date = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  const datetime = `${date}, ${time}`;
  const verdict = shipAnswer(report);

  console.log(theme.title('━━━  ZENOAI — SHIP READINESS REPORT  ━━━'));
  console.log(theme.muted(`Project     : ${basename(root)}`));
  console.log(theme.muted('Reviewed by : Engineering Manager'));
  if (report.projectType) console.log(theme.muted(`Project type: ${report.projectType}`));
  console.log(theme.muted(`Files       : ${fileCount}`));
  console.log(theme.muted(`Date        : ${datetime}\n`));

  console.log(theme.heading('Verdict'));
  console.log(`${chalk.bold(verdict.color(verdict.answer))}  ${verdict.color(`[${verdict.risk}]`)}`);
  console.log('');

  if (report.confidence) {
    console.log(theme.heading('Confidence'));
    console.log(`  ${theme.text(report.confidence)}\n`);
  }

  console.log(theme.heading('Founder summary'));
  console.log(`  ${theme.muted(report.founderSummary ?? report.summary)}\n`);

  printShipIssues('Hard blockers', report.hardBlockers);
  printShipIssues('Soft blockers', report.softBlockers);
  printShipIssues('Code ownership risks', report.codeOwnershipRisks);

  if (report.evidence && report.evidence.length > 0) {
    console.log(theme.heading('Evidence'));
    report.evidence.slice(0, 6).forEach((item, index) => {
      console.log(`  ${theme.heading(`${index + 1}.`)} ${theme.muted(item)}`);
    });
    console.log('');
  }

  if (report.privatePreview || report.publicLaunch || report.paidTraffic) {
    console.log(theme.heading('Can ship?'));
    if (report.privatePreview) {
      console.log(`  ${theme.heading('Private preview:')} ${formatShipDecision(report.privatePreview.answer)} ${theme.muted(report.privatePreview.reason)}`);
    }
    if (report.publicLaunch) {
      console.log(`  ${theme.heading('Public launch:')}   ${formatShipDecision(report.publicLaunch.answer)} ${theme.muted(report.publicLaunch.reason)}`);
    }
    if (report.paidTraffic) {
      console.log(`  ${theme.heading('Paid traffic:')}    ${formatShipDecision(report.paidTraffic.answer)} ${theme.muted(report.paidTraffic.reason)}`);
    }
    console.log('');
  } else if (report.files && report.files.length > 0) {
    console.log(theme.heading('What is blocking shipment'));
    report.files.slice(0, 3).forEach((file, index) => {
      console.log(`  ${theme.heading(`${index + 1}.`)} ${theme.file(file.path)} ${riskColor(file.risk)}`);
      console.log(`     ${theme.muted(file.consequence)}`);
    });
    console.log('');
  }

  if (report.start) {
    console.log(theme.heading('Safest next step'));
    console.log(`  ${theme.text(report.start)}\n`);
  }

  console.log(theme.divider('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
}

function formatShipDecision(answer: 'Yes' | 'Maybe' | 'No'): string {
  if (answer === 'Yes') return theme.success('Yes');
  if (answer === 'Maybe') return theme.caution('Maybe');
  return theme.danger('No');
}

function printShipIssues(title: string, issues: HealthReport['hardBlockers']): void {
  if (!issues || issues.length === 0) return;

  console.log(theme.heading(title));
  issues.slice(0, 5).forEach((item, index) => {
    console.log(`  ${theme.heading(`${index + 1}.`)} ${theme.text(item.issue)} ${riskColor(item.severity)}`);
    console.log(`     ${theme.muted('Evidence:')} ${theme.muted(item.evidence)}`);
    console.log(`     ${theme.muted('Risk:')} ${theme.muted(item.risk)}`);
    console.log(`     ${theme.muted('Fix:')} ${theme.muted(item.suggestedFix)}`);
  });
  console.log('');
}

function legibilityColor(score: number): string {
  if (score >= 8) return theme.success(String(score));
  if (score >= 5) return chalk.hex('#FBBF24')(String(score));
  return theme.danger(String(score));
}

function printNoStrongTargetsMessage(
  action: 'humanise' | 'slim' | 'stress-test',
  skippedFiles: Array<{ path: string; reason: string }> = [],
): void {
  const actionLabel = action === 'humanise'
    ? 'Humanise'
    : action === 'slim'
      ? 'Slim it down'
      : 'Stress test';
  console.log(chalk.yellow(`No useful ${actionLabel} targets found.`));
  const skippedText = skippedFiles.map(s => `${s.path} ${s.reason}`).join('\n').toLowerCase();

  if (action === 'humanise' || action === 'slim') {
    const recommendations: string[] = [];
    if (skippedText.includes('high-consequence') || skippedText.includes('server integration')) {
      recommendations.push('Try Stress test it for routes, webhooks, auth, payment, or server integration flows.');
    }
    if (skippedText.includes('too large')) {
      recommendations.push('Use Split it later for large components or route modules.');
    }
    if (skippedText.includes('framework shell') || skippedText.includes('framework integration') || skippedText.includes('configuration file')) {
      recommendations.push('Framework setup and config files usually need tests or feature work, not readability cleanup.');
    }
    if (skippedText.includes('presentational component')) {
      recommendations.push('Static UI components are already simple enough; Zeno will skip them unless there is real logic to clean up.');
    }
    if (recommendations.length === 0) {
      recommendations.push('Try a different action or a narrower project directory with more local business logic.');
    }

    console.log(chalk.dim('Most remaining files are already too small, framework setup files, configuration files, risky untested files, or better suited for splitting.'));
    for (const recommendation of recommendations) {
      console.log(chalk.dim(recommendation));
    }
    return;
  }

  console.log(chalk.dim('No useful test targets were found. Try a different project area with more business logic.'));
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

  if (viability.complexityBlocked.length > 0) {
    console.log(chalk.dim('\nNeeds split or tests first:'));
    for (const filePath of viability.complexityBlocked) {
      console.log(chalk.dim(`  - ${filePath}`));
    }
  }

  if (viability.weakCleanupTarget.length > 0) {
    console.log(chalk.dim('\nLow-impact cleanup targets:'));
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

  spinner.start('Finding files Zeno can safely change...');
  const preGate = await runPrePlannerGate(reports, action);
  if (preGate.eligibleReports.length === 0) {
    spinner.succeed('0 useful cleanup targets found');
  } else {
    spinner.succeed(`${preGate.eligibleReports.length} file${preGate.eligibleReports.length === 1 ? '' : 's'} look changeable`);
  }

  if (preGate.skippedFiles.length > 0) {
    console.log(chalk.dim(`ⓘ ${preGate.skippedFiles.length} files skipped before review.`));
    for (const skipped of preGate.skippedFiles.slice(0, 8)) {
      console.log(chalk.dim(`  skipped: ${skipped.path} (${skipped.reason})`));
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
  spinner.start('Choosing the safest files to change...');
  const plan = await runPlanner(graph, preGate.eligibleReports, action);
  spinner.succeed(`Selected ${plan.selectedFiles.length} files`);

  if (plan.selectedFiles.length === 0) {
    printNoStrongTargetsMessage(action, preGate.skippedFiles);
    await rollback(preflight.manifestPath);
    process.exit(0);
  }

  const viability = classifySelectedFiles(plan.selectedFiles, reportByPath);
  if (action === 'humanise' && viability.refactorable.length === 0) {
    console.log(chalk.yellow('No safe Humanise targets found. No AI review was started.'));
    printViabilitySummary(viability);
    console.log(chalk.dim('\nRecommended next action: run Split it for large components, or Stress test it for risky untested components.'));
    await rollback(preflight.manifestPath);
    process.exit(0);
  }

  if (action === 'humanise' && viability.refactorable.length === 1 && plan.selectedFiles.length > 3) {
    console.log(chalk.yellow(`Only 1 useful Humanise target found out of ${plan.selectedFiles.length} selected files.`));
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
    console.log(chalk.dim(`ⓘ ${skippedCount} files were skipped in previous ${action} runs.`));
    console.log(chalk.dim('  Zeno will avoid retrying the same low-value changes automatically.'));
  }

  // [COST_DISPLAY] — comment out this entire block when subscription model is active
  const estimatedCost = (plan.selectedFiles.length * 0.18).toFixed(2);

  console.log(theme.info('\nFiles selected for refactoring:'));
  plan.selectedFiles.forEach((f, i) => {
    console.log(chalk.white(`  ${i + 1}. ${f}`));
  });

  console.log('');
  console.log(chalk.yellow(`Estimated max API cost: ~$${estimatedCost}`));
  console.log(chalk.dim(`Based on up to ${plan.selectedFiles.length} files. Actual cost may be lower if Zeno skips files during review.`));

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
      spinner.start(`Finding the safest first split for ${basename(filePath)}...`);
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

    spinner.start(`Planning changes for ${basename(filePath)}...`);
    const reviewed = await runReviewer(filePath, action, fileReport);

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

    spinner.start(`Checking ${basename(filePath)}...`);
    const validated = await runValidator(filePath, reviewed.changes, action, fileReport);
    if (validated.status === 'skipped') {
      spinner.warn(`Skipped ${basename(filePath)}: ${validated.skipReason}`);
      results.push(validated);
      continue;
    }

    spinner.start(`Checking final diff for ${basename(filePath)}...`);
    const critiqued = await runCritic(validated, reviewed.changes, action);
    if (critiqued.status === 'skipped') {
      spinner.warn(`Skipped ${basename(filePath)}: ${critiqued.skipReason}`);
    } else {
      spinner.succeed(`${basename(filePath)} — accepted with confidence ${critiqued.confidenceScore.toFixed(2)}`);
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

export async function runSplit(
  projectPath: string,
  persona: string,
): Promise<void> {
  const spinner = ora('Analysing large files...').start();
  const { reports } = await analyse(projectPath);
  const candidates = reports
    .filter(report => report.lines > MAX_AUTONOMOUS_REFACTOR_LINES)
    .sort((a, b) => b.lines - a.lines);

  spinner.succeed(`Found ${candidates.length} large file${candidates.length === 1 ? '' : 's'} for Split it`);

  if (candidates.length === 0) {
    console.log(chalk.yellow('No large files found for Split it.'));
    console.log(chalk.dim(`Split it currently targets files over ${MAX_AUTONOMOUS_REFACTOR_LINES} lines.`));
    process.exit(0);
  }

  const target = candidates[0];
  console.log(theme.info('\nStarting with:'));
  console.log(chalk.white(`  ${target.path} (${target.lines} lines, ${target.functions} functions)`));
  if (candidates.length > 1) {
    console.log(chalk.dim(`  ${candidates.length - 1} more large file${candidates.length === 2 ? '' : 's'} can be handled in later runs.`));
  }

  console.log(chalk.dim('\nZeno will start with the safest split: moving static constants and data into a sibling module.'));
  console.log(chalk.dim('This step does not spend API credits.'));

  const proceed = await confirm({ message: 'Proceed with this split?', default: true });
  if (!proceed) {
    console.log(chalk.yellow('Run cancelled. Your repo is unchanged.'));
    process.exit(0);
  }

  const preflight = await runPreflight();
  if (!preflight.passed) {
    console.error(chalk.red('Cannot start — ' + preflight.errors.join(', ')));
    process.exit(1);
  }

  spinner.start(`Splitting ${basename(target.path)}...`);
  const result = await runStaticSplit(target);
  if (result.status === 'accepted') {
    spinner.succeed(`${basename(target.path)} — extracted static data`);
  } else {
    spinner.warn(`Skipped ${basename(target.path)}: ${result.skipReason}`);
  }

  const manifest = JSON.parse(await readFile(preflight.manifestPath, 'utf8')) as Record<string, unknown>;
  manifest['action'] = 'split';
  manifest['persona'] = persona;
  await writeFile(preflight.manifestPath, JSON.stringify(manifest, null, 2));

  await runDiffer([result], manifest as unknown as Parameters<typeof runDiffer>[1], preflight.manifestPath);
}
