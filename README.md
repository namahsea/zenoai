<p align="center">
  <img src="https://raw.githubusercontent.com/namahsea/zenoai/master/assets/logo.png" alt="Zeno" width="400"/>
</p>

<h3 align="center">Drop a senior engineer into any codebase. Instantly.</h3>

<p align="center">
  <a href="https://www.npmjs.com/package/zenoai"><img src="https://img.shields.io/npm/v/zenoai?color=00BFFF&label=npm" alt="npm version"/></a>
  <a href="https://www.npmjs.com/package/zenoai"><img src="https://img.shields.io/npm/dm/zenoai?color=00BFFF&label=downloads" alt="downloads"/></a>
  <a href="https://github.com/namahsea/zenoai/blob/master/LICENSE"><img src="https://img.shields.io/github/license/namahsea/zenoai?color=00BFFF" alt="license"/></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D18-00BFFF" alt="node"/></a>
</p>

---

**Zeno** is an AI-powered CLI tool that analyses your JavaScript or TypeScript project and tells you exactly what is messy, what is risky, and where to start.

⚡ **One command.** No setup. No hand-holding.

🔍 **Silent run.** Zeno reads your codebase autonomously and returns a plain-English health report in under 2 minutes.

🔒 **Your key stays local.** API keys are stored only on your machine — never sent to our servers.

---

## 📰 News

- **2026-04-14** 🚀 Released v0.1.4 — recursive file walking fix, symlink support, low-file-count warning
- **2026-04-14** 🚀 Released v0.1.3 — risk table with legibility scores, suggested actions, HTML export
- **2026-04-13** 🚀 Released v0.1.2 — ASCII banner, human-readable errors
- **2026-04-13** 🚀 Released v0.1.1 — multi-provider support (Anthropic, Gemini, OpenRouter, OpenAI)
- **2026-04-12** 🎉 Released v0.1.0 — first public release, SDE persona, Eyeball it action

---

## ✨ Key Features

🧠 **Persona-driven** — Choose the SDE lens for code quality and complexity analysis

⚡ **Lightning fast** — Static analysis runs locally, one AI call returns the full report

🔌 **Model agnostic** — Works with Anthropic, Gemini, OpenRouter, or OpenAI

🔒 **Privacy first** — Your code never leaves your machine. Only a compact structural summary is sent to the AI

🛠️ **Zero config** — No config files, no IDE plugins, no setup. Just `npx zenoai`

---

## 🚀 Quick Start

```bash
npx zenoai
```

No global install needed. Just run it inside any JS/TS project.

---

## 🔄 How it works

<p align="center">
  <img src="https://raw.githubusercontent.com/namahsea/zenoai/master/assets/Zeno-analysis-1.png" alt="How Zeno works" width="700"/>
</p>

---

## 📊 Sample output

```
━━━  ZENO — CODEBASE HEALTH REPORT  ━━━

Health Score: 4/10

Top risky files:
  src/auth/index.ts      — handles auth, DB calls, and session logic in one file
  src/api/routes.ts      — 14 functions, no test file, high coupling
  src/utils/helpers.ts   — 312 lines, mixed concerns, imported everywhere

Observations:
  1. Auth and database logic are tangled — high risk if either changes
  2. 60% of your files have no test coverage
  3. Your utility layer is doing too much
```

---

## 🔌 Supported AI providers

Zeno works with your existing API key. Pick the provider you already have access to:

| Provider | Model | Get a key |
|----------|-------|-----------|
| Anthropic | claude-haiku-4-5-20251001 | [console.anthropic.com](https://console.anthropic.com) |
| Google AI Studio | gemini-2.5-pro | [aistudio.google.com](https://aistudio.google.com) |
| OpenRouter | deepseek/deepseek-v3.2 | [openrouter.ai](https://openrouter.ai) |
| OpenAI | gpt-4o | [platform.openai.com](https://platform.openai.com) |

Your key is saved to `~/.zenoai/config.json` on first run. It never leaves your machine.

---

## 📋 Requirements

- Node.js 18 or higher
- A JavaScript or TypeScript project
- An API key from any supported provider

---

## 🔁 Reset your API key

```bash
rm ~/.zenoai/config.json
npx zenoai
```

---

## 🗺️ Roadmap

| Phase | Status | Description |
|-------|--------|-------------|
| Phase 1 — Eyeball it | ✅ Live | Read-only codebase health report |
| Phase 2 — Fix it | 🔄 Coming soon | Autonomous refactoring with tests-first safety |
| Phase 3 — Scale it | 🔜 Planned | No API key needed, Zeno handles everything |

---

## 📄 License

MIT © [namahc](https://github.com/namahsea)
