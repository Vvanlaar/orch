#!/usr/bin/env node
/**
 * Standalone audit one-pager: Proper Access WCAG 2.2 videospeler audit summary.
 * Generates HTML + PDF (via Playwright). BB branded.
 *
 * Usage: node audit-summary.mjs [--output <path>]
 */
import { writeFileSync } from "fs";
import { AUDIT_DATA } from "./audit-data.mjs";

const BB_BLUE = "#1a3a5c";
const BB_LIGHT_BLUE = "#4a90d9";
const BB_ACCENT = "#e8f0fe";
const BB_ORANGE = "#f07048";
const BB_GREEN = "#2ecc71";
const BB_RED = "#e74c3c";
const BB_YELLOW = "#f5a623";

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
    const rowBg = isPass ? "#f0faf4" : "white";
    const badge = isPass
      ? `<span style="background:${BB_GREEN};color:white;padding:3px 10px;border-radius:12px;font-size:13px;font-weight:600">Voldoet</span>`
      : `<span style="background:${BB_RED};color:white;padding:3px 10px;border-radius:12px;font-size:13px;font-weight:600">Voldoet niet</span>`;
    return `<tr style="background:${rowBg}">
      <td style="padding:12px 16px;border-bottom:1px solid #eee;font-weight:${isPass ? "700" : "400"}">${name}</td>
      <td style="padding:12px 16px;border-bottom:1px solid #eee;text-align:center">${data.findings}</td>
      <td style="padding:12px 16px;border-bottom:1px solid #eee;text-align:center">${data.failedSC}</td>
      <td style="padding:12px 16px;border-bottom:1px solid #eee;text-align:center">${badge}</td>
    </tr>`;
  }).join("");

  const categoryBars = categories.map(([name, cat]) => {
    const pct = (cat.playersAffected / maxAffected) * 100;
    return `<div style="margin:8px 0">
      <div style="display:flex;justify-content:space-between;font-size:14px;margin-bottom:4px">
        <span><strong>${name}</strong> — ${cat.description}</span>
        <span style="color:#666">${cat.playersAffected} van ${totalPlayers} spelers</span>
      </div>
      <div style="background:#eee;border-radius:4px;height:24px;overflow:hidden">
        <div style="background:${BB_ORANGE};height:100%;width:${pct}%;border-radius:4px;transition:width 0.3s"></div>
      </div>
    </div>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Toegankelijkheidsaudit Videospelers — Samenvatting</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap');
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Inter', -apple-system, sans-serif; color: #333; background: #f5f5f5; line-height: 1.6; }
    .page {
      background: white;
      max-width: 900px;
      margin: 0 auto 24px;
      padding: 48px 56px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
      page-break-after: always;
      position: relative;
    }
    .page::after {
      content: '';
      position: absolute;
      bottom: 0; left: 0; right: 0;
      height: 4px;
      background: ${BB_LIGHT_BLUE};
    }
    h1 { font-size: 28px; font-weight: 800; color: ${BB_BLUE}; margin-bottom: 4px; }
    h2 { font-size: 20px; font-weight: 700; color: ${BB_BLUE}; margin: 28px 0 12px; }
    p { margin: 8px 0; color: #444; }
    table { width: 100%; border-collapse: collapse; margin: 12px 0; }
    th { background: ${BB_BLUE}; color: white; padding: 10px 16px; text-align: left; font-weight: 600; font-size: 14px; }
    .footer { display: flex; justify-content: space-between; align-items: center; margin-top: 24px; padding-top: 12px; border-top: 2px solid ${BB_LIGHT_BLUE}; }
    .bb-logo { font-weight: 800; color: ${BB_BLUE}; font-size: 18px; }
    @media print { body { background: white; } .page { box-shadow: none; margin: 0; } }
  </style>
</head>
<body>

  <!-- Page 1: Header + Table + Categories -->
  <div class="page">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px">
      <div>
        <h1>Toegankelijkheidsaudit Videospelers</h1>
        <p style="color:#666;font-size:15px;margin-top:2px">
          Samenvatting — Audit door <strong>${AUDIT_DATA.source}</strong>, december 2025
        </p>
      </div>
      <div class="bb-logo" style="font-size:22px;white-space:nowrap">Blue Billywig</div>
    </div>

    <p style="font-size:15px">
      ${AUDIT_DATA.source} heeft <strong>${totalPlayers} videospelers</strong> getoetst aan de
      <strong>${AUDIT_DATA.standard}</strong> richtlijnen (methode: ${AUDIT_DATA.method}).
      Van de ${totalPlayers} spelers voldoen er <strong style="color:${BB_GREEN}">${passCount}</strong> volledig
      en <strong style="color:${BB_RED}">${failCount}</strong> niet.
    </p>

    <h2>Resultaten per speler</h2>
    <table>
      <thead>
        <tr>
          <th>Videospeler</th>
          <th style="text-align:center">Bevindingen</th>
          <th style="text-align:center">Afgekeurde criteria</th>
          <th style="text-align:center">Status</th>
        </tr>
      </thead>
      <tbody>${playerRows}</tbody>
    </table>

    <h2>Probleemcategorieën</h2>
    <p style="font-size:14px;color:#666">Aantal spelers met problemen per categorie (van de ${totalPlayers} geteste spelers):</p>
    ${categoryBars}

    <div style="background:${BB_ACCENT};border-left:4px solid ${BB_LIGHT_BLUE};padding:16px 20px;margin:24px 0;border-radius:0 8px 8px 0">
      <strong style="color:${BB_BLUE}">Conclusie</strong><br>
      <span style="font-size:15px">
        Blue Billywig is de enige commerciële videospeler die volledig voldoet aan WCAG 2.2.
        De Rijksoverheidsplayer en OpenGemeenten voldoen ook, maar zijn alleen beschikbaar voor overheidsorganisaties.
      </span>
    </div>

    <div class="footer">
      <div style="font-size:13px;color:#666">
        Bron: <a href="${AUDIT_DATA.url}" style="color:${BB_LIGHT_BLUE}">${AUDIT_DATA.source} audit rapport</a>
        (${AUDIT_DATA.method}, ${AUDIT_DATA.date})
      </div>
      <div style="text-align:right">
        <div style="font-weight:700;color:${BB_BLUE}">Plan een demo</div>
        <div style="font-size:13px;color:#666">
          <a href="https://www.bluebillywig.com/nl/demo/" style="color:${BB_LIGHT_BLUE};text-decoration:none">bluebillywig.com/nl/demo</a>
          &nbsp;|&nbsp;
          <a href="https://www.bluebillywig.com/nl/contact/" style="color:${BB_LIGHT_BLUE};text-decoration:none">Contact</a>
        </div>
      </div>
    </div>
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
