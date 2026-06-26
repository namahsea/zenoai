# Zenoai — Progress

## Current branch progress (2026-06-27)

Branch: `add-devtool-ship-readiness`

Zeno's ship-readiness flow has moved from a general AI review into a project-aware launch-readiness system with deterministic evidence, bounded terminal output, and local full reports.

### Ship-readiness V1

- Added deterministic ship-readiness scanning in `src/core/shipReadinessScan.ts`
- Added per-issue certainty:
  - `confirmed`
  - `likely`
  - `needs_verification`
  - `inferred`
- Split findings into:
  - hard blockers
  - soft blockers
  - code ownership risks
- Downgraded metadata, analytics, robots/sitemap, mobile performance, and missing tests so they do not incorrectly outrank broken primary launch paths
- Added clear `Can ship?` guidance for:
  - private preview
  - public launch
  - paid traffic
- Updated guidance so Zeno recommends wiring the launch path before refactoring

### Project-aware reviews

- Added project-type detection with confidence scoring and saved local project config
- Supported project types:
  - landing page
  - SaaS app
  - dashboard
  - devtool
  - backend/API
  - docs site
  - ecommerce
  - unknown
- Added smart confirmation:
  - high-confidence projects continue without asking
  - medium/low-confidence projects ask the user
  - saved project type is reused on later runs
  - strong conflicting signals can trigger confirmation again

### Landing-page readiness

- Added primary action-flow detection
- Detects email/waitlist/preorder capture risk separately from generic CTA behavior
- Flags likely unwired capture flows when email inputs/state/copy exist but no backend, API route, server action, database, webhook, CRM, or email platform is found
- Keeps suspicious CTA behavior as a separate `High [Needs verification]` issue
- Preserves softer treatment for metadata, analytics, SEO files, tests, and ownership risks

### Devtool readiness

- Added devtool-specific checks for CLI launch paths:
  - package `bin`
  - missing bin targets
  - documented install command mismatch
  - risky filesystem writes
  - CLI error handling
  - config validation
- Added devtool fixture coverage for good and bad CLI packages
- Adjusted runtime language for devtools:
  - use `Node runtime/browser API risk`
  - avoid SSR/hydration wording for devtool projects
  - only flag browser globals when actual scanned project code uses `window`, `document`, or `navigator`

### SaaS and dashboard readiness

- Added SaaS/dashboard-specific checks for:
  - auth flow verification
  - protected route verification
  - data write validation/error handling
  - required environment variable validation
  - billing/webhook verification
  - dashboard loading/error/empty states
  - destructive action confirmation
- Added fixtures for:
  - `saas-good`
  - `saas-bad`
  - `dashboard-bad`
- Kept landing-page and devtool findings isolated so project-specific issues do not bleed into unrelated project types

### Reliable terminal reporting

- Reworked ship-readiness output into a bounded terminal report
- Added issue summary and top issues tables
- Limited terminal output to the most important findings while saving the full report locally
- Added JSON parse retry for malformed or truncated AI output
- Added deterministic fallback output instead of dumping raw malformed JSON
- Fixed extra issue-count formatting and pluralization
- Shortened top issue labels while keeping full details in sections below

### Local reports

- Full ship-readiness reports now save to `.zeno/reports/`
- JSON reports remain the source of record
- HTML reports are generated next to JSON reports for local viewing
- CSV issue export is generated for the local report
- Terminal output prints:
  - JSON path
  - HTML path
  - clickable `file://` URL
  - platform-specific manual open command
- Users are asked before opening the local HTML report in the browser
- Added report helpers for listing and opening saved reports where supported

### CLI UX

- Replaced the main action selector with a numbered prompt
- Users can now select actions with either:
  - arrow keys plus Enter
  - direct number shortcuts `1`, `2`, `3`, `4`
- The menu now matches coding-agent muscle memory while preserving the existing interactive flow

### Current positioning

Suggested landing-page hero:

`Zeno is a ship-readiness copilot for vibe-coded apps.`

Suggested support copy:

`Zeno traces critical user flows, detects launch blockers, and turns repository evidence into a clear ship/no-ship verdict before users find what is broken.`

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
