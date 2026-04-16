import { select, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import { resolve, basename, join, sep } from 'node:path';
import { exec } from 'node:child_process';
import ora from 'ora';
import { ensureConfig } from './config.js';
import { runOrchestrator } from './core/orchestrator.js';
import { loadReport } from './core/cache.js';
import { generateHtml } from './core/htmlExporter.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const ROLES = [
  'Senior Developer',
  // 'EM',
  // 'Architect',
  // 'QA',
] as const;
const ACTIONS = [
  'Eyeball it',
  // 'Deep dive',
  // 'Complexity report',
] as const;

type GuardResult =
  | { status: 'ok'; selfRun: boolean }
  | { status: 'dangerous-path'; cwd: string }
  | { status: 'no-package-json' };

function checkProjectDirectory(): GuardResult {
  const cwd = process.cwd();
  const home = os.homedir();
  const dangerousPaths = [
    home,
    '/',
    '/usr',
    '/etc',
    '/var',
    '/tmp',
  ];
  if (cwd === home || dangerousPaths.slice(1).some(p => cwd === p || cwd.startsWith(p + sep))) {
    return { status: 'dangerous-path', cwd };
  }

  const pkgJsonPath = join(cwd, 'package.json');
  if (!existsSync(pkgJsonPath) && !existsSync(join(cwd, '..', 'package.json'))) {
    return { status: 'no-package-json' };
  }

  let selfRun = false;
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { name?: string };
      selfRun = pkg.name === 'zenoai';
    } catch { /* ignore malformed package.json */ }
  }

  return { status: 'ok', selfRun };
}

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

  const QUOTES = [
    'You cannot refactor what you do not understand.',
    'The codebase does not lie. It only reflects the decisions that built it.',
    'Every file you are afraid to touch is a problem you have not solved yet.',
    'Speed without structure is just debt with good marketing.',
    'Complexity is not a sign of intelligence. It is a sign of unfinished thinking.',
    'One function. One purpose. Everything else is negotiation.',
    'The first step to fixing a mess is admitting it exists.',
    'Code that works is not the same as code that lasts.',
    'A function that does everything does nothing well.',
    'The test you skip today is the bug you debug at 2am.',
    'Understanding comes before changing. Always.',
    'The best time to add a test was before you shipped. The second best time is now.',
    'The mess did not appear overnight. Neither will the clarity.',
    'A codebase you cannot explain is a codebase you do not own.',
    'The simplest solution is usually the one you wrote last.',
    'Every shortcut leaves a shadow. Zeno finds them.',
    'Good code is not written. It is rewritten.',
    'What you ship is a promise. Make sure you can keep it.',
  ];
  const quote = QUOTES[Math.floor(Math.random() * QUOTES.length)];

  const banner = `░█████████
      ░██
     ░██    ░███████  ░████████   ░███████
   ░███    ░██    ░██ ░██    ░██ ░██    ░██
  ░██      ░█████████ ░██    ░██ ░██    ░██
 ░██       ░██        ░██    ░██ ░██    ░██
░█████████  ░███████  ░██    ░██  ░███████  `;

  console.log('\n\n' + chalk.hex('#F8F8F2')(banner));
  console.log('');
  console.log('');
  // console.log(chalk.hex('#F8F8F2')('Drop a senior engineer into any codebase.'));
  console.log(chalk.hex('#F8F8F2')(`💎 Zeno v${version}`));
  console.log(chalk.hex('#6272A4')(quote));
  console.log('');

  const guardSpinner = ora({ text: 'Checking project directory...', color: 'cyan' }).start();

  const [guardResult] = await Promise.all([
    Promise.resolve(checkProjectDirectory()),
    new Promise<void>(resolve => setTimeout(resolve, 3000)),
  ]);

  if (guardResult.status === 'dangerous-path') {
    guardSpinner.fail('Not a project directory.');
    console.log(chalk.red('\n⚠  Zeno must be run from inside a project directory.'));
    console.log(chalk.red('   Current directory: ' + guardResult.cwd));
    console.log(chalk.red('   Navigate to your project root and try again.\n'));
    process.exit(1);
  }

  if (guardResult.status === 'no-package-json') {
    guardSpinner.fail('No package.json found.');
    console.log(chalk.yellow('\n⚠  No package.json found in this directory.'));
    console.log(chalk.yellow('   Zeno works best when run from your project root.'));
    const proceed = await confirm({ message: 'Continue anyway?', default: false });
    if (!proceed) process.exit(1);
    console.log('');
  }

  guardSpinner.stop();

  if (guardResult.status === 'ok' && guardResult.selfRun) {
    console.log(chalk.yellow('⚠  Looks like you\'re running Zeno on itself. That\'s very meta. Results may be biased.\n'));
  }

  const config = await ensureConfig();

  const projectName = basename(process.cwd());
  const role = await select({
    message: `Who do you want to review ${projectName}?`,
    choices: ROLES.map((r) => ({ value: r })),
    default: 'Senior Developer',
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
