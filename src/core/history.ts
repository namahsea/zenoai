import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

export interface RefactorHistory {
  actions: {
    humanise: {
      accepted: string[];
      skipped: Array<{ path: string; reason: string }>;
    };
    slim: {
      accepted: string[];
      skipped: Array<{ path: string; reason: string }>;
    };
    'stress-test': {
      accepted: string[];
      skipped: Array<{ path: string; reason: string }>;
    };
    split: {
      accepted: string[];
      skipped: Array<{ path: string; reason: string }>;
    };
  };
  lastRunAt: string;
}

export type HistoryAction = keyof RefactorHistory['actions'];

const HISTORY_FILENAME = '.zeno-history.json';
const GITIGNORE_ENTRY = '.zeno-history.json';

function emptyHistory(): RefactorHistory {
  return {
    actions: {
      humanise: { accepted: [], skipped: [] },
      slim: { accepted: [], skipped: [] },
      'stress-test': { accepted: [], skipped: [] },
      split: { accepted: [], skipped: [] },
    },
    lastRunAt: '',
  };
}

export async function loadHistory(projectRoot: string): Promise<RefactorHistory> {
  try {
    const raw = await readFile(join(projectRoot, HISTORY_FILENAME), 'utf8');
    return JSON.parse(raw) as RefactorHistory;
  } catch {
    return emptyHistory();
  }
}

export async function saveHistory(
  projectRoot: string,
  acceptedFiles: string[],
  skippedFiles: Array<{ path: string; reason: string }>,
  action: HistoryAction,
): Promise<void> {
  const history = await loadHistory(projectRoot);
  history.actions[action] ??= { accepted: [], skipped: [] };
  const bucket = history.actions[action];

  const acceptedRel = acceptedFiles.map(f => relative(projectRoot, f));
  bucket.accepted = [...new Set([...bucket.accepted, ...acceptedRel])];

  const skippedRel = skippedFiles.map(s => ({ path: relative(projectRoot, s.path), reason: s.reason }));
  const skippedByPath = new Map(bucket.skipped.map(s => [s.path, s]));
  for (const s of skippedRel) skippedByPath.set(s.path, s);
  bucket.skipped = [...skippedByPath.values()];

  history.lastRunAt = new Date().toISOString();

  await writeFile(join(projectRoot, HISTORY_FILENAME), JSON.stringify(history, null, 2), 'utf8');

  // Keep history file out of git — append to .gitignore only if entry is missing
  const gitignorePath = join(projectRoot, '.gitignore');
  try {
    const contents = await readFile(gitignorePath, 'utf8');
    if (!contents.split('\n').some(line => line.trim() === GITIGNORE_ENTRY)) {
      await appendFile(gitignorePath, `\n${GITIGNORE_ENTRY}\n`, 'utf8');
    }
  } catch {
    await writeFile(gitignorePath, `${GITIGNORE_ENTRY}\n`, 'utf8');
  }
}

export async function getRefactoredPaths(
  projectRoot: string,
  action: HistoryAction,
): Promise<Set<string>> {
  const history = await loadHistory(projectRoot);
  history.actions[action] ??= { accepted: [], skipped: [] };
  const bucket = history.actions[action];
  return new Set([...bucket.accepted, ...bucket.skipped.map(s => s.path)]);
}
