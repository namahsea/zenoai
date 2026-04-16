import type { HealthReport, RiskLevel, HealthLabel } from '../types.js';

export type { HealthReport };

function esc(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function riskClass(risk: RiskLevel): string {
  switch (risk) {
    case 'Critical': return 'risk-critical';
    case 'High':     return 'risk-high';
    case 'Medium':   return 'risk-medium';
    case 'Low':      return 'risk-low';
  }
}

function labelClass(label: HealthLabel): string {
  switch (label) {
    case 'Critical':
    case 'Concerning': return 'label-bad';
    case 'Fair':       return 'label-fair';
    case 'Good':       return 'label-good';
  }
}

function legibilityClass(score: number): string {
  if (score >= 8) return 'leg-high';
  if (score >= 5) return 'leg-mid';
  return 'leg-low';
}

export function generateHtml(report: HealthReport, root: string, fileCount: number): string {
  const date = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

  const riskyFilesRows = (report.files ?? []).map((f) => `
    <tr>
      <td class="file-path">${esc(f.path)}</td>
      <td><span class="${riskClass(f.risk)}">${esc(f.risk)}</span></td>
      <td><span class="${legibilityClass(f.legibility)}">${f.legibility} / 10</span></td>
      <td class="consequence">${esc(f.consequence)}</td>
    </tr>`).join('');

  const observationsHtml = (report.observations ?? []).map((obs, i) => `
    <div class="obs-item">
      <span class="obs-num">${i + 1}.</span>${esc(obs)}
    </div>`).join('');

  const actionsHtml = (report.actions ?? []).map((item, i) => `
    <div class="action-item">
      <div class="action-title">${i + 1}. ${esc(item.instruction)}</div>
      <div class="action-reason">${esc(item.rationale)}</div>
    </div>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Zenoai — Codebase Health Report</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: #0d1117;
    color: #e6edf3;
    font-family: 'Courier New', Courier, monospace;
    font-size: 14px;
    line-height: 1.7;
    padding: 48px 24px;
  }

  .container {
    max-width: 860px;
    margin: 0 auto;
  }

  .header-rule {
    color: #ffffff;
    font-weight: bold;
    font-size: 15px;
    letter-spacing: 1px;
    margin-bottom: 16px;
  }

  .meta {
    color: #8b949e;
    margin-bottom: 3px;
  }

  .section {
    margin-top: 32px;
  }

  .section-title {
    color: #ffffff;
    font-weight: bold;
    font-size: 15px;
    margin-bottom: 14px;
  }

  .score-line {
    font-size: 20px;
    font-weight: bold;
    margin-bottom: 6px;
  }

  .score-context {
    color: #8b949e;
    font-size: 13px;
  }

  .label-bad  { color: #f85149; }
  .label-fair { color: #d29922; }
  .label-good { color: #3fb950; }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }

  thead th {
    text-align: left;
    color: #ffffff;
    font-weight: bold;
    padding: 8px 12px;
    border-bottom: 1px solid #30363d;
  }

  tbody td {
    padding: 8px 12px;
    border-bottom: 1px solid #21262d;
    vertical-align: top;
  }

  .file-path   { color: #79c0ff; }
  .consequence { color: #8b949e; }

  .risk-critical { color: #f85149; font-weight: bold; }
  .risk-high     { color: #EF9F27; font-weight: bold; }
  .risk-medium   { color: #d29922; font-weight: bold; }
  .risk-low      { color: #3fb950; font-weight: bold; }

  .leg-high { color: #3fb950; }
  .leg-mid  { color: #d29922; }
  .leg-low  { color: #f85149; }

  .obs-item {
    margin-bottom: 8px;
    padding-left: 4px;
  }

  .obs-num {
    color: #8b949e;
    margin-right: 10px;
  }

  .action-item {
    margin-bottom: 18px;
    padding-left: 4px;
  }

  .action-title {
    color: #ffffff;
    font-weight: bold;
    margin-bottom: 4px;
  }

  .action-reason {
    color: #8b949e;
    padding-left: 20px;
    font-size: 13px;
  }

  .start-here-box {
    border: 1px solid #d29922;
    border-radius: 6px;
    padding: 20px 24px;
    background: #161b22;
  }

  .start-here-label {
    color: #ffffff;
    font-weight: bold;
    margin-bottom: 10px;
    font-size: 15px;
  }

  .start-here-text {
    color: #e6edf3;
    font-size: 13px;
  }

  .footer-rule {
    color: #ffffff;
    font-weight: bold;
    font-size: 15px;
    letter-spacing: 1px;
    margin-top: 32px;
  }

  @media print {
    body { background: #ffffff; color: #111111; padding: 24px; }
    .header-rule, .footer-rule { color: #111111; }
    .meta { color: #444444; }
    .section-title { color: #111111; }
    .score-line.label-bad  { color: #cc0000; }
    .score-line.label-fair { color: #b86800; }
    .score-line.label-good { color: #1a7f37; }
    .score-context { color: #444444; }
    .file-path { color: #0550ae; }
    .consequence { color: #444444; }
    .risk-critical { color: #cc0000; }
    .risk-high     { color: #b86800; }
    .risk-medium   { color: #9a6700; }
    .risk-low      { color: #1a7f37; }
    .leg-high { color: #1a7f37; }
    .leg-mid  { color: #9a6700; }
    .leg-low  { color: #cc0000; }
    .obs-num { color: #444444; }
    .action-title { color: #111111; }
    .action-reason { color: #444444; }
    .start-here-box { background: #fffbea; border-color: #b86800; }
    .start-here-label { color: #111111; }
    .start-here-text { color: #111111; }
    thead th { color: #111111; border-bottom-color: #cccccc; }
    tbody td { border-bottom-color: #eeeeee; }
  }
</style>
</head>
<body>
<div class="container">

  <div class="header-rule">━━━  ZENOAI — CODEBASE HEALTH REPORT  ━━━</div>
  <div class="meta">Directory : ${esc(root)}</div>
  <div class="meta">Files     : ${fileCount}</div>
  <div class="meta">Date      : ${date}</div>

  <div class="section">
    <div class="section-title">Health Score</div>
    <div class="score-line ${labelClass(report.label)}">
      ${report.score} / 10 &nbsp; [${esc(report.label)}]
    </div>
    <div class="score-context">${esc(report.summary)}</div>
  </div>

  ${report.files?.length ? `
  <div class="section">
    <div class="section-title">Risky Files</div>
    <table>
      <thead>
        <tr>
          <th>File</th>
          <th>Risk</th>
          <th>Legibility</th>
          <th>Consequence</th>
        </tr>
      </thead>
      <tbody>${riskyFilesRows}</tbody>
    </table>
  </div>` : ''}

  ${report.observations?.length ? `
  <div class="section">
    <div class="section-title">Observations</div>
    ${observationsHtml}
  </div>` : ''}

  ${report.actions?.length ? `
  <div class="section">
    <div class="section-title">Suggested Actions</div>
    ${actionsHtml}
  </div>` : ''}

  ${report.start ? `
  <div class="section">
    <div class="start-here-box">
      <div class="start-here-label">Where to start</div>
      <div class="start-here-text">${esc(report.start)}</div>
    </div>
  </div>` : ''}

  <div class="footer-rule">━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</div>

</div>
</body>
</html>`;
}
