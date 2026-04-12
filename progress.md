# Zenoai — Progress

## Phase 1: Core Scaffold + Eyeball It (Complete)

**What was built:**

- CLI entry point via `bin/zenoai.js` with manual `.env` loading (bypasses vestauth global interceptor)
- Interactive prompts: role (SDE / EM / Architect / QA) and action (Eyeball it / Deep dive / Complexity report)
- Static file analyst (`src/core/analyst.ts`) — walks `process.cwd()`, collects LOC, function count, import count, test file detection per `.ts/.js/.tsx/.jsx` file
- Orchestrator (`src/core/orchestrator.ts`) — wires analyst output to Claude API, parses JSON response, prints formatted terminal report
- Wired route: **SDE → Eyeball it** (all other role/action combos stub out)

**Stack:**

- TypeScript (ESM, NodeNext), `@anthropic-ai/sdk`, `@inquirer/prompts`, `chalk`
- Model: `claude-haiku-4-5-20251001`, max_tokens: 1024
- Response shape: `{ healthScore, topRiskyFiles, observations }`

**Known quirks:**

- vestauth (global npm hook) intercepts dotenv and zeroes env vars — solved by loading `.env` with raw `fs.readFileSync` in `bin/zenoai.js` before any module runs
- Run with: `node bin/zenoai.js` from any JS/TS project root

---

## Phase 2: Planned

- Wire remaining actions for SDE: **Deep dive**, **Complexity report**
- Wire remaining roles: **EM**, **Architect**, **QA** (each with tailored system prompts and report formats)
- Possibly: `npm link` / publish flow so end users run `zenoai` globally
