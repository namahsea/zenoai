import type { FileReport } from './analyst.js';
import { COMPLEXITY_REVIEW_LINE_THRESHOLD } from './refactorLimits.js';

type RefactorAction = 'humanise' | 'slim' | 'stress-test';

export function getSinglePassCleanupBlockReason(
  report: FileReport | undefined,
  action: RefactorAction,
): string | null {
  if (!report) return null;
  if (action === 'stress-test') return null;
  if (report.lines <= COMPLEXITY_REVIEW_LINE_THRESHOLD) return null;

  if (report.functions > 8) {
    return `file has ${report.functions} functions and should be split before cleanup`;
  }

  if (!report.hasTest && (report.hasReactSignals || report.hasBrowserGlobals)) {
    return 'file has untested runtime or component logic — split it or add safety tests first';
  }

  if (report.hasProcessEnv) {
    return 'file reads environment configuration — add tests before cleanup';
  }

  if (report.hasMutableExports) {
    return 'file has mutable exports — split or test it before cleanup';
  }

  return null;
}
