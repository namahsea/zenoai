import * as fs from 'node:fs/promises';
import { generateCompletion } from '../utils/llm.js';
import type { LargeFileAdvisory } from './largeFileAdvisor.js';
import { MAX_AUTONOMOUS_REFACTOR_LINES } from './refactorLimits.js';
import { scoreRefactor } from './refactorScoring.js';

export interface ValidatorResult {
  filePath: string;
  status: 'accepted' | 'skipped';
  confidenceScore: number;
  refactoredSource?: string;
  createdFiles?: Array<{ path: string; source: string }>;
  testFile?: string;
  skipReason?: string;
  linesChanged?: number;
  largeFileAdvisory?: LargeFileAdvisory;
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
  if (lineCount > MAX_AUTONOMOUS_REFACTOR_LINES) {
    return {
      filePath,
      status: 'skipped' as const,
      confidenceScore: 0,
      skipReason: `file is too large for this action (${lineCount} lines, limit ${MAX_AUTONOMOUS_REFACTOR_LINES})`,
      linesChanged: 0,
    };
  }

  // TODO: wire test generation and execution in next iteration
  const testable = false;

  // Step 3 — apply refactor via LLM
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

  const rawRefactorResponse = await generateCompletion(refactorSystemPrompt, rawSource, 8000);

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
  const scored = await scoreRefactor(filePath, rawSource, refactoredSource);
  const status: 'accepted' | 'skipped' = scored.skipReason ? 'skipped' : 'accepted';

  // Step 6 — return
  return {
    filePath,
    status,
    confidenceScore: scored.confidenceScore,
    refactoredSource: status === 'accepted' ? refactoredSource : undefined,
    testFile: testable ? `${filePath}.zeno-test.ts` : undefined,
    skipReason: scored.skipReason,
    linesChanged: scored.linesChanged,
  };
}
