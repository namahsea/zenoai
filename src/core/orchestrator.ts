import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import chalk from 'chalk';
import Table from 'cli-table3';
import boxen from 'boxen';
import ora from 'ora';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { analyse } from './analyst.js';
import { saveReport } from './cache.js';
import type { ZenoConfig } from '../config.js';
import type { HealthReport, RiskLevel, HealthLabel } from '../types.js';

export interface RunOptions {
  role: string;
  action: string;
  config: ZenoConfig;
}

const SYSTEM_PROMPT = `You are a senior software engineer performing a rigorous codebase health review. You will receive a structural summary of project files. Return ONLY a valid JSON object — no markdown fences, no explanation — with exactly these fields:

{
  "healthScore": <integer 1–10>,
  "healthLabel": <one of: "Critical" | "Concerning" | "Fair" | "Good" | "Excellent">,
  "healthContext": <one sentence explaining what the score means specifically for this project>,
  "riskyFiles": [
    {
      "path": <relative file path>,
      "risk": <one of: "Critical" | "High" | "Medium" | "Low">,
      "legibility": <integer 1–10>,
      "consequence": <one plain-English sentence: what actually breaks or becomes dangerous>
    }
  ],
  "observations": [
    <3 specific, impactful strings — not generic, tied directly to patterns found in this codebase>
  ],
  "suggestedActions": [
    {
      "action": <what to do>,
      "reason": <why this gives the highest value at lowest risk>
    }
  ],
  "startHere": <one sentence naming the exact file to tackle first and why>
}

Rules:
- riskyFiles: up to 5 entries, ordered by descending risk severity.
- observations: exactly 3 entries. Must reference actual filenames or patterns from the provided files.
- suggestedActions: exactly 3 entries, ranked highest-value lowest-risk first.
- healthLabel must align with healthScore: 1–2 → Critical, 3–4 → Concerning, 5–6 → Fair, 7–8 → Good, 9–10 → Excellent.
- Be direct, specific, and honest. Avoid generic advice.`;

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
    case 'Good':
    case 'Excellent':  return chalk.green;
  }
}

export async function runOrchestrator(opts: RunOptions): Promise<void> {
  console.log(chalk.dim(`role: ${opts.role}  |  action: ${opts.action}\n`));

  if (opts.role === 'SDE' && opts.action === 'Eyeball it') {
    const root = process.cwd();

    const MAX_SEND = 50;

    process.stdout.write(chalk.yellow('Analysing project… '));
    const { reports: allFiles, skipped } = await analyse(root);

    // foundTotal counts everything before the send cap is applied
    const foundTotal = allFiles.length + skipped.length;
    const files = allFiles.slice(0, MAX_SEND);

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


    // Strip markdown code fences if present
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

    let report: HealthReport;
    try {
      report = JSON.parse(cleaned) as HealthReport;
    } catch {
      console.error(chalk.red('Failed to parse AI response as JSON:'));
      console.error(raw);
      process.exit(1);
    }

    printReport(report, root, files.length);
    await saveReport(report, root, files.length);

    process.exit(0);
  }

  console.log(chalk.yellow('running…'));
  // TODO: other role/action combinations
  process.exit(0);
}

function printReport(report: HealthReport, root: string, fileCount: number): void {
  const now = new Date();
  const date = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  const datetime = `${date}, ${time}`;
  const labelFn = scoreChalk(report.healthLabel);

  // ── Header ──────────────────────────────────────────────────────────────────
  console.log(chalk.bold.white('━━━  ZENOAI — CODEBASE HEALTH REPORT  ━━━'));
  console.log(chalk.dim(`Directory : ${root}`));
  console.log(chalk.dim(`Files     : ${fileCount}`));
  console.log(chalk.dim(`Date      : ${datetime}\n`));

  // ── Health Score ─────────────────────────────────────────────────────────────
  console.log(chalk.bold('Health Score'));
  console.log(`  ${chalk.bold(labelFn(`${report.healthScore} / 10`))}  ${labelFn(`[${report.healthLabel}]`)}`);
  console.log(`  ${chalk.dim(report.healthContext)}\n`);

  // ── Risky Files table ────────────────────────────────────────────────────────
  if (report.riskyFiles && report.riskyFiles.length > 0) {
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

    for (const f of report.riskyFiles) {
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
  if (report.suggestedActions && report.suggestedActions.length > 0) {
    console.log(chalk.bold('Suggested Actions'));
    report.suggestedActions.forEach((item, i) => {
      console.log(`  ${chalk.white.bold(`${i + 1}.`)} ${item.action}`);
      console.log(`     ${chalk.dim(item.reason)}`);
    });
    console.log('');
  }

  // ── Start Here ────────────────────────────────────────────────────────────────
  if (report.startHere) {
    const box = boxen(chalk.bold.white('Where to start\n\n') + report.startHere, {
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
