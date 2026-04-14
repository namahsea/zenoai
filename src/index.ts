import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import figlet from 'figlet';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { exec } from 'node:child_process';
import { ensureConfig } from './config.js';
import { runOrchestrator } from './core/orchestrator.js';
import { loadReport } from './core/cache.js';
import { generateHtml } from './core/htmlExporter.js';

const ROLES = ['SDE', 'EM', 'Architect', 'QA'] as const;
const ACTIONS = ['Eyeball it', 'Deep dive', 'Complexity report'] as const;

async function main() {
  const args = process.argv.slice(2);
  const exportHtml = args.includes('--export');
  const outputIdx = args.indexOf('--output');
  const outputPath = outputIdx !== -1 ? args[outputIdx + 1] : undefined;

  // Export mode — load cached report, write HTML, exit. No prompts, no API call.
  if (exportHtml || outputPath) {
    const cached = await loadReport();
    if (!cached) {
      console.error(chalk.red('No report found. Run `zenoai` first to generate a report.'));
      process.exit(1);
    }
    let dest: string;
    if (outputPath) {
      dest = resolve(process.cwd(), outputPath);
    } else {
      const now = new Date();
      const day   = String(now.getDate()).padStart(2, '0');
      const month = now.toLocaleString('en-GB', { month: 'short' });
      const year  = now.getFullYear();
      const hh    = String(now.getHours()).padStart(2, '0');
      const mm    = String(now.getMinutes()).padStart(2, '0');
      const reportsDir = resolve(process.cwd(), 'reports');
      await mkdir(reportsDir, { recursive: true });
      dest = resolve(reportsDir, `zenoai-report-${day}-${month}-${year}-${hh}${mm}.html`);
    }
    const html = generateHtml(cached.report, cached.root, cached.fileCount);
    await writeFile(dest, html, 'utf8');
    console.log(chalk.green(`Report exported → ${dest}`));
    const opener = process.platform === 'darwin' ? 'open'
                 : process.platform === 'win32'  ? 'start ""'
                 : 'xdg-open';
    exec(`${opener} "${dest}"`);
    process.exit(0);
  }

  const banner = figlet.textSync('ZENO', { font: 'Doom' });

  console.log('\n\n\n' + chalk.hex('#F8F8F2')(banner));
  console.log(chalk.hex('#F8F8F2')('Drop a senior engineer into any codebase.'));
  console.log('');

  const config = await ensureConfig();

  const role = await select({
    message: 'Your role:',
    choices: ROLES.map((r) => ({ value: r })),
    default: 'SDE',
  });

  const action = await select({
    message: 'What do you want?',
    choices: ACTIONS.map((a) => ({ value: a })),
    default: 'Eyeball it',
  });

  console.log('');
  await runOrchestrator({ role, action, config });
}

main().catch((err) => {
  console.error(chalk.red('Error:'), err.message);
  process.exit(1);
});
