import { Command } from 'commander';

const program = new Command();

program
  .name('good-tool')
  .description('Example CLI fixture')
  .action(() => {
    console.log('ok');
  });

try {
  program.parse();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
