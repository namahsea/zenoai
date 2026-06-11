import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { FileReport } from './analyst.js';
import { MAX_AUTONOMOUS_REFACTOR_LINES } from './refactorLimits.js';
import { isHighConsequencePath } from './riskSignals.js';

export type RefactorGateDecision =
  | { kind: 'refactor' }
  | { kind: 'large-file-advisory'; reason: string }
  | { kind: 'skip'; reason: string };

export interface PrePlannerGateResult {
  eligibleReports: FileReport[];
  skippedFiles: Array<{ path: string; reason: string }>;
}

const GENERATED_MARKERS = [
  '@generated',
  'auto-generated',
  'generated file',
  'do not edit',
  'codegen',
];

function hasGeneratedMarker(source: string): boolean {
  const header = source.split('\n').slice(0, 20).join('\n').toLowerCase();
  return GENERATED_MARKERS.some(marker => header.includes(marker));
}

function meaningfulLineCount(source: string): number {
  return source
    .split('\n')
    .map(line => line.trim())
    .filter(line =>
      line.length > 0 &&
      !line.startsWith('//') &&
      !line.startsWith('/*') &&
      !line.startsWith('*')
    )
    .length;
}

function isSimpleRouteWrapper(filePath: string, source: string, report: FileReport | undefined): boolean {
  const fileName = basename(filePath);
  if (fileName !== 'page.tsx' && fileName !== 'page.jsx') return false;
  if ((report?.functions ?? 0) > 1) return false;
  return meaningfulLineCount(source) <= 12;
}

function isMinimalLayout(filePath: string, source: string, report: FileReport | undefined): boolean {
  const fileName = basename(filePath);
  if (fileName !== 'layout.tsx' && fileName !== 'layout.jsx') return false;
  if ((report?.functions ?? 0) > 1) return false;
  if (report?.hasReactSignals || report?.hasBrowserGlobals || report?.hasProcessEnv) return false;
  return meaningfulLineCount(source) <= 35;
}

function isFrameworkShellPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const fileName = basename(normalized);

  return (
    /^app\/entry\.(server|client)\.[tj]sx?$/.test(normalized) ||
    /^app\/root\.[tj]sx?$/.test(normalized) ||
    /^app\/routes\/_index\/route\.[tj]sx?$/.test(normalized) ||
    /^app\/routes\/[^/]+\.[tj]sx?$/.test(normalized) ||
    fileName === 'page.tsx' ||
    fileName === 'page.jsx' ||
    fileName === 'layout.tsx' ||
    fileName === 'layout.jsx' ||
    fileName === 'loading.tsx' ||
    fileName === 'loading.jsx' ||
    fileName === 'error.tsx' ||
    fileName === 'error.jsx' ||
    fileName === 'not-found.tsx' ||
    fileName === 'not-found.jsx'
  );
}

function isLowComplexityFrameworkShell(
  filePath: string,
  source: string,
  report: FileReport | undefined,
  action: 'humanise' | 'slim' | 'stress-test',
): boolean {
  if (action !== 'humanise') return false;
  if (!isFrameworkShellPath(filePath)) return false;
  if ((report?.lines ?? 0) > 150) return false;
  if ((report?.functions ?? 0) > 2) return false;
  if (report?.hasReactSignals || report?.hasBrowserGlobals || report?.hasProcessEnv) return false;
  if ((report?.consoleLogs ?? 0) > 0) return false;
  return meaningfulLineCount(source) <= 90;
}

function isTrivialForAction(source: string, report: FileReport | undefined, action: 'humanise' | 'slim' | 'stress-test'): boolean {
  if (action === 'stress-test') return false;
  if ((report?.functions ?? 0) > 0) return false;
  if ((report?.consoleLogs ?? 0) > 0) return false;
  return meaningfulLineCount(source) <= 25;
}

function shouldRequireTestsBeforeCleanup(
  filePath: string,
  action: 'humanise' | 'slim' | 'stress-test',
  report: FileReport | undefined,
): boolean {
  if (action === 'stress-test') return false;
  if (report?.hasTest) return false;
  return isHighConsequencePath(filePath);
}

export async function runRefactorGate(
  filePath: string,
  action: 'humanise' | 'slim' | 'stress-test',
  report: FileReport | undefined,
): Promise<RefactorGateDecision> {
  if ((report?.lines ?? 0) > MAX_AUTONOMOUS_REFACTOR_LINES) {
    return {
      kind: 'large-file-advisory',
      reason: `file too large for autonomous refactoring (${report?.lines ?? 0} lines, limit ${MAX_AUTONOMOUS_REFACTOR_LINES})`,
    };
  }

  let source: string;
  try {
    source = await readFile(filePath, 'utf8');
  } catch {
    return { kind: 'skip', reason: 'file unreadable' };
  }

  if (hasGeneratedMarker(source)) {
    return { kind: 'skip', reason: 'auto-generated file marker found near top of file' };
  }

  if (shouldRequireTestsBeforeCleanup(filePath, action, report)) {
    return {
      kind: 'skip',
      reason: 'high-consequence route with no tests — run Stress test it before refactoring',
    };
  }

  if (isSimpleRouteWrapper(filePath, source, report)) {
    return { kind: 'skip', reason: 'trivial route wrapper with no meaningful logic to refactor' };
  }

  if (isMinimalLayout(filePath, source, report)) {
    return { kind: 'skip', reason: 'minimal layout file with no local logic to refactor' };
  }

  if (isLowComplexityFrameworkShell(filePath, source, report, action)) {
    return { kind: 'skip', reason: 'low-complexity framework shell with no focused humanise target' };
  }

  if (isTrivialForAction(source, report, action)) {
    return { kind: 'skip', reason: `file is too small and has no local logic for ${action}` };
  }

  return { kind: 'refactor' };
}

export async function runPrePlannerGate(
  reports: FileReport[],
  action: 'humanise' | 'slim' | 'stress-test',
): Promise<PrePlannerGateResult> {
  const eligibleReports: FileReport[] = [];
  const skippedFiles: Array<{ path: string; reason: string }> = [];

  for (const report of reports) {
    const decision = await runRefactorGate(report.path, action, report);
    if (decision.kind === 'skip') {
      skippedFiles.push({ path: report.path, reason: `pre-planner gate: ${decision.reason}` });
      continue;
    }

    eligibleReports.push(report);
  }

  return { eligibleReports, skippedFiles };
}
