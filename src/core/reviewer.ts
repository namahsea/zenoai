import { readFile } from 'node:fs/promises';
import { generateCompletion, extractJson } from '../utils/llm.js';

export interface ReviewerResult {
  filePath: string;
  changes: string[];
  skip: boolean;
  skipReason?: string;
}

const MAX_REVIEWER_TOKENS = 2000;


export async function runReviewer(
  filePath: string,
  action: 'humanise' | 'slim' | 'stress-test',
): Promise<ReviewerResult> {
  // Step 1 — read the file
  let fileSource: string;
  try {
    fileSource = await readFile(filePath, 'utf8');
  } catch {
    return { filePath, changes: [], skip: true, skipReason: 'file unreadable' };
  }

  const lineCount = fileSource.split('\n').length;
  if (lineCount > 300) {
    return {
      filePath,
      changes: [],
      skip: true,
      skipReason: `file too large for autonomous refactoring (${lineCount} lines) — split into smaller modules first`,
    };
  }

  // Step 2 — Claude call
  const systemPrompt = `You are a senior TypeScript engineer reviewing a file before a cleanup run.
Your job is to produce a precise, conservative change plan for the following action: ${action}

Rules for all actions:
- Only suggest changes that meaningfully improve the code
- Never suggest architectural changes or new abstractions
- Keep function signatures identical unless renaming
- Be specific — name the exact function, variable, or pattern and what it should become
- If the file does not need changes for this action, return skip: true with a reason

Rules specific to each action:
- humanise: rename vague variables and functions to describe intent not mechanics, split bloated functions, extract duplicated logic into named helpers, extract magic numbers into named constants
- slim: remove dead code, unused variables, unused imports, redundant comments, simplify overly complex logic
- stress-test: identify every function that has no test coverage and list what behaviors should be tested

Additional rules:
- Identify functions that mix two or more distinct concerns — database operations, business logic calculations, side effects, or notifications. Flag which concern could be extracted as a pure function and name it explicitly.
- Never remove parameters even if unused — flag them with a comment instead.
- Look for functions doing more than one sequential job. Suggest breaking into named steps.
- Identify async side effects that do not affect the return value. Flag these as non-blocking candidates with .catch() handlers.
- Add comments only at decision points where the reason for the order is non-obvious.
- For database query result variables use short names like shopRecord, log, entry. Exception: if a variable captures the return value of a write operation (db.update, db.create, db.upsert), preserve a temporal modifier that signals the post-mutation state — e.g., updatedShop, shopAfterIncrement. This tells the next developer the value reflects state after the write, not before it.
- When making async side effects non-blocking, always attach a .catch() handler. Never leave a floating promise without .catch().

Strict Output Requirements:
- Return ONLY valid JSON. No markdown formatting, no backticks, no explanations.
- Start with { and end with }.

Format:
{
  "changes": string[],
  "skip": boolean,
  "skipReason": string | null
}`;

  // Step 3 — LLM call
  const responseText = await generateCompletion(systemPrompt, fileSource, MAX_REVIEWER_TOKENS);

  // Step 4 — boundary extraction

  let reviewerPayload: { changes?: string[]; skip?: boolean; skipReason?: string | null };
  try {
    reviewerPayload = JSON.parse(extractJson(responseText));
  } catch {
    return { filePath, changes: [], skip: true, skipReason: 'reviewer response unparseable' };
  }

  // Step 5 — return
  return {
    filePath,
    changes: reviewerPayload.changes ?? [],
    skip: reviewerPayload.skip ?? false,
    skipReason: reviewerPayload.skipReason ?? undefined,
  };
}