# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

`zenoai` (distributed as `zenoai`) is a CLI tool that runs inside any JS/TS project and produces an AI-powered codebase health report. It uses static analysis + a single Claude API call to assess code quality without touching any files.

Run from *any JS/TS project directory* — `process.cwd()` is the target project being analysed, not this repo's own directory.

## Commands

```bash
npm run build          # tsc → compiles src/ to dist/
npm run dev            # tsx src/index.ts — runs from source without building
node bin/zenoai.js   # runs the compiled CLI from any project directory
npm run run:env        # loads .env then runs compiled CLI
```

There are no tests and no linter configured yet.

## Architecture

```
bin/zenoai.js          — CLI entry; manually loads .env with fs.readFileSync before
                           any module runs (workaround for vestauth global npm interceptor
                           that zeroes env vars); then dynamic-imports dist/index.js
src/index.ts             — interactive prompts (role + action) via @inquirer/prompts,
                           then calls runOrchestrator()
src/core/orchestrator.ts — routes role/action combos; SDE→"Eyeball it" is the only
                           wired path; calls analyst then Claude API; parses + prints report
src/core/analyst.ts      — walks process.cwd() collecting FileReport per .ts/.js/.tsx/.jsx
                           file (skips node_modules, dist, .git, .next, coverage, out, build;
                           skips files >300 lines; caps at 100 files); two-pass: first
                           collects all paths for test-file detection, then reads each file
```

Data flow: `analyst` → compact JSON (≤30 files sent) → Claude `claude-haiku-4-5-20251001` → parsed `HealthReport` JSON → `printReport()`

## Key constraints

- **ESM throughout** — `"type": "module"` in package.json, `NodeNext` module resolution. All internal imports must use `.js` extensions even when importing `.ts` source files.
- **`.env` loading** — `ANTHROPIC_API_KEY` must be in a `.env` file in the directory where `node bin/zenoai.js` is run (i.e., the target project root). Shell env also works.
- **Only SDE → "Eyeball it" is implemented** — all other role/action combinations hit a stub and exit. The `progress.md` tracks what's planned for Phase 2.
- **Claude response shape**: `{ healthScore: number, topRiskyFiles: [{ filename, oneLineReason }], observations: string[] }` — orchestrator strips markdown code fences before JSON.parse.
