import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

export interface RefactorHistory {
  actions: {
    humanise: string[];
    slim: string[];
    'stress-test': string[];
  };
  lastRunAt: string;
}

const HISTORY_FILENAME = '.zeno-history.json';
const GITIGNORE_ENTRY = '.zeno-history.json';

const EMPTY_HISTORY: RefactorHistory = {
  actions: { humanise: [], slim: [], 'stress-test': [] },
  lastRunAt: '',
};

export async function loadHistory(projectRoot: string): Promise<RefactorHistory> {
  try {
    const raw = await readFile(join(projectRoot, HISTORY_FILENAME), 'utf8');
    return JSON.parse(raw) as RefactorHistory;
  } catch {
    return { ...EMPTY_HISTORY, actions: { humanise: [], slim: [], 'stress-test': [] } };
  }
}

export async function saveHistory(
  projectRoot: string,
  acceptedFiles: string[],
  action: 'humanise' | 'slim' | 'stress-test',
): Promise<void> {
  const history = await loadHistory(projectRoot);

  const relativePaths = acceptedFiles.map(f => relative(projectRoot, f));
  const merged = new Set([...history.actions[action], ...relativePaths]);
  history.actions[action] = [...merged];
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
  action: 'humanise' | 'slim' | 'stress-test',
): Promise<Set<string>> {
  const history = await loadHistory(projectRoot);
  return new Set(history.actions[action]);
}
