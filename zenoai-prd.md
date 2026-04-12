# Zenoai — Product Requirements Document

**Version:** 0.0.1  
**npm:** `zenoai`  
**Command:** `npx zenoai`  
**Domain:** zenoai.dev  
**Author:** namahc

> Drop a senior engineer into any codebase. Instantly.

---

## Problem

Developers with vibe-coded or rushed projects don't know where the mess is. Reading your own code is slow and biased. Existing AI tools either generate more mess or require too much hand-holding to be useful for cleanup.

## Solution

One command that drops a senior AI engineer into your project. It reads, analyses, and tells you exactly what is wrong, what is risky, and what to fix first. No back and forth. No setup friction.

---

## Target user

Solo developer or small team building with AI (vibe coding). JavaScript or TypeScript project. Uses Git. Knows their codebase is messy but doesn't know how bad it is or where to start.

---

## Personas

| Role | Description | Phase |
|------|-------------|-------|
| SDE | Senior developer lens — focused on code quality, complexity, coupling | 1 |
| EM | Engineering manager lens — focused on risk, health overview, priorities | 2 |

---

## Actions

### SDE

| Action | Description | Phase | Status |
|--------|-------------|-------|--------|
| Eyeball it | Read-only health report. No changes. | 1 | Shipped |
| Humanise it | Rename variables, add comments, improve readability | 2 | Planned |
| Slim it down | Remove dead code, simplify logic | 2 | Planned |
| Stress test it | Generate tests for untested files | 2 | Planned |

### EM

| Action | Description | Phase | Status |
|--------|-------------|-------|--------|
| How bad is it | High-level risk summary | 2 | Planned |
| Triage it | Prioritised list of what to fix first | 2 | Planned |
| What are we dealing with | Full codebase overview report | 2 | Planned |

---

## Agents

| Agent | Responsibility | Phase |
|-------|---------------|-------|
| Analyst | Walks the repo, computes static metrics per file (LOC, functions, imports, coupling, test coverage heuristic), builds compact JSON summary. No LLM involved. | 1 |
| Reviewer | Takes Analyst output, produces a prioritised change plan. Scopes work to safest, highest-value changes first. | 2 |
| Validator | Generates tests before touching anything. Refactors. Re-runs tests. Validates behaviour is unchanged. | 2 |

---

## Model strategy

Dynamic model selection based on codebase complexity score computed by the Analyst. Model routing is invisible to the user.

| Complexity | Score range | Testing phase 1 | Testing phase 2 | Production |
|------------|-------------|-----------------|-----------------|------------|
| Low | 0.0 – 0.4 | Gemini 2.5 Pro (free) | OpenRouter Qwen3 Coder 480B (free) | DeepSeek V3 |
| Medium | 0.4 – 0.7 | Gemini 2.5 Pro (free) | OpenRouter Qwen3 Coder 480B (free) | Gemini 2.5 Pro |
| High | 0.7 – 1.0 | Gemini 2.5 Pro (free) | Anthropic Claude Sonnet | Claude Opus or GPT-4.1 |

In production, Zenoai owns the API keys. Users never configure models or keys. They pay Zenoai; Zenoai handles routing.

---

## Confidence scoring *(Phase 2)*

Every proposed change is scored before being applied. Changes below the threshold are skipped and flagged in the report.

**Default threshold:** 0.70  
**Configurable via:** `zenoai.config.json` or `ZENOAI_CONFIDENCE_THRESHOLD` env var

| Factor | Weight | Notes |
|--------|--------|-------|
| tests_passed | 0.40 | |
| lint_clean | 0.20 | |
| change_size | 0.20 | small=1.0, medium=0.7, large=0.3 |
| no_new_deps | 0.10 | |
| had_existing_tests | 0.10 | |

---

## Safety *(Phase 2)*

- Git snapshot taken before any file writes — user can rollback with one command
- No file writes in Phase 1
- User sees full diff and report before any changes are applied — one approval to proceed

---

## Tech stack

| Layer | Choice |
|-------|--------|
| Language | TypeScript |
| Runtime | Node.js |
| Distribution | npm / npx |
| Prompts | Inquirer |
| Spinner | Ora |
| Current AI SDK | Anthropic SDK (to be swapped to Gemini for testing) |

---

## Roadmap

### Phase 1 — Eyeball it *(in progress, ships this weekend)*

Goal: Prove the pipeline works end to end. Read only. No file changes.

**In scope:**
- CLI entry point with Inquirer prompts
- Analyst agent — static file analysis
- Single Claude/Gemini API call with compact JSON summary
- Formatted terminal health report
- npm publish as `zenoai`

**Not in scope:** file changes, git writes, Reviewer/Validator agents, confidence scoring, EM persona

---

### Phase 2 — Fix it *(planned)*

Goal: Zenoai makes safe, test-guarded changes to the codebase autonomously.

- Reviewer agent — change plan
- Validator agent — tests first, refactor, re-validate
- Git snapshot before any writes
- Confidence scoring gate
- Diff viewer — user approves before apply
- Remaining SDE actions: Humanise it, Slim it down, Stress test it
- EM persona and actions

---

### Phase 3 — Scale it *(planned)*

Goal: Production-grade. Zenoai owns API keys. Users pay Zenoai.

- Backend server — Zenoai owns model routing
- Dynamic model selection based on complexity score
- Free tier and paid tier
- Multi-language support beyond JS/TS
- GitHub Actions integration
- Web dashboard for report history

---

## Test cases

### Technical

**TC-001** — CLI runs inside a JS/TS project and returns a health report *(Phase 1 — Eyeball it)*

Steps:
1. Run `npx zenoai` inside a JS/TS project
2. Select SDE role
3. Select Eyeball it
4. Wait for silent run to complete

Expected: health score (1–10), up to 5 risky files with reasons, 3 observations, one suggested action  
Pass criteria: Report prints to terminal with all four sections populated  
Feedback: `// TODO`

---

**TC-002** — Analyst skips node_modules, dist, .git and files over 300 lines *(Phase 1)*

Steps:
1. Run `npx zenoai` inside a project with node_modules present
2. Check that node_modules files do not appear in the report

Pass criteria: Report contains only src files  
Feedback: `// TODO`

---

**TC-003** — Analyst caps file count at 100 *(Phase 1)*

Steps:
1. Run `npx zenoai` inside a project with more than 100 JS/TS files
2. Check that no more than 100 files are sent to the model

Pass criteria: No API errors, report completes successfully  
Feedback: `// TODO`

---

**TC-004** — Tool completes in under 2 minutes on a medium-sized project *(Phase 1)*

Steps:
1. Run `npx zenoai` on a project with 50–100 files
2. Time the run from start to report

Pass criteria: Run completes in under 120 seconds  
Feedback: `// TODO`

---

**TC-005** — Report is honest and accurate on a known messy project *(Phase 1)*

Steps:
1. Run `npx zenoai` on a project you know is messy
2. Compare risky files listed to your own knowledge of the codebase

Pass criteria: At least 3 of 5 risky files feel accurate  
Feedback: `// TODO`

---

### User experience

**UX-001** — First-time user can install and run without documentation *(Phase 1)*

Tester: Colleague with no context  
Steps: Send only `npx zenoai`. Ask them to run it. Ask what they saw.  
Pass criteria: Colleague gets a report without asking for help  
Feedback: `// TODO`

---

**UX-002** — Report feels accurate and useful to the developer who knows the codebase *(Phase 1)*

Tester: Colleague who owns the project  
Steps: Ask them to run it on their own project. Ask: does this feel accurate? Would you act on the suggested first action?  
Pass criteria: Colleague says report felt accurate and useful  
Feedback: `// TODO`

---

**UX-003** — Report is readable and not overwhelming *(Phase 1)*

Tester: Any colleague  
Steps: Show terminal output. Ask: is this easy to read? Too much or too little?  
Pass criteria: Colleague says it is easy to read and appropriately detailed  
Feedback: `// TODO`

---

## Monetisation *(Phase 3)*

Zenoai owns API keys. Users pay Zenoai.

| Tier | Description |
|------|-------------|
| Free | Eyeball it — limited runs per month on lightweight model |
| Pro | Full access, all actions, complex codebase support, better models |

---

## Competitive positioning

| Tool | Gap vs Zenoai |
|------|--------------|
| CodeRabbit | PR review only, no local CLI, no persona UX |
| Cursor Agent | IDE only, human in the loop, no persona framing |
| Aider | Chat-driven, not pick-and-go, no SDE/EM personas |
| Sweep | GitHub App, not local CLI, issue-driven not cleanup-driven |
| Devin | Hosted, closed, broad — not focused on messy codebase cleanup |

**Differentiators:**
- Local CLI — runs inside your project, no IDE required
- Persona UX — SDE and EM roles with concrete action menus
- Tests-before-refactor as a hard default, not optional
- Confidence gate as a user-visible control
- Silent autonomous run — one approval at the end
- Model agnostic — routes to best model based on complexity

---

## Open questions

| # | Question | Status |
|---|----------|--------|
| 1 | What is the right run limit? | Pending |
| 2 | Which messy project to use as the canonical test case for Sunday? | Pending |
| 3 | Swap Anthropic SDK to Gemini 2.5 Pro for Phase 1 testing | In progress |
