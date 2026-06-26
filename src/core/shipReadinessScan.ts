import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import type { FileReport } from './analyst.js';
import { isHighConsequencePath } from './riskSignals.js';
import type { ProjectType } from '../types.js';

export interface PackageScan {
  name?: string;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'unknown';
  framework: string;
  scripts: Record<string, string>;
  binEntries: Array<{ command: string; target: string }>;
  bin: string[];
  hasBin: boolean;
  hasBuildScript: boolean;
  hasLintScript: boolean;
  hasTestScript: boolean;
  dependencies: string[];
  devDependencies: string[];
}

export interface SourceFinding {
  path: string;
  evidence: string;
}

type FileRole = 'runtime' | 'layout' | 'docs' | 'draft' | 'fixture' | 'config' | 'test';

export interface LaunchFinding {
  category: 'hard_blocker' | 'hard_blocker_candidate' | 'soft_blocker' | 'code_ownership_risk';
  issue: string;
  severity: 'Critical' | 'High' | 'Medium' | 'Low';
  certainty: 'confirmed' | 'likely' | 'needs_verification' | 'inferred';
  evidence: string;
  suggestedFix: string;
}

export type ActionFlowType =
  | 'email_capture'
  | 'preorder'
  | 'book_demo'
  | 'contact_sales'
  | 'cta_navigation'
  | 'cli_install'
  | 'cli_entrypoint'
  | 'command_execution'
  | 'filesystem_write_safety'
  | 'config_loading'
  | 'auth_flow'
  | 'protected_route'
  | 'dashboard_load'
  | 'settings_save'
  | 'data_write'
  | 'billing_checkout'
  | 'invite_user'
  | 'destructive_action'
  | 'integration_connect'
  | 'auth'
  | 'checkout'
  | 'unknown';

export type ActionFlowStatus =
  | 'wired'
  | 'likely_unwired'
  | 'needs_verification'
  | 'not_detected';

export interface ActionFlowFinding {
  type: ActionFlowType;
  label: string;
  status: ActionFlowStatus;
  severity: 'Critical' | 'High' | 'Medium' | 'Low';
  certainty: 'confirmed' | 'likely' | 'needs_verification' | 'inferred';
  evidence: string[];
  risk: string;
  fix: string;
}

export interface ProjectTypeDetection {
  primaryType: ProjectType;
  confidence: number;
  confidenceLabel: 'low' | 'medium' | 'high';
  secondaryTypes: ProjectType[];
  signals: string[];
  conflictingSignals: string[];
  shouldAskUser: boolean;
  scores: Partial<Record<ProjectType, number>>;
}

export interface PrimaryFlowVerdictCap {
  score: 4;
  label: 'Concerning';
  verdict: 'Not yet';
  risk: 'High risk';
  reason: string;
  finding: LaunchFinding;
}

export interface DevtoolScan {
  binTargets: SourceFinding[];
  missingBinTargets: SourceFinding[];
  installCommands: SourceFinding[];
  installCommandMismatches: SourceFinding[];
  filesystemWrites: SourceFinding[];
  unsafeFilesystemWrites: SourceFinding[];
  cliExecutionSignals: SourceFinding[];
  cliErrorHandlingSignals: SourceFinding[];
  configUsage: SourceFinding[];
  configValidationSignals: SourceFinding[];
}

export interface SaasDashboardScan {
  authRouteSignals: SourceFinding[];
  protectedRouteSignals: SourceFinding[];
  authGuardSignals: SourceFinding[];
  authPackageSignals: SourceFinding[];
  dataWrites: SourceFinding[];
  validationSignals: SourceFinding[];
  errorHandlingSignals: SourceFinding[];
  envValidationSignals: SourceFinding[];
  billingSignals: SourceFinding[];
  webhookSignatureSignals: SourceFinding[];
  dashboardSignals: SourceFinding[];
  dashboardStateSignals: SourceFinding[];
  destructiveActions: SourceFinding[];
  destructiveConfirmationSignals: SourceFinding[];
}

export interface ShipReadinessScan {
  projectType: ProjectType;
  projectTypeDetection: ProjectTypeDetection;
  package: PackageScan;
  testFiles: string[];
  routeFiles: string[];
  apiRoutes: string[];
  largestFiles: Array<{ path: string; lines: number; functions: number }>;
  todos: SourceFinding[];
  forms: SourceFinding[];
  suspiciousForms: SourceFinding[];
  buttons: SourceFinding[];
  suspiciousButtons: SourceFinding[];
  suspiciousLinks: SourceFinding[];
  networkCalls: SourceFinding[];
  metadata: {
    hasMetadata: boolean;
    hasOpenGraph: boolean;
    hasTwitter: boolean;
    files: string[];
  };
  publicFiles: {
    hasRobotsTxt: boolean;
    hasSitemap: boolean;
  };
  analytics: SourceFinding[];
  envUsage: SourceFinding[];
  browserGlobals: SourceFinding[];
  useEffectBrowserCoupling: SourceFinding[];
  heavyAssets: SourceFinding[];
  missingAltText: SourceFinding[];
  reducedMotion: SourceFinding[];
  riskyFiles: SourceFinding[];
  actionFlows: ActionFlowFinding[];
  devtool: DevtoolScan;
  saasDashboard: SaasDashboardScan;
  launchFindings: LaunchFinding[];
  evidence: string[];
}

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.astro']);
const PROJECT_FILE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.astro', '.md', '.mdx']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.next', 'coverage', 'out', 'build', 'fixtures']);
const TEST_RE = /(?:^|[./_-])(?:test|tests|spec|__tests__)(?:[./_-]|$)|\.(?:test|spec)\.[tj]sx?$/i;
const CAPTURE_COPY_RE = /\b(waitlist|join(?:ed)?|pre[\s-]?order|early access|request access|book demo|contact sales|contact us|sign up|signup|get started)\b/i;
const EMAIL_CAPTURE_RE = /type\s*=\s*["']email["']|name\s*=\s*["']email["']|placeholder\s*=\s*["'][^"']*(email|waitlist|join|pre[\s-]?order|access|demo|contact)[^"']*["']|\b(email|setEmail)\b/i;
const SUBMISSION_PATH_RE = /fetch\s*\(|axios\.|ky\s*\(|got\s*\(|navigator\.sendBeacon|action\s*=|formAction\s*=|['"]use server['"]|\/api\b|export\s+async\s+function\s+POST\b|supabase|firebase|prisma|drizzle|database|db\.\w+\.(create|insert|upsert)|resend|mailchimp|convertkit|loops|hubspot|airtable|google\s*sheets|notion|webhook|zapier|make\.com/i;
const OWNED_CAPTURE_SUBMISSION_RE = /(?:fetch|axios|ky|got)\s*\(\s*["'][^"']*\/api\b|action\s*=\s*["'][^"']*\/api\b|formAction\s*=|['"]use server['"]|export\s+async\s+function\s+POST\b|supabase\.from\s*\(|firebase\.|prisma\.|drizzle\.|db\.\w+\.(create|insert|upsert)|resend\.|mailchimp\.|convertkit\.|loops\.|hubspot\.|airtable\./i;
const KNOWN_CAPTURE_PROVIDER_RE = /(?:https?:\/\/|action\s*=\s*["'][^"']*|fetch\s*\(\s*["'][^"']*)(?:formspree|typeform|tally|hubspot|mailchimp|convertkit|loops|beehiiv|airtable|zapier|make\.com|netlify)/i;
const ENV_ENDPOINT_RE = /process\.env|import\.meta\.env|NEXT_PUBLIC_|PUBLIC_/;
const PARTIAL_SUBMISSION_RE = /onSubmit\s*=|handleSubmit|preventDefault\(\)|set[A-Z]\w*\([^)]*['"`]?\s*['"`]?\)|reset\(/i;
const CTA_TEXT_RE = /\b(start|join|pre[\s-]?order|sign up|signup|book demo|contact|contact sales|get started|try now|install|docs|download|request access)\b/i;
const NAVIGATION_RE = /href\s*=|router\.push|navigate\s*\(|window\.location|location\.href|Link\s+href|to\s*=/i;
const INSTALL_COMMAND_RE = /\b(?:npx|bunx)\s+(@?[\w.-]+(?:\/[\w.-]+)?)(?=\s|$)|\bpnpm\s+dlx\s+(@?[\w.-]+(?:\/[\w.-]+)?)(?=\s|$)|\bnpm\s+(?:install|i)\s+(@?[\w.-]+(?:\/[\w.-]+)?)(?=\s|$)/gi;
const FILESYSTEM_WRITE_RE = /\b(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync|writeFile|writeFileSync|rename|renameSync|cp|cpSync)\s*\(|\b(?:execa|exec|execSync|spawn|spawnSync)\s*\(\s*['"`][^'"`]*(?:rm|mv|cp|unlink|rmdir)\b/i;
const FILESYSTEM_SAFETY_RE = /\b(?:dryRun|dry-run|confirm|confirmation|backup|allowlist|allow-list|safePath|rollback|manifest|preview|diff)\b/i;
const CLI_EXECUTION_RE = /\b(?:program\.parse|parseAsync|command\s*\(|action\s*\(|execa\s*\(|exec\s*\(|fetch\s*\(|client\.(?:messages|responses|chat)|generateContent|runOrchestrator|main\(\))/i;
const ERROR_HANDLING_RE = /\btry\s*\{|\.catch\s*\(|process\.exitCode|console\.error|ora\([^)]*\)\.fail|spinner\.fail|throw new Error/i;
const CONFIG_VALIDATION_RE = /\b(?:validate|ensureConfig|getAiConfig|getApiKey|API key|api key|cannot be empty|missing|reset)\b/i;
const BROWSER_GLOBAL_CODE_RE = /\b(?:window|document|navigator)\s*\.|\btypeof\s+(?:window|document|navigator)\b/;
const AUTH_ROUTE_PATH_RE = /(?:^|\/)(login|signup|sign-in|sign-up|auth|onboarding)(?:\/|\.|$)/i;
const PROTECTED_ROUTE_PATH_RE = /(?:^|\/)(dashboard|settings|account|admin|billing|workspace|organization|team)(?:\/|\.|$)/i;
const DASHBOARD_ROUTE_PATH_RE = /(?:^|\/)(dashboard|admin|analytics|reports|metrics)(?:\/|\.|$)/i;
const AUTH_GUARD_RE = /\b(?:middleware|getServerSession|auth\s*\(|currentUser|requireAuth|withAuth|useSession|redirect\s*\([^)]*(?:login|sign-in|signin|auth)|session\s*\?|session\s*&&|user\s*\?|user\s*&&)\b/i;
const DATA_WRITE_RE = /\b(?:prisma\.\w+\.(?:create|update|delete|upsert)|db\.(?:insert|update|delete)|drizzle\.(?:insert|update|delete)|\.from\s*\([^)]*\)\.(?:insert|update|delete|upsert)|fetch\s*\([^)]*method\s*:\s*['"`](?:POST|PUT|PATCH|DELETE)['"`]|export\s+async\s+function\s+(?:POST|PUT|PATCH|DELETE)\b|['"]use server['"])/is;
const SERVER_DATA_WRITE_RE = /\b(?:prisma\.\w+\.(?:create|update|delete|upsert)|db\.(?:insert|update|delete)|drizzle\.(?:insert|update|delete)|\.from\s*\([^)]*\)\.(?:insert|update|delete|upsert)|export\s+async\s+function\s+(?:POST|PUT|PATCH|DELETE)\b|['"]use server['"])/is;
const VALIDATION_RE = /\b(?:zod|yup|valibot|superstruct|schema\.(?:parse|safeParse)|safeParse\s*\(|parse\s*\(|required|if\s*\([^)]*(?:email|name|id|userId|workspaceId|amount|price|plan|role)[^)]*\))/i;
const USER_ERROR_RE = /\b(?:try\s*\{|\.catch\s*\(|catch\s*\(|return\s+(?:NextResponse\.)?json\s*\([^)]*error|Response\.json\s*\([^)]*error|throw new Error|toast\.(?:error|warning)|setError|errorBoundary|ErrorBoundary)\b/i;
const ENV_VALIDATION_RE = /\b(?:env\.safeParse|envSchema|createEnv|zod.*process\.env|requiredEnv|validateEnv|assertEnv|throw new Error\([^)]*(?:env|environment|DATABASE_URL|STRIPE|CLERK|AUTH|SUPABASE)|if\s*\(\s*!process\.env\.)/is;
const BILLING_RE = /\b(?:stripe|paddle|lemonsqueezy|checkout|billing|subscription|invoice|payment|webhook)\b/i;
const BILLING_EXECUTABLE_RE = /\b(?:stripe|paddle|lemonsqueezy|paypal|checkout\.sessions|paymentIntents|constructEvent|stripe-signature|webhookSecret|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|PADDLE_|LEMONSQUEEZY_|createCheckout|checkoutSession|subscriptionId)\b/i;
const WEBHOOK_SIGNATURE_RE = /\b(?:constructEvent|webhookSignature|signature|svix|stripe-signature|verifyWebhook|verifySignature)\b/i;
const DASHBOARD_STATE_RE = /\b(?:loading|error|empty|skeleton|spinner|fallback|no data|not found|isLoading|isError|isPending|Suspense)\b/i;
const DESTRUCTIVE_ACTION_RE = /\b(?:delete|remove|revoke|disconnect|archive|reset|cancel subscription|downgrade)\b/i;
const DESTRUCTIVE_CONFIRM_RE = /\b(?:confirm|confirmation|dialog|modal|alert|undo|are you sure)\b/i;

function detectPackageManager(root: string): PackageScan['packageManager'] {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) return 'bun';
  if (existsSync(join(root, 'package-lock.json'))) return 'npm';
  return 'unknown';
}

async function readPackage(root: string): Promise<PackageScan> {
  const empty: PackageScan = {
    packageManager: detectPackageManager(root),
    framework: 'unknown',
    scripts: {},
    binEntries: [],
    bin: [],
    hasBin: false,
    hasBuildScript: false,
    hasLintScript: false,
    hasTestScript: false,
    dependencies: [],
    devDependencies: [],
  };

  try {
    const raw = await readFile(join(root, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      name?: string;
      scripts?: Record<string, string>;
      bin?: string | Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const scripts = parsed.scripts ?? {};
    const binEntries = typeof parsed.bin === 'string'
      ? [{ command: parsed.name ?? 'cli', target: parsed.bin }]
      : Object.entries(parsed.bin ?? {}).map(([command, target]) => ({ command, target }));
    const bin = binEntries.map(entry => entry.target);
    const dependencies = Object.keys(parsed.dependencies ?? {});
    const devDependencies = Object.keys(parsed.devDependencies ?? {});
    const allDeps = new Set([...dependencies, ...devDependencies]);

    let framework = 'unknown';
    if (allDeps.has('next')) framework = 'next';
    else if (allDeps.has('@remix-run/react') || allDeps.has('@remix-run/node')) framework = 'remix';
    else if (allDeps.has('astro')) framework = 'astro';
    else if (allDeps.has('vite')) framework = 'vite';
    else if (allDeps.has('react')) framework = 'react';
    else if (allDeps.has('express') || allDeps.has('fastify') || allDeps.has('hono')) framework = 'backend';

    return {
      ...empty,
      name: parsed.name,
      framework,
      scripts,
      binEntries,
      bin,
      hasBin: bin.length > 0,
      hasBuildScript: Boolean(scripts.build),
      hasLintScript: Boolean(scripts.lint),
      hasTestScript: Boolean(scripts.test),
      dependencies,
      devDependencies,
    };
  } catch {
    return empty;
  }
}

function collectSourceFiles(root: string): string[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!SOURCE_EXTS.has(extname(entry.name))) continue;
    const parentDir: string =
      (entry as unknown as { parentPath?: string }).parentPath ??
      (entry as unknown as { path: string }).path;
    const fullPath = join(parentDir, entry.name);
    const relPath = relative(root, fullPath);
    if (relPath.split(sep).some(part => SKIP_DIRS.has(part))) continue;
    files.push(fullPath);
  }
  return files;
}

function collectProjectFiles(root: string): string[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!PROJECT_FILE_EXTS.has(extname(entry.name))) continue;
    const parentDir: string =
      (entry as unknown as { parentPath?: string }).parentPath ??
      (entry as unknown as { path: string }).path;
    const fullPath = join(parentDir, entry.name);
    const relPath = relative(root, fullPath);
    if (relPath.split(sep).some(part => SKIP_DIRS.has(part))) continue;
    files.push(fullPath);
  }
  return files;
}

function includesAny(source: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(source));
}

function pushFinding(target: SourceFinding[], path: string, evidence: string, limit = 20): void {
  if (target.length >= limit) return;
  target.push({ path, evidence });
}

function classifyFileRole(path: string): FileRole {
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  const base = basename(normalized);
  if (TEST_RE.test(normalized)) return 'test';
  if (/(^|\/)(fixtures?|examples?|__mocks__|mock-data)(\/|$)/.test(normalized)) return 'fixture';
  if (/(^|\/)(landing-page-copy|product-brief|copy|drafts?|notes?|scratch|planning|prd|roadmap)(?:[./_-]|$)/.test(normalized)) return 'draft';
  if (/\.(md|mdx)$/.test(normalized) || /(^|\/)(docs?|documentation|guides?)(\/|$)/.test(normalized) || /^readme\.mdx?$/.test(base)) return 'docs';
  if (/package\.json$|tsconfig|astro\.config|next\.config|vite\.config|tailwind\.config|eslint|biome|\.env/.test(normalized)) return 'config';
  if (/(^|\/)(layout|baselayout|head|app)\.(astro|tsx|ts|jsx|js)$/.test(normalized) || /(^|\/)(layouts?|components?)\//.test(normalized)) return 'layout';
  return 'runtime';
}

function isExecutableRole(role: FileRole): boolean {
  return role === 'runtime' || role === 'layout' || role === 'config';
}

function hasAstroOrHtmlOpenGraph(source: string): boolean {
  return /<meta\b[^>]*(?:property|name)\s*=\s*["']og:[^"']+["'][^>]*>/i.test(source);
}

function hasAstroOrHtmlTwitterMetadata(source: string): boolean {
  return /<meta\b[^>]*(?:name|property)\s*=\s*["']twitter:[^"']+["'][^>]*>/i.test(source);
}

function hasAnyMetadata(source: string): boolean {
  return includesAny(source, [
    /export\s+const\s+metadata\s*=/,
    /<Head\b/,
    /metadataBase/i,
    /openGraph/i,
    /twitter/i,
    /<title\b/i,
    /<meta\b[^>]*(?:name|property)\s*=\s*["'](?:description|og:[^"']+|twitter:[^"']+)["'][^>]*>/i,
  ]);
}

function buttonHasExplicitBehavior(button: string, source: string): boolean {
  if (/onClick\s*=|type\s*=\s*["']submit["']|formAction\s*=|disabled\b|popovertarget\s*=|role\s*=\s*["']tab["']|data-copy-command\s*=|data-[\w-]*(?:button|toggle|target|state|open|tab|copy|command|menu)\s*=/i.test(button)) return true;
  const ariaControls = button.match(/aria-controls\s*=\s*["']([^"']+)["']/i)?.[1];
  if (ariaControls && new RegExp(`id\\s*=\\s*["']${ariaControls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i').test(source)) return true;
  const id = button.match(/id\s*=\s*["']([^"']+)["']/i)?.[1];
  if (id && new RegExp(`getElementById\\(\\s*["']${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']\\s*\\)|querySelector\\(\\s*["']#${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']\\s*\\)`, 'i').test(source)) return true;
  return false;
}

function isUtilityButton(button: string): boolean {
  return /role\s*=\s*["']tab["']|aria-controls\s*=|aria-expanded\s*=|aria-label\s*=\s*["'][^"']*(?:copy|menu|navigation|tab|close|open)[^"']*["']|data-copy-command\s*=|data-[\w-]*(?:button|toggle|target|state|open|tab|copy|command|menu)\s*=/i.test(button);
}

function isPrimaryCtaButton(button: string, source: string): boolean {
  if (isUtilityButton(button)) return false;
  const compactButton = button.replace(/\s+/g, ' ');
  return CTA_TEXT_RE.test(compactButton) || CTA_TEXT_RE.test(source);
}

function hasExecutableBillingEvidence(path: string, source: string, role: FileRole, deps: Set<string>): boolean {
  if (!isExecutableRole(role)) return false;
  const hasPaymentDependency = ['stripe', '@stripe/stripe-js', 'paddle', '@paddle/paddle-js', 'lemonsqueezy', 'paypal', '@paypal/react-paypal-js'].some(dep => deps.has(dep));
  if (hasPaymentDependency && BILLING_RE.test(source)) return true;
  if (/(^|\/)(api|app\/api|pages\/api|server|routes?)\/.*(?:checkout|billing|payment|webhook|subscription|invoice)/i.test(path)) return true;
  return BILLING_EXECUTABLE_RE.test(source);
}

function hasDataWriteEvidence(path: string, source: string, role: FileRole): boolean {
  if (!isExecutableRole(role)) return false;
  if (SERVER_DATA_WRITE_RE.test(source)) return true;
  if (!DATA_WRITE_RE.test(source)) return false;
  return apiRouteFile(path) || /(?:^|\/)(server|api|actions?|routes?)\//i.test(path);
}

function hasCaptureFlowSignal(source: string): boolean {
  if (EMAIL_CAPTURE_RE.test(source) && (CAPTURE_COPY_RE.test(source) || /<form\b/i.test(source))) return true;
  return /<form\b[\s\S]*?(?:type\s*=\s*["']email["']|name\s*=\s*["']email["'])[\s\S]*?(?:join|waitlist|early access|pre[\s-]?order|request access|book demo|contact)/i.test(source);
}

function hasActionFlowType(flows: ActionFlowFinding[], type: ActionFlowType): boolean {
  return flows.some(flow => flow.type === type);
}

function detectFlowType(source: string): ActionFlowType {
  if (/\bpre[\s-]?order\b/i.test(source)) return 'preorder';
  if (/\bbook demo\b/i.test(source)) return 'book_demo';
  if (/\bcontact sales|contact us\b/i.test(source)) return 'contact_sales';
  if (EMAIL_CAPTURE_RE.test(source)) return 'email_capture';
  return 'unknown';
}

function isCliPackage(packageScan: PackageScan): boolean {
  const deps = new Set([...packageScan.dependencies, ...packageScan.devDependencies]);
  return packageScan.hasBin ||
    deps.has('commander') ||
    deps.has('yargs') ||
    deps.has('cac') ||
    deps.has('oclif') ||
    deps.has('@oclif/core') ||
    deps.has('@inquirer/prompts') ||
    deps.has('inquirer') ||
    deps.has('execa') ||
    /cli|devtool|tooling|command/i.test(packageScan.name ?? '');
}

function collectInstallCommands(source: string): string[] {
  const commands: string[] = [];
  for (const match of source.matchAll(INSTALL_COMMAND_RE)) {
    const pkg = match[1] ?? match[2] ?? match[3];
    if (pkg) commands.push(pkg);
  }
  return commands;
}

function packageNameMatchesDocumentedCommand(packageName: string | undefined, documentedName: string): boolean {
  if (!packageName) return true;
  return documentedName === packageName;
}

function stripStringAndRegexLiterals(source: string): string {
  return source
    .replace(/\/(?![/*])(?:\\.|[^/\\\n])+\/[dgimsuvy]*/g, '')
    .replace(/`(?:\\.|[^`\\])*`/gs, '')
    .replace(/'(?:\\.|[^'\\])*'/gs, '')
    .replace(/"(?:\\.|[^"\\])*"/gs, '');
}

function buildActionFlows(args: {
  packageScan: PackageScan;
  devtool: DevtoolScan;
  captureSignals: SourceFinding[];
  captureWiringSignals: SourceFinding[];
  capturePartialSignals: SourceFinding[];
  captureEnvEndpointSignals: SourceFinding[];
  captureOwnedSubmissionSignals: SourceFinding[];
  captureProviderSignals: SourceFinding[];
  ctaSignals: SourceFinding[];
  ctaWiringSignals: SourceFinding[];
  suspiciousButtons: SourceFinding[];
}): ActionFlowFinding[] {
  const flows: ActionFlowFinding[] = [];

  if (args.captureSignals.length > 0) {
    const primaryCapture = args.captureSignals[0];
    const type = detectFlowType(primaryCapture.evidence);
    const hasClearSubmissionPath = args.captureWiringSignals.length > 0;
    const hasPartialSubmissionLogic = args.capturePartialSignals.length > 0;
    const hasEnvBackedEndpoint = args.captureEnvEndpointSignals.length > 0;
    const hasOwnedOrProviderProof = args.captureOwnedSubmissionSignals.length > 0 || args.captureProviderSignals.length > 0;
    const hasEnvOnlyEndpoint = hasEnvBackedEndpoint && !hasOwnedOrProviderProof;
    const status: ActionFlowStatus = hasClearSubmissionPath
      ? hasEnvOnlyEndpoint
        ? 'needs_verification'
        : 'wired'
      : 'likely_unwired';

    if (status !== 'wired') {
      flows.push({
        type: type === 'unknown' ? 'email_capture' : type,
        label: type === 'preorder'
          ? 'Primary preorder capture'
          : type === 'book_demo'
            ? 'Primary demo request capture'
            : type === 'contact_sales'
              ? 'Primary contact capture'
              : 'Primary email capture',
        status,
        severity: 'High',
        certainty: status === 'likely_unwired' ? 'likely' : 'needs_verification',
        evidence: hasEnvOnlyEndpoint
          ? [
              `${primaryCapture.path}: ${primaryCapture.evidence}`,
              `${args.captureEnvEndpointSignals[0].path}: Primary capture submission depends on an environment-configured external endpoint with no local/API/provider proof in the repo.`,
            ]
          : [
              `${primaryCapture.path}: ${primaryCapture.evidence}`,
              hasPartialSubmissionLogic
                ? `${args.capturePartialSignals[0].path}: ${args.capturePartialSignals[0].evidence}`
                : 'No fetch/API route/server action/form action/database/email integration was detected.',
            ],
        risk: hasEnvOnlyEndpoint
          ? 'The capture flow may work, but public launch can silently lose leads if the production endpoint env var is absent, stale, or points nowhere.'
          : 'Users may think they joined the waitlist, preordered, requested access, or contacted the team, but nothing is actually captured.',
        fix: hasEnvOnlyEndpoint
          ? 'Submit a real email on the production URL and verify it arrives, or wire the form to an owned API route/server action/provider before launch.'
          : 'Wire the flow to an API route, server action, database, email platform, CRM, webhook, or disable/rename the CTA before launch.',
      });
    }
  }

  if (args.ctaSignals.length > 0 && args.suspiciousButtons.length > 0) {
    const suspiciousCount = Math.min(args.suspiciousButtons.length, 5);
    flows.push({
      type: 'cta_navigation',
      label: 'Primary CTA navigation',
      status: args.ctaWiringSignals.length > 0 ? 'needs_verification' : 'needs_verification',
      severity: 'High',
      certainty: 'needs_verification',
      evidence: [
        `${args.ctaSignals[0].path}: ${args.ctaSignals[0].evidence}`,
        `${suspiciousCount} prominent CTA button${suspiciousCount === 1 ? '' : 's'} lack obvious href/onClick/form submit behavior.`,
      ],
      risk: 'Users may click a primary CTA and nothing happens, or the action may not reach a real destination.',
      fix: 'Wire each primary CTA to a real destination, form submission, router navigation, download, install command, or disabled state.',
    });
  }

  if (isCliPackage(args.packageScan)) {
    flows.push({
      type: 'cli_install',
      label: 'CLI install/run path',
      status: args.packageScan.hasBin && args.devtool.missingBinTargets.length === 0 ? 'wired' : 'needs_verification',
      severity: args.packageScan.hasBin && args.devtool.missingBinTargets.length === 0 ? 'Low' : 'High',
      certainty: args.packageScan.hasBin ? 'confirmed' : 'needs_verification',
      evidence: args.packageScan.hasBin
        ? [`package.json bin entries detected: ${args.packageScan.bin.join(', ')}.`]
        : ['Package dependencies/name suggest CLI or devtool behavior, but no package.json bin entry was detected.'],
      risk: args.packageScan.hasBin
        ? 'The package declares a CLI entrypoint, but the install/run path still needs normal release QA.'
        : 'Users may try to install or run the tool and have no executable entrypoint.',
      fix: args.packageScan.hasBin
        ? 'Verify the published package includes the bin target and that npx/install commands execute the expected entrypoint.'
        : 'Add a package.json bin entry or clarify that this package is not installed as a CLI.',
    });

    flows.push({
      type: 'cli_entrypoint',
      label: 'CLI entrypoint',
      status: args.packageScan.hasBin && args.devtool.missingBinTargets.length === 0
        ? 'wired'
        : args.packageScan.hasBin
          ? 'likely_unwired'
          : 'not_detected',
      severity: args.devtool.missingBinTargets.length > 0 ? 'Critical' : args.packageScan.hasBin ? 'Low' : 'High',
      certainty: 'confirmed',
      evidence: args.devtool.missingBinTargets.length > 0
        ? args.devtool.missingBinTargets.map(item => `${item.path}: ${item.evidence}`)
        : args.devtool.binTargets.length > 0
          ? args.devtool.binTargets.map(item => `${item.path}: ${item.evidence}`)
          : ['No package.json bin target was detected.'],
      risk: args.devtool.missingBinTargets.length > 0
        ? 'Users may install the package but the CLI executable points to a missing file.'
        : 'Users may not have a reliable executable entrypoint.',
      fix: 'Make package.json bin point to an included CLI file and verify npx/install execution.',
    });

    if (args.devtool.unsafeFilesystemWrites.length > 0) {
      flows.push({
        type: 'filesystem_write_safety',
        label: 'Filesystem write safety',
        status: 'needs_verification',
        severity: 'High',
        certainty: 'needs_verification',
        evidence: args.devtool.unsafeFilesystemWrites.slice(0, 3).map(item => `${item.path}: ${item.evidence}`),
        risk: 'A CLI can change or delete user files without enough visible safety guards.',
        fix: 'Add confirmation, dry-run, backup, allowlist, diff preview, or rollback guards around file writes.',
      });
    }

    if (args.devtool.configUsage.length > 0 && args.devtool.configValidationSignals.length === 0) {
      flows.push({
        type: 'config_loading',
        label: 'Config loading',
        status: 'needs_verification',
        severity: 'Medium',
        certainty: 'needs_verification',
        evidence: args.devtool.configUsage.slice(0, 3).map(item => `${item.path}: ${item.evidence}`),
        risk: 'Users may hit unclear failures when API keys, env vars, provider settings, or config files are missing.',
        fix: 'Validate required config and print a direct recovery step before running commands.',
      });
    }
  }

  return flows;
}

function buildSaasDashboardActionFlows(scan: SaasDashboardScan): ActionFlowFinding[] {
  const flows: ActionFlowFinding[] = [];
  const hasMutatingOrProtectedAppSurface = scan.authRouteSignals.length > 0 ||
    scan.protectedRouteSignals.length > 0 ||
    scan.dataWrites.length > 0 ||
    scan.billingSignals.length > 0;

  if (scan.authRouteSignals.length > 0 && scan.authGuardSignals.length === 0 && scan.authPackageSignals.length === 0) {
    flows.push({
      type: 'auth_flow',
      label: 'Auth flow',
      status: 'needs_verification',
      severity: 'High',
      certainty: 'needs_verification',
      evidence: scan.authRouteSignals.slice(0, 3).map(item => `${item.path}: ${item.evidence}`),
      risk: 'Users may access protected screens or fail to sign in correctly.',
      fix: 'Add or verify auth package/session handling and route guards before launch.',
    });
  }

  if (scan.protectedRouteSignals.length > 0 && scan.authGuardSignals.length === 0) {
    flows.push({
      type: 'protected_route',
      label: 'Protected routes',
      status: 'needs_verification',
      severity: 'High',
      certainty: 'needs_verification',
      evidence: scan.protectedRouteSignals.slice(0, 3).map(item => `${item.path}: ${item.evidence}`),
      risk: 'Users may access dashboard, settings, account, admin, or billing screens without authorization.',
      fix: 'Guard protected routes with middleware, session checks, auth(), currentUser, requireAuth, withAuth, or redirects to login.',
    });
  }

  if (scan.dataWrites.length > 0 && (scan.validationSignals.length === 0 || scan.errorHandlingSignals.length === 0)) {
    flows.push({
      type: 'data_write',
      label: 'Data write path',
      status: 'needs_verification',
      severity: 'High',
      certainty: 'needs_verification',
      evidence: [
        ...scan.dataWrites.slice(0, 2).map(item => `${item.path}: ${item.evidence}`),
        scan.validationSignals.length === 0 ? 'No obvious validation signal found.' : 'Validation signal found.',
        scan.errorHandlingSignals.length === 0 ? 'No obvious user-facing error handling signal found.' : 'Error handling signal found.',
      ],
      risk: 'Invalid input, failed writes, or partial mutations may reach production users without clear recovery.',
      fix: 'Validate inputs and wrap writes in clear error handling before launch.',
    });
  }

  if (scan.billingSignals.length > 0 && scan.webhookSignatureSignals.length === 0) {
    flows.push({
      type: 'billing_checkout',
      label: 'Billing/webhook flow',
      status: 'needs_verification',
      severity: 'High',
      certainty: 'needs_verification',
      evidence: scan.billingSignals.slice(0, 3).map(item => `${item.path}: ${item.evidence}`),
      risk: 'Checkout or subscription state may become incorrect if webhooks are missing or unverified.',
      fix: 'Verify checkout routes, success/cancel URLs, webhook routes, env vars, and webhook signature validation.',
    });
  }

  if (hasMutatingOrProtectedAppSurface && scan.destructiveActions.length > 0 && scan.destructiveConfirmationSignals.length === 0) {
    flows.push({
      type: 'destructive_action',
      label: 'Destructive action',
      status: 'needs_verification',
      severity: 'High',
      certainty: 'needs_verification',
      evidence: scan.destructiveActions.slice(0, 3).map(item => `${item.path}: ${item.evidence}`),
      risk: 'Users may delete, revoke, disconnect, reset, cancel, or downgrade something important without confirmation.',
      fix: 'Add confirmation, modal/dialog, undo, or a clear review step before destructive actions run.',
    });
  }

  if (scan.dashboardSignals.length > 0 && scan.dashboardStateSignals.length === 0) {
    flows.push({
      type: 'dashboard_load',
      label: 'Dashboard states',
      status: 'needs_verification',
      severity: 'Medium',
      certainty: 'inferred',
      evidence: scan.dashboardSignals.slice(0, 3).map(item => `${item.path}: ${item.evidence}`),
      risk: 'Dashboard users may see blank or confusing screens when data is loading, empty, or fails.',
      fix: 'Add loading, error, empty, skeleton, fallback, or no-data states for dashboard routes.',
    });
  }

  return flows;
}

function routeFile(path: string): boolean {
  return /(?:^|\/)(app|pages)\/.*(?:page|route|layout|loading|error|not-found)\.[tj]sx?$/.test(path)
    || /(?:^|\/)pages\/.*\.[tj]sx?$/.test(path)
    || /(?:^|\/)netlify\/functions\/.*\.[tj]s$/.test(path)
    || /(?:^|\/)api\/.*\.[tj]s$/.test(path);
}

function apiRouteFile(path: string): boolean {
  return /(?:^|\/)(app\/api|pages\/api|api|netlify\/functions)\/.*\.[tj]s$/.test(path)
    || /(?:^|\/)route\.[tj]s$/.test(path);
}

function addScore(
  scores: Partial<Record<ProjectType, number>>,
  signalsByType: Partial<Record<ProjectType, string[]>>,
  type: ProjectType,
  amount: number,
  signal: string,
): void {
  scores[type] = (scores[type] ?? 0) + amount;
  signalsByType[type] = [...(signalsByType[type] ?? []), signal];
}

function detectProjectType(
  scan: Omit<ShipReadinessScan, 'projectType' | 'projectTypeDetection' | 'evidence'>,
  projectFiles: string[],
): ProjectTypeDetection {
  const scores: Partial<Record<ProjectType, number>> = {};
  const signalsByType: Partial<Record<ProjectType, string[]>> = {};
  const deps = new Set([...scan.package.dependencies, ...scan.package.devDependencies]);
  const executableProjectFiles = projectFiles.filter(file => isExecutableRole(classifyFileRole(file)));
  const docsProjectFiles = projectFiles.filter(file => {
    const role = classifyFileRole(file);
    return role === 'docs' || role === 'draft';
  });
  const allPaths = [
    ...executableProjectFiles.map(file => file.replace(/\\/g, '/')),
    ...scan.routeFiles,
    ...scan.apiRoutes,
    ...scan.riskyFiles.map(item => item.path),
  ].join('\n').toLowerCase();
  const docsPaths = docsProjectFiles.map(file => file.replace(/\\/g, '/')).join('\n').toLowerCase();
  const allEvidence = [
    ...scan.forms.map(item => item.evidence),
    ...scan.suspiciousForms.map(item => item.evidence),
    ...scan.buttons.map(item => item.evidence),
    ...scan.actionFlows.flatMap(flow => flow.evidence),
    ...scan.networkCalls.map(item => item.evidence),
  ].join('\n').toLowerCase();

  if (scan.routeFiles.length <= 2 && scan.apiRoutes.length === 0 && (scan.package.framework === 'next' || scan.package.framework === 'react' || scan.package.framework === 'vite' || scan.package.framework === 'astro')) {
    addScore(scores, signalsByType, 'landing_page', 18, 'single public route shape');
  }
  if (scan.forms.length > 0 && scan.apiRoutes.length <= 1 && !/dashboard|admin|login|signup|sign-in|sign-up|auth|settings|account|billing|checkout|cart|order/.test(allPaths)) {
    addScore(scores, signalsByType, 'landing_page', 24, 'landing capture form with minimal API surface detected');
  }
  if (scan.actionFlows.some(flow => ['email_capture', 'preorder', 'book_demo', 'contact_sales', 'cta_navigation'].includes(flow.type))) {
    addScore(scores, signalsByType, 'landing_page', 22, 'primary CTA or capture flow detected');
  }
  if (/\b(hero|features|pricing|faq|testimonial|waitlist|pre[\s-]?order|early access|book demo|contact sales|get started)\b/i.test(allPaths + '\n' + allEvidence)) {
    addScore(scores, signalsByType, 'landing_page', 18, 'marketing or conversion copy detected');
  }
  if (!/dashboard|admin|login|signup|auth|checkout|cart|billing|order|api\//.test(allPaths) && scan.apiRoutes.length === 0) {
    addScore(scores, signalsByType, 'landing_page', 8, 'no auth/dashboard/payment/API routes detected');
  }

  if (/login|signup|sign-in|sign-up|auth|settings|account|billing|onboarding|workspace|organization|team|session/.test(allPaths)) {
    addScore(scores, signalsByType, 'saas_app', 24, 'auth, account, billing, onboarding, workspace, or team route found');
  }
  if (['next-auth', 'clerk', '@clerk/nextjs', 'auth0', '@auth0/nextjs-auth0', 'supabase', '@supabase/supabase-js', 'firebase', 'prisma', '@prisma/client', 'drizzle-orm', 'mongoose', 'postgres', 'mysql', 'mysql2', 'sqlite', 'better-sqlite3'].some(dep => deps.has(dep))) {
    addScore(scores, signalsByType, 'saas_app', 22, 'auth or database package detected');
  }
  if (['stripe', '@stripe/stripe-js', 'paddle', '@paddle/paddle-js', 'lemonsqueezy'].some(dep => deps.has(dep)) || scan.saasDashboard.billingSignals.length > 0) {
    addScore(scores, signalsByType, 'saas_app', 10, 'billing or subscription signal detected');
  }
  if (/\b(user|session|workspace|organization|team|invite|permission)\b/.test(allPaths + '\n' + allEvidence)) {
    addScore(scores, signalsByType, 'saas_app', 14, 'user/session/workspace logic signal detected');
  }

  if (/dashboard|admin|analytics|reports|metrics/.test(allPaths)) {
    addScore(scores, signalsByType, 'dashboard', 24, 'dashboard/admin/analytics/report route found');
  }
  if (['recharts', 'chart.js', 'ag-grid', '@tanstack/table-core', '@tanstack/react-table'].some(dep => deps.has(dep)) || /chart|table|filter|date range|datatable|export/.test(allPaths + '\n' + allEvidence)) {
    addScore(scores, signalsByType, 'dashboard', 20, 'chart, table, filter, or reporting signal detected');
  }

  if (scan.package.hasBin) {
    addScore(scores, signalsByType, 'devtool', 35, 'package.json bin entry detected');
  }
  if (['commander', 'yargs', 'cac', 'oclif', '@oclif/core', '@inquirer/prompts', 'inquirer', 'prompts', 'chalk', 'execa'].some(dep => deps.has(dep))) {
    addScore(scores, signalsByType, 'devtool', 20, 'CLI/devtool package detected');
  }
  if (/bin\/|(^|\/)(cli|bin|commands?)\.[tj]sx?$|commands\/|cli|command/.test(allPaths) || /\b(?:npx|install|usage)\b/.test(docsPaths)) {
    addScore(scores, signalsByType, 'devtool', 12, 'install, usage, command, or CLI copy detected');
  }
  if (scan.devtool.binTargets.length > 0 || scan.devtool.missingBinTargets.length > 0) {
    addScore(scores, signalsByType, 'devtool', 14, 'CLI bin target checked');
  }
  if (scan.devtool.installCommands.length > 0) {
    addScore(scores, signalsByType, 'devtool', 8, 'documented install/run command detected');
  }

  if (scan.apiRoutes.length >= 2 || scan.package.framework === 'backend') {
    addScore(scores, signalsByType, 'backend_api', 24, 'multiple API routes or backend framework detected');
  }
  if (['express', 'fastify', 'hono', '@trpc/server', 'trpc'].some(dep => deps.has(dep)) || /server\.ts|middleware|webhook|route handler|route\.ts/.test(allPaths)) {
    addScore(scores, signalsByType, 'backend_api', 22, 'server, middleware, webhook, route handler, or backend package detected');
  }
  if (scan.riskyFiles.length > 0 || /\.(create|update|upsert|delete|insert|save)\s*\(/.test(allEvidence)) {
    addScore(scores, signalsByType, 'backend_api', 14, 'data-write or high-consequence server path detected');
  }

  if (/docs|documentation|api-reference|getting-started|guide|mdx?$/i.test(docsPaths + '\n' + allPaths)) {
    addScore(scores, signalsByType, 'docs_site', 24, 'docs, guide, API reference, or markdown route detected');
  }
  if (/getting started|installation|api reference|docs navigation|sidebar/i.test(docsPaths + '\n' + allEvidence)) {
    addScore(scores, signalsByType, 'docs_site', 16, 'documentation copy or navigation signal detected');
  }

  if (/checkout|cart|order|billing|payment|subscription|invoice/.test(allPaths)) {
    addScore(scores, signalsByType, 'ecommerce', 28, 'checkout, cart, order, billing, payment, or subscription route found');
  }
  if (['stripe', '@stripe/stripe-js', 'paddle', '@paddle/paddle-js', 'lemonsqueezy', 'paypal', '@paypal/react-paypal-js'].some(dep => deps.has(dep))) {
    addScore(scores, signalsByType, 'ecommerce', 26, 'payment provider package detected');
  }
  if (scan.saasDashboard.billingSignals.length > 0) {
    addScore(scores, signalsByType, 'ecommerce', 16, 'payment, webhook, invoice, or subscription signal detected');
  }

  const ranked = (Object.entries(scores) as Array<[ProjectType, number]>)
    .filter(([type]) => type !== 'unknown')
    .sort((a, b) => b[1] - a[1]);
  const [topType, topScore] = ranked[0] ?? ['unknown', 0];
  const secondScore = ranked[1]?.[1] ?? 0;
  const gap = topScore - secondScore;
  const conflictingSignals = ranked
    .filter(([type, score]) => type !== topType && score >= 20)
    .flatMap(([type]) => (signalsByType[type] ?? []).map(signal => `${type}: ${signal}`))
    .slice(0, 6);
  const confidence = Math.max(0, Math.min(1, topScore / Math.max(topScore + secondScore, 1)));
  let confidenceLabel: ProjectTypeDetection['confidenceLabel'];
  if (topScore >= 40 && gap >= 20 && conflictingSignals.length <= 2) confidenceLabel = 'high';
  else if (topScore >= 25 && gap >= 10) confidenceLabel = 'medium';
  else confidenceLabel = 'low';

  return {
    primaryType: topType,
    confidence,
    confidenceLabel,
    secondaryTypes: ranked.slice(1, 4).map(([type]) => type),
    signals: (signalsByType[topType] ?? []).slice(0, 6),
    conflictingSignals,
    shouldAskUser: confidenceLabel !== 'high',
    scores,
  };
}

function buildEvidence(scan: Omit<ShipReadinessScan, 'projectType' | 'evidence'>, projectType: ProjectType): string[] {
  const evidence: string[] = [];
  evidence.push(`Project type inferred as ${projectType}.`);
  evidence.push(`Project type confidence: ${scan.projectTypeDetection.confidenceLabel} (${scan.projectTypeDetection.confidence.toFixed(2)}).`);
  evidence.push(`Framework: ${scan.package.framework}; package manager: ${scan.package.packageManager}.`);
  evidence.push(`Scripts: build=${scan.package.hasBuildScript ? 'yes' : 'no'}, lint=${scan.package.hasLintScript ? 'yes' : 'no'}, test=${scan.package.hasTestScript ? 'yes' : 'no'}.`);
  evidence.push(`Tests detected: ${scan.testFiles.length}.`);
  evidence.push(`Routes/pages detected: ${scan.routeFiles.length}; API/server routes detected: ${scan.apiRoutes.length}.`);
  if (scan.actionFlows.length > 0) evidence.push(`Primary action flows detected: ${scan.actionFlows.map(flow => `${flow.type}:${flow.status}`).join(', ')}.`);
  if (scan.suspiciousForms.length > 0) evidence.push(`${scan.suspiciousForms.length} form(s) look unwired or only locally handled.`);
  if (scan.suspiciousButtons.length > 0) evidence.push(`${scan.suspiciousButtons.length} button(s) may lack meaningful click behavior.`);
  if (scan.suspiciousLinks.length > 0) evidence.push(`${scan.suspiciousLinks.length} suspicious link(s) found, such as empty href, #, or javascript:void(0).`);
  evidence.push(`Metadata: base=${scan.metadata.hasMetadata ? 'yes' : 'no'}, openGraph=${scan.metadata.hasOpenGraph ? 'yes' : 'no'}, twitter=${scan.metadata.hasTwitter ? 'yes' : 'no'}.`);
  evidence.push(`Public files: robots.txt=${scan.publicFiles.hasRobotsTxt ? 'yes' : 'no'}, sitemap=${scan.publicFiles.hasSitemap ? 'yes' : 'no'}.`);
  evidence.push(`Analytics detected: ${scan.analytics.length > 0 ? 'yes' : 'no'}.`);
  if (scan.heavyAssets.length > 0) evidence.push(`${scan.heavyAssets.length} heavy media/animation signal(s) found.`);
  if (scan.missingAltText.length > 0) evidence.push(`${scan.missingAltText.length} possible missing image alt text issue(s) found.`);
  if (scan.reducedMotion.length === 0 && scan.heavyAssets.length > 0) evidence.push('Heavy media/animation found but no reduced-motion signal detected.');
  if (scan.saasDashboard.protectedRouteSignals.length > 0) evidence.push(`${scan.saasDashboard.protectedRouteSignals.length} protected route signal(s) found; guard signals=${scan.saasDashboard.authGuardSignals.length}.`);
  if (scan.saasDashboard.dataWrites.length > 0) evidence.push(`${scan.saasDashboard.dataWrites.length} data write signal(s) found; validation=${scan.saasDashboard.validationSignals.length}, error handling=${scan.saasDashboard.errorHandlingSignals.length}.`);
  if (scan.saasDashboard.dashboardSignals.length > 0) evidence.push(`${scan.saasDashboard.dashboardSignals.length} dashboard signal(s) found; loading/error/empty state signals=${scan.saasDashboard.dashboardStateSignals.length}.`);
  return evidence;
}

function buildLaunchFindings(scan: Omit<ShipReadinessScan, 'projectType' | 'projectTypeDetection' | 'evidence' | 'launchFindings'>): LaunchFinding[] {
  const findings: LaunchFinding[] = [];
  const isDevtool = isCliPackage(scan.package);

  if (isDevtool && !scan.package.hasBin) {
    findings.push({
      category: 'hard_blocker_candidate',
      issue: 'CLI entrypoint missing',
      severity: 'High',
      certainty: 'confirmed',
      evidence: 'package.json has no bin entry.',
      suggestedFix: 'Add a package.json bin entry that points to the CLI entry file before publishing or recommending npx usage.',
    });
  }

  for (const missingTarget of scan.devtool.missingBinTargets.slice(0, 3)) {
    findings.push({
      category: 'hard_blocker',
      issue: 'CLI bin target does not exist',
      severity: 'Critical',
      certainty: 'confirmed',
      evidence: `${missingTarget.path}: ${missingTarget.evidence}`,
      suggestedFix: 'Update package.json bin to point to an included executable file, or add the missing bin target.',
    });
  }

  if (scan.devtool.installCommandMismatches.length > 0) {
    const mismatch = scan.devtool.installCommandMismatches[0];
    findings.push({
      category: 'hard_blocker_candidate',
      issue: 'Install command may be wrong',
      severity: 'High',
      certainty: 'likely',
      evidence: scan.devtool.installCommandMismatches.length === 1
        ? `${mismatch.path}: ${mismatch.evidence}`
        : `${mismatch.path}: ${mismatch.evidence} (${scan.devtool.installCommandMismatches.length} mismatch signals found).`,
      suggestedFix: 'Update README/docs install and npx commands to match package.json name.',
    });
  }

  if (isDevtool && scan.devtool.cliExecutionSignals.length > 0 && scan.devtool.cliErrorHandlingSignals.length === 0) {
    findings.push({
      category: 'soft_blocker',
      issue: 'CLI error handling needs verification',
      severity: 'Medium',
      certainty: 'inferred',
      evidence: `${scan.devtool.cliExecutionSignals.length} command execution/API/shell signal(s) found with no obvious user-facing error handling.`,
      suggestedFix: 'Wrap command execution in try/catch and print concise recovery steps for common failures.',
    });
  }

  if (isDevtool && scan.devtool.configUsage.length > 0 && scan.devtool.configValidationSignals.length === 0) {
    findings.push({
      category: 'soft_blocker',
      issue: 'CLI config validation needs verification',
      severity: 'Medium',
      certainty: 'needs_verification',
      evidence: `${scan.devtool.configUsage.length} config/env/API key signal(s) found with no obvious validation message.`,
      suggestedFix: 'Validate required config before running commands and show a clear setup/reset instruction.',
    });
  }

  const hasSaasDashboardSignals = scan.saasDashboard.authRouteSignals.length > 0 ||
    scan.saasDashboard.protectedRouteSignals.length > 0 ||
    scan.saasDashboard.dashboardSignals.length > 0 ||
    scan.saasDashboard.dataWrites.length > 0 ||
    scan.saasDashboard.billingSignals.length > 0;

  if (!isDevtool && hasSaasDashboardSignals && scan.envUsage.length > 0 && scan.saasDashboard.envValidationSignals.length === 0) {
    findings.push({
      category: 'soft_blocker',
      issue: 'Required environment variables need validation',
      severity: 'Medium',
      certainty: 'needs_verification',
      evidence: `${scan.envUsage.length} environment variable usage signal(s) found with no obvious env validation/helpful failure path.`,
      suggestedFix: 'Validate required env vars at startup or before the relevant auth, database, billing, or API flow runs.',
    });
  }

  for (const unsafeWrite of scan.devtool.unsafeFilesystemWrites.slice(0, 3)) {
    findings.push({
      category: 'code_ownership_risk',
      issue: 'Filesystem writes need safety guard',
      severity: 'High',
      certainty: 'needs_verification',
      evidence: `${unsafeWrite.path}: ${unsafeWrite.evidence}`,
      suggestedFix: 'Add dry-run, confirmation, backup, allowlist, diff preview, or rollback guard around filesystem writes.',
    });
  }

  for (const flow of scan.actionFlows) {
    if (flow.status === 'wired' || flow.status === 'not_detected') continue;
    if (['cli_install', 'cli_entrypoint', 'filesystem_write_safety', 'config_loading', 'command_execution'].includes(flow.type)) continue;

    const captureEndpointNeedsVerification = flow.type === 'email_capture' && /environment-configured endpoint|endpoint env var|production signup|production endpoint|production url/i.test(flow.evidence.join(' ') + ' ' + flow.fix);
    const issue = flow.type === 'cta_navigation'
      ? 'Primary CTA behavior needs verification'
      : flow.type === 'email_capture'
        ? captureEndpointNeedsVerification
          ? 'Primary capture endpoint needs production proof'
          : 'Waitlist/email capture appears unwired'
        : flow.type === 'auth_flow'
          ? 'Auth flow needs verification'
          : flow.type === 'protected_route'
            ? 'Protected routes need verification'
            : flow.type === 'data_write'
              ? 'Data write needs validation/error handling'
              : flow.type === 'billing_checkout'
                ? 'Billing/webhook flow needs verification'
                : flow.type === 'destructive_action'
                  ? 'Destructive action needs confirmation'
                  : flow.type === 'dashboard_load'
                    ? 'Dashboard states need verification'
                    : 'Primary capture flow appears unwired';

    findings.push({
      category: flow.type === 'dashboard_load' ? 'soft_blocker' : 'hard_blocker_candidate',
      issue,
      severity: flow.severity,
      certainty: flow.certainty,
      evidence: flow.evidence.join(' '),
      suggestedFix: flow.fix,
    });
  }

  for (const form of scan.suspiciousForms.slice(0, 3)) {
    if (hasActionFlowType(scan.actionFlows, 'email_capture') || hasActionFlowType(scan.actionFlows, 'preorder') || hasActionFlowType(scan.actionFlows, 'book_demo') || hasActionFlowType(scan.actionFlows, 'contact_sales')) {
      break;
    }

    findings.push({
      category: 'hard_blocker_candidate',
      issue: 'Waitlist/form appears unwired',
      severity: 'High',
      certainty: form.evidence.includes('local-only') ? 'likely' : 'needs_verification',
      evidence: `${form.path}: ${form.evidence}`,
      suggestedFix: 'Wire the form to an API route, database, email platform, server action, or disable the CTA before launch.',
    });
  }

  for (const button of scan.suspiciousButtons.slice(0, 3)) {
    if (hasActionFlowType(scan.actionFlows, 'cta_navigation')) break;
    if (hasSaasDashboardSignals) break;

    findings.push({
      category: 'hard_blocker_candidate',
      issue: 'Primary CTA behavior needs verification',
      severity: 'High',
      certainty: 'needs_verification',
      evidence: `${button.path}: ${button.evidence}`,
      suggestedFix: 'Confirm the button either submits a real form, navigates to a real destination, or is disabled/labelled before launch.',
    });
  }

  if (!isDevtool && (!scan.metadata.hasOpenGraph || !scan.metadata.hasTwitter)) {
    findings.push({
      category: 'soft_blocker',
      issue: 'Missing OG/social metadata',
      severity: 'Medium',
      certainty: 'confirmed',
      evidence: `Metadata scan: openGraph=${scan.metadata.hasOpenGraph ? 'yes' : 'no'}, twitter=${scan.metadata.hasTwitter ? 'yes' : 'no'}.`,
      suggestedFix: 'Add Open Graph and Twitter metadata before public/social launch.',
    });
  }

  if (!isDevtool && scan.analytics.length === 0) {
    findings.push({
      category: 'soft_blocker',
      issue: 'No analytics detected',
      severity: 'Medium',
      certainty: 'confirmed',
      evidence: 'No common analytics signal was detected in source files.',
      suggestedFix: 'Add analytics before public launch or paid traffic so visits and conversions are measurable.',
    });
  }

  if (!isDevtool && (!scan.publicFiles.hasRobotsTxt || !scan.publicFiles.hasSitemap)) {
    findings.push({
      category: 'soft_blocker',
      issue: 'robots.txt or sitemap missing',
      severity: 'Low',
      certainty: 'confirmed',
      evidence: `robots.txt=${scan.publicFiles.hasRobotsTxt ? 'yes' : 'no'}, sitemap=${scan.publicFiles.hasSitemap ? 'yes' : 'no'}.`,
      suggestedFix: 'Add robots.txt and sitemap.xml when preparing for public indexing.',
    });
  }

  if (!isDevtool && scan.heavyAssets.length > 0) {
    findings.push({
      category: 'soft_blocker',
      issue: 'Heavy media or animation needs performance QA',
      severity: 'Medium',
      certainty: 'inferred',
      evidence: `${scan.heavyAssets.length} heavy media/animation signal(s) detected.`,
      suggestedFix: 'Run mobile/performance QA and optimize media before public launch.',
    });
  }

  if (!scan.package.hasTestScript || scan.testFiles.length === 0) {
    findings.push({
      category: 'code_ownership_risk',
      issue: 'No test safety net detected',
      severity: 'Low',
      certainty: 'confirmed',
      evidence: `test script=${scan.package.hasTestScript ? 'yes' : 'no'}, test files=${scan.testFiles.length}.`,
      suggestedFix: 'Add focused tests around the highest-risk form, API, auth, payment, or stateful behavior before refactoring.',
    });
  }

  for (const file of scan.largestFiles.filter(file => file.lines >= 500).slice(0, 3)) {
    findings.push({
      category: 'code_ownership_risk',
      issue: `${file.path} is a large file`,
      severity: 'Medium',
      certainty: 'confirmed',
      evidence: `${file.path}: ${file.lines} lines, ${file.functions} functions.`,
      suggestedFix: 'Do not refactor first if launch paths are broken; later split by behavior after the page can ship safely.',
    });
  }

  return findings.slice(0, 12);
}

function isPrimaryFlowBlockingFinding(finding: LaunchFinding): boolean {
  if (finding.category !== 'hard_blocker' && finding.category !== 'hard_blocker_candidate') return false;
  if (finding.severity !== 'High' && finding.severity !== 'Critical') return false;
  if (!['confirmed', 'likely', 'needs_verification'].includes(finding.certainty)) return false;

  return /capture|waitlist|preorder|email capture|capture endpoint|cta|bin target|entrypoint|install command|auth flow|protected route|data write|billing|webhook|checkout|payment|destructive action/i.test(finding.issue);
}

export function getPrimaryFlowVerdictCap(scan: ShipReadinessScan): PrimaryFlowVerdictCap | null {
  const finding = scan.launchFindings.find(isPrimaryFlowBlockingFinding);
  if (!finding) return null;

  return {
    score: 4,
    label: 'Concerning',
    verdict: 'Not yet',
    risk: 'High risk',
    reason: `${finding.issue}: ${finding.evidence}`,
    finding,
  };
}

export async function runShipReadinessScan(root: string, reports: FileReport[]): Promise<ShipReadinessScan> {
  const packageScan = await readPackage(root);
  const sourceFiles = collectSourceFiles(root);
  const projectFiles = collectProjectFiles(root);

  const testFiles: string[] = [];
  const routeFiles: string[] = [];
  const apiRoutes: string[] = [];
  const todos: SourceFinding[] = [];
  const forms: SourceFinding[] = [];
  const suspiciousForms: SourceFinding[] = [];
  const buttons: SourceFinding[] = [];
  const suspiciousButtons: SourceFinding[] = [];
  const suspiciousLinks: SourceFinding[] = [];
  const networkCalls: SourceFinding[] = [];
  const analytics: SourceFinding[] = [];
  const envUsage: SourceFinding[] = [];
  const browserGlobals: SourceFinding[] = [];
  const useEffectBrowserCoupling: SourceFinding[] = [];
  const heavyAssets: SourceFinding[] = [];
  const missingAltText: SourceFinding[] = [];
  const reducedMotion: SourceFinding[] = [];
  const riskyFiles: SourceFinding[] = [];
  const captureSignals: SourceFinding[] = [];
  const captureWiringSignals: SourceFinding[] = [];
  const capturePartialSignals: SourceFinding[] = [];
  const captureEnvEndpointSignals: SourceFinding[] = [];
  const captureOwnedSubmissionSignals: SourceFinding[] = [];
  const captureProviderSignals: SourceFinding[] = [];
  const ctaSignals: SourceFinding[] = [];
  const ctaWiringSignals: SourceFinding[] = [];
  const devtool: DevtoolScan = {
    binTargets: [],
    missingBinTargets: [],
    installCommands: [],
    installCommandMismatches: [],
    filesystemWrites: [],
    unsafeFilesystemWrites: [],
    cliExecutionSignals: [],
    cliErrorHandlingSignals: [],
    configUsage: [],
    configValidationSignals: [],
  };
  const saasDashboard: SaasDashboardScan = {
    authRouteSignals: [],
    protectedRouteSignals: [],
    authGuardSignals: [],
    authPackageSignals: [],
    dataWrites: [],
    validationSignals: [],
    errorHandlingSignals: [],
    envValidationSignals: [],
    billingSignals: [],
    webhookSignatureSignals: [],
    dashboardSignals: [],
    dashboardStateSignals: [],
    destructiveActions: [],
    destructiveConfirmationSignals: [],
  };
  const packageDeps = new Set([...packageScan.dependencies, ...packageScan.devDependencies]);
  for (const authDep of ['next-auth', 'clerk', '@clerk/nextjs', 'auth0', '@auth0/nextjs-auth0', 'supabase', '@supabase/supabase-js', 'firebase']) {
    if (packageDeps.has(authDep)) pushFinding(saasDashboard.authPackageSignals, 'package.json', `${authDep} dependency detected.`);
  }
  for (const billingDep of ['stripe', '@stripe/stripe-js', 'paddle', '@paddle/paddle-js', 'lemonsqueezy']) {
    if (packageDeps.has(billingDep)) pushFinding(saasDashboard.billingSignals, 'package.json', `${billingDep} dependency detected.`);
  }
  const metadata = {
    hasMetadata: false,
    hasOpenGraph: false,
    hasTwitter: false,
    files: [] as string[],
  };

  for (const fullPath of sourceFiles) {
    const path = relative(root, fullPath);
    const role = classifyFileRole(path);
    const executable = isExecutableRole(role);
    if (TEST_RE.test(path)) testFiles.push(path);
    if (routeFile(path)) routeFiles.push(path);
    if (apiRouteFile(path)) apiRoutes.push(path);
    if (isHighConsequencePath(path)) pushFinding(riskyFiles, path, 'Path name suggests auth/payment/webhook/data-write consequence.');
    if (AUTH_ROUTE_PATH_RE.test(path)) pushFinding(saasDashboard.authRouteSignals, path, 'Auth/login/signup/onboarding route detected.');
    if (PROTECTED_ROUTE_PATH_RE.test(path)) pushFinding(saasDashboard.protectedRouteSignals, path, 'Protected dashboard/settings/account/admin/billing route detected.');
    if (DASHBOARD_ROUTE_PATH_RE.test(path)) pushFinding(saasDashboard.dashboardSignals, path, 'Dashboard/admin/analytics/reports/metrics route detected.');

    let source = '';
    try {
      source = await readFile(fullPath, 'utf8');
    } catch {
      continue;
    }
    const codeOnlySource = stripStringAndRegexLiterals(source);

    if (/TODO|FIXME|HACK/.test(source)) pushFinding(todos, path, 'Contains TODO/FIXME/HACK comment.');
    if (executable && FILESYSTEM_WRITE_RE.test(source)) {
      pushFinding(devtool.filesystemWrites, path, 'Filesystem write/delete/copy operation detected.');
      if (!FILESYSTEM_SAFETY_RE.test(source)) {
        pushFinding(devtool.unsafeFilesystemWrites, path, 'Filesystem write/delete/copy operation has no obvious dry-run, confirmation, backup, allowlist, diff, or rollback guard.');
      }
    }
    if (executable && CLI_EXECUTION_RE.test(source)) {
      pushFinding(devtool.cliExecutionSignals, path, 'CLI command execution, shell/model/API call, or command parser signal detected.');
      if (ERROR_HANDLING_RE.test(source)) {
        pushFinding(devtool.cliErrorHandlingSignals, path, 'User-facing error handling signal detected.');
      }
    }
    if (executable && (AUTH_GUARD_RE.test(source) || /(?:^|\/)middleware\.[tj]s$/.test(path))) {
      pushFinding(saasDashboard.authGuardSignals, path, 'Auth/session/protected-route guard signal detected.');
    }
    if (hasDataWriteEvidence(path, source, role)) {
      pushFinding(saasDashboard.dataWrites, path, 'Data write or mutating route/action signal detected.');
    }
    if (executable && VALIDATION_RE.test(source)) {
      pushFinding(saasDashboard.validationSignals, path, 'Input validation signal detected.');
    }
    if (executable && USER_ERROR_RE.test(source)) {
      pushFinding(saasDashboard.errorHandlingSignals, path, 'Error handling or user-facing error signal detected.');
    }
    if (executable && ENV_VALIDATION_RE.test(source)) {
      pushFinding(saasDashboard.envValidationSignals, path, 'Environment validation or helpful missing-env failure signal detected.');
    }
    if (hasExecutableBillingEvidence(path, source, role, packageDeps)) {
      pushFinding(saasDashboard.billingSignals, path, 'Executable billing, checkout, payment provider, or webhook signal detected.');
    }
    if (executable && WEBHOOK_SIGNATURE_RE.test(source)) {
      pushFinding(saasDashboard.webhookSignatureSignals, path, 'Webhook signature verification signal detected.');
    }
    if (executable && /chart|table|filter|date range|datatable|\bexport\s+(?:csv|report|data)\b|metrics|analytics|reports/i.test(source)) {
      pushFinding(saasDashboard.dashboardSignals, path, 'Dashboard chart/table/filter/export/reporting signal detected.');
    }
    if (executable && DASHBOARD_STATE_RE.test(source)) {
      pushFinding(saasDashboard.dashboardStateSignals, path, 'Loading/error/empty/skeleton/fallback dashboard state signal detected.');
    }
    if (executable && DESTRUCTIVE_ACTION_RE.test(codeOnlySource)) {
      pushFinding(saasDashboard.destructiveActions, path, 'Destructive action copy or code signal detected.');
    }
    if (executable && DESTRUCTIVE_CONFIRM_RE.test(source)) {
      pushFinding(saasDashboard.destructiveConfirmationSignals, path, 'Confirmation, dialog, modal, alert, or undo signal detected.');
    }
    if (executable && /process\.env|import\.meta\.env|config\.json|\.env|apiKey|provider|model/i.test(source)) {
      pushFinding(devtool.configUsage, path, 'Config, env, API key, provider, or model setting usage detected.');
      if (CONFIG_VALIDATION_RE.test(source)) {
        pushFinding(devtool.configValidationSignals, path, 'Config validation or recovery-message signal detected.');
      }
    }
    if (hasCaptureFlowSignal(source)) {
      const flowType = detectFlowType(source);
      pushFinding(captureSignals, path, `${flowType} flow: email input/state and capture-oriented copy or form behavior detected.`);
      if (SUBMISSION_PATH_RE.test(source)) {
        pushFinding(captureWiringSignals, path, 'Submission path signal detected for capture flow.');
        if (ENV_ENDPOINT_RE.test(source)) {
          pushFinding(captureEnvEndpointSignals, path, 'Capture submission path depends on an environment variable.');
        }
        if (OWNED_CAPTURE_SUBMISSION_RE.test(source)) {
          pushFinding(captureOwnedSubmissionSignals, path, 'Owned API/server action/database/provider submission proof detected for capture flow.');
        }
        if (KNOWN_CAPTURE_PROVIDER_RE.test(source)) {
          pushFinding(captureProviderSignals, path, 'Known external form/email provider signal detected for capture flow.');
        }
      } else if (PARTIAL_SUBMISSION_RE.test(source)) {
        pushFinding(capturePartialSignals, path, 'Submit/local state handling detected, but no clear persistence or external submission path was found.');
      }
    }

    if (/<form\b/i.test(source)) {
      pushFinding(forms, path, 'Contains a form element.');
      const hasSubmitPath = /onSubmit\s*=|action\s*=|formAction\s*=|['"]use server['"]|fetch\s*\(|axios\.|navigator\.sendBeacon|emailjs|mailchimp|convertkit|supabase|firebase/i.test(source);
      if (!hasSubmitPath) {
        pushFinding(suspiciousForms, path, 'Form exists but no action, onSubmit, server action, network call, or common integration was detected.');
      } else if (/set[A-Z]\w*\([^)]*['"`]?\s*['"`]?\)|reset\(|preventDefault\(\)/.test(source) && !/fetch\s*\(|axios\.|['"]use server['"]|action\s*=|formAction\s*=|emailjs|mailchimp|convertkit|supabase|firebase/i.test(source)) {
        pushFinding(suspiciousForms, path, 'Form handler appears local-only; no network call, server action, action, or integration was detected.');
      }
    }

    const buttonMatches = (source.match(/<button\b[^>]*>/gi) ?? [])
      .filter(button => !button.includes('\\'));
    if (buttonMatches.length > 0) pushFinding(buttons, path, `${buttonMatches.length} button element(s) found.`);
    for (const button of buttonMatches) {
      const primaryCtaButton = isPrimaryCtaButton(button, source);
      if (primaryCtaButton) {
        pushFinding(ctaSignals, path, `CTA-oriented copy detected near button(s): ${button.slice(0, 120)}`);
        if (NAVIGATION_RE.test(button) || buttonHasExplicitBehavior(button, source)) {
          pushFinding(ctaWiringSignals, path, `CTA button has an explicit behavior signal: ${button.slice(0, 120)}`);
        }
      }
      if (primaryCtaButton && !buttonHasExplicitBehavior(button, source)) {
        pushFinding(suspiciousButtons, path, `Button may lack explicit behavior: ${button.slice(0, 120)}`);
      }
    }

    const badLinks = source.match(/href\s*=\s*["'](?:#|javascript:void\(0\)|)["']/gi) ?? [];
    for (const link of badLinks) pushFinding(suspiciousLinks, path, `Suspicious href found: ${link}`);

    if (includesAny(source, [/fetch\s*\(/, /axios\./, /XMLHttpRequest/, /navigator\.sendBeacon/, /['"]use server['"]/])) {
      pushFinding(networkCalls, path, 'Network call or server action signal detected.');
    }
    if (hasAnyMetadata(source)) {
      metadata.hasMetadata = true;
      metadata.files.push(path);
      if (/openGraph/i.test(source) || hasAstroOrHtmlOpenGraph(source)) metadata.hasOpenGraph = true;
      if (/twitter/i.test(source) || hasAstroOrHtmlTwitterMetadata(source)) metadata.hasTwitter = true;
    }
    if (includesAny(source, [/gtag\(/, /GoogleAnalytics/, /plausible/, /posthog/i, /mixpanel/i, /analytics/i, /@vercel\/analytics/])) {
      pushFinding(analytics, path, 'Analytics signal detected.');
    }
    if (/process\.env|import\.meta\.env|NEXT_PUBLIC_|PUBLIC_/.test(source)) {
      pushFinding(envUsage, path, 'Environment variable usage detected.');
    }
    if (BROWSER_GLOBAL_CODE_RE.test(codeOnlySource)) {
      pushFinding(browserGlobals, path, 'Browser API usage detected in runtime code.');
    }
    if (/useEffect\s*\(/.test(codeOnlySource) && BROWSER_GLOBAL_CODE_RE.test(codeOnlySource)) {
      pushFinding(useEffectBrowserCoupling, path, 'useEffect appears coupled to browser APIs.');
    }
    if (/<video\b|\.mp4|\.webm|\.mov|\.glb|\.gltf|three|@react-three|framer-motion|canvas\b|lottie/i.test(source)) {
      pushFinding(heavyAssets, path, 'Heavy media, animation, canvas, or 3D signal detected.');
    }
    const imgTags = source.match(/<img\b[^>]*>/gi) ?? [];
    for (const img of imgTags) {
      if (!/\balt\s*=/.test(img)) pushFinding(missingAltText, path, `Image tag may be missing alt text: ${img.slice(0, 120)}`);
    }
    if (/prefers-reduced-motion|useReducedMotion|motion-reduce|reducedMotion/i.test(source)) {
      pushFinding(reducedMotion, path, 'Reduced-motion support signal detected.');
    }
  }

  for (const entry of packageScan.binEntries) {
    const targetPath = join(root, entry.target);
    if (existsSync(targetPath)) {
      pushFinding(devtool.binTargets, 'package.json', `${entry.command} -> ${entry.target} exists.`);
    } else {
      pushFinding(devtool.missingBinTargets, 'package.json', `${entry.command} -> ${entry.target} does not exist.`);
    }
  }

  for (const fullPath of projectFiles) {
    const path = relative(root, fullPath);
    const normalizedPath = path.replace(/\\/g, '/');
    const isDocumentationFile = /(^|\/)(readme|docs?|documentation)(?:\/|\.|$)/i.test(normalizedPath) || /\.(md|mdx)$/i.test(normalizedPath);
    if (!isDocumentationFile) continue;
    let source = '';
    try {
      source = await readFile(fullPath, 'utf8');
    } catch {
      continue;
    }
    for (const commandPackage of collectInstallCommands(source)) {
      pushFinding(devtool.installCommands, path, `Install/run command references ${commandPackage}.`);
      const shouldCompareToLocalPackage = isCliPackage(packageScan);
      if (shouldCompareToLocalPackage && !packageNameMatchesDocumentedCommand(packageScan.name, commandPackage)) {
        pushFinding(devtool.installCommandMismatches, path, `Documented package ${commandPackage} does not match package.json name ${packageScan.name ?? 'unknown'}.`);
      }
    }
  }

  const publicFiles = {
    hasRobotsTxt: existsSync(join(root, 'public', 'robots.txt')) || existsSync(join(root, 'robots.txt')),
    hasSitemap: existsSync(join(root, 'public', 'sitemap.xml')) || existsSync(join(root, 'sitemap.xml')) || sourceFiles.some(file => basename(file).includes('sitemap')),
  };

  const largestFiles = reports
    .slice()
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 5)
    .map(report => ({ path: report.path, lines: report.lines, functions: report.functions }));

  const baseScanWithoutFindings = {
    package: packageScan,
    testFiles,
    routeFiles,
    apiRoutes,
    largestFiles,
    todos,
    forms,
    suspiciousForms,
    buttons,
    suspiciousButtons,
    suspiciousLinks,
    networkCalls,
    metadata,
    publicFiles,
    analytics,
    envUsage,
    browserGlobals,
    useEffectBrowserCoupling,
    heavyAssets,
    missingAltText,
    reducedMotion,
    riskyFiles,
    devtool,
    saasDashboard,
  };

  const actionFlows = [
    ...buildActionFlows({
      packageScan,
      devtool,
      captureSignals,
      captureWiringSignals,
      capturePartialSignals,
      captureEnvEndpointSignals,
      captureOwnedSubmissionSignals,
      captureProviderSignals,
      ctaSignals,
      ctaWiringSignals,
      suspiciousButtons,
    }),
    ...buildSaasDashboardActionFlows(saasDashboard),
  ];

  const launchFindings = buildLaunchFindings({
    ...baseScanWithoutFindings,
    actionFlows,
  });
  const baseScan = {
    ...baseScanWithoutFindings,
    actionFlows,
    launchFindings,
  };

  const projectTypeDetection = detectProjectType(baseScan, projectFiles.map(file => relative(root, file)));
  const projectType = projectTypeDetection.primaryType;
  const scanWithDetection = {
    ...baseScan,
    projectTypeDetection,
  };
  return {
    projectType,
    ...scanWithDetection,
    evidence: buildEvidence(scanWithDetection, projectType),
  };
}
