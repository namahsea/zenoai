# Zenoai — Progress

## v0.2.0 beta (2026-06-12)

Zeno v0.2.0 has been merged to `main`, tagged as `v0.2.0`, and published to npm.

This release changes Zeno from a read-only health reporter into a small launch-safety CLI for JavaScript and TypeScript projects.

Current user-facing actions:

- **Tell me if this is safe to ship** — AI-assisted read-only ship-readiness report
- **Check for security risks** — local static scan for obvious security risk signals
- **Make this code easier to work with** — guarded cleanup/refactor flow for safe targets
- **Split large files** — deterministic local split for oversized files

Current model defaults:

| Provider | Model |
|----------|-------|
| Anthropic | `claude-sonnet-4-6` |
| OpenAI | `gpt-5.5` |
| Gemini | `gemini-2.5-pro` |
| OpenRouter | `anthropic/claude-sonnet-4.6` |

OpenAI now uses the Responses API path for `gpt-5.5`. OpenRouter remains on the OpenAI-compatible chat completions path.


## What changed in v0.2.0

**Outcome-based CLI**

- Removed the old role-first UX from the active product flow
- Replaced it with action-based prompts that match user intent
- Kept report attribution through `Reviewed by` labels instead of making the user think in internal personas

**Ship-readiness report**

- New primary read-only action: `Tell me if this is safe to ship`
- Output answers the launch question directly:
  - `Safe to ship`
  - `Ship with caution`
  - `Not yet`
  - `Do not ship`
- Includes why, top blockers, and the safest next step
- Shows AI review transparency before paid model calls:
  - provider
  - model
  - call count

**Security check**

- New local static security scan
- No model call, no branch, no file writes
- Checks obvious risk signals:
  - exposed secrets
  - auth/webhook/payment/cart/order/billing routes
  - missing visible tests around high-impact routes
  - unsafe redirects
  - permissive CORS
  - raw HTML rendering
  - dynamic code execution
  - weak crypto
  - disabled TLS verification
  - risky file/database access
  - client/server boundary leaks
- Report clearly says `Scan type: Local static scan`
- Notes that this is not a full security audit
- Progress bar is used only here and clears before the final report

**Safe cleanup flow**

- `Make this code easier to work with` now refuses low-value or unsafe targets before spending model calls
- Added local gates for:
  - generated files
  - config files
  - framework shells
  - server integration files
  - static presentational UI
  - high-consequence untested routes
  - complex 301-500 line files
- Raised the autonomous single-file limit from 300 to 500 lines with additional complexity checks
- Added a pre-run viability check so Zeno does not ask for paid model approval when it already knows no useful target exists

**Refactor quality**

Pipeline is now:

`Preflight -> Analyst -> Planner -> Reviewer -> Validator -> Critic -> Differ -> Approval`

The Critic pass checks:

- helper purity and hidden dependencies
- duplicated caller/callee boundary work
- behavior parity around identity, mutation timing, memoization, and lifecycle assumptions

**Split large files**

- New `Split large files` action
- Current implementation is deterministic and local
- Starts with the safest split: moving obvious top-level static constants/data into a sibling module
- Validates generated split output before accepting it
- No model call is used for this first-pass split

**Docs and repository cleanup**

- README updated for current product flow
- Old role/action diagram removed from README usage
- Badges cleaned up
- `master` branch deleted from GitHub
- `testing-issue-fix` branch deleted after merge
- `main` is the canonical branch


## Validation done

Tested on real projects:

- Shopify/Remix app
- large visual landing-page style app
- Zeno itself

Smoke-tested provider paths:

- Anthropic direct
- OpenRouter
- OpenAI
- Gemini

Release verification:

- `npm run build` passes
- package version bumped to `0.2.0`
- git tag `v0.2.0` pushed
- npm publish completed


## Self-scan finding

After release, Zeno was run against the Zeno codebase itself.

Result:

`Do not ship [Critical risk]`

The report correctly identified the main product risk:

- zero automated test coverage
- `src/core/orchestrator.ts` is large and central
- `src/core/securityCheck.ts` is important but untested
- `src/core/differ.ts` is important but untested

This does not invalidate the beta release, but it is the clearest next engineering priority.

Zeno is now useful as a beta, but it is not yet a stable 1.0 product.


## Next priorities

### 1. Add test coverage around core safety logic

Start with deterministic/local modules:

- `src/core/securityCheck.ts`
- `src/core/refactorGate.ts`
- `src/core/refactorViability.ts`
- `src/core/refactorScoring.ts`
- `src/core/differ.ts`
- `src/core/splitter.ts`

Goal:

- catch false positives/false negatives
- protect the product's safety claims
- make future refactors less risky

### 2. Break down `orchestrator.ts`

`orchestrator.ts` currently coordinates too much:

- read-only report flow
- security flow routing
- Phase 2 refactor flow
- split flow
- terminal report printing
- AI call handling

Suggested direction:

- `shipReadiness.ts`
- `refactorFlow.ts`
- `splitFlow.ts`
- `reportPrinters.ts`
- `aiReview.ts`

Keep behavior stable while extracting.

### 3. Test runner wiring

Zeno should detect and run project tests after accepted refactors.

Targets:

- Jest
- Vitest
- Mocha
- npm test fallback

This should become the main confidence signal for accepted refactors.

### 4. Smarter split large files

Current split only extracts static data.

Next version should support:

- component extraction
- hook extraction
- pure helper extraction
- server/action helper extraction
- import path validation
- TypeScript parse validation

### 5. Model evaluation harness

Create a small Zeno benchmark for model defaults:

- ship-readiness JSON validity
- risk ranking accuracy
- skip correctness
- refactor restraint
- boundary quality
- behavior preservation
- cost/speed

This is especially important before adding cheaper OpenRouter/Kimi-style modes.


## Historical notes

### v0.1.7

- Structured JSON report schema
- Consequence-based risk anchors
- Directory guards
- Prompt clarifications
- Markdown fence stripping before JSON parse
- Post-analysis guards for zero files, generated-only results, unreadable files, and large codebases

### v0.1.6

- Recursive directory walking fixed
- `.d.ts` / `.d.tsx` files excluded as auto-generated
- Added export/log metadata signals
- Smart prioritisation by `lineCount x functionCount`
- Single `MAX_SEND = 50` cap
- Transparency log for skipped files

### v0.1.3

- Risk table with legibility scores
- Suggested actions
- HTML export

### v0.1.0

- First public read-only codebase health report
