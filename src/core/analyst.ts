import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, extname, basename, dirname } from 'node:path';

export interface FileReport {
  path: string;
  lines: number;
  functions: number;
  imports: number;
  hasTest: boolean;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.next', 'coverage', 'out', 'build']);
const VALID_EXTS = new Set(['.ts', '.js', '.tsx', '.jsx']);
const MAX_LINES = 300;
const MAX_FILES = 100;

// Matches: function foo, async function foo, export function foo, export default function
const FN_DECL_RE = /\bfunction\s+\w+\s*\(/g;
// Matches arrow functions assigned to a variable/const/let: const foo = (...) =>
const ARROW_RE = /(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?\(.*?\)\s*=>/g;

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(full);
    } else if (entry.isFile() && VALID_EXTS.has(extname(entry.name))) {
      yield full;
    }
  }
}

function countMatches(content: string, re: RegExp): number {
  return (content.match(re) ?? []).length;
}

function testFileExists(filePath: string, allPaths: Set<string>): boolean {
  const dir = dirname(filePath);
  const base = basename(filePath).replace(/\.(ts|tsx|js|jsx)$/, '');
  const exts = ['.ts', '.tsx', '.js', '.jsx'];
  const suffixes = ['.test', '.spec'];
  for (const suffix of suffixes) {
    for (const ext of exts) {
      if (allPaths.has(join(dir, `${base}${suffix}${ext}`))) return true;
    }
  }
  return false;
}

export async function analyse(projectRoot: string): Promise<FileReport[]> {
  // First pass: collect all paths so we can resolve test-file presence
  const allPaths = new Set<string>();
  for await (const p of walk(projectRoot)) {
    allPaths.add(p);
  }

  const reports: FileReport[] = [];

  for (const filePath of allPaths) {
    if (reports.length >= MAX_FILES) break;

    let content: string;
    try {
      // Quick line count without full read to skip large files fast
      const s = await stat(filePath);
      if (s.size > 300 * 120) continue; // rough byte heuristic before full read

      content = await readFile(filePath, 'utf8');
    } catch {
      continue;
    }

    const lines = content.split('\n').length;
    if (lines > MAX_LINES) continue;

    reports.push({
      path: relative(projectRoot, filePath),
      lines,
      functions: countMatches(content, FN_DECL_RE) + countMatches(content, ARROW_RE),
      imports: countMatches(content, /^import\s/gm),
      hasTest: testFileExists(filePath, allPaths),
    });
  }

  return reports;
}
