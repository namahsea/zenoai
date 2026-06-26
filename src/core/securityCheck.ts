import chalk from 'chalk';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { FileReport } from './analyst.js';
import { isHighConsequencePath } from './riskSignals.js';
import { runProgress } from './progress.js';
import { riskTone, theme } from './theme.js';

type SecuritySeverity = 'Critical' | 'High' | 'Medium' | 'Low';

interface SecurityIssue {
  filePath: string;
  severity: SecuritySeverity;
  concern: string;
  detail: string;
  nextStep: string;
}

function severityColor(severity: SecuritySeverity): (text: string) => string {
  return riskTone(severity);
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

function looksLikeAuthOrSession(filePath: string): boolean {
  return /(?:^|[./_-])(auth|session|login)(?:[./_-]|$)/i.test(filePath);
}

function looksLikeDataRoute(filePath: string): boolean {
  return /(?:^|[./_-])(checkout|checkouts|payment|payments|order|orders|subscription|subscriptions|billing|cart|carts)(?:[./_-]|$)/i.test(filePath);
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

function hasPermissiveCors(source: string): boolean {
  return /Access-Control-Allow-Origin['"]?\s*[,=:]\s*['"]\*['"]|origin\s*:\s*(?:true|['"]\*['"])/i.test(source);
}

function hasDisabledTlsVerification(source: string): boolean {
  return /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]0['"]|rejectUnauthorized\s*:\s*false/i.test(source);
}

function hasWeakCrypto(source: string): boolean {
  return /\b(md5|sha1)\b|createHash\s*\(\s*['"](?:md5|sha1)['"]\s*\)/i.test(source);
}

function hasCommandExecution(source: string): boolean {
  return /\b(?:exec|execSync|spawn|spawnSync)\s*\(|from\s+['"]node:child_process['"]|from\s+['"]child_process['"]/i.test(source);
}

function hasUnsafeDatabaseQuery(source: string): boolean {
  return /\$(?:queryRawUnsafe|executeRawUnsafe)\b|\b(?:query|execute)\s*\(\s*`[\s\S]*?\$\{/i.test(source);
}

function hasRiskyFileAccess(source: string): boolean {
  const fileAccessPattern = /\b(?:readFile|writeFile|appendFile|unlink|rm|rename|createReadStream|createWriteStream)\s*\(([\s\S]{0,180})\)/gi;
  for (const match of source.matchAll(fileAccessPattern)) {
    if (/\b(?:req|request|params|searchParams|body|formData|url|pathname|input|userInput)\b/i.test(match[1] ?? '')) {
      return true;
    }
  }
  return false;
}

function isClientComponent(source: string): boolean {
  const firstLines = source.split('\n').slice(0, 8).join('\n');
  return /['"]use client['"]/.test(firstLines);
}

function hasServerOnlyClientLeak(source: string): boolean {
  if (!isClientComponent(source)) return false;
  return /from\s+['"][^'"]*(?:\.server|server-only|node:fs|fs|node:child_process|child_process)[^'"]*['"]|\bprocess\.env\b/i.test(source);
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
      nextStep: 'Confirm webhook signature verification happens before any database write.',
    });
  }

  if (looksLikeAuthOrSession(report.path) && !report.hasTest) {
    issues.push({
      filePath: report.path,
      severity: 'High',
      concern: 'Auth or session route has no visible safety tests.',
      detail: 'Login and session routes decide who can access the app. Bugs here can lock users out or expose accounts.',
      nextStep: 'Review session creation, failed login, and unauthorized access behavior.',
    });
  } else if ((looksLikeWebhook(report.path) || looksLikeDataRoute(report.path) || isHighConsequencePath(report.path)) && !report.hasTest) {
    issues.push({
      filePath: report.path,
      severity: looksLikeWebhook(report.path) ? 'High' : 'Medium',
      concern: 'High-impact route has no visible safety tests.',
      detail: 'Webhook, billing, checkout, cart, and order routes can affect real users or production data.',
      nextStep: 'Add tests around the route before changing it or shipping new behavior.',
    });
  }

  if (hasSecretLookingValue(source)) {
    issues.push({
      filePath: report.path,
      severity: 'Critical',
      concern: 'Secret-looking value appears in source code.',
      detail: 'API keys, tokens, and secrets should live in environment variables and never ship to the browser.',
      nextStep: 'Move the value to an environment variable and rotate it if it may have been exposed.',
    });
  }

  if (hasDangerousEval(source)) {
    issues.push({
      filePath: report.path,
      severity: 'High',
      concern: 'Dynamic code execution is present.',
      detail: 'eval-style code can turn user-controlled input into executable code.',
      nextStep: 'Remove dynamic code execution or strictly isolate it from user-controlled input.',
    });
  }

  if (hasDangerousHtml(source)) {
    issues.push({
      filePath: report.path,
      severity: 'Medium',
      concern: 'Raw HTML rendering is present.',
      detail: 'Raw HTML must be sanitized before rendering or it can expose users to script injection.',
      nextStep: 'Confirm the HTML is sanitized before rendering.',
    });
  }

  if (hasOpenRedirectSignal(source)) {
    issues.push({
      filePath: report.path,
      severity: 'Medium',
      concern: 'Redirect may depend on request input.',
      detail: 'User-controlled redirects should only allow known internal destinations.',
      nextStep: 'Restrict redirects to known internal paths or an allowlist.',
    });
  }

  if (hasPermissiveCors(source)) {
    issues.push({
      filePath: report.path,
      severity: 'Medium',
      concern: 'CORS appears to allow broad cross-origin access.',
      detail: 'Permissive CORS can expose API responses to websites you do not control.',
      nextStep: 'Restrict CORS to known production origins and keep credentials handling explicit.',
    });
  }

  if (hasDisabledTlsVerification(source)) {
    issues.push({
      filePath: report.path,
      severity: 'High',
      concern: 'TLS verification appears to be disabled.',
      detail: 'Disabling certificate verification can make server-to-server requests vulnerable to interception.',
      nextStep: 'Remove the TLS bypass and fix the certificate or local development setup instead.',
    });
  }

  if (hasWeakCrypto(source)) {
    issues.push({
      filePath: report.path,
      severity: 'Medium',
      concern: 'Weak hashing algorithm is present.',
      detail: 'MD5 and SHA-1 are not suitable for password storage, signatures, or security-sensitive integrity checks.',
      nextStep: 'Use a modern password hashing or signing approach appropriate to the use case.',
    });
  }

  if (hasCommandExecution(source)) {
    issues.push({
      filePath: report.path,
      severity: 'High',
      concern: 'Shell command execution is present.',
      detail: 'Command execution is high risk if any argument can be influenced by a user, request, or external input.',
      nextStep: 'Avoid shell execution, or strictly validate and hard-code allowed commands and arguments.',
    });
  }

  if (hasUnsafeDatabaseQuery(source)) {
    issues.push({
      filePath: report.path,
      severity: 'High',
      concern: 'Database query may use raw string input.',
      detail: 'Raw SQL built from strings can expose customer or production data through injection bugs.',
      nextStep: 'Use parameterized queries or ORM helpers instead of interpolated raw SQL.',
    });
  }

  if (hasRiskyFileAccess(source)) {
    issues.push({
      filePath: report.path,
      severity: 'Medium',
      concern: 'File access may depend on request input.',
      detail: 'Reading or writing paths from request data can create path traversal or unsafe file overwrite issues.',
      nextStep: 'Resolve paths against an allowlisted directory and reject parent-directory traversal.',
    });
  }

  if (hasServerOnlyClientLeak(source)) {
    issues.push({
      filePath: report.path,
      severity: 'High',
      concern: 'Client component appears to import server-only code.',
      detail: 'Server-only modules, filesystem access, command execution, or environment secrets should not enter browser bundles.',
      nextStep: 'Move server-only work behind a route, server action, loader, or API boundary.',
    });
  }

  return issues;
}

export async function runSecurityCheck(reports: FileReport[]): Promise<void> {
  const inspectedReports = reports.slice(0, 50);
  const issueGroups = await runProgress(
    {
      label: 'scanning files',
      total: inspectedReports.length,
      minDurationMs: 1200,
      maxDurationMs: 5200,
    },
    () => Promise.all(inspectedReports.map(inspectFile)),
  );
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

  console.log(theme.title('━━━  ZENOAI — SECURITY CHECK  ━━━'));
  console.log(theme.muted(`Project     : ${basename(process.cwd())}`));
  console.log(theme.muted('Reviewed by : Security Reviewer'));
  console.log(theme.muted('Scan type   : Local static scan'));
  console.log(theme.muted(`Files       : ${inspectedReports.length}`));
  console.log(theme.muted(`Date        : ${date}, ${time}\n`));

  console.log(theme.heading('What Zeno checked'));
  console.log(theme.muted('  - exposed secrets and client/server boundary leaks'));
  console.log(theme.muted('  - auth, webhook, payment, cart, order, and billing routes'));
  console.log(theme.muted('  - unsafe redirects and permissive CORS'));
  console.log(theme.muted('  - raw HTML rendering and dynamic code execution'));
  console.log(theme.muted('  - weak crypto, disabled TLS, command execution, and risky file/database access\n'));

  console.log(theme.heading('Note'));
  console.log(theme.muted('  This checks obvious risk signals. It is not a full security audit.\n'));

  console.log(theme.muted('Are there obvious security risks?'));
  if (issues.length === 0) {
    console.log(`${chalk.bold(theme.success('No obvious high-risk issues found'))}  ${theme.success('[Low risk]')}\n`);
    console.log(theme.heading('Next step'));
    console.log(theme.muted('  Run this again before launch after major route, auth, payment, or webhook changes.\n'));
    console.log(theme.divider('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    return;
  }

  console.log(`${chalk.bold(severityFn('Yes'))}  ${severityFn(`[${severity} risk]`)}\n`);

  console.log(theme.heading('Main concern'));
  const mainIssue = issues[0];
  console.log(`  ${theme.text(mainIssue.concern)}`);
  console.log(`  ${theme.muted(mainIssue.detail)}\n`);

  console.log(theme.heading('Where to look'));
  for (const issue of issues.slice(0, 5)) {
    const color = severityColor(issue.severity);
    console.log(`  ${theme.file(issue.filePath)} ${color(issue.severity)}`);
    console.log(`     ${theme.muted(issue.concern)}`);
  }
  console.log('');

  console.log(theme.heading('Safest next step'));
  console.log(`  ${theme.text(`Start with ${mainIssue.filePath}. ${mainIssue.nextStep}`)}\n`);
  console.log(theme.divider('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
}
