import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import { resolve, basename, dirname, join, relative, sep } from 'node:path';
import { exec } from 'node:child_process';
import ora from 'ora';
import { ensureConfig, resetConfig } from './config.js';
import { runOrchestrator, runPhase2, runSplit } from './core/orchestrator.js';
import { loadReport } from './core/cache.js';
import { generateHtml } from './core/htmlExporter.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const ZENO_ACTIONS = [
  {
    value: 'Tell me if this is safe to ship',
    description: 'Read-only report on risk, maintainability, and where to start.',
  },
  {
    value: 'Make this code easier to work with',
    description: 'Cleans safe files, or recommends a split/test first.',
  },
  {
    value: 'Split large files',
    description: 'Makes oversized files smaller without changing behavior.',
  },
  {
    value: 'Check for security risks',
    description: 'Finds obvious security risks before launch.',
  },
] as const;

type GuardResult =
  | { status: 'ok'; selfRun: boolean }
  | { status: 'dangerous-path'; cwd: string }
  | { status: 'no-package-json'; nestedPackageJsons: string[] };

const NESTED_PROJECT_SEARCH_DEPTH = 3;
const IGNORED_NESTED_PROJECT_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
]);

function findNestedPackageJsons(root: string, maxDepth = NESTED_PROJECT_SEARCH_DEPTH): string[] {
  const found: string[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORED_NESTED_PROJECT_DIRS.has(entry.name)) continue;

      const childDir = join(dir, entry.name);
      const packageJsonPath = join(childDir, 'package.json');
      if (existsSync(packageJsonPath)) {
        found.push(relative(root, packageJsonPath));
        continue;
      }

      walk(childDir, depth + 1);
    }
  }

  walk(root, 1);
  return found.slice(0, 5);
}

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
    return { status: 'no-package-json', nestedPackageJsons: findNestedPackageJsons(cwd) };
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
  const resetRequested = args.includes('reset') || args.includes('--reset');
  const exportHtml = args.includes('--export');
  const outputIdx = args.indexOf('--output');
  const outputPath = outputIdx !== -1 ? args[outputIdx + 1] : undefined;

  if (resetRequested) {
    const removed = await resetConfig();
    if (removed) {
      console.log(chalk.green('Saved API key removed. Run `npx zenoai` to enter a new one.'));
    } else {
      console.log(chalk.yellow('No saved API key found. Run `npx zenoai` to set one up.'));
    }
    process.exit(0);
  }

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
    console.log(chalk.red('\n⚠  Zeno must be run from inside a JavaScript or TypeScript project.'));
    console.log(chalk.red('   No package.json found in this directory or its parent.'));

    if (guardResult.nestedPackageJsons.length === 1) {
      const nestedPackageJson = guardResult.nestedPackageJsons[0];
      const nestedProjectDir = dirname(nestedPackageJson);
      console.log(chalk.yellow('\n   Zeno found a project folder inside this directory:'));
      console.log(chalk.yellow(`   ${nestedPackageJson}`));
      console.log(chalk.yellow('\n   You appear to be one folder above the actual project.'));
      console.log(chalk.yellow('   Run Zeno from that project folder instead:'));
      console.log(chalk.cyan(`\n   cd ${nestedProjectDir}`));
      console.log(chalk.cyan('   npx zenoai\n'));
    } else if (guardResult.nestedPackageJsons.length > 1) {
      console.log(chalk.yellow('\n   Zeno found multiple project folders inside this directory:'));
      for (const nestedPackageJson of guardResult.nestedPackageJsons) {
        console.log(chalk.yellow(`   - ${nestedPackageJson}`));
      }
      console.log(chalk.yellow('\n   Choose the project you want to review, then run Zeno from that folder.\n'));
    } else {
      console.log(chalk.red('   Navigate to your project root and try again.\n'));
    }

    process.exit(1);
  }

  guardSpinner.stop();

  if (guardResult.status === 'ok' && guardResult.selfRun) {
    console.log(chalk.yellow('⚠  You are running Zeno on its own codebase. Results may be less useful.\n'));
  }

  const config = await ensureConfig();
  if (config.source === 'saved') {
    console.log(chalk.dim(`Using saved ${config.provider} API key from ~/.zenoai/config.json\n`));
  }

  const projectName = basename(process.cwd());
  const action = await select({
    message: `What do you want Zeno to do for ${projectName}?\n`,
    choices: ZENO_ACTIONS.map((a) => ({
      value: a.value,
      description: a.description,
    })),
  });

  console.log('');

  if (action === 'Tell me if this is safe to ship') {
    await runOrchestrator({ role: 'Engineering Manager', action, config });
  } else if (action === 'Make this code easier to work with') {
    await runPhase2(process.cwd(), 'humanise', 'Senior Engineer');
  } else if (action === 'Split large files') {
    await runSplit(process.cwd(), 'Senior Engineer');
  } else if (action === 'Check for security risks') {
    await runOrchestrator({ role: 'Security Reviewer', action, config });
  }
}

main().catch((err) => {
  console.error(chalk.red('Error:'), err.message);
  process.exit(1);
});
