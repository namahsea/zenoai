import chalk from 'chalk';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { FileReport } from './analyst.js';
import { isHighConsequencePath } from './riskSignals.js';

type SecuritySeverity = 'Critical' | 'High' | 'Medium' | 'Low';

interface SecurityIssue {
  filePath: string;
  severity: SecuritySeverity;
  concern: string;
  detail: string;
}

function severityColor(severity: SecuritySeverity): (text: string) => string {
  switch (severity) {
    case 'Critical': return chalk.red;
    case 'High': return chalk.hex('#EF9F27');
    case 'Medium': return chalk.yellow;
    case 'Low': return chalk.green;
  }
}

function overallSeverity(issues: SecurityIssue[]): SecuritySeverity {
  if (issues.some(issue => issue.severity === 'Critical')) return 'Critical';
  if (issues.some(issue => issue.severity === 'High')) return 'High';
  if (issues.some(issue => issue.severity === 'Medium')) return 'Medium';
  return 'Low';
}

function looksLikeWebhook(filePath: string): boolean {
  return /webhook|webhooks/i.test(filePath);
}

function hasDataWrite(source: string): boolean {
  return /\.(create|update|upsert|delete|insert|save)\s*\(|\b(prisma|db|database)\.\w+\.(create|update|upsert|delete)\s*\(/.test(source);
}

function hasVerificationSignal(source: string): boolean {
  return /\b(verify|signature|hmac|authenticate|authenticator|authenticate\.webhook|validateWebhook)\b/i.test(source);
}

function hasSecretLookingValue(source: string): boolean {
  return /\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i.test(source);
}

function hasDangerousEval(source: string): boolean {
  return /\b(eval|Function)\s*\(/.test(source);
}

function hasDangerousHtml(source: string): boolean {
  return /dangerouslySetInnerHTML/.test(source);
}

function hasOpenRedirectSignal(source: string): boolean {
  return /\bredirect\s*\([^)]*(request|url|searchParams|params)\b/i.test(source);
}

async function inspectFile(report: FileReport): Promise<SecurityIssue[]> {
  let source: string;
  try {
    source = await readFile(report.path, 'utf8');
  } catch {
    return [];
  }

  const issues: SecurityIssue[] = [];

  if (looksLikeWebhook(report.path) && hasDataWrite(source) && !hasVerificationSignal(source)) {
    issues.push({
      filePath: report.path,
      severity: 'High',
      concern: 'Webhook route changes data before verification is obvious.',
      detail: 'Public webhook routes should prove the request is trusted before writing customer, cart, order, or subscription data.',
    });
  }

  if (isHighConsequencePath(report.path) && !report.hasTest) {
    issues.push({
      filePath: report.path,
      severity: 'Medium',
      concern: 'High-impact route has no visible safety tests.',
      detail: 'Auth, webhook, billing, checkout, cart, and order routes can affect real users or production data.',
    });
  }

  if (hasSecretLookingValue(source)) {
    issues.push({
      filePath: report.path,
      severity: 'Critical',
      concern: 'Secret-looking value appears in source code.',
      detail: 'API keys, tokens, and secrets should live in environment variables and never ship to the browser.',
    });
  }

  if (hasDangerousEval(source)) {
    issues.push({
      filePath: report.path,
      severity: 'High',
      concern: 'Dynamic code execution is present.',
      detail: 'eval-style code can turn user-controlled input into executable code.',
    });
  }

  if (hasDangerousHtml(source)) {
    issues.push({
      filePath: report.path,
      severity: 'Medium',
      concern: 'Raw HTML rendering is present.',
      detail: 'Raw HTML must be sanitized before rendering or it can expose users to script injection.',
    });
  }

  if (hasOpenRedirectSignal(source)) {
    issues.push({
      filePath: report.path,
      severity: 'Medium',
      concern: 'Redirect may depend on request input.',
      detail: 'User-controlled redirects should only allow known internal destinations.',
    });
  }

  return issues;
}

export async function runSecurityCheck(reports: FileReport[]): Promise<void> {
  const inspectedReports = reports.slice(0, 50);
  const issueGroups = await Promise.all(inspectedReports.map(inspectFile));
  const issues = issueGroups
    .flat()
    .sort((a, b) => {
      const order: Record<SecuritySeverity, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };
      return order[a.severity] - order[b.severity];
    });

  const severity = overallSeverity(issues);
  const severityFn = severityColor(severity);
  const now = new Date();
  const date = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

  console.log(chalk.bold.white('━━━  ZENOAI — SECURITY CHECK  ━━━'));
  console.log(chalk.dim(`Project     : ${basename(process.cwd())}`));
  console.log(chalk.dim('Reviewed by : Security Reviewer'));
  console.log(chalk.dim(`Files       : ${inspectedReports.length}`));
  console.log(chalk.dim(`Date        : ${date}, ${time}\n`));

  console.log(chalk.dim('Are there obvious security risks?'));
  if (issues.length === 0) {
    console.log(`${chalk.bold.green('No obvious high-risk issues found')}  ${chalk.green('[Low risk]')}\n`);
    console.log(chalk.bold('Next step'));
    console.log(chalk.dim('  Run this again before launch after major route, auth, payment, or webhook changes.\n'));
    console.log(chalk.bold.white('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    return;
  }

  console.log(`${chalk.bold(severityFn('Yes'))}  ${severityFn(`[${severity} risk]`)}\n`);

  console.log(chalk.bold('Main concern'));
  const mainIssue = issues[0];
  console.log(`  ${mainIssue.concern}`);
  console.log(`  ${chalk.dim(mainIssue.detail)}\n`);

  console.log(chalk.bold('Where to look'));
  for (const issue of issues.slice(0, 5)) {
    const color = severityColor(issue.severity);
    console.log(`  ${chalk.cyan(issue.filePath)} ${color(issue.severity)}`);
    console.log(`     ${chalk.dim(issue.concern)}`);
  }
  console.log('');

  console.log(chalk.bold('Safest next step'));
  console.log(`  Check ${mainIssue.filePath} first. ${mainIssue.detail}\n`);
  console.log(chalk.bold.white('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
}
