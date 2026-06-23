import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import type { FileReport } from './analyst.js';
import { isHighConsequencePath } from './riskSignals.js';
import type { ProjectType } from '../types.js';

export interface PackageScan {
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'unknown';
  framework: string;
  scripts: Record<string, string>;
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

export interface LaunchFinding {
  category: 'hard_blocker_candidate' | 'soft_blocker' | 'code_ownership_risk';
  issue: string;
  severity: 'Critical' | 'High' | 'Medium' | 'Low';
  certainty: 'confirmed' | 'likely' | 'needs_verification' | 'inferred';
  evidence: string;
  suggestedFix: string;
}

export interface ShipReadinessScan {
  projectType: ProjectType;
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
  launchFindings: LaunchFinding[];
  evidence: string[];
}

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.astro']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.next', 'coverage', 'out', 'build']);
const TEST_RE = /(?:^|[./_-])(?:test|tests|spec|__tests__)(?:[./_-]|$)|\.(?:test|spec)\.[tj]sx?$/i;

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
    hasBuildScript: false,
    hasLintScript: false,
    hasTestScript: false,
    dependencies: [],
    devDependencies: [],
  };

  try {
    const raw = await readFile(join(root, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const scripts = parsed.scripts ?? {};
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
      framework,
      scripts,
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

function includesAny(source: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(source));
}

function pushFinding(target: SourceFinding[], path: string, evidence: string, limit = 20): void {
  if (target.length >= limit) return;
  target.push({ path, evidence });
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

function inferProjectType(scan: Omit<ShipReadinessScan, 'projectType' | 'evidence'>): ProjectType {
  const allPaths = [
    ...scan.routeFiles,
    ...scan.apiRoutes,
    ...scan.riskyFiles.map(item => item.path),
  ].join('\n').toLowerCase();

  if (scan.package.dependencies.includes('commander') || scan.package.dependencies.includes('inquirer') || scan.package.dependencies.includes('@inquirer/prompts')) {
    return 'cli_tooling';
  }
  if (/checkout|payment|billing|subscription|cart|order/.test(allPaths)) return 'ecommerce_payment_app';
  if (/auth|login|session|permission/.test(allPaths)) return 'auth_app';
  if (scan.apiRoutes.length >= 3 || scan.package.framework === 'backend') return 'backend_api';
  if (/dashboard|admin|settings|account/.test(allPaths)) return 'dashboard';
  if (scan.forms.length > 0 && scan.apiRoutes.length <= 2 && scan.routeFiles.length <= 8) return 'landing_page';
  if (scan.package.framework === 'next' || scan.package.framework === 'react' || scan.package.framework === 'vite' || scan.package.framework === 'astro') {
    return scan.apiRoutes.length <= 1 ? 'landing_page' : 'saas_app';
  }
  return 'unknown';
}

function buildEvidence(scan: Omit<ShipReadinessScan, 'projectType' | 'evidence'>, projectType: ProjectType): string[] {
  const evidence: string[] = [];
  evidence.push(`Project type inferred as ${projectType}.`);
  evidence.push(`Framework: ${scan.package.framework}; package manager: ${scan.package.packageManager}.`);
  evidence.push(`Scripts: build=${scan.package.hasBuildScript ? 'yes' : 'no'}, lint=${scan.package.hasLintScript ? 'yes' : 'no'}, test=${scan.package.hasTestScript ? 'yes' : 'no'}.`);
  evidence.push(`Tests detected: ${scan.testFiles.length}.`);
  evidence.push(`Routes/pages detected: ${scan.routeFiles.length}; API/server routes detected: ${scan.apiRoutes.length}.`);
  if (scan.suspiciousForms.length > 0) evidence.push(`${scan.suspiciousForms.length} form(s) look unwired or only locally handled.`);
  if (scan.suspiciousButtons.length > 0) evidence.push(`${scan.suspiciousButtons.length} button(s) may lack meaningful click behavior.`);
  if (scan.suspiciousLinks.length > 0) evidence.push(`${scan.suspiciousLinks.length} suspicious link(s) found, such as empty href, #, or javascript:void(0).`);
  evidence.push(`Metadata: base=${scan.metadata.hasMetadata ? 'yes' : 'no'}, openGraph=${scan.metadata.hasOpenGraph ? 'yes' : 'no'}, twitter=${scan.metadata.hasTwitter ? 'yes' : 'no'}.`);
  evidence.push(`Public files: robots.txt=${scan.publicFiles.hasRobotsTxt ? 'yes' : 'no'}, sitemap=${scan.publicFiles.hasSitemap ? 'yes' : 'no'}.`);
  evidence.push(`Analytics detected: ${scan.analytics.length > 0 ? 'yes' : 'no'}.`);
  if (scan.heavyAssets.length > 0) evidence.push(`${scan.heavyAssets.length} heavy media/animation signal(s) found.`);
  if (scan.missingAltText.length > 0) evidence.push(`${scan.missingAltText.length} possible missing image alt text issue(s) found.`);
  if (scan.reducedMotion.length === 0 && scan.heavyAssets.length > 0) evidence.push('Heavy media/animation found but no reduced-motion signal detected.');
  return evidence;
}

function buildLaunchFindings(scan: Omit<ShipReadinessScan, 'projectType' | 'evidence' | 'launchFindings'>): LaunchFinding[] {
  const findings: LaunchFinding[] = [];

  for (const form of scan.suspiciousForms.slice(0, 3)) {
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
    findings.push({
      category: 'hard_blocker_candidate',
      issue: 'Primary CTA behavior needs verification',
      severity: 'High',
      certainty: 'needs_verification',
      evidence: `${button.path}: ${button.evidence}`,
      suggestedFix: 'Confirm the button either submits a real form, navigates to a real destination, or is disabled/labelled before launch.',
    });
  }

  if (!scan.metadata.hasOpenGraph || !scan.metadata.hasTwitter) {
    findings.push({
      category: 'soft_blocker',
      issue: 'Missing OG/social metadata',
      severity: 'Medium',
      certainty: 'confirmed',
      evidence: `Metadata scan: openGraph=${scan.metadata.hasOpenGraph ? 'yes' : 'no'}, twitter=${scan.metadata.hasTwitter ? 'yes' : 'no'}.`,
      suggestedFix: 'Add Open Graph and Twitter metadata before public/social launch.',
    });
  }

  if (scan.analytics.length === 0) {
    findings.push({
      category: 'soft_blocker',
      issue: 'No analytics detected',
      severity: 'Medium',
      certainty: 'confirmed',
      evidence: 'No common analytics signal was detected in source files.',
      suggestedFix: 'Add analytics before public launch or paid traffic so visits and conversions are measurable.',
    });
  }

  if (!scan.publicFiles.hasRobotsTxt || !scan.publicFiles.hasSitemap) {
    findings.push({
      category: 'soft_blocker',
      issue: 'robots.txt or sitemap missing',
      severity: 'Low',
      certainty: 'confirmed',
      evidence: `robots.txt=${scan.publicFiles.hasRobotsTxt ? 'yes' : 'no'}, sitemap=${scan.publicFiles.hasSitemap ? 'yes' : 'no'}.`,
      suggestedFix: 'Add robots.txt and sitemap.xml when preparing for public indexing.',
    });
  }

  if (scan.heavyAssets.length > 0) {
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

export async function runShipReadinessScan(root: string, reports: FileReport[]): Promise<ShipReadinessScan> {
  const packageScan = await readPackage(root);
  const sourceFiles = collectSourceFiles(root);

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
  const metadata = {
    hasMetadata: false,
    hasOpenGraph: false,
    hasTwitter: false,
    files: [] as string[],
  };

  for (const fullPath of sourceFiles) {
    const path = relative(root, fullPath);
    if (TEST_RE.test(path)) testFiles.push(path);
    if (routeFile(path)) routeFiles.push(path);
    if (apiRouteFile(path)) apiRoutes.push(path);
    if (isHighConsequencePath(path)) pushFinding(riskyFiles, path, 'Path name suggests auth/payment/webhook/data-write consequence.');

    let source = '';
    try {
      source = await readFile(fullPath, 'utf8');
    } catch {
      continue;
    }

    if (/TODO|FIXME|HACK/.test(source)) pushFinding(todos, path, 'Contains TODO/FIXME/HACK comment.');
    if (/<form\b/i.test(source)) {
      pushFinding(forms, path, 'Contains a form element.');
      const hasSubmitPath = /onSubmit\s*=|action\s*=|formAction\s*=|['"]use server['"]|fetch\s*\(|axios\.|navigator\.sendBeacon|emailjs|mailchimp|convertkit|supabase|firebase/i.test(source);
      if (!hasSubmitPath) {
        pushFinding(suspiciousForms, path, 'Form exists but no action, onSubmit, server action, network call, or common integration was detected.');
      } else if (/set[A-Z]\w*\([^)]*['"`]?\s*['"`]?\)|reset\(|preventDefault\(\)/.test(source) && !/fetch\s*\(|axios\.|['"]use server['"]|action\s*=|formAction\s*=|emailjs|mailchimp|convertkit|supabase|firebase/i.test(source)) {
        pushFinding(suspiciousForms, path, 'Form handler appears local-only; no network call, server action, action, or integration was detected.');
      }
    }

    const buttonMatches = source.match(/<button\b[^>]*>/gi) ?? [];
    if (buttonMatches.length > 0) pushFinding(buttons, path, `${buttonMatches.length} button element(s) found.`);
    for (const button of buttonMatches) {
      if (!/onClick\s*=|type\s*=\s*["']submit["']|formAction\s*=|aria-label\s*=|disabled\b/i.test(button)) {
        pushFinding(suspiciousButtons, path, `Button may lack explicit behavior: ${button.slice(0, 120)}`);
      }
    }

    const badLinks = source.match(/href\s*=\s*["'](?:#|javascript:void\(0\)|)["']/gi) ?? [];
    for (const link of badLinks) pushFinding(suspiciousLinks, path, `Suspicious href found: ${link}`);

    if (includesAny(source, [/fetch\s*\(/, /axios\./, /XMLHttpRequest/, /navigator\.sendBeacon/, /['"]use server['"]/])) {
      pushFinding(networkCalls, path, 'Network call or server action signal detected.');
    }
    if (includesAny(source, [/export\s+const\s+metadata\s*=/, /<Head\b/, /openGraph/i, /twitter/i, /metadataBase/i])) {
      metadata.hasMetadata = true;
      metadata.files.push(path);
      if (/openGraph/i.test(source)) metadata.hasOpenGraph = true;
      if (/twitter/i.test(source)) metadata.hasTwitter = true;
    }
    if (includesAny(source, [/gtag\(/, /GoogleAnalytics/, /plausible/, /posthog/i, /mixpanel/i, /analytics/i, /@vercel\/analytics/])) {
      pushFinding(analytics, path, 'Analytics signal detected.');
    }
    if (/process\.env|import\.meta\.env|NEXT_PUBLIC_|PUBLIC_/.test(source)) {
      pushFinding(envUsage, path, 'Environment variable usage detected.');
    }
    if (/(window|document|localStorage|sessionStorage|navigator)\b/.test(source)) {
      pushFinding(browserGlobals, path, 'Browser global usage detected.');
    }
    if (/useEffect\s*\(/.test(source) && /(window|document|localStorage|sessionStorage|navigator)\b/.test(source)) {
      pushFinding(useEffectBrowserCoupling, path, 'useEffect appears coupled to browser globals.');
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
  };

  const launchFindings = buildLaunchFindings(baseScanWithoutFindings);
  const baseScan = {
    ...baseScanWithoutFindings,
    launchFindings,
  };

  const projectType = inferProjectType(baseScan);
  return {
    projectType,
    ...baseScan,
    evidence: buildEvidence(baseScan, projectType),
  };
}
