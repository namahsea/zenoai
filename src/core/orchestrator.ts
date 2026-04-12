import Anthropic from '@anthropic-ai/sdk';
import chalk from 'chalk';
import { analyse } from './analyst.js';

export interface RunOptions {
  role: string;
  action: string;
}

interface RiskyFile {
  filename: string;
  oneLineReason: string;
}

interface HealthReport {
  healthScore: number;
  topRiskyFiles: RiskyFile[];
  observations: string[];
}

const SYSTEM_PROMPT =
  'You are a senior software engineer reviewing a messy codebase. You will receive a structural summary of the project files. Return a JSON object with: healthScore (1–10), topRiskyFiles (array of max 5 objects with filename and oneLineReason), and observations (array of 3 plain-English strings about the codebase). Be direct and honest.';

export async function runOrchestrator(opts: RunOptions): Promise<void> {
  console.log(chalk.dim(`role: ${opts.role}  |  action: ${opts.action}\n`));

  if (opts.role === 'SDE' && opts.action === 'Eyeball it') {
    const root = process.cwd();

    process.stdout.write(chalk.yellow('Analysing project… '));
    const allFiles = await analyse(root);
    const files = allFiles.slice(0, 30);
    console.log(chalk.dim(`(${files.length} files)\n`));

    process.stdout.write(chalk.yellow('Sending to Claude… '));
    const client = new Anthropic();

    let raw: string;
    try {
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Project file summary (${files.length} files):\n\n${JSON.stringify(files, null, 2)}`,
          },
        ],
      });

      const block = response.content[0];
      if (block.type !== 'text') throw new Error('Unexpected response type from Claude');
      raw = block.text;
    } catch (err) {
      console.log(chalk.red('failed'));
      throw err;
    }

    console.log(chalk.dim('done\n'));

    // Strip markdown code fences if present
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

    let report: HealthReport;
    try {
      report = JSON.parse(cleaned) as HealthReport;
    } catch {
      console.error(chalk.red('Failed to parse Claude response as JSON:'));
      console.error(raw);
      process.exit(1);
    }

    printReport(report, root, files.length);
    process.exit(0);
  }

  console.log(chalk.yellow('running…'));
  // TODO: other role/action combinations
  process.exit(0);
}

function printReport(report: HealthReport, root: string, fileCount: number): void {
  const score = report.healthScore;
  const scoreColor =
    score >= 8 ? chalk.green : score >= 5 ? chalk.yellow : chalk.red;

  console.log(chalk.bold('━━━  ZENOAI — CODEBASE HEALTH REPORT  ━━━'));
  console.log(chalk.dim(`Directory: ${root}`));
  console.log(chalk.dim(`Files analysed: ${fileCount}\n`));

  console.log(chalk.bold('Health Score'));
  console.log(`  ${scoreColor(String(score))} / 10\n`);

  if (report.observations.length > 0) {
    console.log(chalk.bold('Observations'));
    for (const obs of report.observations) {
      console.log(`  • ${obs}`);
    }
    console.log('');
  }

  if (report.topRiskyFiles.length > 0) {
    console.log(chalk.bold('Risky Files'));
    for (const f of report.topRiskyFiles) {
      console.log(`  ${chalk.red(f.filename)}`);
      console.log(`    ${chalk.dim(f.oneLineReason)}`);
    }
    console.log('');
  }

  console.log(chalk.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
}
