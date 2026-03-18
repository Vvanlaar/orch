#!/usr/bin/env node
/**
 * Standalone audit one-pager: Proper Access WCAG 2.2 videospeler audit summary.
 * Generates HTML + PDF (via Playwright). BB branded. Two A4 pages.
 *
 * Usage: node audit-summary.mjs [--output <path>]
 */
import { writeFileSync } from "fs";
import { AUDIT_DATA } from "./audit-data.mjs";

function generateHTML() {
  const players = Object.entries(AUDIT_DATA.players)
    .sort((a, b) => a[1].findings - b[1].findings);

  const categories = Object.entries(AUDIT_DATA.categories)
    .sort((a, b) => b[1].playersAffected - a[1].playersAffected);

  const totalPlayers = players.length;
  const passCount = players.filter(([, d]) => d.status === "pass").length;
  const failCount = totalPlayers - passCount;
  const maxAffected = Math.max(...categories.map(([, c]) => c.playersAffected));

  const playerRows = players.map(([name, data]) => {
    const isPass = data.status === "pass";
    const rowClass = isPass ? ' class="row-success"' : '';
    const nameClass = isPass ? ' class="fw-bold"' : '';
    const badge = isPass
      ? `<span class="status status-pass">Voldoet</span>`
      : `<span class="status status-fail">Voldoet niet</span>`;
    return `<tr${rowClass}>
      <td${nameClass}>${name}</td>
      <td class="text-center">${data.findings}</td>
      <td class="text-center">${data.failedSC}</td>
      <td class="text-center">${badge}</td>
    </tr>`;
  }).join("");

  const categoryBars = categories.map(([name, cat]) => {
    const pct = (cat.playersAffected / maxAffected) * 100;
    return `<div class="category-item">
      <div class="category-header">
        <span><strong>${name}</strong> — ${cat.description}</span>
        <span class="category-count">${cat.playersAffected} van ${totalPlayers} spelers</span>
      </div>
      <div class="bar-bg"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
    </div>`;
  }).join("");

  const footer = (page) => `<div class="page-footer">
      <div>Pagina ${page} van 2</div>
      <div>
        <span class="footer-logo">Blue Billywig</span> &nbsp;|&nbsp;
        <a href="https://www.bluebillywig.com/nl/demo/">bluebillywig.com/nl/demo</a> &nbsp;|&nbsp;
        <a href="https://www.bluebillywig.com/nl/contact/">Contact</a>
      </div>
    </div>`;

  return `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Toegankelijkheidsaudit Videospelers — Samenvatting</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
    * { margin: 0; padding: 0; box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { font-family: 'Inter', -apple-system, sans-serif; color: #334155; background: #e2e8f0; line-height: 1.6; display: flex; flex-direction: column; align-items: center; padding: 2rem 0; }
    .page { width: 210mm; height: 297mm; background: white; margin-bottom: 2rem; padding: 20mm 20mm 25mm 20mm; box-shadow: 0 10px 25px rgba(0,0,0,0.1); position: relative; overflow: hidden; }
    .page::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 6px; background: linear-gradient(90deg, #1a3a5c 0%, #4a90d9 100%); }
    h1 { font-size: 26px; font-weight: 800; color: #0f172a; margin-bottom: 4px; letter-spacing: -0.5px; }
    h2 { font-size: 18px; font-weight: 700; color: #0f172a; margin: 32px 0 16px; border-bottom: 2px solid #f1f5f9; padding-bottom: 8px; }
    p { margin: 8px 0; color: #475569; font-size: 14px; }
    strong { color: #0f172a; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; }
    .header-subtitle { color: #64748b; font-size: 14px; margin-top: 2px; }
    table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 13px; }
    th { background: #f8fafc; color: #475569; padding: 12px 16px; text-align: left; font-weight: 600; border-bottom: 2px solid #e2e8f0; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; }
    td { padding: 12px 16px; border-bottom: 1px solid #f1f5f9; }
    tr:nth-child(even) td { background: #fafbfc; }
    .text-center { text-align: center; }
    .fw-bold { font-weight: 700; color: #0f172a; }
    .status { padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; display: inline-block; }
    .status-pass { background: #dcfce7; color: #166534; }
    .status-fail { background: #fee2e2; color: #991b1b; }
    .row-success td { background-color: #f0fdf4 !important; }
    .category-item { margin: 16px 0; }
    .category-header { display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 6px; }
    .category-count { color: #64748b; font-weight: 500; }
    .bar-bg { background: #e2e8f0; border-radius: 6px; height: 12px; overflow: hidden; }
    .bar-fill { background: #f97316; height: 100%; border-radius: 6px; }
    .conclusion-box { background: #f0f9ff; border-left: 4px solid #0ea5e9; padding: 20px; margin: 32px 0 0 0; border-radius: 0 8px 8px 0; }
    .conclusion-title { font-size: 16px; color: #0369a1; font-weight: 700; margin-bottom: 8px; display: block; }
    .conclusion-text { font-size: 14px; color: #0f172a; line-height: 1.7; }
    .page-footer { position: absolute; bottom: 0; left: 0; right: 0; height: 20mm; padding: 0 20mm; display: flex; justify-content: space-between; align-items: center; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b; background: #ffffff; }
    .page-footer a { color: #0ea5e9; text-decoration: none; font-weight: 500; }
    .footer-logo { font-weight: 700; color: #1a3a5c; }
    @page { size: A4; margin: 0; }
    @media print { body { background: white; margin: 0; padding: 0; display: block; } .page { margin: 0; box-shadow: none; border: none; page-break-after: always; height: 297mm; } }
  </style>
</head>
<body>

  <div class="page">
    <div class="header">
      <div>
        <h1>Toegankelijkheidsaudit Videospelers</h1>
        <p class="header-subtitle">Samenvatting — Audit door <strong>${AUDIT_DATA.source}</strong>, december 2025</p>
      </div>
    </div>

    <p>
      ${AUDIT_DATA.source} heeft <strong>${totalPlayers} videospelers</strong> getoetst aan de
      <strong>${AUDIT_DATA.standard}</strong> richtlijnen (methode: ${AUDIT_DATA.method}).
      Van de ${totalPlayers} spelers voldoen er <strong style="color:#166534">${passCount} volledig</strong>
      en <strong style="color:#991b1b">${failCount} niet</strong>.
    </p>

    <h2>Resultaten per speler</h2>
    <table>
      <thead>
        <tr>
          <th>Videospeler</th>
          <th class="text-center">Bevindingen</th>
          <th class="text-center">Afgekeurde criteria</th>
          <th class="text-center">Status</th>
        </tr>
      </thead>
      <tbody>${playerRows}</tbody>
    </table>

    ${footer(1)}
  </div>

  <div class="page">
    <div class="header">
      <div>
        <h1>Probleemcategorieën & Conclusie</h1>
        <p class="header-subtitle">Vervolg — Audit door ${AUDIT_DATA.source}, december 2025</p>
      </div>
    </div>

    <h2>Knelpunten in de markt</h2>
    <p style="margin-bottom: 24px;">Aantal spelers met specifieke problemen per categorie (van de ${totalPlayers} geteste spelers):</p>

    ${categoryBars}

    <div class="conclusion-box">
      <span class="conclusion-title">Eindconclusie</span>
      <span class="conclusion-text">
        Uit de audit blijkt dat de meerderheid van de videospelers in de markt niet voldoet aan de basiseisen voor digitale toegankelijkheid. <strong>Blue Billywig</strong> is de enige commerciële videospeler die volledig voldoet aan WCAG 2.2. De Rijksoverheidsplayer en OpenGemeenten voldoen eveneens, maar zijn uitsluitend beschikbaar voor specifieke overheidsorganisaties.
      </span>
    </div>

    ${footer(2)}
  </div>

</body>
</html>`;
}

// ── Main ──
const args = process.argv.slice(2);
const outputIdx = args.indexOf("--output");
const outputPath = outputIdx !== -1 && args[outputIdx + 1]
  ? args[outputIdx + 1]
  : "audit-summary.html";

const html = generateHTML();
writeFileSync(outputPath, html);
console.log(`Audit samenvatting gegenereerd: ${outputPath}`);

// Generate PDF if Playwright available
try {
  const { chromium } = await import("playwright");
  const { pathToFileURL } = await import("url");
  const { resolve } = await import("path");

  const pdfPath = outputPath.replace(".html", ".pdf");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(resolve(outputPath)).href, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1000);
    await page.pdf({
      path: pdfPath,
      format: "A4",
      printBackground: true,
      margin: { top: "0", bottom: "0", left: "0", right: "0" },
    });
    console.log(`PDF gegenereerd: ${pdfPath}`);
  } finally {
    await browser.close();
  }
} catch (err) {
  console.log(`[info] PDF niet gegenereerd (playwright niet beschikbaar): ${err.message}`);
}
