#!/usr/bin/env node
/**
 * BB Videoscan - HTML Report Generator
 * Generates a branded Blue Billywig Video Quick Scan report from scan JSON data.
 *
 * Usage: node report.mjs <scan-json-file> [--social <social-json>]
 */
import { readFileSync, writeFileSync } from "fs";

const BB_BLUE = "#1a3a5c";
const BB_LIGHT_BLUE = "#4a90d9";
const BB_ACCENT = "#e8f0fe";
const BB_ORANGE = "#f07048";
const BB_GREEN = "#2ecc71";
const BB_YELLOW = "#f5a623";

// Pie chart colors
const CHART_COLORS = [
  "#1a3a5c",
  "#4a90d9",
  "#f07048",
  "#f5a623",
  "#2ecc71",
  "#9b59b6",
  "#e74c3c",
  "#1abc9c",
  "#34495e",
  "#e67e22",
];

function generatePieChartSVG(data, size = 200) {
  if (data.length === 0) return "";
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total === 0) return "";

  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 10;
  let startAngle = -Math.PI / 2;
  const paths = [];

  for (let i = 0; i < data.length; i++) {
    const slice = data[i];
    const angle = (slice.value / total) * 2 * Math.PI;
    const endAngle = startAngle + angle;
    const largeArc = angle > Math.PI ? 1 : 0;

    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);

    if (data.length === 1) {
      paths.push(
        `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${CHART_COLORS[i % CHART_COLORS.length]}" />`
      );
    } else {
      paths.push(
        `<path d="M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${largeArc},1 ${x2},${y2} Z" fill="${CHART_COLORS[i % CHART_COLORS.length]}" />`
      );
    }
    startAngle = endAngle;
  }

  const legend = data
    .map(
      (d, i) =>
        `<div style="display:flex;align-items:center;gap:8px;margin:4px 0">
      <div style="width:14px;height:14px;border-radius:3px;background:${CHART_COLORS[i % CHART_COLORS.length]};flex-shrink:0"></div>
      <span style="font-size:14px"><strong>${d.label}</strong> ${((d.value / total) * 100).toFixed(1)}%</span>
    </div>`
    )
    .join("");

  return `
    <div style="display:flex;align-items:center;gap:32px;flex-wrap:wrap">
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${paths.join("")}</svg>
      <div>${legend}</div>
    </div>`;
}

function generateReport(scanData, socialData) {
  const { domain, scanDate, pagesScanned, playerSummary, details } = scanData;
  const orgName = domain.replace(/^www\./, "").replace(/\.\w+$/, "");
  const orgNameCap = orgName.charAt(0).toUpperCase() + orgName.slice(1);
  const dateStr = new Date(scanDate).toLocaleDateString("nl-NL", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const players = Object.entries(playerSummary || {});
  const totalVideos = players.reduce((s, [, v]) => s + v.count, 0);
  const pagesWithVideo = scanData.pagesWithVideo || details?.length || 0;

  // Pie chart data
  const pieData = players
    .sort((a, b) => b[1].count - a[1].count)
    .map(([name, data]) => ({ label: name, value: data.count }));

  // Group pages by site section (first path segment)
  const sectionGroups = {};
  for (const page of details || []) {
    try {
      const path = new URL(page.url).pathname;
      const section = path.split("/").filter(Boolean)[0] || "(homepage)";
      if (!sectionGroups[section]) sectionGroups[section] = { players: new Set(), pages: [], count: 0 };
      sectionGroups[section].count++;
      sectionGroups[section].pages.push(page.url);
      for (const p of page.players) sectionGroups[section].players.add(p.name);
    } catch {}
  }

  // Privacy analysis - which players have privacy concerns
  const privacyRisks = [];
  const playerNames = players.map(([n]) => n);
  if (playerNames.includes("YouTube"))
    privacyRisks.push({
      player: "YouTube",
      risk: "Google verzamelt gebruikersgegevens via tracking cookies en plaatst marketing cookies bij het afspelen van video.",
    });
  if (playerNames.includes("Vimeo"))
    privacyRisks.push({
      player: "Vimeo",
      risk: "Vimeo plaatst third-party cookies en deelt data met advertentienetwerken.",
    });
  if (playerNames.includes("Instagram"))
    privacyRisks.push({
      player: "Instagram",
      risk: "Meta/Instagram verzamelt uitgebreide gebruikersdata en plaatst tracking pixels.",
    });
  if (playerNames.includes("Spotify (podcast)"))
    privacyRisks.push({
      player: "Spotify",
      risk: "Spotify embedded players plaatsen cookies en tracken luistergedrag.",
    });
  if (playerNames.includes("TikTok"))
    privacyRisks.push({
      player: "TikTok",
      risk: "TikTok verzamelt data en slaat deze op buiten de EU (China).",
    });

  const nonEUPlayers = playerNames.filter((p) =>
    ["YouTube", "Vimeo", "Instagram", "TikTok", "DailyMotion", "Wistia", "Vidyard", "Loom"].includes(p)
  );

  // Social media section
  let socialHTML = "";
  if (socialData) {
    const totalVideos = Object.values(socialData).reduce((s, v) => s + (v.videos || 0), 0);
    const totalFollowers = Object.values(socialData).reduce((s, v) => s + (v.followers || 0), 0);
    const platforms = Object.entries(socialData)
      .filter(([, v]) => v.videos > 0 || v.followers > 0)
      .map(
        ([platform, data]) => `
        <div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid #eee">
          <div style="width:40px;height:40px;background:${BB_BLUE};border-radius:8px;display:flex;align-items:center;justify-content:center;color:white;font-weight:bold;font-size:12px">${platform.slice(0, 2).toUpperCase()}</div>
          <div>
            <strong>${platform}</strong><br>
            <span style="color:#666;font-size:14px">${data.videos || 0} video's, ${formatNumber(data.followers || 0)} volgers</span>
          </div>
        </div>`
      )
      .join("");

    socialHTML = `
      <div class="page">
        <h1>Video aanwezigheid op social media</h1>
        <p>Er is ook gekeken naar het gebruik van video op verschillende platformen buiten jullie eigen website om.</p>
        <div style="display:flex;gap:48px;flex-wrap:wrap;margin-top:24px">
          <div style="flex:1;min-width:280px">
            <h3 style="color:${BB_BLUE}">Waar worden video's gepubliceerd</h3>
            ${platforms}
          </div>
          <div style="flex:1;min-width:200px">
            <div style="display:flex;gap:32px;margin-top:24px">
              <div style="text-align:center">
                <div style="font-size:36px;font-weight:800;color:${BB_BLUE}">${formatNumber(totalVideos)}</div>
                <div style="color:#666;font-size:14px">totaal aantal video's</div>
              </div>
              <div style="text-align:center">
                <div style="font-size:36px;font-weight:800;color:${BB_BLUE}">${formatNumber(totalFollowers)}</div>
                <div style="color:#666;font-size:14px">totaal aantal volgers</div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
  }

  return `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Video Quick Scan - ${orgNameCap}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap');

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: 'Inter', -apple-system, sans-serif;
      color: #333;
      background: #f5f5f5;
      line-height: 1.6;
    }

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
      bottom: 0;
      left: 0;
      right: 0;
      height: 4px;
      background: ${BB_LIGHT_BLUE};
    }

    h1 {
      font-size: 32px;
      font-weight: 800;
      color: ${BB_BLUE};
      margin-bottom: 8px;
      position: relative;
      display: inline-block;
    }

    h1::after {
      content: '';
      position: absolute;
      bottom: -2px;
      left: 0;
      width: 100%;
      height: 8px;
      background: ${BB_YELLOW};
      opacity: 0.5;
      z-index: -1;
    }

    h2 {
      font-size: 24px;
      font-weight: 700;
      color: ${BB_BLUE};
      margin: 32px 0 16px;
    }

    h3 { font-size: 18px; font-weight: 700; color: ${BB_BLUE}; margin: 16px 0 8px; }

    p { margin: 12px 0; color: #444; }

    .cover {
      background: linear-gradient(135deg, ${BB_BLUE} 0%, #2a5a8c 100%);
      color: white;
      padding: 64px 56px;
      min-height: 500px;
      display: flex;
      flex-direction: column;
      justify-content: center;
    }

    .cover h1 { color: white; font-size: 42px; }
    .cover h1::after { background: ${BB_YELLOW}; opacity: 0.7; }
    .cover p { color: rgba(255,255,255,0.9); font-size: 18px; }

    .stat-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 16px;
      margin: 24px 0;
    }

    .stat-card {
      background: ${BB_ACCENT};
      border-radius: 12px;
      padding: 20px;
      text-align: center;
    }

    .stat-card .number {
      font-size: 36px;
      font-weight: 800;
      color: ${BB_BLUE};
    }

    .stat-card .label {
      font-size: 14px;
      color: #666;
      margin-top: 4px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      margin: 16px 0;
    }

    th {
      background: ${BB_BLUE};
      color: white;
      padding: 12px 16px;
      text-align: left;
      font-weight: 600;
    }

    td {
      padding: 12px 16px;
      border-bottom: 1px solid #eee;
    }

    tr:hover td { background: ${BB_ACCENT}; }

    .risk-card {
      background: #fff5f5;
      border-left: 4px solid ${BB_ORANGE};
      padding: 16px 20px;
      margin: 12px 0;
      border-radius: 0 8px 8px 0;
    }

    .tip-card {
      background: ${BB_ACCENT};
      border-left: 4px solid ${BB_LIGHT_BLUE};
      padding: 16px 20px;
      margin: 12px 0;
      border-radius: 0 8px 8px 0;
    }

    .checklist {
      list-style: none;
      padding: 0;
    }

    .checklist li {
      padding: 12px 0;
      border-bottom: 1px solid #eee;
      display: flex;
      align-items: flex-start;
      gap: 12px;
    }

    .checklist li::before {
      content: '';
      width: 20px;
      height: 20px;
      border: 2px solid ${BB_LIGHT_BLUE};
      border-radius: 4px;
      flex-shrink: 0;
      margin-top: 2px;
    }

    .bb-logo {
      font-weight: 800;
      color: ${BB_BLUE};
      font-size: 20px;
    }

    .footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 32px;
      padding-top: 16px;
      border-top: 2px solid ${BB_LIGHT_BLUE};
    }

    .page-num {
      position: absolute;
      bottom: 16px;
      right: 24px;
      font-size: 14px;
      color: #999;
    }

    .cta-card {
      background: white;
      border: 2px solid #eee;
      border-radius: 12px;
      padding: 24px;
      text-align: center;
    }

    .cta-btn {
      display: inline-block;
      background: ${BB_ORANGE};
      color: white;
      padding: 10px 24px;
      border-radius: 6px;
      text-decoration: none;
      font-weight: 600;
      margin-top: 12px;
    }

    @media print {
      body { background: white; }
      .page {
        box-shadow: none;
        margin: 0;
        page-break-after: always;
      }
    }
  </style>
</head>
<body>

  <!-- Page 1: Cover -->
  <div class="page cover">
    <h1>Video quick scan voor ${orgNameCap}</h1>
    <div style="margin-top:24px;height:4px;background:${BB_YELLOW};width:200px;border-radius:2px"></div>
    <p style="margin-top:32px;max-width:600px">
      Deze Video quickscan biedt inzicht in het gebruik van video binnen <strong>${orgNameCap}</strong>.
    </p>
    <p style="max-width:600px">
      De aanwezigheid en prestaties, het aantal verschillende videospelers,
      de toegankelijkheid en privacy van zowel de videocontent als de players
      werden geanalyseerd. Afsluitend worden er aanbevelingen gepresenteerd.
    </p>
    <div style="margin-top:auto;padding-top:48px">
      <div class="bb-logo" style="color:white;font-size:24px">Blue Billywig</div>
      <div style="color:rgba(255,255,255,0.7);font-size:14px;margin-top:4px">${dateStr}</div>
    </div>
  </div>

  <!-- Page 2: Overzicht videogebruik -->
  <div class="page">
    <h1>Overzicht in het videogebruik</h1>
    <p style="margin-top:16px">
      We hebben het videolandschap van <strong>${orgNameCap}</strong> in kaart gebracht
      door <strong>${pagesScanned}</strong> pagina's te doorzoeken.
      Er zijn video-/audioplayers gevonden op <strong>${pagesWithVideo}</strong> pagina's,
      met <strong>${players.length}</strong> verschillende player(s).
    </p>

    <div class="stat-grid">
      <div class="stat-card">
        <div class="number">${pagesScanned}</div>
        <div class="label">Pagina's gescand</div>
      </div>
      <div class="stat-card">
        <div class="number">${pagesWithVideo}</div>
        <div class="label">Pagina's met video</div>
      </div>
      <div class="stat-card">
        <div class="number">${players.length}</div>
        <div class="label">Unieke players</div>
      </div>
    </div>

    ${
      players.length > 0
        ? `
    <h2>Gevonden players</h2>
    <table>
      <thead>
        <tr>
          <th>Player</th>
          <th>Aantal pagina's</th>
          <th>Voorbeeldpagina's</th>
        </tr>
      </thead>
      <tbody>
        ${players
          .sort((a, b) => b[1].count - a[1].count)
          .map(
            ([name, data]) => `
          <tr>
            <td><strong>${name}</strong></td>
            <td>${data.count}</td>
            <td style="font-size:13px">${data.pages
              .slice(0, 2)
              .map((u) => `<a href="${u}" target="_blank" style="color:${BB_LIGHT_BLUE};text-decoration:none">${truncateUrl(u, 50)}</a>`)
              .join("<br>")}</td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>

    <h2>Verdeling players</h2>
    ${generatePieChartSVG(pieData, 220)}
    `
        : `<p><em>Geen videoplayers gevonden op de gescande pagina's.</em></p>`
    }

    <div class="footer">
      <div class="bb-logo">Blue Billywig</div>
    </div>
  </div>

  ${socialHTML}

  <!-- Page: Overzicht per sectie -->
  ${
    details && details.length > 0
      ? `
  <div class="page">
    <h1>Overzicht per sectie</h1>
    <p>De gevonden video- en audioplayers gegroepeerd per website-sectie.</p>
    <table>
      <thead>
        <tr>
          <th>Sectie</th>
          <th>Aantal pagina's</th>
          <th>Players</th>
        </tr>
      </thead>
      <tbody>
        ${Object.entries(sectionGroups)
          .sort((a, b) => b[1].count - a[1].count)
          .map(
            ([section, data]) => `
          <tr>
            <td><strong>/${section}</strong></td>
            <td>${data.count}</td>
            <td>${[...data.players].map((p) => `<span style="display:inline-block;background:${BB_ACCENT};padding:2px 8px;border-radius:4px;margin:2px;font-size:13px">${p}</span>`).join(" ")}</td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>

    <h2>Selectie van pagina's</h2>
    <p style="font-size:14px;color:#666">Een selectie van de ${details.length} pagina's waar players zijn gevonden:</p>
    <table>
      <thead>
        <tr>
          <th>Pagina</th>
          <th>Players</th>
        </tr>
      </thead>
      <tbody>
        ${details
          .filter((d, i, arr) => {
            // Show max ~15 representative pages: first of each section + some variety
            const section = new URL(d.url).pathname.split("/").filter(Boolean)[0] || "";
            const isFirstInSection = arr.findIndex(
              (x) => (new URL(x.url).pathname.split("/").filter(Boolean)[0] || "") === section
            ) === i;
            return isFirstInSection || i < 5;
          })
          .slice(0, 15)
          .map(
            (d) => `
          <tr>
            <td style="font-size:13px"><a href="${d.url}" target="_blank" style="color:${BB_LIGHT_BLUE};text-decoration:none">${truncateUrl(d.url, 55)}</a></td>
            <td>${d.players.map((p) => `<span style="display:inline-block;background:${BB_ACCENT};padding:2px 8px;border-radius:4px;margin:2px;font-size:13px">${p.name}</span>`).join(" ")}</td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>
    <div class="footer"><div class="bb-logo">Blue Billywig</div></div>
  </div>`
      : ""
  }

  <!-- Page: Privacy -->
  <div class="page">
    <h1>Privacy</h1>
    <p>
      Bij het gebruik van third-party videoplayers worden er vaak cookies geplaatst
      en gebruikersgegevens gedeeld met externe partijen.
      ${nonEUPlayers.length > 0 ? `<strong>${nonEUPlayers.length}</strong> van de gevonden players slaan data op buiten de EU.` : ""}
    </p>

    ${
      privacyRisks.length > 0
        ? `
    <h2>Privacy risico's</h2>
    ${privacyRisks.map((r) => `<div class="risk-card"><strong>${r.player}</strong><br>${r.risk}</div>`).join("")}
    `
        : ""
    }

    <div class="tip-card">
      <strong>Aanbeveling</strong><br>
      Duidelijke privacyverklaring en mogelijk overstappen op een privacyvriendelijk platform
      dat data binnen de EU opslaat en geen tracking cookies plaatst.
    </div>

    ${
      playerNames.includes("YouTube")
        ? `
    <div style="margin-top:24px;background:#f8f8f8;border-radius:12px;padding:24px;text-align:center">
      <div style="color:#999;font-size:14px;margin-bottom:8px">⚠ Accepteer de cookies om dit te bekijken</div>
      <div style="display:inline-block;background:${BB_ORANGE};color:white;padding:8px 20px;border-radius:6px;font-weight:600;font-size:14px">Accepteren</div>
      <p style="margin-top:16px;font-size:14px;color:#666">
        YouTube embedded video's vereisen cookie-consent. Dit leidt tot minder kijkers
        doordat bezoekers eerst cookies moeten accepteren.
      </p>
    </div>`
        : ""
    }

    <div class="footer"><div class="bb-logo">Blue Billywig</div></div>
  </div>

  <!-- Page: Toegankelijkheid -->
  <div class="page">
    <h1>Voor iedereen toegankelijk?</h1>
    <p>
      Wist je dat als je video's wilt embedden op je eigen website,
      je videospeler aan de <strong>55 succescriteria</strong> van de WCAG 2.1 AA
      moet voldoen om een A-status te behalen?
    </p>

    <h2>Wat is er nodig voor toegankelijkheid?</h2>

    <h3 style="font-style:italic">Techniek</h3>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin:12px 0">
      ${["Tekstalternatief", "Transcriptie", "Gebarentolk", "WCAG 2.1 AA Video player", "Ondertiteling", "Toetsenbordbediening", "Audiodescriptie", "Schermlezerondersteuning", "Bestanden downloaden"]
        .map(
          (t) =>
            `<span style="display:inline-block;border:2px solid #ddd;border-radius:8px;padding:6px 14px;font-size:14px">${t}</span>`
        )
        .join("")}
    </div>

    <h3 style="font-style:italic">Content</h3>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin:12px 0">
      ${["Contrast", "Kleurgebruik", "Minder dan 3 flitsen per seconde"]
        .map(
          (t) =>
            `<span style="display:inline-block;border:2px solid #ddd;border-radius:8px;padding:6px 14px;font-size:14px">${t}</span>`
        )
        .join("")}
    </div>

    <div class="tip-card" style="margin-top:24px">
      <strong>Tip</strong><br>
      Gebruik een transcript indien er geen ruimte is voor audiodescriptie (AD) en
      maak je video's volledig toegankelijk door een gebarentolk toe te voegen.
    </div>

    <div class="footer"><div class="bb-logo">Blue Billywig</div></div>
  </div>

  <!-- Page: Checklist -->
  <div class="page">
    <h1>Checklist Online Video</h1>
    <p>
      Vergroot je bereik en engagement, voldoe aan de wetgeving en digitale richtlijnen,
      bespaar kosten, of gewoon omdat je net als wij vindt dat iedereen in onze maatschappij
      mee zou mogen doen.
    </p>

    <h3 style="font-style:italic;margin-top:24px">Digitaal toegankelijk</h3>
    <ul class="checklist">
      <li><div><strong>Toegankelijke content</strong> | Controleer contrast, kleurgebruik & max 3 flitsen p/sec.</div></li>
      <li><div><strong>Zelfredzaamheid</strong> | Voeg audiodescriptie, transcript & ondertitels (ODS).</div></li>
      <li><div><strong>Videoplayer</strong> | Kies WCAG 2.2 AA en ga voor A-status.</div></li>
    </ul>

    <h3 style="font-style:italic;margin-top:24px">Privacy compliant</h3>
    <ul class="checklist">
      <li><div><strong>Cookies consent</strong> | Kies een player met beheersbare cookies.</div></li>
      <li><div><strong>Eigendom content</strong> | Doe geen afstand van je eigendomsrechten.</div></li>
      <li><div><strong>Opslag gegevens</strong> | Gebruik EU servers voor opslag van je content.</div></li>
    </ul>

    <h3 style="font-style:italic;margin-top:24px">Video workflow</h3>
    <ul class="checklist">
      <li><div><strong>Veilig</strong> | Start vanuit een centraal en veilig distributiepunt voor al je video's.</div></li>
      <li><div><strong>Effectief</strong> | Laat je kijkers overgaan tot actie op je eigen kanalen.</div></li>
      <li><div><strong>Makkelijk</strong> | Creeer een simpele workflow voor je externe & interne content.</div></li>
    </ul>

    <div class="footer"><div class="bb-logo">Blue Billywig</div></div>
  </div>

  <!-- Page: Contact -->
  <div class="page" style="text-align:center;padding-top:80px">
    <h1>Samen tillen we je videoprestaties naar een hoger niveau</h1>

    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px;margin-top:48px">
      <div class="cta-card">
        <h3>Vraag een demo aan</h3>
        <p style="font-size:14px">Vraag vrijblijvend een demo aan voor jou en je collega's.</p>
        <a class="cta-btn" href="https://www.bluebillywig.com/nl/demo/" target="_blank">Klik hier</a>
      </div>
      <div class="cta-card">
        <h3>Bekijk onze blogs</h3>
        <p style="font-size:14px">Bekijk ons blogs en webinars over video management en toegankelijkheid.</p>
        <a class="cta-btn" href="https://www.bluebillywig.com/nl/blog/" target="_blank">Klik hier</a>
      </div>
      <div class="cta-card">
        <h3>Plan een kop koffie</h3>
        <p style="font-size:14px">Maak een afspraak voor een heerlijke koffie!</p>
        <a class="cta-btn" href="https://www.bluebillywig.com/nl/contact/" target="_blank">Klik hier</a>
      </div>
    </div>

    <div style="margin-top:64px">
      <div class="bb-logo" style="font-size:28px">Blue Billywig</div>
    </div>
  </div>

</body>
</html>`;
}

function truncateUrl(url, len) {
  const short = url.replace(/^https?:\/\/(www\.)?/, "");
  return short.length > len ? short.slice(0, len - 3) + "..." : short;
}

function formatNumber(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(0) + "K";
  return n.toString();
}

// ── Main ──
const args = process.argv.slice(2);
if (args.length === 0) {
  console.log("Gebruik: node report.mjs <scan-json-file> [--social <social-json>]");
  process.exit(0);
}

const scanFile = args[0];
const scanData = JSON.parse(readFileSync(scanFile, "utf-8"));

let socialData = null;
const socialIdx = args.indexOf("--social");
if (socialIdx !== -1 && args[socialIdx + 1]) {
  socialData = JSON.parse(readFileSync(args[socialIdx + 1], "utf-8"));
}

const html = generateReport(scanData, socialData);
const outFile = scanFile.replace(".json", ".html");
writeFileSync(outFile, html);
console.log(`Rapport gegenereerd: ${outFile}`);
