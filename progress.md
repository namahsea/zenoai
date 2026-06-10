# Zenoai — Progress

## v0.1.4 (2026-04-14)

**Fixed symlink support** — symlinked files were silently skipped because `Dirent.isFile()` returns `false` for symlinks. Now uses `stat()` (follows symlinks) to verify file type.

**Simplified directory walking** — replaced the manual recursive async generator with Node's built-in `readdir({ withFileTypes: true, recursive: true })` (Node 18.17+). Single call, flat result, no recursive yield chain. SKIP_DIRS now checked against every segment of the relative path, so nested skip dirs (e.g. `src/dist/`) are also excluded.

**Sanity check warning** — after the analyst runs, if fewer than 3 files are found and a `package.json` exists in the cwd, prints an amber warning: `Warning: only N files found — this may be incomplete. Make sure you are running zenoai from your project root.` Does not block the run.

---

## v0.1.3 (2026-04-14)

**Improved health report output:**

- Risky files rendered as a rich table via `cli-table3` — columns: file path, risk level (colour-coded), legibility score (1–10, colour-coded), consequence
- 3 prioritised suggested actions (ranked highest-value lowest-risk first), each with an action and reason
- "Where to start" recommendation rendered in a boxen callout (yellow border)
- `healthLabel` added to AI response schema: Critical / Concerning / Fair / Good / Excellent, aligned to score bands

**HTML export (`--export` flag):**

- `zenoai --export` — loads last cached report, generates self-contained HTML, auto-opens in browser. No re-run, no API call consumed.
- `zenoai --output path/to/file.html` — custom output path
- Fully self-contained HTML (embedded CSS, dark theme matching terminal, `@media print` for PDF export)
- Reports saved to `reports/zenoai-report-DD-Mon-YYYY-HHmm.html` in the project root

---

## Phase 1: Core Scaffold + Eyeball It (Complete)

**What was built:**

- CLI entry point via `bin/zenoai.js` with manual `.env` loading (bypasses vestauth global npm interceptor that zeroes env vars); then dynamic-imports `dist/index.js`
- Interactive prompts: role (SDE / EM / Architect / QA) and action (Eyeball it / Deep dive / Complexity report)
- Static file analyst (`src/core/analyst.ts`) — walks `process.cwd()`, collects LOC, function count, import count, test file detection per `.ts/.js/.tsx/.jsx` file
- Orchestrator (`src/core/orchestrator.ts`) — wires analyst output to AI provider, parses JSON response, prints formatted terminal report
- Wired route: **SDE → Eyeball it** (all other role/action combos stub out)
- Config flow (`src/config.ts`) — first-run setup, prompts for provider + API key, stores in `~/.zenoai/config.json`

**Multi-provider support:**

| Provider | Model |
|----------|-------|
| Anthropic | `claude-haiku-4-5-20251001` |
| Google Gemini | `gemini-2.5-pro` |
| OpenAI | `gpt-4o` |
| OpenRouter | `deepseek/deepseek-v3.2` |

**Report output (terminal):**

- Health score (1–10) with label (Critical / Concerning / Fair / Good / Excellent) and one-line context
- Risky files table — file path, risk level (colour-coded), legibility score, consequence
- 3 observations tied to actual filenames/patterns
- 3 suggested actions ranked by value/risk
- "Where to start" callout box (boxen, yellow border)
- Colour helpers: `riskColor`, `legibilityColor`, `scoreChalk`

**HTML export (`--export` flag):**

- `zenoai --export` — loads last cached report, generates self-contained HTML, opens in browser automatically. No re-run, no API call.
- `zenoai --output path/to/file.html` — same but custom output path
- Report saved to `reports/zenoai-report-DD-Mon-YYYY-HHmm.html` in the directory where the command is run
- `--output` overrides the default path entirely
- HTML is fully self-contained (embedded CSS, no external deps), dark theme matching terminal, with `@media print` styles for clean PDF export via browser print
- Auto-open: uses `child_process.exec` with platform detection (`open` / `start` / `xdg-open`)

**Report caching:**

- Every successful run saves `~/.zenoai/last-report.json` (report + root path + file count + timestamp)
- `--export` reads from cache — instant, no API call consumed
- If no cache exists, prints: `No report found. Run zenoai first to generate a report.`

**Shared types (`src/types.ts`):**

- `HealthReport`, `RiskyFile`, `SuggestedAction`, `RiskLevel`, `HealthLabel` — shared across orchestrator, htmlExporter, cache

**Known quirks:**

- vestauth (global npm hook) intercepts dotenv and zeroes env vars — solved by loading `.env` with raw `fs.readFileSync` in `bin/zenoai.js` before any module runs
- Run with: `node bin/zenoai.js` from any JS/TS project root; or `npm link` to use `zenoai` globally

---

## Phase 2: Current state

The core Phase 2 pipeline works end to end:

`Preflight -> Analyst -> Planner -> Reviewer -> Validator -> Critic -> Differ -> Approval`

It has been tested on real projects and can produce reviewable human-style diffs on a dedicated `zeno/refactor-...` branch.

**Implemented since Phase 1:**

- SDE actions wired: **Humanise it**, **Slim it down**, **Stress test it**
- EM actions wired back to the read-only health report path: **How bad is it**, **Triage it**
- Recursive branch guard blocks running a new refactor from inside an existing `zeno/` branch
- Dirty tree prompt offers to commit before starting a Zeno run
- Rollback uses `git reset --hard HEAD` before switching branches to avoid leaked files
- Git submodule detection excludes files inside submodules from analysis
- Shared provider-agnostic LLM client for Phase 2
- API key loaded from `~/.zenoai/config.json`
- Reviewer and Validator skip autonomous whole-file refactors over 300 lines
- Shared `extractJson` helper for model JSON responses
- Skipped files are saved to `.zeno-history.json`, including zero-accepted runs
- Post-refactor Critic pass audits extracted helper boundaries before files are written

**Current Phase 2 safety shape:**

- File-writing actions require git preflight
- Zeno creates a `zeno/refactor-...` branch before applying accepted changes
- Planner selects up to 5 files from up to 20 candidates
- Files with too many importers, test/spec paths, declaration files, direct cycles, or prior history are skipped
- Reviewer produces conservative change instructions
- Validator rewrites only accepted files and applies local confidence checks
- Critic reviews helper purity, duplicate caller/callee setup, and behavior parity
- Differ writes accepted files, commits them, prints an accepted/skipped report, and asks before merge

**Still needed before shipping 0.2.0:**

- Test Phase 2 on one more real messy project
- Improve large-file handling without raising the autonomous rewrite limit
- Bump version to `0.2.0`
- Publish to npm
- Document Phase 2 user-facing behavior
