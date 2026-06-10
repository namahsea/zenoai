import type { DependencyGraph, FileReport } from './analyst.js';
import { getRefactoredPaths } from './history.js';
import { generateCompletion, extractJson } from '../utils/llm.js';
import { isHighConsequencePath } from './riskSignals.js';

export interface PlannerResult {
  selectedFiles: string[];
  skippedFiles: Array<{ path: string; reason: string }>;
}

const MAX_PLANNER_CANDIDATES = 20;
const MAX_IMPORTER_COUNT = 15;
const PLANNER_MAX_TOKENS = 1500;

function findDirectCyclePaths(candidates: string[], importedBy: Record<string, string[]>): Set<string> {
  const cycleSkipped = new Set<string>();
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const fileA = candidates[i];
      const fileB = candidates[j];
      const aImportsB = (importedBy[fileB] ?? []).includes(fileA);
      const bImportsA = (importedBy[fileA] ?? []).includes(fileB);
      if (aImportsB && bImportsA) {
        cycleSkipped.add(fileA);
        cycleSkipped.add(fileB);
      }
    }
  }
  return cycleSkipped;
}

function buildCompactFileSummary(
  path: string,
  graph: DependencyGraph,
  report: FileReport | undefined,
  candidateFileSet: Set<string>,
) {
  return {
    path,
    importerCount: graph.importerCount[path] ?? 0,
    importedBy: (graph.importedBy[path] ?? []).filter((p: string) => candidateFileSet.has(p)),
    lineCount: report?.lines ?? 0,
    functionCount: report?.functions ?? 0,
    hasTests: report?.hasTest ?? false,
    hasReactSignals: report?.hasReactSignals ?? false,
    hasBrowserGlobals: report?.hasBrowserGlobals ?? false,
    hasProcessEnv: report?.hasProcessEnv ?? false,
    hasMutableExports: report?.hasMutableExports ?? false,
    isHighConsequence: isHighConsequencePath(path),
  };
}


export async function runPlanner(
  graph: DependencyGraph,
  reports: FileReport[],
  action: 'humanise' | 'slim' | 'stress-test',
  maxFiles: number = 5,
): Promise<PlannerResult> {
  const skippedFiles: Array<{ path: string; reason: string }> = [];
  const reportByPath = new Map(reports.map(report => [report.path, report]));

  // Step 1 — local filtering
  const pathsPassingLocalFilter: string[] = [];
  for (const path of graph.order) {
    if ((graph.importerCount[path] ?? 0) > MAX_IMPORTER_COUNT) {
      skippedFiles.push({ path, reason: `local filter: too many importers (>${MAX_IMPORTER_COUNT})` });
      continue;
    }
    if (/node_modules|dist|\.git|test|spec/.test(path)) {
      skippedFiles.push({ path, reason: 'local filter: excluded path pattern' });
      continue;
    }
    if (path.endsWith('.d.ts')) {
      skippedFiles.push({ path, reason: 'local filter: declaration file' });
      continue;
    }
    pathsPassingLocalFilter.push(path);
  }

  // Cap candidates before cycle detection — the LLM context window constrains how many summaries can be sent at once
  const candidateFiles = pathsPassingLocalFilter.slice(0, MAX_PLANNER_CANDIDATES);

  // Exclude files already refactored for this action in a previous run
  const alreadyRefactored = await getRefactoredPaths(process.cwd(), action);
  const freshCandidates = candidateFiles.filter(f => !alreadyRefactored.has(f));

  if (freshCandidates.length === 0) {
    return {
      selectedFiles: [],
      skippedFiles: [{
        path: 'all candidates',
        reason: 'local filter: all eligible files have already been refactored for this action. Run a different action or reset history.',
      }],
    };
  }

  const candidateFileSet = new Set(freshCandidates);

  // Step 2 — direct circular dependency detection
  // Note: this only detects direct A<->B cycles, not transitive cycles (A->B->C->A).
  // Transitive cycle detection (Tarjan's algorithm) is deferred — direct cycles cover ~90% of real cases.
  const cycleSkipped = findDirectCyclePaths(freshCandidates, graph.importedBy);
  for (const path of cycleSkipped) {
    skippedFiles.push({ path, reason: 'local filter: circular dependency' });
  }
  const cycleFreePaths = freshCandidates.filter(p => !cycleSkipped.has(p));

  // Step 3 — build compact per-file summary (importedBy filtered to batch only)
  const compactFileSummaries = cycleFreePaths.map(path =>
    buildCompactFileSummary(path, graph, reportByPath.get(path), candidateFileSet),
  );

  // Step 4 — Claude call
  const systemPrompt = `You are a senior engineer planning a safe refactoring run.
You will receive metadata for up to ${MAX_PLANNER_CANDIDATES} files sorted leaf-first.
Your job is to select up to ${maxFiles} files to include in this refactoring run.
Current action target: ${action}

Rules:
- Prefer files with 0 importers first
- Prefer files with no existing tests (they need the most help)
- Prefer larger files (more lines = more to improve)
- Never select two files where one appears in the other's importedBy list
- Never select files that look like configuration, generated code, or type definitions
- For action "humanise": prefer medium-risk files with local complexity, vague names, magic constants, duplicated helpers, or bloated functions
- For action "humanise": avoid untested high-consequence files such as webhooks, auth, billing, subscriptions, checkout, payment, order, cart, or database-write routes; those need tests before cleanup
- For action "slim": prefer files with high line count but avoid untested high-consequence files unless the change is obviously dead code cleanup
- For action "stress-test": prefer untested high-consequence files first, especially webhooks, auth, billing, subscriptions, checkout, payment, order, cart, and data-write routes

Strict Output Requirements:
- Return ONLY valid JSON. No markdown formatting, no backticks, no explanations.
- Start with { and end with }.
- Every file provided in the input MUST appear in either the "selected" array or the "skipped" array.

Format:
{
  "selected": string[],
  "skipped": [{ "path": string, "reason": string }]
}`;

  // Step 5 — parse planner selection from LLM response
  const rawResponseText = await generateCompletion(systemPrompt, JSON.stringify(compactFileSummaries, null, 2), PLANNER_MAX_TOKENS);
  const plannerSelection = JSON.parse(extractJson(rawResponseText)) as {
    selected: string[];
    skipped: Array<{ path: string; reason: string }>;
  };

  // Step 6 — combine results
  for (const skippedEntry of plannerSelection.skipped ?? []) {
    skippedFiles.push(skippedEntry);
  }

  return {
    selectedFiles: plannerSelection.selected ?? [],
    skippedFiles,
  };
}
