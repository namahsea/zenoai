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

  const lineCount = rawSource.split('\n').length;
  if (lineCount > 300) {
    return {
      filePath,
      status: 'skipped' as const,
      confidenceScore: 0,
      skipReason: `file too large for autonomous refactoring (${lineCount} lines) — split into smaller modules first`,
      linesChanged: 0,
    };
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // TODO: wire test generation and execution in next iteration
  const testable = false;

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
    max_tokens: 8000,
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

  // Truncation guard — if brace count is significantly unbalanced the refactor was cut off
  const openBraces = (refactoredSource.match(/{/g) ?? []).length;
  const closeBraces = (refactoredSource.match(/}/g) ?? []).length;
  if (Math.abs(openBraces - closeBraces) > 5) {
    return {
      filePath,
      status: 'skipped' as const,
      confidenceScore: 0,
      skipReason: 'refactored source appears truncated — brace mismatch detected',
      linesChanged: 0,
    };
  }

  // Step 4 — score confidence locally. No Claude call.
  let score = 0;
  const penalties: string[] = [];

  const originalLines = rawSource.split('\n').length;
  const refactoredLines = refactoredSource.split('\n').length;
  const linesChanged = Math.abs(refactoredLines - originalLines);
  const changeRatio = linesChanged / originalLines;

  // change size (0.50)
  if (changeRatio < 0.10) score += 0.50;
  else if (changeRatio < 0.25) score += 0.35;
  else penalties.push(`large diff (${(changeRatio * 100).toFixed(0)}% change)`);

  // no new imports (0.25)
  const originalImports = (rawSource.match(/^import /gm) ?? []).length;
  const refactoredImports = (refactoredSource.match(/^import /gm) ?? []).length;
  if (refactoredImports <= originalImports) score += 0.25;
  else penalties.push('introduced new imports');

  // had existing tests (0.25)
  const testFilePath = filePath.replace(/\.(ts|tsx)$/, '.test.$1');
  const hasExistingTests = await fs.access(testFilePath).then(() => true).catch(() => false);
  if (hasExistingTests) score += 0.25;
  else penalties.push('no existing tests');

  // Threshold temporarily 0.55 — restore to 0.70 when test runner is wired in next iteration
  const CONFIDENCE_THRESHOLD = 0.55;

  let status: 'accepted' | 'skipped' = 'accepted';
  let skipReason: string | undefined;

  if (score < CONFIDENCE_THRESHOLD) {
    status = 'skipped';
    skipReason = `confidence ${score.toFixed(2)} — ${penalties.join(', ')}`;
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
