import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { getPrimaryFlowVerdictCap, runShipReadinessScan } from '../src/core/shipReadinessScan.js';
import type { FileReport } from '../src/core/analyst.js';

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.astro', '.html']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.next', '.zeno', 'coverage', 'out', 'build']);

interface HarnessExpectation {
  name: string;
  root: string;
  projectType?: string;
  includes?: string[];
  excludes?: string[];
  custom?: Array<{
    label: string;
    check: (context: HarnessContext) => boolean;
  }>;
}

interface HarnessContext {
  issues: string[];
  evidence: string;
  scan: Awaited<ReturnType<typeof runShipReadinessScan>>;
}

async function collectSourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = relative(root, fullPath);
      if (relPath.split(sep).some(part => SKIP_DIRS.has(part))) continue;

      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }

      if (entry.isFile() && SOURCE_EXTS.has(extname(entry.name))) {
        files.push(fullPath);
      }
    }
  }

  await visit(root);
  return files;
}

async function buildReports(root: string): Promise<FileReport[]> {
  const files = await collectSourceFiles(root);

  return Promise.all(files.map(async (file) => {
    const source = await readFile(file, 'utf8');
    return {
      path: relative(root, file),
      lines: source.split('\n').length,
      functions: (source.match(/\bfunction\b|=>/g) ?? []).length,
      imports: (source.match(/\bimport\b/g) ?? []).length,
      exports: (source.match(/^export\s/gm) ?? []).length,
      consoleLogs: (source.match(/\bconsole\.log\b/g) ?? []).length,
      hasTest: /\.(test|spec)\.[tj]sx?$/.test(file),
      hasReactSignals: /\b(useState|useEffect|React\.)\b/.test(source),
      hasBrowserGlobals: /\b(window|document|navigator|localStorage|sessionStorage)\b/.test(source),
      hasProcessEnv: /\bprocess\.env\b/.test(source),
      hasMutableExports: /^export\s+(let|var)\s/gm.test(source),
    };
  }));
}

function normalize(value: string): string {
  return value.toLowerCase();
}

function hasIssue(context: HarnessContext, expected: string): boolean {
  const needle = normalize(expected);
  return context.issues.some(issue => normalize(issue).includes(needle));
}

function hasEvidence(context: HarnessContext, expected: string): boolean {
  return normalize(context.evidence).includes(normalize(expected));
}

const fixtureRoot = join(process.cwd(), 'fixtures', 'ship-readiness');

const expectations: HarnessExpectation[] = [
  {
    name: 'landing-static-html',
    root: join(fixtureRoot, 'landing-static-html'),
    projectType: 'landing_page',
    custom: [
      {
        label: 'static HTML landing page has high confidence',
        check: ({ scan }) => scan.projectTypeDetection.confidenceLabel === 'high',
      },
      {
        label: 'static HTML landing page does not require a manual prompt',
        check: ({ scan }) => scan.projectTypeDetection.shouldAskUser === false,
      },
      {
        label: 'unwired CTA without external JavaScript remains a hard blocker candidate',
        check: ({ scan }) => scan.launchFindings.some(finding =>
          finding.issue === 'Primary CTA behavior needs verification' && finding.category === 'hard_blocker_candidate'),
      },
    ],
  },
  {
    name: 'landing-sellmo-external-js',
    root: join(fixtureRoot, 'landing-sellmo-external-js'),
    projectType: 'landing_page',
    includes: ['CTA behavior in external JavaScript could not be verified statically.'],
    excludes: [
      'Primary CTA behavior needs verification',
      'Required environment variables need validation',
    ],
    custom: [
      {
        label: 'external JavaScript CTA is not a hard blocker',
        check: ({ scan }) => !scan.launchFindings.some(finding =>
          finding.issue.includes('CTA') && (finding.category === 'hard_blocker' || finding.category === 'hard_blocker_candidate')),
      },
      {
        label: 'external JavaScript CTA does not create a primary-flow verdict cap',
        check: ({ scan }) => getPrimaryFlowVerdictCap(scan) === null,
      },
      {
        label: 'environment variable alias validation is detected',
        check: ({ scan }) => scan.saasDashboard.envValidationSignals.some(signal => signal.path.includes('send-confirmation')),
      },
    ],
  },
  {
    name: 'landing-astro-env-capture',
    root: join(fixtureRoot, 'landing-astro-env-capture'),
    projectType: 'landing_page',
    includes: ['Primary capture endpoint needs production proof'],
    excludes: [
      'Primary CTA behavior needs verification',
      'Billing/webhook flow needs verification',
      'Destructive action needs confirmation',
      'Install command may be wrong',
      'Missing OG/social metadata',
      'Data write needs validation/error handling',
      'Dashboard states need verification',
    ],
    custom: [
      {
        label: 'primary capture endpoint creates verdict cap',
        check: ({ scan }) => getPrimaryFlowVerdictCap(scan)?.finding.issue === 'Primary capture endpoint needs production proof',
      },
      {
        label: 'detects Astro/Open Graph metadata',
        check: ({ scan }) => scan.metadata.hasOpenGraph && scan.metadata.hasTwitter,
      },
      {
        label: 'keeps marketing billing copy out of executable billing signals',
        check: ({ scan }) => scan.saasDashboard.billingSignals.length === 0,
      },
      {
        label: 'keeps docs npx package name out of private-site mismatch',
        check: ({ scan }) => scan.devtool.installCommandMismatches.length === 0,
      },
      {
        label: 'treats aria-controls menu button as wired',
        check: ({ scan }) => scan.suspiciousButtons.length === 0,
      },
    ],
  },
  {
    name: 'landing-unwired-bad',
    root: join(fixtureRoot, 'landing-unwired-bad'),
    projectType: 'landing_page',
    includes: ['Waitlist/email capture appears unwired'],
    excludes: [
      'Primary capture endpoint needs production proof',
      'Dashboard states need verification',
    ],
    custom: [
      {
        label: 'unwired capture creates verdict cap',
        check: ({ scan }) => getPrimaryFlowVerdictCap(scan)?.finding.issue === 'Waitlist/email capture appears unwired',
      },
    ],
  },
  {
    name: 'landing-verified-good',
    root: join(fixtureRoot, 'landing-verified-good'),
    projectType: 'landing_page',
    excludes: [
      'Primary capture endpoint needs production proof',
      'Waitlist/email capture appears unwired',
      'Primary CTA behavior needs verification',
      'Missing OG/social metadata',
      'No analytics detected',
      'robots.txt or sitemap missing',
      'No test safety net detected',
    ],
    custom: [
      {
        label: 'verified capture does not create verdict cap',
        check: ({ scan }) => getPrimaryFlowVerdictCap(scan) === null,
      },
      {
        label: 'owned capture route is detected',
        check: ({ scan }) => scan.apiRoutes.some(path => path.includes('api/beta-updates/route')),
      },
    ],
  },
  {
    name: 'landing-next-good',
    root: join(fixtureRoot, 'landing-next-good'),
    projectType: 'landing_page',
    excludes: [
      'Primary CTA behavior needs verification',
      'Waitlist/email capture appears unwired',
      'Missing OG/social metadata',
      'Billing/webhook flow needs verification',
    ],
  },
  {
    name: 'devtool-good',
    root: join(fixtureRoot, 'devtool-good'),
    projectType: 'devtool',
    excludes: [
      'CLI entrypoint missing',
      'CLI bin target does not exist',
      'Install command may be wrong',
      'Filesystem writes need safety guard',
    ],
  },
  {
    name: 'devtool-bad',
    root: join(fixtureRoot, 'devtool-bad'),
    projectType: 'devtool',
    includes: [
      'CLI bin target does not exist',
      'Install command may be wrong',
      'Filesystem writes need safety guard',
    ],
  },
  {
    name: 'saas-good',
    root: join(fixtureRoot, 'saas-good'),
    projectType: 'saas_app',
    excludes: [
      'Protected routes need verification',
      'Data write needs validation/error handling',
      'Billing/webhook flow needs verification',
      'Destructive action needs confirmation',
    ],
  },
  {
    name: 'saas-bad',
    root: join(fixtureRoot, 'saas-bad'),
    includes: [
      'Protected routes need verification',
      'Data write needs validation/error handling',
      'Billing/webhook flow needs verification',
      'Destructive action needs confirmation',
    ],
  },
  {
    name: 'dashboard-bad',
    root: join(fixtureRoot, 'dashboard-bad'),
    projectType: 'dashboard',
    includes: [
      'Protected routes need verification',
      'Dashboard states need verification',
      'Destructive action needs confirmation',
    ],
  },
];

async function runCase(expectation: HarnessExpectation): Promise<string[]> {
  const scan = await runShipReadinessScan(expectation.root, await buildReports(expectation.root));
  const issues = scan.launchFindings.map(finding => finding.issue);
  const evidence = [
    ...scan.evidence,
    ...scan.launchFindings.map(finding => `${finding.issue} ${finding.evidence}`),
    ...scan.actionFlows.flatMap(flow => [flow.label, ...flow.evidence]),
  ].join('\n');
  const context: HarnessContext = { issues, evidence, scan };
  const failures: string[] = [];

  if (expectation.projectType && scan.projectType !== expectation.projectType) {
    failures.push(`expected project type ${expectation.projectType}, got ${scan.projectType}`);
  }

  for (const expectedIssue of expectation.includes ?? []) {
    if (!hasIssue(context, expectedIssue) && !hasEvidence(context, expectedIssue)) {
      failures.push(`expected finding containing "${expectedIssue}"`);
    }
  }

  for (const excludedIssue of expectation.excludes ?? []) {
    if (hasIssue(context, excludedIssue)) {
      failures.push(`unexpected finding containing "${excludedIssue}"`);
    }
  }

  for (const customCheck of expectation.custom ?? []) {
    if (!customCheck.check(context)) {
      failures.push(customCheck.label);
    }
  }

  return failures;
}

async function main(): Promise<void> {
  let failureCount = 0;

  for (const expectation of expectations) {
    const failures = await runCase(expectation);
    if (failures.length === 0) {
      console.log(`PASS ${expectation.name}`);
      continue;
    }

    failureCount += failures.length;
    console.error(`FAIL ${expectation.name}`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
  }

  if (failureCount > 0) {
    console.error(`\nShip-readiness harness failed with ${failureCount} failure${failureCount === 1 ? '' : 's'}.`);
    process.exit(1);
  }

  console.log('\nShip-readiness harness passed.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
