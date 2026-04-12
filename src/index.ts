import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import figlet from 'figlet';
import { ensureConfig } from './config.js';
import { runOrchestrator } from './core/orchestrator.js';

const ROLES = ['SDE', 'EM', 'Architect', 'QA'] as const;
const ACTIONS = ['Eyeball it', 'Deep dive', 'Complexity report'] as const;

async function main() {
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
