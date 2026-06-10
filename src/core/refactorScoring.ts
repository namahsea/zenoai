import { access } from 'node:fs/promises';

export interface RefactorScore {
  confidenceScore: number;
  linesChanged: number;
  skipReason?: string;
}

const CONFIDENCE_THRESHOLD = 0.55;

function countChangedLines(before: string, after: string): number {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const max = Math.max(beforeLines.length, afterLines.length);
  let changed = 0;

  for (let i = 0; i < max; i++) {
    if (beforeLines[i] !== afterLines[i]) changed += 1;
  }

  return changed;
}

export async function scoreRefactor(
  filePath: string,
  originalSource: string,
  refactoredSource: string,
): Promise<RefactorScore> {
  let score = 0;
  const penalties: string[] = [];

  const originalLines = originalSource.split('\n').length;
  const linesChanged = countChangedLines(originalSource, refactoredSource);
  const changeRatio = linesChanged / originalLines;

  // change size (0.50)
  if (changeRatio < 0.10) score += 0.50;
  else if (changeRatio < 0.25) score += 0.35;
  else penalties.push(`large diff (${(changeRatio * 100).toFixed(0)}% changed lines)`);

  // no new imports (0.25)
  const originalImports = (originalSource.match(/^import /gm) ?? []).length;
  const refactoredImports = (refactoredSource.match(/^import /gm) ?? []).length;
  if (refactoredImports <= originalImports) score += 0.25;
  else penalties.push('introduced new imports');

  // had existing tests (0.25)
  const testFilePath = filePath.replace(/\.(ts|tsx|js|jsx)$/, '.test.$1');
  const hasExistingTests = await access(testFilePath).then(() => true).catch(() => false);
  if (hasExistingTests) score += 0.25;
  else penalties.push('no existing tests');

  const confidenceScore = parseFloat(score.toFixed(2));
  return {
    confidenceScore,
    linesChanged,
    skipReason: confidenceScore < CONFIDENCE_THRESHOLD
      ? `confidence ${confidenceScore.toFixed(2)} — ${penalties.join(', ')}`
      : undefined,
  };
}
