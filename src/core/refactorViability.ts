import type { FileReport } from './analyst.js';
import { MAX_AUTONOMOUS_REFACTOR_LINES } from './refactorLimits.js';

export interface RefactorViability {
  refactorable: string[];
  advisoryOnly: string[];
  riskyUntestedVisual: string[];
  weakCleanupTarget: string[];
}

function isRiskyUntestedVisual(report: FileReport | undefined): boolean {
  if (!report) return false;
  if (report.hasTest) return false;
  if (!report.path.endsWith('.tsx') && !report.path.endsWith('.jsx')) return false;
  const hasSizeComplexity = report.lines > 150 || report.functions > 3;
  return hasSizeComplexity;
}

function isWeakCleanupTarget(report: FileReport | undefined): boolean {
  if (!report) return false;
  if (!report.path.endsWith('.tsx') && !report.path.endsWith('.jsx')) return false;
  if (report.hasReactSignals || report.hasBrowserGlobals || report.hasProcessEnv || report.hasMutableExports) return false;
  if (report.consoleLogs > 0) return false;
  return report.lines <= 180 && report.functions <= 1;
}

export function classifySelectedFiles(
  selectedFiles: string[],
  reportByPath: Map<string, FileReport>,
): RefactorViability {
  const viability: RefactorViability = {
    refactorable: [],
    advisoryOnly: [],
    riskyUntestedVisual: [],
    weakCleanupTarget: [],
  };

  for (const filePath of selectedFiles) {
    const report = reportByPath.get(filePath);
    if ((report?.lines ?? 0) > MAX_AUTONOMOUS_REFACTOR_LINES) {
      viability.advisoryOnly.push(filePath);
      continue;
    }

    if (isRiskyUntestedVisual(report)) {
      viability.riskyUntestedVisual.push(filePath);
      continue;
    }

    if (isWeakCleanupTarget(report)) {
      viability.weakCleanupTarget.push(filePath);
      continue;
    }

    viability.refactorable.push(filePath);
  }

  return viability;
}
