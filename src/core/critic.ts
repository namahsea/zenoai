import { readFile } from 'node:fs/promises';
import { generateCompletion, extractJson } from '../utils/llm.js';
import type { ValidatorResult } from './validator.js';

interface CriticPayload {
  status?: 'accepted' | 'skipped';
  correctedSource?: string;
  correctedSourceLines?: string[];
  skipReason?: string | null;
  boundaryNotes?: string[];
}

const MAX_CRITIC_TOKENS = 8000;

function stripMarkdownFence(source: string): string {
  let cleaned = source.trim();
  const fenceStart = cleaned.indexOf('```');
  const fenceEnd = cleaned.lastIndexOf('```');

  if (fenceStart !== -1 && fenceEnd !== fenceStart) {
    const afterOpenFence = cleaned.indexOf('\n', fenceStart) + 1;
    cleaned = cleaned.substring(afterOpenFence, fenceEnd).trim();
  }

  return cleaned;
}

function hasLikelyTruncation(source: string): boolean {
  const openBraces = (source.match(/{/g) ?? []).length;
  const closeBraces = (source.match(/}/g) ?? []).length;
  return Math.abs(openBraces - closeBraces) > 5;
}

function countChangedLines(before: string, after: string): number {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const max = Math.max(beforeLines.length, afterLines.length);
  let changed = 0;

  for (let i = 0; i < max; i++) {
    if (beforeLines[i] !== afterLines[i]) changed += 1;
  }

  return changed;
}

export async function runCritic(
  validated: ValidatorResult,
  changes: string[],
  action: 'humanise' | 'slim' | 'stress-test',
): Promise<ValidatorResult> {
  if (validated.status !== 'accepted' || !validated.refactoredSource) {
    return validated;
  }

  let originalSource: string;
  try {
    originalSource = await readFile(validated.filePath, 'utf8');
  } catch {
    return {
      ...validated,
      status: 'skipped',
      refactoredSource: undefined,
      skipReason: 'critic could not read original file',
    };
  }

  const criticSystemPrompt = `You are a senior TypeScript engineer performing a focused post-refactor Critic pass.
You are not doing a broad style review. You only inspect boundaries introduced by this refactor.

Current action target: ${action}

Review only:
1. Newly extracted helpers.
2. Renamed boundaries.
3. Changed call sites.

Checks:
- Purity Check: extracted helpers should use only parameters and local variables unless an environment dependency is explicit and deliberate. Watch for window, document, navigator, process.env, refs, hooks, routers, stores, module-level mutable state, or other globals hidden inside helper bodies.
- Boundary Check: caller and callee must not both perform the same setup. Watch for duplicate cloning, parsing, validation, normalization, serialization, memoization, or equivalent preparation work.
- Behavior Parity Check: preserve mutation timing, object identity, memoization behavior, framework lifecycle semantics, and React/Three.js assumptions.

Rules:
- Preserve behavior.
- Make only minimal edits needed to fix boundary-quality issues.
- Do not rewrite unrelated code.
- Do not introduce broad architectural changes.
- If a helper should remain environment-aware, make that dependency explicit through parameters or naming.
- If the refactored source already has clean boundaries, return it unchanged.
- If the boundary problem cannot be fixed safely with a small edit, return status "skipped" with a concise skipReason.

Strict Output Requirements:
- Return ONLY valid JSON. No markdown formatting, no backticks, no explanations.
- Start with { and end with }.

Format:
{
  "status": "accepted" | "skipped",
  "correctedSourceLines": string[] | null,
  "skipReason": string | null,
  "boundaryNotes": string[]
}`;

  const criticUserPrompt = `Reviewer change instructions:
${changes.map((change, i) => `${i + 1}. ${change}`).join('\n')}

Original source:
<<<ORIGINAL
${originalSource}
ORIGINAL

Refactored source to audit:
<<<REFACTORED
${validated.refactoredSource}
REFACTORED`;

  let payload: CriticPayload;
  try {
    const rawResponse = await generateCompletion(criticSystemPrompt, criticUserPrompt, MAX_CRITIC_TOKENS);
    payload = JSON.parse(extractJson(rawResponse)) as CriticPayload;
  } catch {
    return {
      ...validated,
      status: 'skipped',
      refactoredSource: undefined,
      skipReason: 'critic response unparseable',
    };
  }

  if (payload.status === 'skipped') {
    return {
      ...validated,
      status: 'skipped',
      refactoredSource: undefined,
      skipReason: payload.skipReason ?? 'critic found boundary-quality issues',
    };
  }

  const correctedSource = stripMarkdownFence(
    payload.correctedSourceLines?.join('\n') ??
    payload.correctedSource ??
    validated.refactoredSource,
  );
  if (hasLikelyTruncation(correctedSource)) {
    return {
      ...validated,
      status: 'skipped',
      refactoredSource: undefined,
      skipReason: 'critic output appears truncated — brace mismatch detected',
    };
  }

  return {
    ...validated,
    refactoredSource: correctedSource,
    linesChanged: countChangedLines(originalSource, correctedSource),
  };
}
