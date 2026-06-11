<p align="center">
  <img src="https://raw.githubusercontent.com/namahsea/zenoai/main/assets/logo_2.png" alt="Zeno" width="400"/>
</p>
<h1 align="center">Drop a Senior Engineer into any codebase. Instantly!</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/zenoai"><img src="https://img.shields.io/npm/v/zenoai?color=50FA7B&label=npm" alt="npm version"/></a>
  <a href="https://www.npmjs.com/package/zenoai"><img src="https://img.shields.io/npm/dm/zenoai?color=BD93F9&label=downloads" alt="downloads"/></a>
  <a href="https://github.com/namahsea/zenoai/blob/master/LICENSE"><img src="https://img.shields.io/github/license/namahsea/zenoai?color=F1FA8C" alt="license"/></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D18-8BE9FD" alt="node"/></a>
  <a href="https://twitter.com/zeno_cli"><img src="https://img.shields.io/badge/Twitter-%40zeno__cli-1DA1F2?logo=twitter&logoColor=white" alt="Twitter"/></a>
</p>

**Zeno** is an AI-powered CLI tool that analyses your JavaScript or TypeScript project and tells you exactly what is messy, what is risky, what is safe to change, and where to start.

⚡ **One command.** No setup. No hand-holding.

🔍 **Plain-English review.** Zeno reads your codebase and returns a practical terminal report.

🛡️ **Safety first.** If Zeno cannot find a safe cleanup target, it refuses instead of forcing a risky change.

🔒 **Your key stays local.** API keys are stored only on your machine.

## 📰 News

- **0.2.0 candidate** 🚀 Outcome-based actions, ship-readiness review, local security scan, safe cleanup gating, large-file splitting
- **2026-04-17** 🚀 Released v0.1.7 — structured JSON report schema, consequence-based risk anchors, directory guards, prompt clarifications
- **2026-04-14** 🚀 Released v0.1.6 — smart file prioritisation, richer metadata signals, single send cap
- **2026-04-14** 🚀 Released v0.1.3 — risk table with legibility scores, suggested actions, HTML export
- **2026-04-12** 🎉 Released v0.1.0 — first public release

## ✨ Key Features

🚢 **Ship-readiness review** — Ask Zeno whether the code is safe to ship and get a clear verdict.

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
2. Pick what you want Zeno to do
3. Zeno scans your JavaScript and TypeScript files locally
4. Zeno chooses the safest path:
   - read-only report
   - local security scan
   - guarded cleanup
   - large-file split
5. Zeno prints a terminal report
6. If files change, Zeno stages them on a zeno branch for review
```

## 📊 Sample Output

```text
━━━  ZENOAI — SHIP READINESS REPORT  ━━━
Project     : my-app
Reviewed by : Engineering Manager
Files       : 24

Is this code safe to ship?
Not yet  [High risk]

Why
  The highest-risk routes touch auth, data writes, or external APIs without visible safety tests.

What is blocking shipment
  1. src/server/auth.ts High
     Session logic is hard to verify and has no nearby test coverage.
  2. src/api/webhooks.ts High
     Webhook behavior can affect production data if verification breaks.

Safest next step
  Add tests around the highest-risk route before refactoring or shipping new behavior.
```

## 🧭 Available Actions

| Action | What it does |
|--------|--------------|
| Tell me if this is safe to ship | Read-only AI-assisted codebase risk report |
| Check for security risks | Local static scan for obvious security signals |
| Make this code easier to work with | Guarded refactor flow for safe cleanup targets |
| Split large files | Local deterministic split for oversized files |

## 🔌 Supported AI Providers

Zeno works with your existing API key. Pick the provider you already have access to:

| Provider | Model | Get a key |
|----------|-------|-----------|
| Anthropic | claude-haiku-4-5-20251001 | [console.anthropic.com](https://console.anthropic.com) |
| Google AI Studio | gemini-2.5-pro | [aistudio.google.com](https://aistudio.google.com) |
| OpenRouter | deepseek/deepseek-v3.2 | [openrouter.ai](https://openrouter.ai) |
| OpenAI | gpt-4o | [platform.openai.com](https://platform.openai.com) |

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
rm ~/.zenoai/config.json
npx zenoai
```

## 🗺️ Roadmap

| Area | Status | Description |
|------|--------|-------------|
| Ship-readiness review | ✅ Live | Read-only risk report with a clear ship/no-ship answer |
| Security check | ✅ Live | Local static scan for obvious security risk signals |
| Safe cleanup | ✅ Live | Guarded refactoring with validation and final boundary review |
| Large-file splitting | ✅ Live | Static extraction for oversized files |
| Test runner wiring | 🔜 Planned | Detect Jest/Vitest/Mocha and run generated tests |
| Smarter splitting | 🔜 Planned | Decompose large files into components, hooks, and modules |
| Hosted access | 🔜 Planned | Use Zeno without bringing your own API key |

## 📦 Changelog

### 0.2.0 candidate
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
