import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import chalk from 'chalk';
import Table from 'cli-table3';
import boxen from 'boxen';
import ora from 'ora';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, basename, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { analyse } from './analyst.js';
import { saveReport } from './cache.js';
import { runPreflight, rollback } from './preflight.js';
import { runPlanner } from './planner.js';
import { runReviewer } from './reviewer.js';
import { runValidator } from './validator.js';
import type { ValidatorResult } from './validator.js';
import { runCritic } from './critic.js';
import { runLargeFileAdvisor } from './largeFileAdvisor.js';
import { runPrePlannerGate, runRefactorGate } from './refactorGate.js';
import { confirm, select } from '@inquirer/prompts';
import { runDiffer } from './differ.js';
import { runStaticSplit } from './splitter.js';
import { runSecurityCheck } from './securityCheck.js';
import { getPrimaryFlowVerdictCap, runShipReadinessScan } from './shipReadinessScan.js';
import type { LaunchFinding, ShipReadinessScan } from './shipReadinessScan.js';
import { manualOpenCommand, openFileInBrowser } from './localReportViewer.js';
import { ZENO_MODELS } from './models.js';
import type { ZenoConfig } from '../config.js';
import type { HealthReport, RiskLevel, HealthLabel, ProjectType } from '../types.js';
import { classifySelectedFiles } from './refactorViability.js';
import { MAX_AUTONOMOUS_REFACTOR_LINES } from './refactorLimits.js';
import { healthTone, riskTone, theme } from './theme.js';

export interface RunOptions {
  role: string;
  action: string;
  config: ZenoConfig;
}

const SYSTEM_PROMPT = `You are a senior software engineer performing a rigorous codebase health review. You will receive a structural summary of project files. Return ONLY a valid JSON object — no markdown, no backticks, no preamble — with exactly this structure:

{
  "score": <integer 1–10>,
  "label": <one of: "Critical" | "Concerning" | "Fair" | "Good">,
  "summary": <one sentence describing the overall codebase health>,
  "files": [
    {
      "path": <relative file path>,
      "risk": <one of: "Critical" | "High" | "Medium" | "Low">,
      "legibility": <integer 1–10>,
      "consequence": <one plain-English sentence: what actually breaks or becomes dangerous>
    }
  ],
  "observations": [
    <observation one>,
    <observation two>,
    <observation three>
  ],
  "actions": [
    {
      "instruction": <what to do>,
      "rationale": <why this gives the highest value at lowest risk>
    }
  ],
  "start": <one sentence — the single most important place to begin>
}

Rules:
- score must be an integer between 1 and 10.
- label must match score exactly: 1–3 → Critical, 4–5 → Concerning, 6–7 → Fair, 8–10 → Good.
- files must contain between 1 and 5 entries, ordered by risk descending. Do not invent files to reach a minimum count.
- observations must contain exactly 3 items, referencing actual filenames or patterns from the provided files.
- actions must contain exactly 3 items, ranked highest-value lowest-risk first.
- Return only the JSON object. No markdown fences, no backticks, no explanation.
- Risk levels must reflect what can break if this code is changed, not how unattractive the file looks:
  - Critical: reserve for auth bypass, payment failure, data loss, security exposure, irreversible writes, production outage, or similarly severe user/business impact.
  - High: important user-facing flows, external APIs, email/webhooks, environment secrets, form submission, or business logic where failure reaches users but is usually reversible.
  - Medium: complex, large, or hard-to-maintain code where failure is localized, recoverable, or easy to detect.
  - Low: isolated, presentational, cosmetic, or straightforward code with low behavioral consequence.
  Do not assign Critical for file size, lack of tests, browser APIs, missing exports, or general messiness alone. Those can raise maintainability risk, but Critical requires severe consequence.
- Treat Zeno as a refactor judgment system, not a generic code generator. Recommended actions should identify the smallest safe improvement, not broad rewrites.
- Suggested actions should prefer bounded changes such as adding tests, extracting pure helpers, isolating validation, or naming risky boundaries. Avoid recommending large rewrites unless the provided summary makes them clearly safer than incremental work.
- When a file has risky behavior, mention boundaries that should not be touched in the action or rationale, such as auth checks, webhook verification, mutation order, environment variable names, retry behavior, response status behavior, or permission checks.
- It is acceptable to recommend skipping a file when a refactor would be mostly cosmetic or the safe next step is tests/observability instead of code movement.
- The "start" field must always recommend the highest-consequence safe next step, not the easiest one. Prioritise tests or small protective changes around payments, auth, data writes, webhooks, external APIs, environment secrets, and critical user flows. Never recommend logging cleanup or formatting changes when untested business logic exists.`;

const SHIP_READINESS_PROMPT = `You are Zeno, a launch-readiness and code-ownership reviewer for JavaScript and TypeScript projects, especially AI-generated or vibe-coded apps.

You will receive:
1. compact file metadata, and
2. a deterministic ship-readiness scan with repo facts.

Return ONLY a valid JSON object. No markdown, no backticks, no preamble.

Use exactly this structure:

{
  "score": <integer 1-10>,
  "label": <one of: "Critical" | "Concerning" | "Fair" | "Good">,
  "summary": <one sentence>,
  "reviewIntent": "ship_readiness",
  "projectType": <one of: "landing_page" | "saas_app" | "dashboard" | "devtool" | "backend_api" | "docs_site" | "ecommerce" | "unknown">,
  "confidence": <one of: "High" | "Medium" | "Low">,
  "founderSummary": <2-3 plain-English sentences for a founder>,
  "hardBlockers": [
    {
      "issue": <specific problem>,
      "evidence": <specific scan evidence or file reference>,
      "risk": <what breaks for real users or production>,
      "suggestedFix": <smallest practical fix>,
      "severity": <one of: "Critical" | "High" | "Medium" | "Low">,
      "certainty": <one of: "confirmed" | "likely" | "needs_verification" | "inferred">
    }
  ],
  "softBlockers": [
    {
      "issue": <specific problem>,
      "evidence": <specific scan evidence or file reference>,
      "risk": <launch quality risk>,
      "suggestedFix": <smallest practical fix>,
      "severity": <one of: "Critical" | "High" | "Medium" | "Low">,
      "certainty": <one of: "confirmed" | "likely" | "needs_verification" | "inferred">
    }
  ],
  "codeOwnershipRisks": [
    {
      "issue": <specific maintainability risk>,
      "evidence": <specific scan evidence or file reference>,
      "risk": <why future changes become risky>,
      "suggestedFix": <smallest practical fix>,
      "severity": <one of: "Critical" | "High" | "Medium" | "Low">,
      "certainty": <one of: "confirmed" | "likely" | "needs_verification" | "inferred">
    }
  ],
  "evidence": [
    <short evidence bullet>
  ],
  "privatePreview": { "answer": <"Yes" | "Maybe" | "No">, "reason": <one sentence> },
  "publicLaunch": { "answer": <"Yes" | "Maybe" | "No">, "reason": <one sentence> },
  "paidTraffic": { "answer": <"Yes" | "Maybe" | "No">, "reason": <one sentence> },
  "safestNextStep": <single safest next step>
}

Rules:
- The review is about launch readiness first, code health second.
- Allowed top-level keys are exactly: score, label, summary, reviewIntent, projectType, confidence, founderSummary, hardBlockers, softBlockers, codeOwnershipRisks, evidence, privatePreview, publicLaunch, paidTraffic, safestNextStep.
- Do not return extra top-level keys. Do not return files, observations, actions, start, notes, markdown, commentary, or raw analysis.
- Keep the response bounded: max 3 hardBlockers, max 4 softBlockers, max 3 codeOwnershipRisks, max 6 evidence items.
- Keep every issue field concise: issue under 90 chars, evidence under 160 chars, risk under 180 chars, suggestedFix under 180 chars.
- Prioritise real user-flow blockers before refactoring advice.
- Do not recommend refactoring first if a main CTA, form, route, build/lint status, or payment/auth/data path is broken or unverified.
- Every hardBlocker, softBlocker, and codeOwnershipRisk must cite evidence from the deterministic scan or file metadata.
- The deterministic scan includes launchFindings with suggested category, severity, and certainty. Treat these as the default classification unless stronger evidence in the scan clearly contradicts them.
- Evidence quality matters. Copy-only signals, draft docs, marketing copy, or product briefs can inform context, but they do not prove an executable user flow exists.
- Do not promote keyword-only findings into hard blockers. Hard blockers require executable evidence such as route/component code, API/server code, package dependencies, config, concrete unwired markup, or missing files.
- If deterministic evidence conflicts with concrete code evidence, prefer concrete code evidence and downgrade or omit the weaker finding.
- The deterministic scan may include actionFlows. These answer: "What is the user supposed to do, and can that action complete?" Treat action-flow findings as first-class launch evidence.
- Do not collapse email/waitlist/preorder/contact/demo capture flows into generic CTA issues. If actionFlows or launchFindings show a capture flow risk, report it separately from generic CTA/navigation behavior.
- If something is inferred, say "appears" or "not detected" instead of claiming certainty.
- Every issue must include a certainty value:
  - confirmed: the deterministic scan directly proves it, such as missing metadata, missing robots.txt, no analytics detected, no tests detected, or a known script exists/missing.
  - likely: evidence strongly suggests it, such as a form submit path where no action, API route, server action, fetch/axios, or integration was detected.
  - needs_verification: suspicious code was found but behavior cannot be proven broken, such as a button without obvious onClick/href.
  - inferred: risk is based on patterns, such as browser APIs in the wrong runtime, heavy animation, or runtime compatibility risk.
- For landing_page projects, prioritise primary action flows first: email/waitlist/preorder capture, demo/contact requests, CTA navigation, download/install/docs paths, then mobile readiness, metadata/social preview, analytics, performance, copy/brand consistency, and accessibility basics.
- For devtool projects, prioritise in this order: can users install/run the CLI, package.json bin resolves, documented install/npx commands match package.json name, filesystem writes are guarded, config/API key failures are validated clearly, errors are readable, and large/risky CLI files are maintainable.
- For devtool projects, describe browser API findings as "Node runtime/browser API risk". Do not use frontend framework rendering terminology. Only report this risk when deterministic scan evidence shows actual runtime code using window/document/navigator, not when those terms appear in strings, prompts, types, or scanner regexes.
- If package.json bin points to a missing file, treat "CLI bin target does not exist" as a Critical confirmed hard blocker.
- If docs mention the wrong npx/npm/pnpm/bun install package, report "Install command may be wrong" as High likely.
- Only report install-command mismatch when the reviewed project itself is the CLI/devtool package or the deterministic scan includes an install-command launch finding. Do not compare a private website package name to a public npm package named in docs or marketing copy.
- If filesystem write/delete operations appear without dry-run, confirmation, backup, allowlist, diff, or rollback signals, report "Filesystem writes need safety guard" as a High needs_verification code ownership risk unless the scan evidence clearly shows it can directly damage user files during the main command path.
- For saas_app projects, prioritise in this order: can users sign up/log in, protected routes are guarded, data writes are validated and handled safely, required env vars are validated, billing/payment/webhooks are safe if present, destructive actions are confirmed, loading/error/empty states exist, and code ownership risks are manageable.
- For dashboard projects, prioritise in this order: dashboard data can load, loading/error/empty states are handled, tables/charts are usable, filters/export actions are safe, admin/protected routes are guarded, and destructive actions are confirmed.
- For saas_app or dashboard projects, treat "Auth flow needs verification", "Protected routes need verification", "Data write needs validation/error handling", "Billing/webhook flow needs verification", and "Destructive action needs confirmation" as High needs_verification hard blocker candidates when present in deterministic launchFindings.
- For saas_app or dashboard projects, treat "Required environment variables need validation" and "Dashboard states need verification" as soft blockers unless deterministic evidence proves a production break.
- For ecommerce or backend_api projects, prioritise auth, permissions, data writes, payment flow, webhooks, error states, tests, and security.
- For billing/payment/webhook findings, marketing text that mentions billing, checkout, subscriptions, or webhooks is not enough. Only report billing/payment risk when executable payment evidence exists, such as payment dependencies, checkout/API routes, webhook handlers, payment env vars, or provider SDK usage.
- For Astro or static sites, Open Graph metadata can appear as plain <meta property="og:*"> tags in layouts. Do not report missing OG metadata if deterministic metadata evidence says openGraph=yes.
- Hard blocker means real users cannot complete the main flow, production can break, or launch would be misleading or unsafe. Only use hardBlockers for: main user action broken or very likely broken; form appears unwired; primary CTA appears unwired; build/lint/test command fails if actually executed or known; page likely cannot render; required env/config missing; auth/payment/database/webhook/data-write risk; severe mobile breakage; broken route/navigation.
- If an email/waitlist/preorder/contact/demo capture flow is detected and no clear submission path exists, include a first-class hardBlocker candidate: "Waitlist/email capture appears unwired" or "Primary capture flow appears unwired" with severity High and certainty likely. Use risk text like: "Users may think they joined the waitlist, preordered, requested access, or contacted the team, but nothing is actually captured."
- If a primary landing-page capture flow has a submission path but depends only on an environment-configured external endpoint, with no local API route/server action/provider proof in the repo, do not call it unwired. Report "Primary capture endpoint needs production proof" as High needs_verification. Public launch should be No or Maybe only after production proof; paid traffic should be No until a real production submission is verified.
- If a capture endpoint uses a known form/email provider signal or an owned API/server action, keep the finding softer or omit it unless there is other evidence of failure.
- If capture flow submission logic is partial or unclear, keep it separate from CTA behavior and use certainty needs_verification.
- If suspicious buttons or CTAs are found but behavior is not proven broken, use wording like "Primary CTA behavior needs verification" or "Potentially unwired button". Do not say "CTA is broken" unless evidence proves it.
- Soft blocker means launch quality is weaker but the main flow can still work.
- Do not classify these as hardBlockers by default: missing OG/social metadata, no analytics, no robots.txt, no sitemap, no tests for a landing page, general performance concern without measured failure, or general accessibility gap.
- For landing pages, classify missing OG/social metadata as a softBlocker, Medium, confirmed. Classify no analytics as a softBlocker, Medium, confirmed. Classify missing robots.txt or sitemap as a softBlocker, Low or Medium, confirmed. Classify no tests/no test script as a codeOwnershipRisk, Low, confirmed.
- Only elevate metadata or analytics if the provided evidence explicitly says public social launch, paid traffic, or campaign tracking is required.
- Code ownership risk means future changes become dangerous or expensive.
- Do not put large files, no tests, browser API usage, or mixed concerns in hardBlockers unless they directly break launch. These usually belong in codeOwnershipRisks.
- Score/label mapping: 1-3 Critical, 4-5 Concerning, 6-7 Fair, 8-10 Good.
- Prefer moving a finding to softBlockers or codeOwnershipRisks over inflating severity. Precision is more important than sounding dramatic.
- If deterministic launchFindings contain a High or Critical hard blocker/candidate for a primary action flow, the overall verdict must not be "Ship with caution" or "Safe to ship". Use at most "Not yet" / High risk until the primary action flow is verified.
- safestNextStep must be the safest next step for launch readiness, not broad cleanup. For landing pages with action-flow risks, the safest next step is to verify and wire the primary action flow first: capture flow and main CTAs before metadata, analytics, or refactoring.
- Return valid JSON only. No markdown. No extra text before or after JSON.`;

function modelForProvider(provider: ZenoConfig['provider']): string {
  return ZENO_MODELS[provider];
}

async function callAI(config: ZenoConfig, userMessage: string, systemPrompt = SYSTEM_PROMPT, maxTokens = 1500): Promise<string> {
  const { provider, apiKey } = config;

  if (provider === 'anthropic') {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: ZENO_MODELS.anthropic,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });
    const block = response.content[0];
    if (block.type !== 'text') throw new Error('Unexpected response type from Anthropic');
    return block.text;
  }

  if (provider === 'gemini') {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: ZENO_MODELS.gemini,
      systemInstruction: systemPrompt,
    });
    const result = await model.generateContent(userMessage);
    return result.response.text();
  }

  if (provider === 'openai') {
    const client = new OpenAI({ apiKey });
    const response = await client.responses.create({
      model: ZENO_MODELS.openai,
      max_output_tokens: maxTokens,
      input: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    });
    const text = response.output_text;
    if (!text) throw new Error('Empty response from OpenAI');
    return text;
  }

  if (provider === 'openrouter') {
    const client = new OpenAI({
      apiKey,
      baseURL: 'https://openrouter.ai/api/v1',
    });
    const response = await client.chat.completions.create({
      model: ZENO_MODELS.openrouter,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    });
    const text = response.choices[0]?.message?.content;
    if (!text) throw new Error('Empty response from OpenRouter');
    return text;
  }

  throw new Error(`Unknown provider: ${provider}`);
}


function riskColor(risk: RiskLevel): string {
  return riskTone(risk)(risk);
}

function scoreChalk(label: HealthLabel): (text: string) => string {
  return healthTone(label);
}

function actionSlug(action: string): string {
  return action.toLowerCase().replace(/\s+/g, '-');
}

function isReadOnlyReportAction(role: string, action: string): boolean {
  return (
    (role === 'Senior Developer' && action === 'Eyeball it') ||
    (role === 'EM' && (action === 'How bad is it' || action === 'Triage it')) ||
    (role === 'Engineering Manager' && action === 'Tell me if this is safe to ship') ||
    (role === 'Security Reviewer' && action === 'Check for security risks')
  );
}

function isShipReadinessAction(action: string): boolean {
  return action === 'Tell me if this is safe to ship';
}

function shipAnswer(report: HealthReport): { answer: string; risk: string; color: (text: string) => string } {
  if (report.score >= 8) return { answer: 'Safe to ship', risk: 'Low risk', color: theme.success };
  if (report.score >= 6) return { answer: 'Ship with caution', risk: 'Medium risk', color: chalk.hex('#FBBF24') };
  if (report.score >= 4) return { answer: 'Not yet', risk: 'High risk', color: theme.caution };
  return { answer: 'Do not ship', risk: 'Critical risk', color: theme.danger };
}

function stripJsonFences(raw: string): string {
  return raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
}

function parseHealthReport(raw: string): HealthReport {
  return JSON.parse(stripJsonFences(raw)) as HealthReport;
}

function buildRepairPrompt(raw: string): string {
  return `Your previous response was invalid or truncated JSON. Return a shorter valid JSON object using only these top-level keys: score, label, summary, reviewIntent, projectType, confidence, founderSummary, hardBlockers, softBlockers, codeOwnershipRisks, evidence, privatePreview, publicLaunch, paidTraffic, safestNextStep.

No markdown. No extra keys. No text before or after JSON. Maximum 2 issues per section. Keep every field concise.

Previous invalid response:
${raw.slice(0, 6000)}`;
}

function launchFindingToIssue(finding: LaunchFinding): NonNullable<HealthReport['hardBlockers']>[number] {
  const risk = finding.category === 'hard_blocker' || finding.category === 'hard_blocker_candidate'
    ? 'The primary launch path may fail for real users.'
    : finding.category === 'soft_blocker'
      ? 'Launch quality or measurement may be weaker.'
      : 'Future changes may be riskier or slower.';

  return {
    issue: finding.issue,
    evidence: finding.evidence,
    risk,
    suggestedFix: finding.suggestedFix,
    severity: finding.severity,
    certainty: finding.certainty,
  };
}

function fallbackReportFromScan(scan: ShipReadinessScan): HealthReport {
  const hardBlockers = scan.launchFindings
    .filter(finding => finding.category === 'hard_blocker' || finding.category === 'hard_blocker_candidate')
    .map(launchFindingToIssue);
  const softBlockers = scan.launchFindings
    .filter(finding => finding.category === 'soft_blocker')
    .map(launchFindingToIssue);
  const codeOwnershipRisks = scan.launchFindings
    .filter(finding => finding.category === 'code_ownership_risk')
    .map(launchFindingToIssue);
  const hasCritical = hardBlockers.some(issue => issue.severity === 'Critical');
  const score = hasCritical ? 3 : hardBlockers.length > 0 ? 4 : softBlockers.length > 0 ? 6 : 8;
  const label: HealthLabel = score <= 3 ? 'Critical' : score <= 5 ? 'Concerning' : score <= 7 ? 'Fair' : 'Good';
  const primaryActionRisk = hardBlockers.find(issue => /capture|cta|entrypoint|form/i.test(issue.issue));

  return {
    score,
    label,
    summary: hardBlockers.length > 0
      ? 'Deterministic scan found launch-path risks that should be fixed before public launch.'
      : 'Deterministic scan found no hard launch blockers, but some launch quality and ownership risks may remain.',
    reviewIntent: 'ship_readiness',
    projectType: scan.projectType,
    confidence: 'Medium',
    founderSummary: hardBlockers.length > 0
      ? 'Zeno could not format the AI report, so this fallback uses local scan findings. The primary launch path needs verification before public traffic.'
      : 'Zeno could not format the AI report, so this fallback uses local scan findings. No hard blocker was detected locally.',
    hardBlockers,
    softBlockers,
    codeOwnershipRisks,
    evidence: scan.evidence.slice(0, 6),
    privatePreview: {
      answer: hardBlockers.length > 0 ? 'Maybe' : 'Yes',
      reason: hardBlockers.length > 0 ? 'Private preview is possible after manually verifying the primary action flow.' : 'No local hard blocker was detected.',
    },
    publicLaunch: {
      answer: hardBlockers.length > 0 ? 'No' : 'Maybe',
      reason: hardBlockers.length > 0 ? 'Public launch should wait until hard blockers are fixed.' : 'Public launch still needs soft-blocker review.',
    },
    paidTraffic: {
      answer: hardBlockers.length > 0 || softBlockers.some(issue => /analytics/i.test(issue.issue)) ? 'No' : 'Maybe',
      reason: hardBlockers.length > 0 ? 'Paid traffic should wait until the primary action flow works.' : 'Paid traffic needs measurement and conversion checks.',
    },
    safestNextStep: primaryActionRisk
      ? `Verify and wire the primary action flow first: ${primaryActionRisk.issue}. Do not refactor before the launch path works.`
      : 'Verify the main user path manually before refactoring or sending public traffic.',
  };
}

function applyPrimaryFlowVerdictCap(report: HealthReport, scan: ShipReadinessScan | null): HealthReport {
  if (!scan) return report;
  const cap = getPrimaryFlowVerdictCap(scan);
  if (!cap || report.score <= cap.score) return report;

  const cappedReport: HealthReport = {
    ...report,
    score: cap.score,
    label: cap.label,
    summary: report.summary,
    publicLaunch: {
      answer: 'No',
      reason: `Public launch should wait until this primary action flow is verified: ${cap.finding.issue}.`,
    },
    paidTraffic: {
      answer: 'No',
      reason: `Paid traffic should wait until this primary action flow is verified: ${cap.finding.issue}.`,
    },
  };

  if (!cappedReport.privatePreview || cappedReport.privatePreview.answer === 'Yes') {
    cappedReport.privatePreview = {
      answer: 'Maybe',
      reason: `Private preview is reasonable only after manually checking: ${cap.finding.issue}.`,
    };
  }

  if (cappedReport.founderSummary && !cappedReport.founderSummary.toLowerCase().includes('not yet')) {
    cappedReport.founderSummary = `${cappedReport.founderSummary} Zeno is capping the verdict at Not yet because the primary action flow still needs proof.`;
  }

  return cappedReport;
}

function localTimestamp(date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}-${hh}-${min}`;
}

type ProjectTypeSource = 'detected' | 'saved' | 'user_confirmed' | 'changed_confirmed';

interface ProjectConfig {
  projectType: ProjectType;
  confidence: number;
  confidenceLabel: 'low' | 'medium' | 'high';
  confirmedByUser: boolean;
  signals: string[];
  updatedAt: string;
}

interface ProjectTypeResolution {
  projectType: ProjectType;
  source: ProjectTypeSource;
  confidence: number;
  confidenceLabel: 'low' | 'medium' | 'high';
  signals: string[];
}

const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  landing_page: 'Landing page',
  saas_app: 'SaaS app',
  dashboard: 'Dashboard',
  devtool: 'Devtool',
  backend_api: 'Backend/API',
  docs_site: 'Docs site',
  ecommerce: 'Ecommerce',
  unknown: 'Unknown',
};

function formatProjectType(type: ProjectType): string {
  return PROJECT_TYPE_LABELS[type] ?? type;
}

function formatConfidenceLabel(label: 'low' | 'medium' | 'high'): string {
  if (label === 'high') return 'High confidence';
  if (label === 'medium') return 'Medium confidence';
  return 'Low confidence';
}

async function loadProjectConfig(root: string): Promise<ProjectConfig | null> {
  try {
    const raw = await readFile(join(root, '.zeno', 'project.json'), 'utf8');
    const parsed = JSON.parse(raw) as Partial<ProjectConfig>;
    if (!parsed.projectType) return null;
    return {
      projectType: parsed.projectType,
      confidence: parsed.confidence ?? 0,
      confidenceLabel: parsed.confidenceLabel ?? 'low',
      confirmedByUser: Boolean(parsed.confirmedByUser),
      signals: parsed.signals ?? [],
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function saveProjectConfig(root: string, config: ProjectConfig): Promise<void> {
  const zenoDir = join(root, '.zeno');
  await mkdir(zenoDir, { recursive: true });
  await writeFile(join(zenoDir, 'project.json'), JSON.stringify(config, null, 2), 'utf8');
}

function hasStrongProjectTypeConflict(saved: ProjectConfig, scan: ShipReadinessScan): boolean {
  const detection = scan.projectTypeDetection;
  if (saved.projectType === detection.primaryType) return false;
  if (detection.primaryType === 'unknown') return false;
  const newScore = detection.scores[detection.primaryType] ?? 0;
  const savedScore = detection.scores[saved.projectType] ?? 0;
  return detection.confidenceLabel === 'high' && newScore >= 40 && newScore - savedScore >= 20;
}

async function askProjectType(args: {
  message: string;
  detection: ShipReadinessScan['projectTypeDetection'];
  saved?: ProjectConfig;
}): Promise<{ projectType: ProjectType; confirmedByUser: boolean }> {
  const choices: Array<{ name: string; value: ProjectType | 'choose_detected' }> = [];
  const seen = new Set<ProjectType>();

  function pushType(type: ProjectType, suffix = ''): void {
    if (seen.has(type)) return;
    seen.add(type);
    choices.push({ name: `${formatProjectType(type)}${suffix}`, value: type });
  }

  pushType(args.detection.primaryType);
  for (const type of args.detection.secondaryTypes) pushType(type);
  if (args.saved) pushType(args.saved.projectType, ` (keep saved)`);
  for (const type of ['landing_page', 'saas_app', 'dashboard', 'devtool', 'backend_api', 'docs_site', 'ecommerce', 'unknown'] as ProjectType[]) {
    pushType(type);
  }
  choices.push({ name: 'Mixed project', value: 'unknown' });
  choices.push({ name: 'Not sure - choose for me', value: 'choose_detected' });

  console.log(theme.caution(args.message));
  if (args.detection.signals.length > 0) {
    console.log(theme.muted('\nDetected signals:'));
    for (const signal of args.detection.signals.slice(0, 5)) console.log(theme.muted(`  - ${signal}`));
  }
  if (args.detection.conflictingSignals.length > 0) {
    console.log(theme.muted('\nMixed signals:'));
    for (const signal of args.detection.conflictingSignals.slice(0, 5)) console.log(theme.muted(`  - ${signal}`));
  }
  console.log('');

  const selected = await select<ProjectType | 'choose_detected'>({
    message: 'What should Zeno review this as?',
    choices,
  });

  if (selected === 'choose_detected') {
    return { projectType: args.detection.primaryType, confirmedByUser: false };
  }
  return { projectType: selected, confirmedByUser: true };
}

async function resolveProjectType(root: string, scan: ShipReadinessScan): Promise<ProjectTypeResolution> {
  const detection = scan.projectTypeDetection;
  const saved = await loadProjectConfig(root);

  if (saved && !hasStrongProjectTypeConflict(saved, scan)) {
    console.log(theme.success(`✔ Using saved project type: ${formatProjectType(saved.projectType)}`));
    return {
      projectType: saved.projectType,
      source: saved.confirmedByUser ? 'user_confirmed' : 'saved',
      confidence: saved.confidence,
      confidenceLabel: saved.confidenceLabel,
      signals: saved.signals,
    };
  }

  if (saved && hasStrongProjectTypeConflict(saved, scan)) {
    const selected = await askProjectType({
      message: `Project type may have changed.\n\nSaved: ${formatProjectType(saved.projectType)}\nNew: ${formatProjectType(detection.primaryType)} [${formatConfidenceLabel(detection.confidenceLabel)}]`,
      detection,
      saved,
    });
    const config: ProjectConfig = {
      projectType: selected.projectType,
      confidence: detection.confidence,
      confidenceLabel: detection.confidenceLabel,
      confirmedByUser: selected.confirmedByUser,
      signals: detection.signals,
      updatedAt: new Date().toISOString(),
    };
    await saveProjectConfig(root, config);
    return {
      projectType: selected.projectType,
      source: 'changed_confirmed',
      confidence: detection.confidence,
      confidenceLabel: detection.confidenceLabel,
      signals: detection.signals,
    };
  }

  if (!detection.shouldAskUser) {
    console.log(theme.success(`✔ Detected project type: ${formatProjectType(detection.primaryType)} [${formatConfidenceLabel(detection.confidenceLabel)}]`));
    if (detection.signals.length > 0) {
      console.log(theme.muted(`  Signals: ${detection.signals.slice(0, 3).join(', ')}`));
    }
    const config: ProjectConfig = {
      projectType: detection.primaryType,
      confidence: detection.confidence,
      confidenceLabel: detection.confidenceLabel,
      confirmedByUser: false,
      signals: detection.signals,
      updatedAt: new Date().toISOString(),
    };
    await saveProjectConfig(root, config);
    return {
      projectType: detection.primaryType,
      source: 'detected',
      confidence: detection.confidence,
      confidenceLabel: detection.confidenceLabel,
      signals: detection.signals,
    };
  }

  const selected = await askProjectType({
    message: 'This project looks mixed.',
    detection,
  });
  const config: ProjectConfig = {
    projectType: selected.projectType,
    confidence: detection.confidence,
    confidenceLabel: detection.confidenceLabel,
    confirmedByUser: selected.confirmedByUser,
    signals: detection.signals,
    updatedAt: new Date().toISOString(),
  };
  await saveProjectConfig(root, config);
  return {
    projectType: selected.projectType,
    source: selected.confirmedByUser ? 'user_confirmed' : 'detected',
    confidence: detection.confidence,
    confidenceLabel: detection.confidenceLabel,
    signals: detection.signals,
  };
}

async function saveShipReadinessLocalReport(args: {
  root: string;
  report: HealthReport;
  fileCount: number;
  scan: ShipReadinessScan | null;
  projectTypeResolution?: ProjectTypeResolution;
  provider: ZenoConfig['provider'];
  model: string;
  source: 'ai' | 'ai-retry' | 'deterministic-fallback';
  malformedOutput?: string;
}): Promise<{ jsonPath: string; htmlPath: string; csvPath: string; htmlFileUrl: string; htmlAbsolutePath: string }> {
  const reportsDir = join(args.root, '.zeno', 'reports');
  await mkdir(reportsDir, { recursive: true });
  const timestamp = localTimestamp();
  const jsonFilePath = join(reportsDir, `ship-readiness-${timestamp}.json`);
  const htmlFilePath = join(reportsDir, `ship-readiness-${timestamp}.html`);
  const csvFilePath = join(reportsDir, `ship-readiness-${timestamp}.csv`);
  const htmlFileUrl = pathToFileURL(htmlFilePath).href;
  const payload = {
    savedAt: new Date().toISOString(),
    source: args.source,
    root: args.root,
    fileCount: args.fileCount,
    provider: args.provider,
    model: args.model,
    projectTypeResolution: args.projectTypeResolution,
    report: args.report,
    deterministicScan: args.scan,
    malformedOutput: args.malformedOutput,
  };
  await writeFile(jsonFilePath, JSON.stringify(payload, null, 2), 'utf8');
  await writeFile(csvFilePath, generateShipReadinessCsv(args.report), 'utf8');
  await writeFile(htmlFilePath, generateShipReadinessHtml(payload, basename(csvFilePath), htmlFileUrl), 'utf8');
  return {
    jsonPath: relative(args.root, jsonFilePath),
    htmlPath: relative(args.root, htmlFilePath),
    csvPath: relative(args.root, csvFilePath),
    htmlFileUrl,
    htmlAbsolutePath: htmlFilePath,
  };
}

type ShipReadinessSavedPayload = {
  savedAt: string;
  source: 'ai' | 'ai-retry' | 'deterministic-fallback';
  root: string;
  fileCount: number;
  provider: ZenoConfig['provider'];
  model: string;
  projectTypeResolution?: ProjectTypeResolution;
  report: HealthReport;
  deterministicScan: ShipReadinessScan | null;
  malformedOutput?: string;
};

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function paragraph(value: unknown): string {
  return escapeHtml(value).replace(/\n/g, '<br>');
}

function csvCell(value: unknown): string {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function generateShipReadinessCsv(report: HealthReport): string {
  const rows = [
    ['category', 'issue', 'severity', 'certainty', 'evidence', 'risk', 'fix'],
    ...(report.hardBlockers ?? []).map(issue => [
      'hard_blocker',
      issue.issue,
      issue.severity,
      issue.certainty ?? '',
      issue.evidence,
      issue.risk,
      issue.suggestedFix,
    ]),
    ...(report.softBlockers ?? []).map(issue => [
      'soft_blocker',
      issue.issue,
      issue.severity,
      issue.certainty ?? '',
      issue.evidence,
      issue.risk,
      issue.suggestedFix,
    ]),
    ...(report.codeOwnershipRisks ?? []).map(issue => [
      'code_ownership_risk',
      issue.issue,
      issue.severity,
      issue.certainty ?? '',
      issue.evidence,
      issue.risk,
      issue.suggestedFix,
    ]),
  ];
  return `${rows.map(row => row.map(csvCell).join(',')).join('\n')}\n`;
}

function sectionClass(title: string): string {
  if (title.toLowerCase().includes('hard')) return 'hard';
  if (title.toLowerCase().includes('soft')) return 'soft';
  return 'ownership';
}

function emptyIssueMessage(title: string): string {
  if (title.toLowerCase().includes('hard')) return 'No hard blockers found.';
  if (title.toLowerCase().includes('soft')) return 'No soft blockers found.';
  return 'No code ownership risks found.';
}

function issueList(title: string, issues: HealthReport['hardBlockers']): string {
  const sectionTone = sectionClass(title);
  if (!issues || issues.length === 0) {
    return `<section class="section-card">
      <div class="section-title"><h2>${escapeHtml(title)}</h2></div>
      <div class="empty-state">${escapeHtml(emptyIssueMessage(title))}</div>
    </section>`;
  }
  return `<section class="section-card">
    <div class="section-title"><h2>${escapeHtml(title)}</h2><span>${issues.length}</span></div>
    ${issues.map((issue, index) => `<article class="issue ${sectionTone} severity-border-${escapeHtml(issue.severity.toLowerCase())}">
      <div class="issue-heading">
        <h3>${index + 1}. ${escapeHtml(issue.issue)}</h3>
        <div class="chips">
          <span class="chip severity-${escapeHtml(issue.severity.toLowerCase())}">${escapeHtml(issue.severity)}</span>
          ${issue.certainty ? `<span class="chip certainty">${escapeHtml(formatCertainty(issue.certainty))}</span>` : ''}
        </div>
      </div>
      <div class="issue-body">
        <div><span>Evidence</span><p>${paragraph(issue.evidence)}</p></div>
        <div><span>Risk</span><p>${paragraph(issue.risk)}</p></div>
        <div><span>Fix</span><p>${paragraph(issue.suggestedFix)}</p></div>
      </div>
    </article>`).join('')}
  </section>`;
}

function deterministicFindingsHtml(scan: ShipReadinessScan | null): string {
  if (!scan || scan.launchFindings.length === 0) {
    return '<section class="section-card"><div class="section-title"><h2>Full deterministic findings</h2></div><div class="empty-state">No deterministic findings were saved.</div></section>';
  }
  return `<section class="section-card">
    <div class="section-title"><h2>Full deterministic findings</h2><span>${scan.launchFindings.length}</span></div>
    ${scan.launchFindings.map((finding, index) => `<article class="issue compact severity-border-${escapeHtml(finding.severity.toLowerCase())}">
      <div class="issue-heading">
        <h3>${index + 1}. ${escapeHtml(finding.issue)}</h3>
      </div>
      <div class="chips">
        <span class="chip">${escapeHtml(finding.category.replace(/_/g, ' '))}</span>
        <span class="chip severity-${escapeHtml(finding.severity.toLowerCase())}">${escapeHtml(finding.severity)}</span>
        <span class="chip">${escapeHtml(formatCertainty(finding.certainty))}</span>
      </div>
      <p><strong>Evidence:</strong> ${paragraph(finding.evidence)}</p>
      <p><strong>Fix:</strong> ${paragraph(finding.suggestedFix)}</p>
    </article>`).join('')}
  </section>`;
}

function decisionHtml(label: string, decision: HealthReport['privatePreview']): string {
  if (!decision) return '';
  return `<div class="decision"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(decision.answer)}</span><p>${paragraph(decision.reason)}</p></div>`;
}

function generateShipReadinessHtml(payload: ShipReadinessSavedPayload, csvFileName: string, htmlFileUrl: string): string {
  const { report, deterministicScan: scan } = payload;
  const verdict = shipAnswer(report);
  const hardBlockers = report.hardBlockers ?? [];
  const softBlockers = report.softBlockers ?? [];
  const codeOwnershipRisks = report.codeOwnershipRisks ?? [];
  const projectName = basename(payload.root);
  const date = new Date(payload.savedAt).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const projectTypeBadge = payload.projectTypeResolution
    ? payload.projectTypeResolution.source === 'saved'
      ? 'Saved'
      : payload.projectTypeResolution.source === 'user_confirmed' || payload.projectTypeResolution.source === 'changed_confirmed'
        ? 'User confirmed'
        : formatConfidenceLabel(payload.projectTypeResolution.confidenceLabel)
    : report.confidence;
  const safestNextStep = report.safestNextStep ?? report.start ?? '';
  const founderSummary = report.founderSummary ?? report.summary ?? '';
  const riskClass = verdict.risk.toLowerCase().replace(/[^a-z]+/g, '-');
  const topIssues = [
    ...hardBlockers.slice(0, 3).map(issue => ({ category: 'Hard', issue })),
    ...softBlockers.slice(0, 3).map(issue => ({ category: 'Soft', issue })),
    ...codeOwnershipRisks.slice(0, 3).map(issue => ({ category: 'Ownership', issue })),
  ].slice(0, 6);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ZENOAI Ship Readiness Report - ${escapeHtml(projectName)}</title>
<style>
  :root {
    color-scheme: light;
    --page-bg: #eef1f5;
    --paper: #ffffff;
    --paper-soft: #f8fafc;
    --ink: #111827;
    --muted: #5b6472;
    --line: #d8dee8;
    --line-strong: #b9c3d3;
    --title: #0f172a;
    --accent: #2563eb;
    --critical: #991b1b;
    --critical-bg: #fef2f2;
    --high: #dc2626;
    --high-bg: #fff1f2;
    --medium: #b45309;
    --medium-bg: #fffbeb;
    --low: #15803d;
    --low-bg: #f0fdf4;
    --ownership: #0369a1;
    --ownership-bg: #f0f9ff;
    --shadow: 0 18px 50px rgba(15, 23, 42, .12);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: linear-gradient(180deg, #e8edf5 0, var(--page-bg) 340px, #f6f7fb 100%);
    color: var(--ink);
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
    font-size: 14px;
    line-height: 1.52;
    min-height: 100vh;
  }
  main {
    width: min(100%, 980px);
    margin: 30px auto;
    padding: 38px 46px 52px;
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 18px;
    box-shadow: var(--shadow);
  }
  header {
    display: flex;
    gap: 24px;
    align-items: flex-start;
    justify-content: space-between;
    padding: 26px;
    margin-bottom: 24px;
    border: 1px solid #c7d2fe;
    border-radius: 16px;
    background: linear-gradient(135deg, #eef2ff 0%, #f8fafc 58%, #eff6ff 100%);
  }
  h1 { margin: 4px 0 14px; color: var(--title); font-size: 34px; line-height: 1.08; letter-spacing: 0; }
  h2 { margin: 0; color: var(--title); font-size: 20px; letter-spacing: 0; }
  h3 { margin: 0; color: var(--title); font-size: 15px; letter-spacing: 0; }
  p { margin: 8px 0; }
  a { color: inherit; text-decoration: none; }
  .meta, .muted { color: var(--muted); }
  .kicker { color: var(--accent); font-size: 11px; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; }
  .actions { display: flex; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
  .button {
    appearance: none;
    border: 1px solid var(--line);
    background: #ffffff;
    color: var(--title);
    border-radius: 8px;
    padding: 8px 12px;
    font: inherit;
    font-size: 12px;
    font-weight: 650;
    cursor: pointer;
    transition: border-color .16s ease, background .16s ease;
  }
  .button:hover { border-color: var(--accent); background: #eff6ff; }
  .button.primary { border-color: var(--accent); color: #ffffff; background: var(--accent); }
  .hero-grid { display: grid; grid-template-columns: 1.35fr repeat(3, 1fr); gap: 12px; margin: 22px 0 18px; }
  .card, .section-card, .summary, .issue {
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 12px;
  }
  .card { padding: 15px 16px; min-height: 96px; background: var(--paper-soft); }
  .verdict-card {
    min-height: 132px;
    border-width: 2px;
    border-color: #bfdbfe;
    background: linear-gradient(180deg, #eff6ff, #ffffff);
  }
  .risk-medium-risk { border-color: var(--medium); background: var(--medium-bg); }
  .risk-high-risk, .risk-critical-risk { border-color: var(--high); background: var(--high-bg); }
  .card-label { color: var(--muted); font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .1em; }
  .card-value { margin-top: 8px; font-size: 18px; font-weight: 750; }
  .verdict { color: var(--title); font-size: 32px; line-height: 1.05; }
  .risk-badge {
    display: inline-flex;
    margin-top: 13px;
    border: 1px solid var(--line-strong);
    border-radius: 8px;
    padding: 5px 9px;
    color: var(--title);
    background: #ffffff;
    font-size: 12px;
    font-weight: 700;
  }
  .section-card { padding: 20px 22px; margin-top: 18px; break-inside: avoid; }
  .section-title { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 14px; }
  .section-title span { color: var(--muted); border: 1px solid var(--line); border-radius: 8px; padding: 2px 8px; font-size: 12px; background: var(--paper-soft); }
  .summary { position: relative; padding: 16px 18px; color: var(--ink); background: var(--paper-soft); }
  .summary.with-action { padding-right: 88px; }
  .copy-small { position: absolute; right: 12px; top: 12px; padding: 5px 9px; font-size: 12px; }
  .summary-table, .top-table { width: 100%; border-collapse: collapse; overflow: hidden; border: 1px solid var(--line); border-radius: 10px; }
  .summary-table th, .summary-table td, .top-table th, .top-table td { padding: 10px 12px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
  .summary-table th, .top-table th { color: var(--title); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; background: #eef2f7; }
  .summary-table tr:hover td, .top-table tr:hover td { background: #f8fafc; }
  .summary-table tr:last-child td, .top-table tr:last-child td { border-bottom: 0; }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; }
  .chip {
    border: 1px solid var(--line);
    border-radius: 7px;
    padding: 3px 8px;
    color: var(--muted);
    font-size: 11px;
    font-weight: 750;
    background: #ffffff;
    white-space: nowrap;
  }
  .certainty { color: #4338ca; border-color: #c7d2fe; background: #eef2ff; }
  .severity-critical { color: var(--critical); border-color: #fecaca; background: var(--critical-bg); }
  .severity-high { color: var(--high); border-color: #fecaca; background: var(--high-bg); }
  .severity-medium { color: var(--medium); border-color: #fde68a; background: var(--medium-bg); }
  .severity-low { color: var(--low); border-color: #bbf7d0; background: var(--low-bg); }
  .issue {
    margin-bottom: 12px;
    padding: 16px 18px;
    border-left: 7px solid var(--line-strong);
    break-inside: avoid;
  }
  .issue.hard { background: #fff7f7; border-color: #fecaca; }
  .issue.soft { background: #fffbeb; border-color: #fde68a; }
  .issue.ownership { background: var(--ownership-bg); border-color: #bae6fd; }
  .severity-border-critical { border-left-color: var(--critical); }
  .severity-border-high { border-left-color: var(--high); }
  .severity-border-medium { border-left-color: var(--medium); }
  .severity-border-low { border-left-color: var(--low); }
  .issue-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 12px; }
  .issue-body { display: grid; gap: 10px; }
  .issue-body span { display: block; color: var(--muted); font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .1em; }
  .issue-body p { margin: 2px 0 0; color: var(--ink); }
  .issue.compact p { margin: 6px 0; }
  .decision { display: grid; grid-template-columns: 160px 72px 1fr; gap: 10px; align-items: start; padding: 12px 0; border-bottom: 1px solid var(--line); }
  .decision:last-child { border-bottom: 0; }
  .decision span { color: var(--accent); font-weight: 800; }
  .decision p { margin: 0; color: var(--ink); }
  .empty-state { border: 1px dashed var(--line-strong); border-radius: 10px; padding: 16px; color: var(--muted); background: var(--paper-soft); }
  ul { padding-left: 22px; }
  li { margin: 6px 0; }
  code { background: #eef2f7; padding: 2px 5px; border-radius: 4px; }
  @media (max-width: 820px) {
    header, .issue-heading { flex-direction: column; }
    .actions { justify-content: flex-start; }
    .hero-grid { grid-template-columns: 1fr; }
    .decision { grid-template-columns: 1fr; }
    .summary.with-action { padding-right: 18px; padding-top: 54px; }
  }
  @media print {
    @page { margin: 14mm; size: A4; }
    body { background: #ffffff; color: #111827; font-size: 12px; }
    main { width: auto; max-width: none; margin: 0; padding: 0; border: 0; border-radius: 0; box-shadow: none; }
    header { padding: 18px; margin-bottom: 16px; border-color: #b7c4d8; background: #f8fafc; break-inside: avoid; }
    .actions, .copy-small { display: none !important; }
    .card, .section-card, .summary, .issue { box-shadow: none; break-inside: avoid; }
    .hero-grid { grid-template-columns: repeat(4, 1fr); gap: 8px; }
    .card { min-height: auto; padding: 10px; }
    .verdict { font-size: 24px; }
    .section-card { margin-top: 12px; padding: 14px; }
    .issue { padding: 12px 14px; }
    .top-table th, .top-table td, .summary-table th, .summary-table td { padding: 7px 8px; }
    a { color: #111827; }
  }
</style>
</head>
<body>
<main>
  <header>
    <div>
      <div class="kicker">ZENOAI</div>
      <h1>Ship Readiness Report</h1>
      <div class="meta">Project: ${escapeHtml(projectName)}</div>
      <div class="meta">Date: ${escapeHtml(date)}</div>
      <div class="meta">Provider: ${escapeHtml(payload.provider)} · Model: ${escapeHtml(payload.model)} · Source: ${escapeHtml(payload.source)}</div>
    </div>
    <div class="actions" aria-label="Report actions">
      <button class="button primary" type="button" onclick="window.print()">Export PDF</button>
      <a class="button" href="${escapeHtml(csvFileName)}" download>Export CSV</a>
      <button class="button" type="button" data-copy="${escapeHtml(htmlFileUrl)}" onclick="copyText(this)">Copy report path</button>
    </div>
  </header>

  <section class="hero-grid" aria-label="Report overview">
    <div class="card verdict-card risk-${escapeHtml(riskClass)}"><div class="card-label">Verdict</div><div class="card-value verdict">${escapeHtml(verdict.answer)}</div><div class="risk-badge">${escapeHtml(verdict.risk)}</div></div>
    <div class="card"><div class="card-label">Project type</div><div class="card-value">${escapeHtml(report.projectType ?? 'unknown')}${projectTypeBadge ? ` [${escapeHtml(projectTypeBadge)}]` : ''}</div></div>
    <div class="card"><div class="card-label">Confidence</div><div class="card-value">${escapeHtml(report.confidence ?? 'Unknown')}</div></div>
    <div class="card"><div class="card-label">Files reviewed</div><div class="card-value">${escapeHtml(payload.fileCount)}</div></div>
  </section>

  <section class="section-card">
    <div class="section-title"><h2>Founder summary</h2></div>
    <div class="summary with-action">
      <button class="button copy-small" type="button" data-copy="${escapeHtml(founderSummary)}" onclick="copyText(this)">Copy</button>
      ${paragraph(founderSummary)}
    </div>
  </section>

  <section class="section-card">
    <div class="section-title"><h2>Issue summary</h2></div>
    <table class="summary-table">
      <thead><tr><th>Category</th><th>Found</th></tr></thead>
      <tbody>
        <tr><td>Hard blockers</td><td>${hardBlockers.length}</td></tr>
        <tr><td>Soft blockers</td><td>${softBlockers.length}</td></tr>
        <tr><td>Code ownership risks</td><td>${codeOwnershipRisks.length}</td></tr>
      </tbody>
    </table>
  </section>

  <section class="section-card">
    <div class="section-title"><h2>Top issues</h2></div>
    ${topIssues.length > 0 ? `<table class="top-table">
      <thead><tr><th>Category</th><th>Severity</th><th>Certainty</th><th>Issue</th></tr></thead>
      <tbody>${topIssues.map(item => `<tr>
        <td>${escapeHtml(item.category)}</td>
        <td><span class="chip severity-${escapeHtml(item.issue.severity.toLowerCase())}">${escapeHtml(item.issue.severity)}</span></td>
        <td>${item.issue.certainty ? `<span class="chip certainty">${escapeHtml(formatCertainty(item.issue.certainty))}</span>` : ''}</td>
        <td>${escapeHtml(shortIssueLabel(item.issue.issue))}</td>
      </tr>`).join('')}</tbody>
    </table>` : '<div class="empty-state">No top issues found.</div>'}
  </section>

  ${issueList('Hard blockers', hardBlockers)}
  ${issueList('Soft blockers', softBlockers)}
  ${issueList('Code ownership risks', codeOwnershipRisks)}

  <section class="section-card">
    <div class="section-title"><h2>Evidence</h2></div>
    ${(report.evidence ?? []).length > 0 ? `<ul>${(report.evidence ?? []).map(item => `<li>${paragraph(item)}</li>`).join('')}</ul>` : '<p class="muted">No evidence items were returned by the AI report.</p>'}
  </section>

  <section class="section-card">
    <div class="section-title"><h2>Can ship?</h2></div>
    ${decisionHtml('Private preview', report.privatePreview)}
    ${decisionHtml('Public launch', report.publicLaunch)}
    ${decisionHtml('Paid traffic', report.paidTraffic)}
  </section>

  <section class="section-card">
    <div class="section-title"><h2>Safest next step</h2></div>
    <div class="summary">${paragraph(safestNextStep)}</div>
  </section>

  ${deterministicFindingsHtml(scan)}
</main>
<script>
function copyText(button) {
  var text = button.getAttribute('data-copy') || '';
  var original = button.textContent;
  function done() {
    button.textContent = 'Copied';
    window.setTimeout(function () { button.textContent = original; }, 1400);
  }
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done).catch(function () { fallbackCopy(text, done); });
  } else {
    fallbackCopy(text, done);
  }
}
function fallbackCopy(text, done) {
  var textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  try { document.execCommand('copy'); done(); } catch (_) {}
  document.body.removeChild(textarea);
}
</script>
</body>
</html>`;
}

export async function runOrchestrator(opts: RunOptions): Promise<void> {
  const normalizedAction = actionSlug(opts.action);
  console.log(chalk.dim(`action: ${normalizedAction}\n`));

  if (opts.action === 'Check for security risks') {
    const root = process.cwd();
    const spinner = ora('Finding files to scan...').start();
    const { reports } = await analyse(root);
    spinner.succeed(`Found ${reports.length} files`);
    await runSecurityCheck(reports);
    process.exit(0);
  }

  if (isReadOnlyReportAction(opts.role, opts.action)) {
    const root = process.cwd();

    const MAX_SEND = 50;

    const analyseSpinner = ora('Analysing project...').start();
    const { reports: allFiles, skipped } = await analyse(root);
    analyseSpinner.succeed(`Found ${allFiles.length} files`);

    // foundTotal counts everything before the send cap is applied
    const foundTotal = allFiles.length + skipped.length;
    const files = allFiles.slice(0, MAX_SEND);

    // Guard 4: only auto-generated files (more specific, checked before Guard 3)
    if (files.length === 0 && skipped.every(s => s.reason === 'auto-generated')) {
      console.log(chalk.red('\n⚠  Only auto-generated files found — no source code to analyse.'));
      console.log(chalk.red('   Make sure you are running Zeno from your project root.\n'));
      process.exit(1);
    }

    // Guard 3: zero files found
    if (files.length === 0) {
      console.log(chalk.red('\n⚠  No JavaScript or TypeScript files found.'));
      console.log(chalk.red('   Make sure you are running Zeno from your project root.\n'));
      process.exit(1);
    }

    // Guard 6: majority of files unreadable
    const unreadableCount = skipped.filter(s => s.reason === 'unreadable').length;
    if (unreadableCount > 0 && unreadableCount / (foundTotal) > 0.5) {
      console.log(chalk.red(`\n⚠  Most files could not be read (${unreadableCount} skipped as unreadable).`));
      console.log(chalk.red('   Check file permissions and try again.\n'));
      process.exit(1);
    }

    // Guard 5: large codebase warning (non-fatal)
    if (foundTotal > 100) {
      console.log(chalk.yellow(`⚠  Large codebase detected (${foundTotal} files found).`));
      console.log(chalk.yellow('   Zeno is sending the 50 highest-risk files for analysis.'));
      console.log(chalk.yellow('   For best results, consider running from a specific subdirectory.\n'));
    }

    // Track files dropped by the send cap so they appear in the transparency log
    if (allFiles.length > MAX_SEND) {
      for (const f of allFiles.slice(MAX_SEND)) {
        skipped.push({ path: f.path, reason: `cap reached (${MAX_SEND} file limit)` });
      }
    }

    let summary = `found (${foundTotal}) → sending (${files.length})`;
    if (allFiles.length > MAX_SEND) summary += ` (capped at ${MAX_SEND})`;
    console.log(chalk.dim(summary));
    for (const s of skipped) {
      console.log(chalk.dim(`  skipped: ${s.path} (${s.reason})`));
    }
    console.log('');

    if (files.length < 3) {
      let hasPkgJson = false;
      try { await access(join(root, 'package.json')); hasPkgJson = true; } catch { /* not found */ }
      if (hasPkgJson) {
        console.log(theme.info(`Note: Zeno found ${files.length} JavaScript/TypeScript source file${files.length === 1 ? '' : 's'} to review.`));
        console.log(theme.muted('  For small apps or landing pages, that may be expected.\n'));
      }
    }

    console.log(theme.heading('AI review'));
    console.log(theme.muted(`  Provider : ${opts.config.provider}`));
    console.log(theme.muted(`  Model    : ${modelForProvider(opts.config.provider)}`));
    console.log(theme.muted(`  Calls    : 1 model call${isShipReadinessAction(opts.action) ? ' + 1 formatting retry if needed' : ''}\n`));

    const proceedWithReview = await confirm({ message: 'Proceed with this AI review?', default: true });
    if (!proceedWithReview) {
      console.log(chalk.yellow('\nRun cancelled. No model call was made.'));
      process.exit(0);
    }
    console.log('');

    const shipScan = isShipReadinessAction(opts.action)
      ? await runShipReadinessScan(root, allFiles)
      : null;
    const projectTypeResolution = shipScan
      ? await resolveProjectType(root, shipScan)
      : undefined;
    if (shipScan && projectTypeResolution) {
      shipScan.projectType = projectTypeResolution.projectType;
    }

    const userMessage = isShipReadinessAction(opts.action)
      ? `Review intent: ship_readiness

Selected project type: ${projectTypeResolution?.projectType ?? shipScan?.projectType ?? 'unknown'}
Project type source: ${projectTypeResolution?.source ?? 'detected'}

Project file summary (${files.length} files):
${JSON.stringify(files, null, 2)}

Deterministic ship-readiness scan:
${JSON.stringify(shipScan, null, 2)}`
      : `Project file summary (${files.length} files):\n\n${JSON.stringify(files, null, 2)}`;

    const LATE_MESSAGES = [
      'mapping dependencies…',
      'weighing your risks…',
      'cross-referencing patterns…',
      'finishing your report…',
      'almost there…',
    ];

    function buildSpinnerText(elapsed: number, lateMsg: string): string {
      let phase: string;
      if (elapsed < 5)       phase = 'working…';
      else if (elapsed < 10) phase = "this one's taking a moment…";
      else                   phase = lateMsg;
      return theme.heading('Zeno') + theme.muted(' — ') + theme.caution(phase);
    }

    let elapsed = 0;
    let lateMsg = LATE_MESSAGES[0];
    let lateTimer: ReturnType<typeof setTimeout> | null = null;

    function scheduleNextMessage(): void {
      const delay = 2000 + Math.random() * 6000; // 2s – 8s, different every time
      lateTimer = setTimeout(() => {
        lateMsg = LATE_MESSAGES[Math.floor(Math.random() * LATE_MESSAGES.length)];
        scheduleNextMessage();
      }, delay);
    }

    const spinner = ora({ text: buildSpinnerText(0, lateMsg), color: 'yellow' }).start();

    const tickInterval = setInterval(() => {
      elapsed += 1;
      if (elapsed === 10) scheduleNextMessage();
      spinner.text = buildSpinnerText(elapsed, lateMsg);
    }, 1000);

    function clearSpinnerTimers(): void {
      clearInterval(tickInterval);
      if (lateTimer) clearTimeout(lateTimer);
    }

    let raw: string;
    try {
      raw = await callAI(
        opts.config,
        userMessage,
        isShipReadinessAction(opts.action) ? SHIP_READINESS_PROMPT : SYSTEM_PROMPT,
        isShipReadinessAction(opts.action) ? 4200 : 1500,
      );
      clearSpinnerTimers();
      spinner.succeed(theme.heading('Zeno') + theme.muted(` — done (${elapsed}s)`));
    } catch (err) {
      clearSpinnerTimers();
      spinner.fail(chalk.red('failed'));
      console.log('');
      const msg = err instanceof Error ? err.message : String(err);
      const lower = msg.toLowerCase();
      if (lower.includes('credit balance') || lower.includes('400')) {
        console.error(chalk.red('Your API key has no credits. Top up your account at the provider and try again.'));
      } else if (lower.includes('invalid') || lower.includes('401')) {
        console.error(chalk.red('Your API key looks incorrect. Run zenoai reset to enter a new one.'));
      } else if (lower.includes('429')) {
        console.error(chalk.red('You have hit the rate limit. Wait a moment and try again.'));
      } else {
        console.error(chalk.red('Something went wrong. Check your API key and internet connection and try again.'));
      }
      process.exit(1);
    }


    let report: HealthReport;
    let reportSource: 'ai' | 'ai-retry' | 'deterministic-fallback' = 'ai';
    let malformedOutput: string | undefined;
    try {
      report = parseHealthReport(raw);
    } catch (firstParseErr) {
      malformedOutput = raw;
      if (isShipReadinessAction(opts.action)) {
        console.log(theme.caution('Warning: AI report formatting failed. Retrying with a shorter schema...'));
        try {
          const repaired = await callAI(
            opts.config,
            buildRepairPrompt(raw),
            SHIP_READINESS_PROMPT,
            1800,
          );
          report = parseHealthReport(repaired);
          reportSource = 'ai-retry';
        } catch {
          console.log(theme.caution('Warning: AI report formatting failed. Showing deterministic scan summary instead.'));
          report = fallbackReportFromScan(shipScan as ShipReadinessScan);
          reportSource = 'deterministic-fallback';
        }
      } else {
        console.warn(chalk.yellow('Warning: could not parse structured report.'));
        console.error(firstParseErr instanceof Error ? firstParseErr.message : String(firstParseErr));
        process.exit(1);
      }
    }

    if (isShipReadinessAction(opts.action)) {
      if (projectTypeResolution) {
        report.projectType = projectTypeResolution.projectType;
      }
      report = applyPrimaryFlowVerdictCap(report, shipScan);
      const localReportPath = await saveShipReadinessLocalReport({
        root,
        report,
        fileCount: files.length,
        scan: shipScan,
        projectTypeResolution,
        provider: opts.config.provider,
        model: modelForProvider(opts.config.provider),
        source: reportSource,
        malformedOutput,
      });
      printShipReadinessReport(report, root, files.length, localReportPath, shipScan, projectTypeResolution);
      const openReport = await confirm({ message: 'Open full report in browser?', default: true });
      if (openReport) {
        try {
          await openFileInBrowser(localReportPath.htmlAbsolutePath);
          console.log(theme.success('Opened full report in your browser.'));
        } catch {
          console.log(theme.caution('Could not open the report automatically.'));
          console.log(theme.muted(`Open manually: ${manualOpenCommand(localReportPath.htmlAbsolutePath)}`));
        }
      }
    } else {
      printReport(report, root, files.length, normalizedAction);
    }
    await saveReport(report, root, files.length);

    process.exit(0);
  }

  console.log(chalk.yellow('running…'));
  // TODO: other role/action combinations
  process.exit(0);
}

function printReport(report: HealthReport, root: string, fileCount: number, action: string): void {
  const now = new Date();
  const date = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  const datetime = `${date}, ${time}`;
  const labelFn = scoreChalk(report.label);

  // ── Header ──────────────────────────────────────────────────────────────────
  console.log(theme.title('━━━  ZENOAI — CODEBASE HEALTH REPORT  ━━━'));
  console.log(theme.muted(`Directory : ${root}`));
  console.log(theme.muted(`Files     : ${fileCount}`));
  console.log(theme.muted(`Action    : ${action}`));
  console.log(theme.muted(`Date      : ${datetime}\n`));

  // ── Health Score ─────────────────────────────────────────────────────────────
  console.log(theme.heading('Health Score'));
  console.log(`  ${chalk.bold(labelFn(`${report.score} / 10`))}  ${labelFn(`[${report.label}]`)}`);
  console.log(`  ${theme.muted(report.summary)}\n`);

  // ── Risky Files table ────────────────────────────────────────────────────────
  if (report.files && report.files.length > 0) {
    console.log(theme.heading('Risky Files'));

    const table = new Table({
      head: [
        theme.heading('File'),
        theme.heading('Risk'),
        theme.heading('Legibility'),
        theme.heading('Consequence'),
      ],
      colWidths: [36, 12, 12, 48],
      wordWrap: true,
      style: { head: [], border: ['dim'] },
    });

    for (const f of report.files) {
      table.push([
        theme.file(f.path),
        riskColor(f.risk),
        legibilityColor(f.legibility),
        theme.muted(f.consequence),
      ]);
    }

    console.log(table.toString());
    console.log('');
  }

  // ── Observations ─────────────────────────────────────────────────────────────
  if (report.observations && report.observations.length > 0) {
    console.log(theme.heading('Observations'));
    report.observations.forEach((obs, i) => {
      console.log(`  ${theme.muted(`${i + 1}.`)} ${theme.text(obs)}`);
    });
    console.log('');
  }

  // ── Suggested Actions ─────────────────────────────────────────────────────────
  if (report.actions && report.actions.length > 0) {
    console.log(theme.heading('Suggested Actions'));
    report.actions.forEach((item, i) => {
      console.log(`  ${theme.heading(`${i + 1}.`)} ${theme.text(item.instruction)}`);
      console.log(`     ${theme.muted(item.rationale)}`);
    });
    console.log('');
  }

  // ── Start Here ────────────────────────────────────────────────────────────────
  if (report.start) {
    const box = boxen(theme.heading('Where to start\n\n') + theme.text(report.start), {
      padding: { top: 0, bottom: 0, left: 2, right: 2 },
      borderStyle: 'round',
      borderColor: '#F59E0B',
      dimBorder: false,
    });
    console.log(box);
    console.log('');
  }

  console.log(theme.divider('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
}

function printShipReadinessReport(
  report: HealthReport,
  root: string,
  fileCount: number,
  localReportPath: { jsonPath: string; htmlPath: string; csvPath: string; htmlFileUrl: string; htmlAbsolutePath: string },
  scan: ShipReadinessScan | null,
  projectTypeResolution?: ProjectTypeResolution,
): void {
  const now = new Date();
  const date = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  const datetime = `${date}, ${time}`;
  const verdict = shipAnswer(report);
  const hardBlockers = report.hardBlockers ?? [];
  const softBlockers = report.softBlockers ?? [];
  const codeOwnershipRisks = report.codeOwnershipRisks ?? [];
  const fullHardCount = Math.max(
    hardBlockers.length,
    scan?.launchFindings.filter(finding => finding.category === 'hard_blocker' || finding.category === 'hard_blocker_candidate').length ?? 0,
  );
  const fullSoftCount = Math.max(
    softBlockers.length,
    scan?.launchFindings.filter(finding => finding.category === 'soft_blocker').length ?? 0,
  );
  const fullOwnershipCount = Math.max(
    codeOwnershipRisks.length,
    scan?.launchFindings.filter(finding => finding.category === 'code_ownership_risk').length ?? 0,
  );

  console.log(theme.title('━━━  ZENOAI — SHIP READINESS REPORT  ━━━'));
  console.log(theme.muted(`Project     : ${basename(root)}`));
  console.log(theme.muted('Reviewed by : Engineering Manager'));
  if (report.projectType) {
    const projectTypeBadge = projectTypeResolution
      ? projectTypeResolution.source === 'saved'
        ? 'Saved'
        : projectTypeResolution.source === 'user_confirmed' || projectTypeResolution.source === 'changed_confirmed'
          ? 'User confirmed'
          : formatConfidenceLabel(projectTypeResolution.confidenceLabel)
      : report.confidence;
    console.log(theme.muted(`Project type: ${report.projectType}${projectTypeBadge ? ` [${projectTypeBadge}]` : ''}`));
  }
  console.log(theme.muted(`Files       : ${fileCount}`));
  console.log(theme.muted(`Date        : ${datetime}\n`));

  console.log(theme.heading('Verdict'));
  console.log(`${chalk.bold(verdict.color(verdict.answer))}  ${verdict.color(`[${verdict.risk}]`)}`);
  console.log('');

  if (report.confidence) {
    console.log(theme.heading('Confidence'));
    console.log(`  ${theme.text(report.confidence)}\n`);
  }

  console.log(theme.heading('Founder summary'));
  console.log(`  ${theme.muted(report.founderSummary ?? report.summary)}\n`);

  printShipIssueSummary(fullHardCount, fullSoftCount, fullOwnershipCount, hardBlockers.length, softBlockers.length, codeOwnershipRisks.length);
  printTopIssuesTable(hardBlockers, softBlockers, codeOwnershipRisks);
  printShipIssues('Hard blockers', hardBlockers, 3);
  printMoreIssues('hard blocker', fullHardCount, Math.min(hardBlockers.length, 3));
  printShipIssues('Soft blockers', softBlockers, 3);
  printMoreIssues('soft blocker', fullSoftCount, Math.min(softBlockers.length, 3));
  printShipIssues('Code ownership risks', codeOwnershipRisks, 3);
  printMoreIssues('code ownership risk', fullOwnershipCount, Math.min(codeOwnershipRisks.length, 3));

  if (report.privatePreview || report.publicLaunch || report.paidTraffic) {
    console.log(theme.heading('Can ship?'));
    if (report.privatePreview) {
      console.log(`  ${theme.heading('Private preview:')} ${formatShipDecision(report.privatePreview.answer)} ${theme.muted(report.privatePreview.reason)}`);
    }
    if (report.publicLaunch) {
      console.log(`  ${theme.heading('Public launch:')}   ${formatShipDecision(report.publicLaunch.answer)} ${theme.muted(report.publicLaunch.reason)}`);
    }
    if (report.paidTraffic) {
      console.log(`  ${theme.heading('Paid traffic:')}    ${formatShipDecision(report.paidTraffic.answer)} ${theme.muted(report.paidTraffic.reason)}`);
    }
    console.log('');
  }

  const safestNextStep = report.safestNextStep ?? report.start;
  if (safestNextStep) {
    console.log(theme.heading('Safest next step'));
    console.log(`  ${theme.text(safestNextStep)}\n`);
  }

  if (scan && scan.launchFindings.length > 0) {
    console.log(theme.muted(`Deterministic findings saved: ${scan.launchFindings.length} launch finding${scan.launchFindings.length === 1 ? '' : 's'}`));
  }
  console.log(theme.success('Full report saved:'));
  console.log(theme.muted(`JSON: ${localReportPath.jsonPath}`));
  console.log(theme.muted(`HTML: ${localReportPath.htmlPath}`));
  console.log(theme.muted(`CSV: ${localReportPath.csvPath}`));
  console.log('');
  console.log(theme.heading('View full report:'));
  console.log(theme.info(localReportPath.htmlFileUrl));
  console.log('');
  console.log(theme.heading('Or open manually:'));
  console.log(theme.muted(manualOpenCommand(localReportPath.htmlAbsolutePath)));
  console.log(theme.divider('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
}

function formatShipDecision(answer: 'Yes' | 'Maybe' | 'No'): string {
  if (answer === 'Yes') return theme.success('Yes');
  if (answer === 'Maybe') return theme.caution('Maybe');
  return theme.danger('No');
}

function printShipIssueSummary(
  hardCount: number,
  softCount: number,
  ownershipCount: number,
  hardShowing: number,
  softShowing: number,
  ownershipShowing: number,
): void {
  console.log(theme.heading('Issue summary'));
  const table = new Table({
    head: [theme.heading('Category'), theme.heading('Found'), theme.heading('Showing')],
    colWidths: [24, 10, 10],
    style: { head: [], border: ['dim'] },
  });
  table.push(
    [theme.text('Hard blockers'), String(hardCount), String(Math.min(hardShowing, 3))],
    [theme.text('Soft blockers'), String(softCount), String(Math.min(softShowing, 3))],
    [theme.text('Code ownership risks'), String(ownershipCount), String(Math.min(ownershipShowing, 3))],
  );
  console.log(table.toString());
  console.log('');
}

function printTopIssuesTable(
  hardBlockers: NonNullable<HealthReport['hardBlockers']>,
  softBlockers: NonNullable<HealthReport['softBlockers']>,
  codeOwnershipRisks: NonNullable<HealthReport['codeOwnershipRisks']>,
): void {
  const rows = [
    ...hardBlockers.slice(0, 3).map(issue => ({ category: 'Hard', issue })),
    ...softBlockers.slice(0, 3).map(issue => ({ category: 'Soft', issue })),
    ...codeOwnershipRisks.slice(0, 3).map(issue => ({ category: 'Ownership', issue })),
  ];

  if (rows.length === 0) return;

  console.log(theme.heading('Top issues'));
  const table = new Table({
    head: [
      theme.heading('Category'),
      theme.heading('Severity'),
      theme.heading('Certainty'),
      theme.heading('Issue'),
    ],
    colWidths: [12, 12, 22, 48],
    wordWrap: true,
    style: { head: [], border: ['dim'] },
  });

  for (const row of rows) {
    table.push([
      theme.text(row.category),
      riskColor(row.issue.severity),
      theme.muted(row.issue.certainty ? formatCertainty(row.issue.certainty) : ''),
      theme.text(shortIssueLabel(row.issue.issue)),
    ]);
  }

  console.log(table.toString());
  console.log('');
}

function pluralize(label: string, count: number): string {
  if (count === 1) return label;
  if (label === 'code ownership risk') return 'code ownership risks';
  return `${label}s`;
}

function printMoreIssues(label: string, count: number, showing: number): void {
  const remaining = count - showing;
  if (remaining > 0) {
    console.log(theme.muted(`+ ${remaining} more ${pluralize(label, remaining)} in full local report`));
    console.log('');
  }
}

function shortIssueLabel(issue: string): string {
  const lower = issue.toLowerCase();
  if (/capture|waitlist|email|form/.test(lower) && /unwired|verification|appears/.test(lower)) return 'Capture flow unwired';
  if (/cta|button/.test(lower)) return 'CTA needs verification';
  if (/og|social|twitter|metadata/.test(lower)) return 'Missing social metadata';
  if (/analytics/.test(lower)) return 'No analytics';
  if (/heavy|animation|media|performance|mobile/.test(lower)) return 'Mobile perf risk';
  if (/large file|monolith|lines/.test(lower)) return 'Large page file';
  if (/browser global|browser api|node runtime|hydration|ssr/.test(lower)) return 'Browser API guard risk';
  if (/test/.test(lower)) return 'No tests';
  if (/robots|sitemap/.test(lower)) return 'SEO files missing';
  if (/bin target/.test(lower)) return 'Bin target missing';
  if (/install command/.test(lower)) return 'Install command wrong';
  if (/filesystem/.test(lower)) return 'FS safety guard';
  if (/config validation|config/.test(lower)) return 'Config validation';
  if (/error handling/.test(lower)) return 'CLI error handling';
  if (/cli|entrypoint|bin/.test(lower)) return 'CLI entrypoint';
  return issue.length > 42 ? `${issue.slice(0, 39)}...` : issue;
}

function printShipIssues(
  title: string,
  issues: HealthReport['hardBlockers'],
  limit = 3,
): void {
  if (!issues || issues.length === 0) return;

  console.log(theme.heading(title));
  issues.slice(0, limit).forEach((item, index) => {
    const certainty = item.certainty ? ` [${formatCertainty(item.certainty)}]` : '';
    console.log(`  ${theme.heading(`${index + 1}.`)} ${theme.text(item.issue)} ${riskColor(item.severity)}${theme.muted(certainty)}`);
    console.log(`     ${theme.muted('Evidence:')} ${theme.muted(item.evidence)}`);
    console.log(`     ${theme.muted('Risk:')} ${theme.muted(item.risk)}`);
    console.log(`     ${theme.muted('Fix:')} ${theme.muted(item.suggestedFix)}`);
  });
  console.log('');
}

function formatCertainty(certainty: NonNullable<HealthReport['hardBlockers']>[number]['certainty']): string {
  switch (certainty) {
    case 'confirmed': return 'Confirmed';
    case 'likely': return 'Likely';
    case 'needs_verification': return 'Needs verification';
    case 'inferred': return 'Inferred';
    default: return '';
  }
}

function legibilityColor(score: number): string {
  if (score >= 8) return theme.success(String(score));
  if (score >= 5) return chalk.hex('#FBBF24')(String(score));
  return theme.danger(String(score));
}

function printNoStrongTargetsMessage(
  action: 'humanise' | 'slim' | 'stress-test',
  skippedFiles: Array<{ path: string; reason: string }> = [],
): void {
  const actionLabel = action === 'humanise'
    ? 'Humanise'
    : action === 'slim'
      ? 'Slim it down'
      : 'Stress test';
  console.log(chalk.yellow(`No useful ${actionLabel} targets found.`));
  const skippedText = skippedFiles.map(s => `${s.path} ${s.reason}`).join('\n').toLowerCase();

  if (action === 'humanise' || action === 'slim') {
    const recommendations: string[] = [];
    if (skippedText.includes('high-consequence') || skippedText.includes('server integration')) {
      recommendations.push('Try Stress test it for routes, webhooks, auth, payment, or server integration flows.');
    }
    if (skippedText.includes('too large')) {
      recommendations.push('Use Split it later for large components or route modules.');
    }
    if (skippedText.includes('framework shell') || skippedText.includes('framework integration') || skippedText.includes('configuration file')) {
      recommendations.push('Framework setup and config files usually need tests or feature work, not readability cleanup.');
    }
    if (skippedText.includes('presentational component')) {
      recommendations.push('Static UI components are already simple enough; Zeno will skip them unless there is real logic to clean up.');
    }
    if (recommendations.length === 0) {
      recommendations.push('Try a different action or a narrower project directory with more local business logic.');
    }

    console.log(chalk.dim('Most remaining files are already too small, framework setup files, configuration files, risky untested files, or better suited for splitting.'));
    for (const recommendation of recommendations) {
      console.log(chalk.dim(recommendation));
    }
    return;
  }

  console.log(chalk.dim('No useful test targets were found. Try a different project area with more business logic.'));
}

function printViabilitySummary(
  viability: ReturnType<typeof classifySelectedFiles>,
): void {
  if (viability.advisoryOnly.length > 0) {
    console.log(chalk.dim('\nSplit it candidates:'));
    for (const filePath of viability.advisoryOnly) {
      console.log(chalk.dim(`  - ${filePath}`));
    }
  }

  if (viability.riskyUntestedVisual.length > 0) {
    console.log(chalk.dim('\nNeeds tests first:'));
    for (const filePath of viability.riskyUntestedVisual) {
      console.log(chalk.dim(`  - ${filePath}`));
    }
  }

  if (viability.complexityBlocked.length > 0) {
    console.log(chalk.dim('\nNeeds split or tests first:'));
    for (const filePath of viability.complexityBlocked) {
      console.log(chalk.dim(`  - ${filePath}`));
    }
  }

  if (viability.weakCleanupTarget.length > 0) {
    console.log(chalk.dim('\nLow-impact cleanup targets:'));
    for (const filePath of viability.weakCleanupTarget) {
      console.log(chalk.dim(`  - ${filePath}`));
    }
  }
}

export async function runPhase2(
  projectPath: string,
  action: 'humanise' | 'slim' | 'stress-test',
  persona: string,
): Promise<void> {
  // Step 1 — preflight
  const preflight = await runPreflight();
  if (!preflight.passed) {
    console.error(chalk.red('Cannot start — ' + preflight.errors.join(', ')));
    process.exit(1);
  }

  // Step 2 — analyst
  const spinner = ora('Analysing codebase...').start();
  const { reports, graph } = await analyse(projectPath);
  const reportByPath = new Map(reports.map(report => [report.path, report]));
  spinner.succeed(`Found ${reports.length} files`);

  spinner.start('Finding files Zeno can safely change...');
  const preGate = await runPrePlannerGate(reports, action);
  if (preGate.eligibleReports.length === 0) {
    spinner.succeed('0 useful cleanup targets found');
  } else {
    spinner.succeed(`${preGate.eligibleReports.length} file${preGate.eligibleReports.length === 1 ? '' : 's'} look changeable`);
  }

  if (preGate.skippedFiles.length > 0) {
    console.log(chalk.dim(`ⓘ ${preGate.skippedFiles.length} files skipped before review.`));
    for (const skipped of preGate.skippedFiles.slice(0, 8)) {
      console.log(chalk.dim(`  skipped: ${skipped.path} (${skipped.reason})`));
    }
    if (preGate.skippedFiles.length > 8) {
      console.log(chalk.dim(`  ...and ${preGate.skippedFiles.length - 8} more`));
    }
    console.log('');
  }

  if (preGate.eligibleReports.length === 0) {
    printNoStrongTargetsMessage(action, preGate.skippedFiles);
    await rollback(preflight.manifestPath);
    process.exit(0);
  }

  // Step 3 — planner
  spinner.start('Choosing the safest files to change...');
  const plan = await runPlanner(graph, preGate.eligibleReports, action);
  spinner.succeed(`Selected ${plan.selectedFiles.length} files`);

  if (plan.selectedFiles.length === 0) {
    printNoStrongTargetsMessage(action, preGate.skippedFiles);
    await rollback(preflight.manifestPath);
    process.exit(0);
  }

  const viability = classifySelectedFiles(plan.selectedFiles, reportByPath);
  if (action === 'humanise' && viability.refactorable.length === 0) {
    console.log(chalk.yellow('No safe Humanise targets found. No AI review was started.'));
    printViabilitySummary(viability);
    console.log(chalk.dim('\nRecommended next action: run Split it for large components, or Stress test it for risky untested components.'));
    await rollback(preflight.manifestPath);
    process.exit(0);
  }

  if (action === 'humanise' && viability.refactorable.length === 1 && plan.selectedFiles.length > 3) {
    console.log(chalk.yellow(`Only 1 useful Humanise target found out of ${plan.selectedFiles.length} selected files.`));
    printViabilitySummary(viability);
    const continueWithSingleTarget = await confirm({
      message: `Continue with ${viability.refactorable[0]} only?`,
      default: false,
    });
    if (!continueWithSingleTarget) {
      console.log(chalk.yellow('\nRun cancelled. Cleaning up...'));
      await rollback(preflight.manifestPath);
      console.log(chalk.yellow('Branch removed. Your repo is unchanged.'));
      process.exit(0);
    }
    plan.selectedFiles = viability.refactorable;
  }

  const { loadHistory } = await import('./history.js');
  const runHistory = await loadHistory(process.cwd());
  const skippedCount = runHistory.actions[action]?.skipped?.length ?? 0;

  if (skippedCount > 0) {
    console.log(chalk.dim(`ⓘ ${skippedCount} files were skipped in previous ${action} runs.`));
    console.log(chalk.dim('  Zeno will avoid retrying the same low-value changes automatically.'));
  }

  // [COST_DISPLAY] — comment out this entire block when subscription model is active
  const estimatedCost = (plan.selectedFiles.length * 0.18).toFixed(2);

  console.log(theme.info('\nFiles selected for refactoring:'));
  plan.selectedFiles.forEach((f, i) => {
    console.log(chalk.white(`  ${i + 1}. ${f}`));
  });

  console.log('');
  console.log(chalk.yellow(`Estimated max API cost: ~$${estimatedCost}`));
  console.log(chalk.dim(`Based on up to ${plan.selectedFiles.length} files. Actual cost may be lower if Zeno skips files during review.`));

  const proceedWithCost = await confirm({ message: 'Proceed with this run?', default: true });

  if (!proceedWithCost) {
    console.log(chalk.yellow('\nRun cancelled. Cleaning up...'));
    await rollback(preflight.manifestPath);
    console.log(chalk.yellow('Branch removed. Your repo is unchanged.'));
    process.exit(0);
  }
  // [/COST_DISPLAY]

  // Step 4 — reviewer + validator + critic loop
  const results: ValidatorResult[] = [];
  for (const filePath of plan.selectedFiles) {
    const fileReport = reportByPath.get(filePath);
    const gateDecision = await runRefactorGate(filePath, action, fileReport);

    if (gateDecision.kind === 'large-file-advisory') {
      spinner.start(`Finding the safest first split for ${basename(filePath)}...`);
      const advisory = await runLargeFileAdvisor(filePath, action, fileReport);
      spinner.warn(`Skipped ${basename(filePath)}: ${advisory.reason}`);
      results.push({
        filePath,
        status: 'skipped' as const,
        confidenceScore: 0,
        skipReason: advisory.reason,
        largeFileAdvisory: advisory,
      });
      continue;
    }

    if (gateDecision.kind === 'skip') {
      spinner.warn(`Skipped ${basename(filePath)}: ${gateDecision.reason}`);
      results.push({
        filePath,
        status: 'skipped' as const,
        confidenceScore: 0,
        skipReason: gateDecision.reason,
      });
      continue;
    }

    spinner.start(`Planning changes for ${basename(filePath)}...`);
    const reviewed = await runReviewer(filePath, action, fileReport);

    if (reviewed.skip) {
      const skippedResult: ValidatorResult = {
        filePath,
        status: 'skipped' as const,
        confidenceScore: 0,
        skipReason: reviewed.skipReason ?? 'reviewer skipped this file',
      };

      spinner.warn(`Skipped ${basename(filePath)}: ${skippedResult.skipReason}`);
      results.push(skippedResult);
      continue;
    }

    spinner.start(`Checking ${basename(filePath)}...`);
    const validated = await runValidator(filePath, reviewed.changes, action, fileReport);
    if (validated.status === 'skipped') {
      spinner.warn(`Skipped ${basename(filePath)}: ${validated.skipReason}`);
      results.push(validated);
      continue;
    }

    spinner.start(`Checking final diff for ${basename(filePath)}...`);
    const critiqued = await runCritic(validated, reviewed.changes, action);
    if (critiqued.status === 'skipped') {
      spinner.warn(`Skipped ${basename(filePath)}: ${critiqued.skipReason}`);
    } else {
      spinner.succeed(`${basename(filePath)} — accepted with confidence ${critiqued.confidenceScore.toFixed(2)}`);
    }
    results.push(critiqued);
  }

  // Step 5 — differ
  const manifest = JSON.parse(await readFile(preflight.manifestPath, 'utf8')) as Record<string, unknown>;
  manifest['action'] = action;
  manifest['persona'] = persona;
  await writeFile(preflight.manifestPath, JSON.stringify(manifest, null, 2));

  await runDiffer(results, manifest as unknown as Parameters<typeof runDiffer>[1], preflight.manifestPath);
}

export async function runSplit(
  projectPath: string,
  persona: string,
): Promise<void> {
  const spinner = ora('Analysing large files...').start();
  const { reports } = await analyse(projectPath);
  const candidates = reports
    .filter(report => report.lines > MAX_AUTONOMOUS_REFACTOR_LINES)
    .sort((a, b) => b.lines - a.lines);

  spinner.succeed(`Found ${candidates.length} large file${candidates.length === 1 ? '' : 's'} for Split it`);

  if (candidates.length === 0) {
    console.log(chalk.yellow('No large files found for Split it.'));
    console.log(chalk.dim(`Split it currently targets files over ${MAX_AUTONOMOUS_REFACTOR_LINES} lines.`));
    process.exit(0);
  }

  const target = candidates[0];
  console.log(theme.info('\nStarting with:'));
  console.log(chalk.white(`  ${target.path} (${target.lines} lines, ${target.functions} functions)`));
  if (candidates.length > 1) {
    console.log(chalk.dim(`  ${candidates.length - 1} more large file${candidates.length === 2 ? '' : 's'} can be handled in later runs.`));
  }

  console.log(chalk.dim('\nZeno will start with the safest split: moving static constants and data into a sibling module.'));
  console.log(chalk.dim('This step does not spend API credits.'));

  const proceed = await confirm({ message: 'Proceed with this split?', default: true });
  if (!proceed) {
    console.log(chalk.yellow('Run cancelled. Your repo is unchanged.'));
    process.exit(0);
  }

  const preflight = await runPreflight();
  if (!preflight.passed) {
    console.error(chalk.red('Cannot start — ' + preflight.errors.join(', ')));
    process.exit(1);
  }

  spinner.start(`Splitting ${basename(target.path)}...`);
  const result = await runStaticSplit(target);
  if (result.status === 'accepted') {
    spinner.succeed(`${basename(target.path)} — extracted static data`);
  } else {
    spinner.warn(`Skipped ${basename(target.path)}: ${result.skipReason}`);
  }

  const manifest = JSON.parse(await readFile(preflight.manifestPath, 'utf8')) as Record<string, unknown>;
  manifest['action'] = 'split';
  manifest['persona'] = persona;
  await writeFile(preflight.manifestPath, JSON.stringify(manifest, null, 2));

  await runDiffer([result], manifest as unknown as Parameters<typeof runDiffer>[1], preflight.manifestPath);
}
