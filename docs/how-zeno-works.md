# How Zeno Works Internally

This document explains what happens when a user runs:

```bash
npx zenoai
```

Zeno runs as a Node CLI:

```text
bin/zenoai.js -> dist/index.js -> src/index.ts
```

At a high level:

```text
1. Start CLI
2. Check project directory
3. Load or ask for API config
4. Ask user which action they want
5. Route into one of four workflows
```

The four workflows are:

```text
1. Tell me if this is safe to ship
2. Check for security risks
3. Make this code easier to work with
4. Split large files
```

## Startup Flow

Before any action runs, Zeno does this:

1. Loads `.env` from the current project if one exists.
2. Handles maintenance commands:

```bash
npx zenoai help
npx zenoai reset
npx zenoai reset-history
npx zenoai clear-report
npx zenoai --export
```

3. Checks the current directory:
   - Blocks dangerous directories like home, `/`, `/usr`, `/etc`, `/var`, and `/tmp`.
   - Expects a JavaScript or TypeScript project with `package.json`.
   - Warns if running Zeno on itself.

4. Loads config from:

```text
~/.zenoai/config.json
```

If config is missing, Zeno asks the user to choose an AI provider:

```text
Anthropic
Gemini
OpenRouter
OpenAI
```

Then it saves the provider and API key locally.

5. Shows the action menu.

## Shared Project Analysis

Most workflows use `analyse(projectRoot)`.

Zeno scans for:

```text
.ts
.tsx
.js
.jsx
```

Zeno skips:

```text
node_modules
dist
build
out
.next
coverage
.git
.d.ts / .d.tsx files
git submodules
```

For each source file, Zeno creates compact metadata:

```ts
{
  path,
  lines,
  functions,
  imports,
  exports,
  consoleLogs,
  hasTest,
  hasReactSignals,
  hasBrowserGlobals,
  hasProcessEnv,
  hasMutableExports
}
```

Zeno also builds a lightweight dependency graph from local imports.

Files are sorted by:

```text
lines x functions
```

This keeps the most complex files near the top.

## Scenario 1: Tell Me If This Is Safe To Ship

This is the main read-only AI review.

Flow:

```text
src/index.ts
  -> runOrchestrator({
       role: "Engineering Manager",
       action: "Tell me if this is safe to ship",
       config
     })
```

Then:

1. Zeno scans the project with `analyse(root)`.
2. Zeno caps the AI payload at 50 files.
3. Zeno applies guardrails:
   - Stops if only generated files are found.
   - Stops if no JS/TS files are found.
   - Stops if most files are unreadable.
   - Warns if the codebase is large and only 50 files will be sent.
   - Notes when very few source files are found.
4. Zeno prints a transparency summary:

```text
found (N) -> sending (M)
skipped: some-file.d.ts (auto-generated)
```

5. Zeno asks the user:

```text
Proceed with this AI review?
```

6. If approved, Zeno sends compact file metadata to the selected AI provider.

Important: this read-only report sends metadata, not full raw code.

Example model input:

```json
[
  {
    "path": "script.js",
    "lines": 845,
    "functions": 31,
    "imports": 0,
    "exports": 0,
    "hasTest": false
  }
]
```

7. The model must return strict JSON:

```ts
{
  score,
  label,
  summary,
  files,
  observations,
  actions,
  start
}
```

8. Zeno parses the JSON and prints:

```text
ZENOAI -- SHIP READINESS REPORT
Is this code safe to ship?
Why
What is blocking shipment
Safest next step
```

9. Zeno caches the report at:

```text
~/.zenoai/last-report.json
```

This flow does not modify files.

## Scenario 2: Check For Security Risks

This is a local static security scan.

Flow:

```text
src/index.ts
  -> runOrchestrator({
       role: "Security Reviewer",
       action: "Check for security risks",
       config
     })
```

Then:

1. Zeno scans files with `analyse(root)`.
2. Zeno passes file reports into:

```ts
runSecurityCheck(reports)
```

3. The security checker reads local source files and searches for obvious risk signals:

```text
secrets in code
process.env in risky places
auth/session paths
webhook/payment/cart/order/billing paths
unsafe redirects
permissive CORS
dangerous HTML rendering
dynamic code execution
weak crypto
disabled TLS
command execution
risky file/database access
```

4. Zeno prints:

```text
ZENOAI -- SECURITY CHECK
What Zeno checked
Are there obvious security risks?
Main concern
Where to look
Safest next step
```

This flow:

```text
No AI call
No API cost
No file changes
Local only
```

## Scenario 3: Make This Code Easier To Work With

This is the guarded cleanup/refactor flow.

Flow:

```text
src/index.ts
  -> runPhase2(process.cwd(), "humanise", "Senior Engineer")
```

This is where the multi-agent cleanup architecture still exists.

Backend pipeline:

```text
Preflight
  -> Analyst
  -> Pre-planner gate
  -> Planner
  -> Refactor viability check
  -> Reviewer
  -> Validator
  -> Critic
  -> Differ
```

### 1. Preflight

Zeno runs:

```ts
runPreflight()
```

This checks Git safety before touching files.

It protects against:

```text
dirty working tree
bad directories
recursive Zeno branches
unsafe repo state
```

It creates a manifest and prepares a safe Zeno branch. The original branch should not be directly modified.

### 2. Analyst

Zeno scans the project:

```ts
analyse(projectPath)
```

This produces file metadata and a dependency graph.

### 3. Pre-Planner Gate

Zeno filters out poor cleanup targets before spending model calls:

```ts
runPrePlannerGate(reports, action)
```

It skips things like:

```text
generated files
config files
framework shells
static UI
high-consequence untested routes
files too risky for autonomous cleanup
```

If nothing useful remains, Zeno stops and rolls back.

This is important: Zeno is designed to refuse low-value or risky cleanup.

### 4. Planner

Zeno chooses the safest files:

```ts
runPlanner(graph, eligibleReports, action)
```

Planner considers:

```text
dependency graph
importer count
history
risk
complexity
```

It avoids retrying files already accepted or skipped in:

```text
.zeno-history.json
```

### 5. Viability Check

For `humanise`, Zeno classifies selected files:

```ts
classifySelectedFiles(...)
```

If selected files are not actually safe or useful for cleanup, Zeno stops before AI review.

### 6. Cost Confirmation

Zeno estimates cost and asks:

```text
Proceed with this run?
```

### 7. Reviewer

For each selected file:

```ts
runReviewer(filePath, action, fileReport)
```

The reviewer plans changes. This is where selected file content may be sent to the configured AI provider, because Zeno needs a concrete plan for the actual file.

The reviewer can also skip the file.

### 8. Refactor Gate

Before changing each file:

```ts
runRefactorGate(filePath, action, fileReport)
```

This can decide:

```text
continue
skip
large-file-advisory
```

### 9. Validator

If the reviewer produces a plan:

```ts
runValidator(filePath, reviewed.changes, action, fileReport)
```

Validator applies or evaluates the proposed refactor and scores confidence.

If confidence is low, it skips instead of guessing.

### 10. Critic

After validator:

```ts
runCritic(validated, reviewed.changes, action)
```

Critic is a final safety review. It checks whether the diff crossed boundaries or introduced bad abstractions.

### 11. Differ

Finally:

```ts
runDiffer(results, manifest, manifestPath)
```

This shows results and lets the user decide whether to keep or discard changes.

It also saves accepted and skipped files into:

```text
.zeno-history.json
```

So Zeno does not keep retrying the same bad target.

This flow can modify files, but only after Git preflight and user confirmation.

## Scenario 4: Split Large Files

This is deterministic large-file splitting.

Flow:

```text
src/index.ts
  -> runSplit(process.cwd(), "Senior Engineer")
```

Then:

1. Zeno scans files with `analyse(projectPath)`.
2. Zeno finds files over:

```ts
MAX_AUTONOMOUS_REFACTOR_LINES
```

3. Zeno sorts candidates by largest file first.
4. If no large files exist, it exits.
5. If candidates exist, it shows the first target:

```text
Starting with:
  SomeLargeFile.tsx (900 lines, 40 functions)
```

6. Zeno tells the user:

```text
Zeno will start with the safest split:
moving static constants and data into a sibling module.
This step does not spend API credits.
```

7. User confirms:

```text
Proceed with this split?
```

8. Zeno runs Git preflight.
9. Zeno executes:

```ts
runStaticSplit(target)
```

This is local deterministic logic, not an LLM refactor.

10. Zeno passes the result into:

```ts
runDiffer(...)
```

So the user can keep or discard the change.

This flow can modify files, but it is local and zero model cost.

## What Each Scenario Sends To AI

```text
Safe to ship:
  Sends compact metadata only.

Security risks:
  Sends nothing. Local scan only.

Make this code easier to work with:
  May send selected file content to the configured provider.

Split large files:
  Sends nothing. Local deterministic split.
```

## Current Product Reality

The CLI today is not yet a full PR bot.

It currently does:

```text
codebase scan
ship-readiness review
security scan
safe cleanup/refactor gating
large-file static splitting
HTML report export
history/config maintenance
```

The roadmap direction is:

```text
AI-generated diff review
pre-merge safety layer
agent-agnostic review around Codex / Claude Code / Cursor
```

So the backend today is partly codebase review and partly guarded cleanup. The strategic future is to make that safety judgment apply directly to AI-generated diffs before merge.
