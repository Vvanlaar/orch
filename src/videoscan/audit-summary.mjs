#!/usr/bin/env node
/**
 * Standalone audit one-pager: Proper Access WCAG 2.2 videospeler audit summary.
 * Generates HTML + PDF (via Playwright). Reuses BB report design system.
 *
 * Usage: node audit-summary.mjs [--output <path>]
 */
import { readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { AUDIT_DATA } from "./audit-data.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(__dirname, "templates");

const BB_LOGO_URL = "https://d3bn524hv76vco.cloudfront.net/upload/newskin.acc/780b5079ecb7d44a8d5a2d090d06882962d5ab17.svg";

function loadTemplate(name) {
  return readFileSync(join(TEMPLATE_DIR, name), "utf-8");
}

function fillTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    vars[key] !== undefined ? String(vars[key]) : match
  );
}

/** CSS overrides specific to this one-pager (on top of shared styles.css) */
const SUMMARY_CSS = `
    /* One-pager overrides */
    .page { min-height: 297mm; height: auto; }

    /* Stats row (simpler than overview's stats-overview) */
    .stats-row { display: flex; gap: 20px; margin: 24px 0; }
    .stat-box .number.green { color: var(--accent-green); }
    .stat-box .number.red { color: var(--accent-red); }

    /* Badge pills */
    .badge { padding: 4px 12px; border-radius: 14px; font-size: 12px; font-weight: 700; color: var(--white); }
    .badge-pass { background: var(--accent-green); }
    .badge-fail { background: var(--accent-red); }
    .row-pass { background: rgba(70, 175, 145, 0.06); }

    /* Category horizontal bars */
    .cat-row { margin: 10px 0; }
    .cat-header { display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 4px; }
    .cat-count { color: #666; white-space: nowrap; }
    .cat-bar-bg { background: var(--bg-box); border: 1px solid var(--border-box); border-radius: 4px; height: 22px; overflow: hidden; }
    .cat-bar-fill { background: var(--primary); height: 100%; border-radius: 4px; }

    /* Conclusion callout */
    .conclusion-box { border: 2px solid #D2E0EF; border-radius: 6px; padding: 20px; display: flex; gap: 16px; align-items: flex-start; background: var(--white); box-shadow: 4px 4px 0px 0px #D2E0EF; margin: 24px 0; }
    .conclusion-box .icon { font-size: 28px; flex-shrink: 0; }
    .conclusion-box .title { font-family: 'Gustavo', sans-serif; font-size: 15px; font-weight: 700; color: var(--text-dark); margin-bottom: 4px; }
    .conclusion-box p { margin: 0; font-size: 13px; }

    /* Source attribution */
    .source-line { font-size: 12px; color: #666; margin-top: 8px; }
    .source-line a { color: var(--primary); text-decoration: none; }

    /* Footer links variant (one-pager uses links instead of page number) */
    .footer-links { display: flex; gap: 16px; align-items: center; }
    .footer-links a { color: var(--white); text-decoration: none; font-size: 13px; font-weight: 500; }
    .footer-links span { color: rgba(255,255,255,0.5); }

    /* One-pager table: reset italic from shared styles */
    td { font-style: normal; }
`;

function generateHTML() {
  const players = Object.entries(AUDIT_DATA.players)
    .sort((a, b) => a[1].findings - b[1].findings);

  const categories = Object.entries(AUDIT_DATA.categories)
    .sort((a, b) => b[1].playersAffected - a[1].playersAffected);

  const totalPlayers = players.length;
  const passCount = players.filter(([, d]) => d.status === "pass").length;
  const failCount = totalPlayers - passCount;
  const maxFailedSC = Math.max(...players.map(([, d]) => d.failedSC));

  // Bar chart -- WCAG failures per player (skip passing players)
  const failPlayers = players.filter(([, d]) => d.status === "fail");
  const barChart = failPlayers.map(([name, data]) => {
    const pct = maxFailedSC > 0 ? (data.failedSC / maxFailedSC) * 100 : 0;
    return `<div class="bar-col">
        <div class="bar-number">${data.failedSC}</div>
        <div class="bar"><div class="bar-fill" style="height:${pct}%"></div></div>
        <div class="bar-label">${name}</div>
      </div>`;
  }).join("");

  // Player results table
  const playerRows = players.map(([name, data]) => {
    const isPass = data.status === "pass";
    const badge = isPass
      ? `<span class="badge badge-pass">Voldoet</span>`
      : `<span class="badge badge-fail">Voldoet niet</span>`;
    return `<tr${isPass ? ' class="row-pass"' : ""}>
        <td${isPass ? ' style="font-weight:700"' : ""}>${name}</td>
        <td style="text-align:center">${data.findings}</td>
        <td style="text-align:center">${data.failedSC}</td>
        <td style="text-align:center">${badge}</td>
      </tr>`;
  }).join("");

  // Category horizontal bars
  const maxAffected = Math.max(...categories.map(([, c]) => c.playersAffected));
  const categoryBars = categories.map(([name, cat]) => {
    const pct = (cat.playersAffected / maxAffected) * 100;
    return `<div class="cat-row">
        <div class="cat-header">
          <span><strong>${name}</strong> — ${cat.description}</span>
          <span class="cat-count">${cat.playersAffected} van ${totalPlayers} spelers</span>
        </div>
        <div class="cat-bar-bg"><div class="cat-bar-fill" style="width:${pct}%"></div></div>
      </div>`;
  }).join("");

  // Build page content
  const pageContent = `
  <div class="page">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
      <h1><span class="highlight-line">Toegankelijkheidsaudit Videospelers</span></h1>
      <img src="${BB_LOGO_URL}" alt="Blue Billywig" style="width:150px;margin-top:8px">
    </div>

    <p class="text-intro">
      ${AUDIT_DATA.source} heeft <strong>${totalPlayers} videospelers</strong> getoetst aan de
      <strong>${AUDIT_DATA.standard}</strong> richtlijnen (methode: ${AUDIT_DATA.method}).
    </p>

    <div class="stats-row">
      <div class="stat-box">
        <div class="number">${totalPlayers}</div>
        <div class="label">Geteste spelers</div>
      </div>
      <div class="stat-box">
        <div class="number green">${passCount}</div>
        <div class="label">Voldoen</div>
      </div>
      <div class="stat-box">
        <div class="number red">${failCount}</div>
        <div class="label">Voldoen niet</div>
      </div>
    </div>

    <h2><span class="highlight-line">Afgekeurde WCAG-criteria per speler</span></h2>
    <div class="bar-chart">${barChart}</div>
    <p class="chart-label">&#9632; Aantal afgekeurde WCAG-criteria per speler</p>

    <h2><span class="highlight-line">Resultaten per speler</span></h2>
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

    <h2><span class="highlight-line">Probleemcategorie&euml;n</span></h2>
    <p style="font-size:12px;color:#666">Aantal spelers met problemen per categorie (van de ${totalPlayers} geteste spelers):</p>
    ${categoryBars}

    <div class="conclusion-box">
      <div class="icon">&#x2714;&#xFE0F;</div>
      <div>
        <div class="title">Conclusie</div>
        <p>Blue Billywig is de enige commerci&euml;le videospeler die volledig voldoet aan WCAG 2.2.
        De Rijksoverheidsplayer en OpenGemeenten voldoen ook, maar zijn alleen beschikbaar voor overheidsorganisaties.</p>
      </div>
    </div>

    <div class="source-line">
      Bron: <a href="${AUDIT_DATA.url}">${AUDIT_DATA.source} audit rapport</a>
      (${AUDIT_DATA.method}, ${AUDIT_DATA.date})
    </div>

    <div class="footer">
      <div class="footer-container">
        <div class="svg-logo-white">
          <img src="${BB_LOGO_URL}" alt="Blue Billywig">
        </div>
        <div class="footer-links">
          <a href="https://www.bluebillywig.com/nl/demo/">Plan een demo</a>
          <span>|</span>
          <a href="https://www.bluebillywig.com/nl/contact/">Contact</a>
        </div>
      </div>
    </div>
  </div>`;

  const styles = loadTemplate("styles.css") + SUMMARY_CSS;
  return fillTemplate(loadTemplate("document.html"), {
    title: "Toegankelijkheidsaudit Videospelers — Samenvatting",
    styles,
    pages: pageContent,
  });
}

// -- CLI --
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
