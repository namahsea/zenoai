import Anthropic from '@anthropic-ai/sdk';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const REVIEWER_SYSTEM = `You are a senior TypeScript engineer reviewing a file before a cleanup run. List specific, conservative changes that would make this code read like a careful human wrote it. Rename vague variables, split bloated functions, remove dead code. Be precise — name the exact function or variable and what it should become. Return JSON only: { "changes": string[] }

- Identify functions that mix two or more distinct concerns — database operations, business logic calculations, side effects, or notifications. For each, flag which concern could be extracted as a pure function and name it explicitly.

- Never remove parameters even if unused in the current function body. Unused parameters may exist for interface compatibility, future use, or observability. Flag them with a comment instead of dropping them.

- Look for functions doing more than one sequential job. If a function records something, then evaluates something, then triggers something, suggest breaking it into named steps with a brief comment per step.

- Identify async side effects that do not affect the return value. These should be non-blocking. Flag any awaited call that is purely a side effect and could fail without affecting the main execution path.

- Add comments only at decision points or sequential orchestration steps where the reason for the order is non-obvious from reading the code alone. Never comment operations that are self-explanatory from their name.

- When making async side effects non-blocking by removing await, always attach a .catch() handler. A floating promise without .catch() will crash Node.js with UnhandledPromiseRejection if the call fails. The correct pattern is: sideEffect(args).catch(err => console.error('Description of what failed:', err));

Return ONLY a raw JSON object. No markdown. No backticks. No explanation. Start your response with { and end with }.`;

const VALIDATOR_SYSTEM = `You are a senior TypeScript engineer rewriting a file for clarity. Rules: rename variables to describe intent not mechanics, never add comments to obvious code, do not introduce new abstractions, keep function signatures identical, match the naming voice already in the file, produce the smallest change that meaningfully improves readability. Return only the rewritten file source, no markdown fences, no explanation.

- For variables holding database query results, use short descriptive names like shopRecord, log, or entry — not compound names that describe every field the row contains. The type signature already communicates the shape.`;

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: tsx scripts/poc-humanise.ts <path-to-ts-file>');
    process.exit(1);
  }

  const source = await readFile(resolve(filePath), 'utf8');

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not set');
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });

  // ── Reviewer call ─────────────────────────────────────────────────────────
  const reviewerResponse = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    system: REVIEWER_SYSTEM,
    messages: [{ role: 'user', content: source }],
  });

  const reviewerBlock = reviewerResponse.content[0];
  if (reviewerBlock.type !== 'text') throw new Error('Unexpected response type from reviewer');

  const raw = reviewerBlock.text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('No JSON object found in Reviewer response');
  }
  const jsonStr = raw.substring(start, end + 1);

  let changes: string[];
  try {
    const parsed = JSON.parse(jsonStr);
    ({ changes } = parsed as { changes: string[] });
  } catch (err) {
    console.error('Failed to parse reviewer response:\n', raw);
    throw err;
  }

  // ── Validator/refactor call ───────────────────────────────────────────────
  const validatorResponse = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: VALIDATOR_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Original source:\n\n${source}\n\nChange instructions:\n${changes.map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
      },
    ],
  });

  const validatorBlock = validatorResponse.content[0];
  if (validatorBlock.type !== 'text') throw new Error('Unexpected response type from validator');

  process.stdout.write(validatorBlock.text);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
