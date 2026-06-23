import { rmSync, writeFileSync } from 'node:fs';
import { execa } from 'execa';

const apiKey = process.env.BAD_TOOL_API_KEY;

async function main() {
  writeFileSync('output.txt', 'unsafe write');
  rmSync('tmp-output', { recursive: true, force: true });
  await execa('rm', ['-rf', 'cache']);
  console.log(apiKey);
}

main();
