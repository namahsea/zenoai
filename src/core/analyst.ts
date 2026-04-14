import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative, extname, basename, dirname, sep } from 'node:path';

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

function collectAllFiles(rootDir: string): string[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(rootDir, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }

  const results: string[] = [];
  for (const entry of entries) {
    if (results.length >= MAX_FILES) break;

    // Only want real files — isFile() follows symlinks on readdirSync entries
    if (!entry.isFile()) continue;
    if (!VALID_EXTS.has(extname(entry.name))) continue;

    // entry.parentPath (Node 21.3+) is the containing directory; older Node exposes it as entry.path
    const parentDir: string =
      (entry as unknown as { parentPath?: string }).parentPath ??
      (entry as unknown as { path: string }).path;
    const fullPath = join(parentDir, entry.name);
    const relPath = relative(rootDir, fullPath);
    const parts = relPath.split(sep);

    // Skip if any path segment is a directory we want to ignore
    if (parts.some(p => SKIP_DIRS.has(p))) continue;

    results.push(fullPath);
  }

  return results;
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
  const allPaths = new Set<string>(collectAllFiles(projectRoot));

  const reports: FileReport[] = [];

  for (const filePath of allPaths) {
    if (reports.length >= MAX_FILES) break;

    let content: string;
    try {
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
