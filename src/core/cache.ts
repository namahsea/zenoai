import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { HealthReport } from '../types.js';

const CACHE_DIR = join(homedir(), '.zenoai');
const CACHE_PATH = join(CACHE_DIR, 'last-report.json');

export interface CachedReport {
  report: HealthReport;
  root: string;
  fileCount: number;
  savedAt: string;
}

export async function saveReport(report: HealthReport, root: string, fileCount: number): Promise<void> {
  const data: CachedReport = { report, root, fileCount, savedAt: new Date().toISOString() };
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify(data, null, 2), 'utf8');
}

export async function loadReport(): Promise<CachedReport | null> {
  try {
    const raw = await readFile(CACHE_PATH, 'utf8');
    return JSON.parse(raw) as CachedReport;
  } catch {
    return null;
  }
}
