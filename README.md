# Zeno

**Drop a senior engineer into any codebase. Instantly.**

Zeno is an AI-powered CLI tool that analyses your JavaScript or TypeScript project and tells you exactly what is messy, what is risky, and where to start. One command. No setup. No hand-holding.

Built for developers who vibe-code fast and need to understand what they've built.

---

## Install

```bash
npx zenoai
```

No global install needed. Just run it inside any JS/TS project.

---

## How it works

1. Run `npx zenoai` inside your project
2. Pick your AI provider and enter your API key (stored locally, never shared)
3. Select your role: **SDE**
4. Select your action: **Eyeball it**
5. Zeno reads your codebase silently
6. Returns a plain-English health report in under 2 minutes

---

## What you get

```
━━━  ZENO — CODEBASE HEALTH REPORT  ━━━

Health Score: 4/10

Top risky files:
  src/auth/index.ts      — handles auth, DB calls, and session logic in one file
  src/api/routes.ts      — 14 functions, no test file, c/utils/helpers.ts   — 312 lines, mixed concerns, imported everywhere

Observations:
  1. Auth and database logic are tangled — high risk if either changes
  2. 60% of your files have no test coverage
  3. Your utility layer is doing too much

Suggested first action: Split src/auth/index.ts into auth.ts and db.ts
```

---

## Supported AI providers

Zeno works with your existing API key. Pick the provider you already have access to:

| Provider | Model used |
|----------|-----------|
| Anthropic | claude-haiku-4-5-20251001 |
| Google AI Studio (Gemini) | gemini-2.5-pro |
| OpenRouter | deepseek/deepseek-v3.2 |
| OpenAI | gpt-4o |

Your key is saved locally to `~/.zenoai/config.json` on first run. It never leaves your machine.

---

## Requirements

- Node.js 18 or higher
- A JavaScript or TypeScript project
- An API key from any supported provider

---

## Reset your API key

```bash
rm ~/.zenoai/config.json
npx zenoai
```

---

## Roadmap

- **Phase 1 (now)** — Eyeball it: read-only health report
- **Phase 2** — Fix it: autonomous refactoring with tests-first safety
- **Phase 3** — Scale it: no API key needed, Zeno handles everything

---

## License

MIT © namahc
