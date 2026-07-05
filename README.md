<p align="center">
  <img src="https://raw.githubusercontent.com/namahsea/zenoai/main/assets/logo_2.png" alt="Zeno" width="400"/>
</p>
<h1 align="center">Ship-readiness for vibe-coded apps.</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/zenoai"><img src="https://img.shields.io/npm/v/zenoai?color=50FA7B&label=npm" alt="npm version"/></a>
  <a href="https://www.npmjs.com/package/zenoai"><img src="https://img.shields.io/npm/dm/zenoai?color=BD93F9&label=downloads" alt="downloads"/></a>
  <a href="https://github.com/namahsea/zenoai/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-F1FA8C" alt="license"/></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D18-8BE9FD" alt="node"/></a>
  <a href="https://twitter.com/zeno_cli"><img src="https://img.shields.io/badge/Twitter-%40zeno__cli-1DA1F2?logo=twitter&logoColor=white" alt="Twitter"/></a>
</p>

> [!IMPORTANT]
> **Zeno is currently in a public testing phase.** Results may include false positives or miss project-specific risks. Review its findings and any proposed code changes before relying on them in production.

**Zeno** is a ship-readiness copilot for vibe-coded JavaScript and TypeScript apps. It traces critical user flows, finds launch blockers, and turns repository evidence into a clear ship/no-ship verdict.

⚡ **One command.** No setup. No hand-holding.

🔍 **Evidence-backed review.** Zeno reads your codebase and returns a bounded terminal report plus a full local report.

🛡️ **Launch-path first.** Zeno separates broken primary flows from polish, metadata, analytics, and refactor work.

🔒 **Your key stays local.** API keys are stored only on your machine.


## 📰 News

- **2026-06-27** Released v0.3.0 — project-aware ship-readiness, landing-page/devtool/SaaS/dashboard checks, local full reports, numbered action menu
- **2026-06-12** Released v0.2.0 beta — outcome-based actions, ship-readiness review, local security scan, safe cleanup gating, large-file splitting
- **2026-04-17** Released v0.1.7 — structured JSON report schema, consequence-based risk anchors, directory guards, prompt clarifications
- **2026-04-14** Released v0.1.6 — smart file prioritisation, richer metadata signals, single send cap
- **2026-04-14** Released v0.1.3 — risk table with legibility scores, suggested actions, HTML export
- **2026-04-12** Released v0.1.0 — first public release


## ✨ Key Features

🚢 **Project-aware ship-readiness** — Ask Zeno whether the code is safe to ship and get a clear verdict.

🧭 **Critical path detection** — Zeno checks whether the primary user action can actually complete.

🧱 **Vertical-specific checks** — Landing pages, devtools, SaaS apps, and dashboards get different launch-readiness rubrics.

📄 **Local full reports** — Zeno saves JSON and HTML reports in `.zeno/reports/` for deeper review.

🔐 **Security risk check** — Run a local static scan for obvious security risk signals before launch.

🧹 **Safe cleanup** — Zeno cleans up files only when the change is low-risk and useful.

✂️ **Large-file splitting** — Zeno can split oversized files by extracting obvious static data into a sibling module.

🔌 **Model agnostic** — Works with Anthropic, Gemini, OpenRouter, or OpenAI.

🛠️ **Zero config** — No config files, no IDE plugins, no setup. Just `npx zenoai`.


## 🚀 Quick Start

```bash
npx zenoai
```

No global install needed. Run it inside any JS/TS project.


## 🔄 How It Works

```text
1. Run `npx zenoai`
2. Pick what you want Zeno to do with arrows or number shortcuts
3. Zeno scans your JavaScript and TypeScript files locally
4. Zeno detects the project type and chooses the right review path:
   - landing page
   - SaaS app
   - dashboard
   - devtool
   - backend/API
   - docs site
   - ecommerce
5. Zeno chooses the safest action:
   - read-only report
   - local security scan
   - guarded cleanup
   - large-file split
6. Zeno prints a concise terminal report
7. For ship-readiness, Zeno also saves the full local report
8. If files change, Zeno stages them on a zeno branch for review
```


## 📊 Sample Output

```text
💎 Zeno v0.3.0
Code that works is not the same as code that lasts.

✔ What do you want Zeno to do for my-app?
❯ 1. Tell me if this is safe to ship
  2. Make this code easier to work with
  3. Split large files
  4. Check for security risks

Use ↑/↓ and Enter, or press 1-4.

✔ Detected project type: Landing page [High confidence]
  Signals: email capture, CTA copy, single public route

━━━  ZENOAI — SHIP READINESS REPORT  ━━━
Verdict     : Not yet [High risk]
Confidence  : High
Project type: landing_page [High confidence]

Founder summary
Your landing page has a waitlist capture flow that appears unwired.
Users may think they joined, but no backend, API route, CRM, webhook,
or email platform was detected.

Issue summary

Category              Found   Showing
Hard blockers         2       2
Soft blockers         4       3
Code ownership risks  3       3

Top issues

Category   Severity   Certainty             Issue
Hard       High       Likely                Capture flow unwired
Hard       High       Needs verification    CTA needs verification
Soft       Medium     Confirmed             Missing social metadata

Can ship?
Private preview: Maybe, after manually verifying the primary action flow.
Public launch: No, not until capture and CTAs are wired.
Paid traffic: No, not until CTAs/capture and analytics are wired.

Safest next step
Verify and wire the primary action flow first. Do not refactor before the launch path works.

Full report saved:
JSON: .zeno/reports/ship-readiness-2026-06-27-01-01.json
HTML: .zeno/reports/ship-readiness-2026-06-27-01-01.html
```


## 🧭 Available Actions

| Action | What it does |
|--------|--------------|
| Tell me if this is safe to ship | Project-aware launch-readiness report |
| Check for security risks | Local static scan for obvious security signals |
| Make this code easier to work with | Guarded refactor flow for safe cleanup targets |
| Split large files | Local deterministic split for oversized files |

The main menu supports both arrow-key navigation and direct number shortcuts.


## 🚢 Ship-Readiness Checks

Zeno detects the project type and adjusts the rubric.

| Project type | What Zeno prioritizes |
|--------------|------------------------|
| Landing page | Capture forms, CTA navigation, metadata, analytics, performance, ownership risks |
| Devtool | CLI bin entrypoint, install command accuracy, file write safety, config validation |
| SaaS app | Auth flow, protected routes, data writes, env validation, billing/webhooks |
| Dashboard | Data loading, loading/error/empty states, protected routes, destructive actions |

Zeno separates launch blockers from softer polish:

| Category | Meaning |
|----------|---------|
| Hard blockers | Primary user flows or production paths that may fail |
| Soft blockers | Important launch polish or observability gaps |
| Code ownership risks | Maintainability risks that should not outrank the launch path |

Each finding includes certainty:

`Confirmed`, `Likely`, `Needs verification`, or `Inferred`.

Known limitation: Zeno can detect that static HTML loads external JavaScript, but it does not yet correlate CSS selectors across HTML and JavaScript files. CTA wiring in external JavaScript is reported as a soft manual-verification item rather than a launch blocker. Cross-file selector correlation is planned for v0.3.2.


## 📁 Local Reports

Ship-readiness runs save full local reports:

```text
.zeno/reports/ship-readiness-YYYY-MM-DD-HH-mm.json
.zeno/reports/ship-readiness-YYYY-MM-DD-HH-mm.html
```

The terminal shows a clickable `file://` link where supported and asks before opening the report in your browser.


## 🔌 Supported AI Providers

Zeno works with your existing API key. Pick the provider you already have access to:

| Provider | Model | Get a key |
|----------|-------|-----------|
| Anthropic | claude-sonnet-4-6 | [console.anthropic.com](https://console.anthropic.com) |
| Google AI Studio | gemini-2.5-pro | [aistudio.google.com](https://aistudio.google.com) |
| OpenRouter | anthropic/claude-sonnet-4.6 | [openrouter.ai](https://openrouter.ai) |
| OpenAI | gpt-5.5 | [platform.openai.com](https://platform.openai.com) |

Your key is saved to `~/.zenoai/config.json` on first run.


## 🔒 Privacy

- Zeno scans your project locally before choosing what to do.
- Security checks and first-pass large-file splits are local static operations.
- Read-only reports send a compact structural summary to your selected AI provider.
- Refactor actions may send selected file content to your selected AI provider so Zeno can propose changes.
- API keys are stored only in `~/.zenoai/config.json`.


## 📋 Requirements

- Node.js 18 or higher
- A JavaScript or TypeScript project
- An API key from any supported provider


## 🔁 Reset Your API Key

```bash
npx zenoai reset
npx zenoai
```


## 🆘 Help & Maintenance

```bash
npx zenoai help
```

| Command | What it does |
|---------|--------------|
| `npx zenoai` | Run Zeno in the current project |
| `npx zenoai help` | Show available commands |
| `npx zenoai reset` | Remove saved API provider/key |
| `npx zenoai reset-history` | Remove this project's `.zeno-history.json` |
| `npx zenoai clear-report` | Remove cached last report |
| `npx zenoai --export` | Export cached report as HTML |
| `npx zenoai report list` | List saved local ship-readiness reports |
| `npx zenoai report open latest` | Open the latest local report |


## 🗺️ Roadmap

| Area | Status | Description |
|------|--------|-------------|
| Project-aware ship-readiness | ✅ Live | Read-only risk report with a clear ship/no-ship answer |
| Landing-page readiness | ✅ Live | Capture flow and CTA launch-path checks |
| Devtool readiness | ✅ Live | CLI bin, install command, config, and file-write checks |
| SaaS/dashboard readiness | ✅ Live | Auth, protected route, data write, billing, and dashboard-state checks |
| Local reports | ✅ Live | JSON and HTML reports saved locally |
| Security check | ✅ Live | Local static scan for obvious security risk signals |
| Safe cleanup | ✅ Live | Guarded refactoring with validation and final boundary review |
| Large-file splitting | ✅ Live | Static extraction for oversized files |
| Cross-file CTA correlation | 🔜 v0.3.2 | Correlate HTML selectors with event handlers in external JavaScript |
| Test runner wiring | 🔜 Planned | Detect Jest/Vitest/Mocha and run generated tests |
| Smarter splitting | 🔜 Planned | Decompose large files into components, hooks, and modules |
| Hosted access | 🔜 Planned | Use Zeno without bringing your own API key |


## 📦 Changelog

### v0.3.0
- Project-type detection with confidence scoring
- Saved project type in local Zeno project config
- Landing-page action-flow checks for waitlist/email/preorder capture and CTA behavior
- Devtool checks for CLI bin targets, install command mismatch, filesystem write safety, error handling, and config validation
- SaaS/dashboard checks for auth, protected routes, data writes, env validation, billing/webhooks, dashboard states, and destructive actions
- Bounded ship-readiness terminal output with issue summary and top issues tables
- Full local JSON and HTML reports saved to `.zeno/reports/`
- JSON parse retry and deterministic fallback when AI output formatting fails
- Numbered main action menu with direct `1-4` shortcuts


### v0.2.0 beta
- Outcome-based action menu
- Ship-readiness report
- Local static security check
- Guarded cleanup with pre-run viability checks
- Large-file splitting for static data extraction
- Post-refactor Critic pass after Validator
- Local gates for generated files, config files, framework shells, static UI, and high-consequence untested routes
- Cleaner terminal progress and report output


### v0.1.7
- Structured JSON report schema
- Consequence-based risk anchors in system prompt
- "Where to start" anchored to highest-consequence action
- Markdown fence stripping before JSON parse
- Directory guards for unsafe working directories
- Post-analysis guards for zero files, generated-only results, unreadable files, and large codebases


### v0.1.6
- Recursive directory walking fixed
- `.d.ts` / `.d.tsx` files excluded as auto-generated
- Two new metadata signals — `exportCount` and `hasConsoleLog`
- Smart prioritisation by `lineCount x functionCount`
- Single `MAX_SEND = 50` cap
- Full transparency log for skipped files

---


## 📄 License

MIT © [namahc](https://github.com/namahsea)
