import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative, extname, basename, dirname, sep } from 'node:path';

export interface FileReport {
  path: string;
  lines: number;
  functions: number;
  imports: number;
  exports: number;
  consoleLogs: number;
  hasTest: boolean;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.next', 'coverage', 'out', 'build']);
const VALID_EXTS = new Set(['.ts', '.js', '.tsx', '.jsx']);
const DECL_RE = /\.d\.tsx?$/;

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface AnalyseResult {
  reports: FileReport[];
  skipped: SkippedFile[];
}

// Matches: function foo, async function foo, export function foo, export default function
const FN_DECL_RE = /\bfunction\s+\w+\s*\(/g;
// Matches arrow functions assigned to a variable/const/let: const foo = (...) =>
const ARROW_RE = /(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?\(.*?\)\s*=>/g;
// All export statements at line-start (named, default, re-exports, barrels)
const EXPORT_RE = /^export\s/gm;
// console.log calls anywhere in the file
const CONSOLE_LOG_RE = /\bconsole\.log\b/g;

function collectAllFiles(rootDir: string): { paths: string[]; skipped: SkippedFile[] } {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(rootDir, { withFileTypes: true, recursive: true });
  } catch {
    return { paths: [], skipped: [] };
  }

  const paths: string[] = [];
  const skipped: SkippedFile[] = [];

  for (const entry of entries) {
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

    // Skip auto-generated declaration files
    if (DECL_RE.test(entry.name)) {
      skipped.push({ path: relPath, reason: 'auto-generated' });
      continue;
    }

    paths.push(fullPath);
  }

  return { paths, skipped };
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

export async function analyse(projectRoot: string): Promise<AnalyseResult> {
  // First pass: collect all paths so we can resolve test-file presence
  const { paths, skipped } = collectAllFiles(projectRoot);
  const allPaths = new Set<string>(paths);

  const reports: FileReport[] = [];

  for (const filePath of allPaths) {
    let content: string;
    try {
      content = await readFile(filePath, 'utf8');
    } catch {
      skipped.push({ path: relative(projectRoot, filePath), reason: 'unreadable' });
      continue;
    }

    const lines = content.split('\n').length;

    reports.push({
      path: relative(projectRoot, filePath),
      lines,
      functions: countMatches(content, FN_DECL_RE) + countMatches(content, ARROW_RE),
      imports: countMatches(content, /^import\s/gm),
      exports: countMatches(content, EXPORT_RE),
      consoleLogs: countMatches(content, CONSOLE_LOG_RE),
      hasTest: testFileExists(filePath, allPaths),
    });
  }

  // Sort descending by risk score (lines × functions) so the caller's cap keeps the most complex files
  reports.sort((a, b) => (b.lines * b.functions) - (a.lines * a.functions));

  return { reports, skipped };
}
