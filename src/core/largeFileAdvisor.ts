import { readFile } from 'node:fs/promises';
import { generateCompletion, extractJson } from '../utils/llm.js';
import type { FileReport } from './analyst.js';
import { MAX_AUTONOMOUS_REFACTOR_LINES } from './refactorLimits.js';

export interface LargeFileAdvisory {
  filePath: string;
  lineCount: number;
  reason: string;
  responsibilities: string[];
  extractionCandidates: string[];
  safestFirstStep: string;
  riskNotes: string[];
}

interface LargeFileAdvisoryPayload {
  responsibilities?: string[];
  extractionCandidates?: string[];
  safestFirstStep?: string;
  riskNotes?: string[];
}

const MAX_LARGE_FILE_ADVISOR_TOKENS = 2000;

function fallbackAdvisory(
  filePath: string,
  lineCount: number,
  reason: string,
): LargeFileAdvisory {
  return {
    filePath,
    lineCount,
    reason,
    responsibilities: [],
    extractionCandidates: [],
    safestFirstStep: 'Split the file into smaller modules before asking Zeno to refactor it autonomously.',
    riskNotes: ['The file exceeds the autonomous whole-file rewrite limit.'],
  };
}

function compactSource(source: string): string {
  const lines = source.split('\n');
  if (lines.length <= 260) return source;

  const head = lines.slice(0, 140).join('\n');
  const tail = lines.slice(-100).join('\n');
  return `${head}\n\n/* ... middle of large file omitted for advisory context ... */\n\n${tail}`;
}

function normalizeList(value: string[] | undefined, maxItems: number): string[] {
  return (value ?? [])
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map(item => item.trim())
    .slice(0, maxItems);
}

export async function runLargeFileAdvisor(
  filePath: string,
  action: 'humanise' | 'slim' | 'stress-test',
  report: FileReport | undefined,
): Promise<LargeFileAdvisory> {
  const lineCount = report?.lines ?? 0;
  const reason = `file too large for autonomous refactoring (${lineCount} lines, limit ${MAX_AUTONOMOUS_REFACTOR_LINES})`;

  let source: string;
  try {
    source = await readFile(filePath, 'utf8');
  } catch {
    return fallbackAdvisory(filePath, lineCount, reason);
  }

  const systemPrompt = `You are a senior TypeScript engineer advising on a file that is too large for autonomous whole-file refactoring.
Zeno will not rewrite this file. Your job is to produce a concise, read-only split plan.

Current action target: ${action}
Autonomous rewrite limit: ${MAX_AUTONOMOUS_REFACTOR_LINES} lines

Rules:
- Do not propose a full rewrite.
- Do not propose broad architecture changes.
- Identify the file's main responsibilities.
- Identify small extraction candidates a human should split first.
- Prefer low-risk, behavior-preserving first steps.
- Call out lifecycle, mutation, object identity, framework, or global dependency risks.
- Keep every item concise and specific.

Strict Output Requirements:
- Return ONLY valid JSON. No markdown formatting, no backticks, no explanations.
- Start with { and end with }.

Format:
{
  "responsibilities": string[],
  "extractionCandidates": string[],
  "safestFirstStep": string,
  "riskNotes": string[]
}`;

  const userPrompt = `File metadata:
${JSON.stringify({
  path: filePath,
  lines: lineCount,
  functions: report?.functions ?? 0,
  imports: report?.imports ?? 0,
  exports: report?.exports ?? 0,
  consoleLogs: report?.consoleLogs ?? 0,
  hasTest: report?.hasTest ?? false,
  hasReactSignals: report?.hasReactSignals ?? false,
  hasBrowserGlobals: report?.hasBrowserGlobals ?? false,
  hasProcessEnv: report?.hasProcessEnv ?? false,
  hasMutableExports: report?.hasMutableExports ?? false,
}, null, 2)}

Source excerpt:
<<<SOURCE
${compactSource(source)}
SOURCE`;

  let payload: LargeFileAdvisoryPayload;
  try {
    const rawResponse = await generateCompletion(systemPrompt, userPrompt, MAX_LARGE_FILE_ADVISOR_TOKENS);
    payload = JSON.parse(extractJson(rawResponse)) as LargeFileAdvisoryPayload;
  } catch {
    return fallbackAdvisory(filePath, lineCount, reason);
  }

  return {
    filePath,
    lineCount,
    reason,
    responsibilities: normalizeList(payload.responsibilities, 4),
    extractionCandidates: normalizeList(payload.extractionCandidates, 4),
    safestFirstStep: payload.safestFirstStep?.trim() || fallbackAdvisory(filePath, lineCount, reason).safestFirstStep,
    riskNotes: normalizeList(payload.riskNotes, 4),
  };
}
