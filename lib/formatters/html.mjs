import { writeFileSync } from 'node:fs';

export function generateHtmlReport(data, outputPath) {
  const { scannedFiles, findings, errors } = data;
  
  // Hitung distribusi severitas untuk Chart
  const severityCounts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
  findings.forEach(f => {
    const sev = f.severity.toUpperCase();
    if (severityCounts[sev] !== undefined) severityCounts[sev]++;
    else severityCounts['INFO']++;
  });

  // Generate baris tabel temuan
  const findingsRows = findings.map(f => {
    const severityColor = {
      'CRITICAL': '#ef4444', // Merah
      'HIGH': '#f97316',     // Oranye
      'MEDIUM': '#eab308',   // Kuning
      'LOW': '#3b82f6',      // Biru
      'INFO': '#6b7280'      // Abu-abu
    }[f.severity.toUpperCase()] || '#6b7280';

    return `
      <tr>
        <td><span style="background:${severityColor}20; color:${severityColor}; padding:4px 8px; border-radius:4px; font-weight:bold; font-size:0.85em;">${f.severity}</span></td>
        <td><code style="background:#1e293b; padding:2px 6px; border-radius:4px;">${f.rule}</code></td>
        <td><code>${f.file}:${f.line}</code></td>
        <td>${f.message}</td>
        <td><pre style="background:#0f172a; padding:8px; border-radius:4px; border-left:3px solid ${severityColor}; margin:0; font-size:0.85em; color:#94a3b8;">${escapeHtml(f.snippet || 'No snippet available')}</pre></td>
      </tr>
    `;
  }).join('');

  // Generate baris tabel error (jika ada)
  const errorRows = errors.map(e => `
    <tr>
      <td colspan="5" style="color:#ef4444;">⚠️ Error scanning <code>${e.file}</code>: ${escapeHtml(e.error)}</td>
    </tr>
  `).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Noctra Security Report</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    :root { --bg: #0f172a; --card: #1e293b; --text: #e2e8f0; --text-muted: #94a3b8; --border: #334155; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 2rem; line-height: 1.6; }
    .container { max-width: 1200px; margin: 0 auto; }
    header { text-align: center; margin-bottom: 2rem; border-bottom: 1px solid var(--border); padding-bottom: 1rem; }
    header h1 { margin: 0; font-size: 2rem; background: linear-gradient(90deg, #3b82f6, #8b5cf6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
    .card { background: var(--card); padding: 1.5rem; border-radius: 8px; border: 1px solid var(--border); text-align: center; }
    .card h3 { margin: 0 0 0.5rem 0; color: var(--text-muted); font-size: 0.9rem; text-transform: uppercase; letter-spacing: 1px; }
    .card .number { font-size: 2.5rem; font-weight: bold; margin: 0; }
    .chart-container { background: var(--card); padding: 1.5rem; border-radius: 8px; border: 1px solid var(--border); margin-bottom: 2rem; max-width: 500px; margin-left: auto; margin-right: auto; }
    table { width: 100%; border-collapse: collapse; background: var(--card); border-radius: 8px; overflow: hidden; border: 1px solid var(--border); }
    th, td { padding: 1rem; text-align: left; border-bottom: 1px solid var(--border); }
    th { background: #0f172a; color: var(--text-muted); font-weight: 600; text-transform: uppercase; font-size: 0.85rem; }
    tr:last-child td { border-bottom: none; }
    .footer { text-align: center; margin-top: 3rem; color: var(--text-muted); font-size: 0.85rem; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🛡️ Noctra Security Intelligence Report</h1>
      <p style="color: var(--text-muted);">Generated on ${new Date().toLocaleString()}</p>
    </header>

    <div class="summary-grid">
      <div class="card"><h3>Files Scanned</h3><p class="number">${scannedFiles}</p></div>
      <div class="card"><h3>Total Findings</h3><p class="number" style="color: #ef4444;">${findings.length}</p></div>
      <div class="card"><h3>Critical</h3><p class="number" style="color: #ef4444;">${severityCounts.CRITICAL}</p></div>
      <div class="card"><h3>High</h3><p class="number" style="color: #f97316;">${severityCounts.HIGH}</p></div>
    </div>

    <div class="chart-container">
      <canvas id="severityChart"></canvas>
    </div>

    <h2 style="border-bottom: 1px solid var(--border); padding-bottom: 0.5rem;">🚨 Detailed Findings</h2>
    <table>
      <thead>
        <tr>
          <th>Severity</th>
          <th>Rule ID</th>
          <th>Location</th>
          <th>Message</th>
          <th>Code Snippet</th>
        </tr>
      </thead>
      <tbody>
        ${findingsRows || '<tr><td colspan="5" style="text-align:center; padding: 2rem;">✅ No vulnerabilities found. Great job!</td></tr>'}
        ${errorRows}
      </tbody>
    </table>

    <div class="footer">
      <p>Powered by <strong>Noctra Security Scanner</strong> | <a href="https://github.com/0xjenichord-web/noctra" style="color: #3b82f6;">github.com/0xjenichord-web/noctra</a></p>
    </div>
  </div>

  <script>
    const ctx = document.getElementById('severityChart').getContext('2d');
    new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Critical', 'High', 'Medium', 'Low', 'Info'],
        datasets: [{
          data: [${severityCounts.CRITICAL}, ${severityCounts.HIGH}, ${severityCounts.MEDIUM}, ${severityCounts.LOW}, ${severityCounts.INFO}],
          backgroundColor: ['#ef4444', '#f97316', '#eab308', '#3b82f6', '#6b7280'],
          borderWidth: 0
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { position: 'bottom', labels: { color: '#e2e8f0' } }
        }
      }
    });
  </script>
</body>
</html>`;

  writeFileSync(outputPath, html, 'utf-8');
  console.log(`\n🎨 HTML Dashboard Report saved to: ${outputPath}`);
  console.log(`💡 Tip: Open this file in your web browser to view the interactive dashboard.`);
}

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
