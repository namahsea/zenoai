import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'node:fs/promises';

export interface ValidatorResult {
  filePath: string;
  status: 'accepted' | 'skipped';
  confidenceScore: number;
  refactoredSource?: string;
  testFile?: string;
  skipReason?: string;
  linesChanged?: number;
}

export async function runValidator(
  filePath: string,
  changes: string[],
  action: 'humanise' | 'slim' | 'stress-test',
): Promise<ValidatorResult> {
  // Step 1 — read the original file
  let rawSource: string;
  try {
    rawSource = await fs.readFile(filePath, 'utf8');
  } catch {
    return { filePath, status: 'skipped', confidenceScore: 0, skipReason: 'file unreadable' };
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Step 2 — generate tests via Claude
  // Note: generated tests capture behavioral intent but will likely require
  // mock context (Prisma, Stripe, email services) to execute successfully.
  // Test execution and mock wiring deferred to next iteration.
  const testSystemPrompt = `You are generating a behavioral test file for a TypeScript module.
Goal: capture the current behavior so any regression after refactoring is caught.

Rules:
- Use Jest syntax
- Do not test implementation details. Test outputs and side effects only.
- Write only what you can infer from the code. Do not invent behavior.
- If the file has no testable exports, return { "skippable": true }
- Otherwise return { "skippable": false, "testSource": "<full test file source>" }

Strict Output Requirements:
- Return ONLY valid JSON. No markdown, no backticks, no explanations.
- Start with { and end with }.`;

  const testResponse = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    system: testSystemPrompt,
    messages: [{ role: 'user', content: rawSource }],
  });

  const testBlock = testResponse.content[0];
  let testable = false;

  if (testBlock.type === 'text') {
    const raw = testBlock.text;
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end !== -1) {
      try {
        const parsed = JSON.parse(raw.substring(start, end + 1)) as {
          skippable: boolean;
          testSource?: string;
        };
        if (!parsed.skippable && parsed.testSource) {
          await fs.writeFile(`${filePath}.zeno-test.ts`, parsed.testSource, 'utf8');
          testable = true;
        }
      } catch {
        // non-fatal — proceed without test file
      }
    }
  }

  // TODO: wire test runner execution in next iteration

  // Step 3 — apply refactor via Claude
  const refactorSystemPrompt = `You are a senior TypeScript engineer rewriting a file for clarity and maintainability.
You write code the way a careful human would — not the way an AI would clean it up.

Change instructions:
${changes.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Rules:
- Rename variables and functions to describe intent not mechanics
- Never add comments to explain obvious code. Add comments only where the WHY is non-obvious.
- Do not introduce new abstractions. Simplify existing ones.
- Keep the same function signatures unless explicitly told to change them.
- Match the naming voice already present in the file.
- Produce the smallest change that meaningfully improves readability.
- For database query result variables use short names like shopRecord, log, entry. Exception: if a variable captures the return value of a write operation (db.update, db.create, db.upsert), preserve a temporal modifier — e.g., updatedShop, shopAfterIncrement. This tells the next developer the value reflects state after the write, not before it.
- When making async side effects non-blocking, always attach a .catch() handler. Never leave a floating promise without .catch().

Return only the rewritten file source. No markdown fences. No explanation.`;

  const refactorResponse = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    system: refactorSystemPrompt,
    messages: [{ role: 'user', content: rawSource }],
  });

  const refactorBlock = refactorResponse.content[0];
  if (refactorBlock.type !== 'text') {
    return { filePath, status: 'skipped', confidenceScore: 0, skipReason: 'refactor response empty' };
  }

  const rawRefactorResponse = refactorBlock.text;

  let refactoredSource = rawRefactorResponse.trim();
  const fenceStart = refactoredSource.indexOf('```');
  const fenceEnd = refactoredSource.lastIndexOf('```');

  if (fenceStart !== -1 && fenceEnd !== fenceStart) {
    const afterOpenFence = refactoredSource.indexOf('\n', fenceStart) + 1;
    refactoredSource = refactoredSource.substring(afterOpenFence, fenceEnd).trim();
  }

  // Step 4 — score confidence locally. No Claude call.
  // Scoring reflects only what can be measured in this iteration.
  // testsPassed and lintClean deferred to next iteration when test runner is wired.
  // Weights redistributed across measurable factors only.

  const originalLines = rawSource.split('\n').length;
  const refactoredLines = refactoredSource.split('\n').length;
  const linesChanged = Math.abs(refactoredLines - originalLines);
  const changeRatio = linesChanged / originalLines;

  let score = 0;

  // change size (0.50)
  if (changeRatio < 0.10) score += 0.50;
  else if (changeRatio < 0.25) score += 0.35;
  else score += 0.15;

  // no new imports (0.25)
  const originalImports = (rawSource.match(/^import /gm) ?? []).length;
  const refactoredImports = (refactoredSource.match(/^import /gm) ?? []).length;
  if (refactoredImports <= originalImports) score += 0.25;

  // had existing tests (0.25)
  const testFilePath = filePath.replace(/\.(ts|tsx)$/, '.test.$1');
  const hasExistingTests = await fs.access(testFilePath).then(() => true).catch(() => false);
  if (hasExistingTests) score += 0.25;

  // Threshold temporarily 0.55 — reflects scoring without test execution or lint.
  // Restore to 0.70 when test runner is wired in next iteration.
  const CONFIDENCE_THRESHOLD = 0.55;

  // Step 5 — gate check
  let status: 'accepted' | 'skipped';
  let skipReason: string | undefined;

  if (score >= CONFIDENCE_THRESHOLD) {
    status = 'accepted';
  } else {
    status = 'skipped';
    skipReason = `confidence score ${score.toFixed(2)} below threshold`;
  }

  // Step 6 — return
  return {
    filePath,
    status,
    confidenceScore: parseFloat(score.toFixed(2)),
    refactoredSource: status === 'accepted' ? refactoredSource : undefined,
    testFile: testable ? `${filePath}.zeno-test.ts` : undefined,
    skipReason: status === 'skipped' ? skipReason : undefined,
    linesChanged,
  };
}
