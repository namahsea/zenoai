import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import { runOrchestrator } from './core/orchestrator.js';

const ROLES = ['SDE', 'EM', 'Architect', 'QA'] as const;
const ACTIONS = ['Eyeball it', 'Deep dive', 'Complexity report'] as const;

async function main() {
  console.log(chalk.bold.cyan('\n  zenoai — drop a senior engineer into any codebase\n'));

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
  await runOrchestrator({ role, action });
}

main().catch((err) => {
  console.error(chalk.red('Error:'), err.message);
  process.exit(1);
});
