#!/usr/bin/env node
/**
 * BB Videoscan - HTML Report Generator (template-based)
 * Generates a branded Blue Billywig Video Quick Scan report from scan JSON data.
 *
 * Usage: node report.mjs <scan.json> [--preview] [--social <file>]
 *   [--cover-image <url>] [--contact-image <url>]
 *   [--contact-name <name>] [--contact-phone <phone>] [--contact-email <email>]
 */
import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { AUDIT_DATA, SCANNER_TO_AUDIT } from "./audit-data.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(__dirname, "templates");

// New palette matching designer
const CHART_COLORS = [
  "#3578BB", "#ED6A5B", "#46AF91", "#FAB44B",
  "#9b59b6", "#e67e22", "#1abc9c", "#34495e", "#e74c3c", "#2ecc71",
];

// Colors for social page inline HTML (out of scope for redesign)
const SOCIAL_BLUE = "#3578BB";
const SOCIAL_LIGHT = "#9ABBDD";

// ── Template utilities ──

function loadTemplate(name) {
  return readFileSync(join(TEMPLATE_DIR, name), "utf-8");
}

function fillTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    vars[key] !== undefined ? String(vars[key]) : match
  );
}

function buildFooter(pageNumber) {
  return fillTemplate(loadTemplate("footer.html"), {
    pageNumber: String(pageNumber).padStart(2, "0"),
  });
}

// ── Chart helpers ──

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
      paths.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${CHART_COLORS[i % CHART_COLORS.length]}" />`);
    } else {
      paths.push(`<path d="M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${largeArc},1 ${x2},${y2} Z" fill="${CHART_COLORS[i % CHART_COLORS.length]}" />`);
    }
    startAngle = endAngle;
  }

  const legend = data.map((d, i) =>
    `<div class="legend-item"><div class="legend-box" style="background:${CHART_COLORS[i % CHART_COLORS.length]}"></div> ${d.label} <span class="font-normal">(${((d.value / total) * 100).toFixed(1)}%)</span></div>`
  ).join("");

  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${paths.join("")}</svg>
    <div>${legend}</div>`;
}

function generateBarChartHTML(auditMatches) {
  if (!auditMatches.length) return "";
  const maxFindings = Math.max(...auditMatches.map(m => m.findings));
  const bars = auditMatches
    .sort((a, b) => b.findings - a.findings)
    .map(m => {
      const heightPct = maxFindings > 0 ? (m.findings / maxFindings) * 100 : 0;
      return `      <div class="bar-col">
        <div class="bar-number">${m.findings}</div>
        <div class="bar"><div class="bar-fill" style="height: ${heightPct}%;"></div></div>
        <div class="bar-label">${m.auditName}</div>
      </div>`;
    }).join("\n");
  return `    <div class="bar-chart">\n${bars}\n    </div>
    <p class="text-danger chart-label">&#9632; Aantal afgekeurde WCAG-criteria per speler</p>`;
}

// ── Audit section ──

function generateAuditSection(playerSummary) {
  const playerNames = Object.keys(playerSummary || {});
  const auditMatches = [];
  for (const name of playerNames) {
    const auditName = SCANNER_TO_AUDIT[name];
    if (auditName && AUDIT_DATA.players[auditName]) {
      auditMatches.push({ scanName: name, auditName, ...AUDIT_DATA.players[auditName] });
    }
  }
  if (auditMatches.length === 0) return { html: "", matches: [] };

  const failCount = auditMatches.filter(m => m.status === "fail").length;

  const rows = auditMatches
    .sort((a, b) => a.findings - b.findings)
    .map(m => {
      const isPass = m.status === "pass";
      const rowBg = isPass ? "#f0faf4" : "white";
      const badge = isPass
        ? `<span style="background:#46AF91;color:white;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:600">Voldoet</span>`
        : `<span style="background:#ED6A5B;color:white;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:600">Voldoet niet</span>`;
      return `<tr style="background:${rowBg}">
        <td style="padding:10px 16px;border-bottom:1px solid #eee">${m.auditName}</td>
        <td style="padding:10px 16px;border-bottom:1px solid #eee;text-align:center">${m.findings}</td>
        <td style="padding:10px 16px;border-bottom:1px solid #eee;text-align:center">${m.failedSC}</td>
        <td style="padding:10px 16px;border-bottom:1px solid #eee;text-align:center">${badge}</td>
      </tr>`;
    }).join("");

  const summaryText = failCount > 0
    ? `Van de ${auditMatches.length} gevonden player${auditMatches.length > 1 ? "s" : ""} voldoe${failCount === 1 ? "t" : "n"} <strong>${failCount}</strong> niet aan WCAG 2.2.`
    : `Alle ${auditMatches.length} gevonden players voldoen aan WCAG 2.2.`;

  const html = `
    <h2>Audit resultaten gevonden players</h2>
    <p style="font-size:14px;color:#525659">
      ${summaryText}
      <br>Bron: <a href="${AUDIT_DATA.url}" style="color:#3578BB">${AUDIT_DATA.source} audit</a> (${AUDIT_DATA.method}, ${AUDIT_DATA.date})
    </p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px">
      <thead>
        <tr>
          <th style="background:var(--primary);color:white;padding:12px 16px;text-align:left;font-weight:600">Videospeler</th>
          <th style="background:var(--primary);color:white;padding:12px 16px;text-align:center;font-weight:600">Bevindingen</th>
          <th style="background:var(--primary);color:white;padding:12px 16px;text-align:center;font-weight:600">Afgekeurde criteria</th>
          <th style="background:var(--primary);color:white;padding:12px 16px;text-align:center;font-weight:600">Status</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;

  return { html, matches: auditMatches };
}

/**
 * Explains the WCAG gaps of a bare HTML5 `<video>` element ("HTML5 native").
 * It is deliberately NOT part of the Proper Access audit table — a kale <video>
 * is a generic element, not an audited branded player, so we do NOT attach the
 * audit-source link to it. Returns "" when no HTML5 native player was detected.
 */
function generateHtml5NativeSection(playerNames) {
  if (!playerNames.includes("HTML5 native")) return "";

  const criteria = [
    ["1.2.1", "Louter-geluid en louter-beeld (vooraf opgenomen)", "A"],
    ["1.2.2", "Ondertitels voor doven en slechthorenden (vooraf opgenomen)", "A"],
    ["1.2.3", "Audiodescriptie of media-alternatief (vooraf opgenomen)", "A"],
    ["1.2.5", "Audiodescriptie (vooraf opgenomen)", "AA"],
    ["1.4.2", "Geluidsbediening (bij autoplay met geluid)", "A"],
  ];

  const items = criteria
    .map(([sc, name, level]) =>
      `<li style="margin-bottom:6px"><strong>${sc}</strong> ${name} <span style="color:#888">(niveau ${level})</span></li>`
    ).join("\n        ");

  return `
    <h2>Kale HTML5 video (&lt;video&gt;)</h2>
    <p style="font-size:14px;color:#525659">
      Een deel van de gevonden video's gebruikt een <strong>kaal &lt;video&gt;-element</strong>
      met de standaard browserknoppen. Zo'n speler biedt uit zichzelf <strong>geen ondertiteling,
      audiodescriptie of transcript</strong> en kan daardoor niet voldoen aan de WCAG 2.2-criteria
      voor tijdgebonden media:
    </p>
    <ul style="font-size:14px;color:#525659;margin:12px 0 12px 20px">
        ${items}
    </ul>
    <p style="font-size:13px;color:#888">
      Dit zijn structurele beperkingen van het element zelf; per video kan het beeld anders zijn
      als er ondertitels (&lt;track&gt;) en een transcript zijn toegevoegd.
    </p>`;
}

// ── Utility ──

function truncateUrl(url, len) {
  const short = url.replace(/^https?:\/\/(www\.)?/, "");
  return short.length > len ? short.slice(0, len - 3) + "..." : short;
}

function formatNumber(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(0) + "K";
  return n.toString();
}

// ── Full report ──

function generateReport(scanData, socialData, options = {}) {
  const { domain, scanDate, pagesScanned, playerSummary, details } = scanData;
  const derivedName = domain.replace(/^www\./, "").replace(/\.\w+$/, "");
  const orgNameCap = options.orgName || (derivedName.charAt(0).toUpperCase() + derivedName.slice(1));
  const dateStr = new Date(scanDate).toLocaleDateString("nl-NL", { year: "numeric", month: "long", day: "numeric" });

  const players = Object.entries(playerSummary || {});
  const totalVideos = players.reduce((s, [, v]) => s + v.count, 0);
  const pagesWithVideo = scanData.pagesWithVideo || details?.length || 0;
  const playerNames = players.map(([n]) => n);

  const pages = [];
  let pageNum = 1; // cover has no page number

  // ── Cover page ──
  const introText = `Deze Video quickscan biedt inzicht in de aanwezigheid en prestaties, het aantal videospelers, toegankelijkheid en privacy van de videocontent binnen de <strong class="text-primary">${orgNameCap}-domeinen</strong>. Afsluitend worden er een aantal aanbevelingen gepresenteerd.`;
  const coverImageUrl = options.coverImageUrl || "";

  pages.push(fillTemplate(loadTemplate("cover.html"), {
    orgName: orgNameCap,
    coverImageUrl,
    introText,
    dateStr,
  }));

  // ── Overview page ──
  pageNum++;

  // Stat boxes
  const statsBoxes = [
    { number: pagesScanned, label: "Pagina's gescand" },
    { number: pagesWithVideo, label: "Pagina's met video" },
    { number: players.length, label: "Unieke players" },
  ].map(s => `        <div class="stat-box"><div class="number">${s.number}</div><div class="label">${s.label}</div></div>`).join("\n");

  // Section groups
  const domainSet = new Set();
  for (const page of details || []) {
    try { domainSet.add(new URL(page.url).hostname); } catch {}
  }
  const isMultiDomain = domainSet.size > 1;

  const sectionGroups = {};
  for (const page of details || []) {
    try {
      const u = new URL(page.url);
      const pathSection = u.pathname.split("/").filter(Boolean)[0] || "(homepage)";
      const section = isMultiDomain ? `${u.hostname}/${pathSection}` : pathSection;
      if (!sectionGroups[section]) sectionGroups[section] = {
        players: new Set(), pages: [], count: 0,
        baseUrl: encodeURI(`${u.origin}${pathSection === "(homepage)" ? "/" : "/" + pathSection}`)
      };
      sectionGroups[section].count++;
      sectionGroups[section].pages.push(page.url);
      for (const p of page.players) sectionGroups[section].players.add(p.name);
    } catch {}
  }

  const sectionTableRows = Object.entries(sectionGroups)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([section, data]) =>
      `        <tr><td><a href="${data.baseUrl}" target="_blank" style="color:#3578BB;text-decoration:none">${section.includes("/") && isMultiDomain ? section : "/" + section}</a></td><td>${data.count}</td><td>${[...data.players].join(", ")}</td></tr>`
    ).join("\n");

  // Pie chart
  const pieData = players
    .sort((a, b) => b[1].count - a[1].count)
    .map(([name, data]) => ({ label: name, value: data.count }));
  const pieChart = generatePieChartSVG(pieData, 160);

  // Detail table (representative pages, up to 15)
  let detailTable = "";
  // Sections to omit from the example table only (still counted in stats/overview).
  const excludedSections = new Set(options.excludeExampleSections || []);
  const sectionOf = (u) => {
    try { return new URL(u).pathname.split("/").filter(Boolean)[0] || ""; } catch { return ""; }
  };
  const exampleDetails = excludedSections.size
    ? (details || []).filter(d => !excludedSections.has(sectionOf(d.url)))
    : (details || []);
  // In all-video-pages mode the selection is replaced by a dedicated full-list
  // page (built after the overview), so skip the 15-row example table here.
  if (!options.allVideoPages && exampleDetails.length > 0) {
    // Pass 1: seed with 1 page per unique player so every player gets a row
    const seen = new Set();
    const seedByPlayer = [];
    for (const d of exampleDetails) {
      for (const p of d.players) {
        if (!seen.has(p.name)) {
          seen.add(p.name);
          seedByPlayer.push(d);
          break;
        }
      }
    }
    // Pass 2: fill with section-representative + first-5 logic, excluding seeds
    const seedSet = new Set(seedByPlayer.map(d => d.url));
    const filler = exampleDetails
      .filter(d => !seedSet.has(d.url))
      .filter((d, i, arr) => {
        const section = new URL(d.url).pathname.split("/").filter(Boolean)[0] || "";
        const isFirstInSection = arr.findIndex(
          x => (new URL(x.url).pathname.split("/").filter(Boolean)[0] || "") === section
        ) === i;
        return isFirstInSection || i < 5;
      });
    const selectedDetails = [...seedByPlayer, ...filler].slice(0, 15);

    const detailRows = selectedDetails.map(d =>
      `        <tr><td style="font-size:13px"><a href="${d.url}" target="_blank" style="color:#3578BB;text-decoration:none">${truncateUrl(d.url, 55)}</a></td><td>${d.players.map(p => p.name).join(", ")}</td></tr>`
    ).join("\n");

    detailTable = `
    <h2>Selectie van pagina's</h2>
    <p style="font-size:14px;color:#525659">Een selectie van de ${details.length} pagina's waar players zijn gevonden:</p>
    <table>
      <thead><tr><th>Pagina</th><th>Players</th></tr></thead>
      <tbody>\n${detailRows}\n      </tbody>
    </table>`;
  }

  pages.push(fillTemplate(loadTemplate("overview.html"), {
    orgName: orgNameCap,
    pagesWithVideo: String(pagesWithVideo),
    statsBoxes,
    sectionTableRows,
    pieChart,
    detailTable,
    footer: buildFooter(pageNum),
  }));

  // ── Full "Pagina's met video" list page (opt-in via allVideoPages) ──
  // Lists every page where video was found (no 15-row cap, no section filtering),
  // so the report can serve as a complete URL inventory. Long lists flow across
  // multiple PDF pages (see .page print rules); rows never split (page-break-inside).
  if (options.allVideoPages && (details || []).length > 0) {
    pageNum++;
    const allRows = (details || [])
      .map((d, i) =>
        `        <tr><td style="font-size:13px;color:#525659">${i + 1}</td><td style="font-size:13px;word-break:break-all"><a href="${d.url}" target="_blank" style="color:#3578BB;text-decoration:none">${d.url}</a></td><td style="font-size:13px">${d.players.map(p => p.name).join(", ")}</td></tr>`
      )
      .join("\n");
    pages.push(`
  <div class="page">
    <h1><span class="highlight-line">Pagina's met video</span></h1>
    <p>Hieronder alle <strong class="text-primary">${details.length} pagina's</strong> waar video is aangetroffen op de onderzochte ${orgNameCap}-domeinen.</p>
    <table>
      <thead><tr><th style="width:32px">#</th><th>Pagina</th><th>Players</th></tr></thead>
      <tbody>
${allRows}
      </tbody>
    </table>
${buildFooter(pageNum)}
  </div>`);
  }

  // ── Social page (inline, out of scope for redesign) ──
  if (socialData) {
    pageNum++;
    const totalSocialVideos = Object.values(socialData).reduce((s, v) => s + (v.videos || 0), 0);
    const totalFollowers = Object.values(socialData).reduce((s, v) => s + (v.followers || 0), 0);
    const platforms = Object.entries(socialData)
      .filter(([, v]) => v.videos > 0 || v.followers > 0)
      .map(([platform, data]) => `
        <div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid #eee">
          <div style="width:40px;height:40px;background:${SOCIAL_BLUE};border-radius:8px;display:flex;align-items:center;justify-content:center;color:white;font-weight:bold;font-size:12px">${platform.slice(0, 2).toUpperCase()}</div>
          <div>
            <strong>${platform}</strong><br>
            <span style="color:#666;font-size:14px">${data.videos || 0} video's, ${formatNumber(data.followers || 0)} volgers</span>
          </div>
        </div>`).join("");

    pages.push(`  <div class="page">
    <h1><span class="highlight-line">Video aanwezigheid op social media</span></h1>
    <p>Er is ook gekeken naar het gebruik van video op verschillende platformen buiten jullie eigen website om.</p>
    <div style="display:flex;gap:48px;flex-wrap:wrap;margin-top:24px">
      <div style="flex:1;min-width:280px">
        <h3>Waar worden video's gepubliceerd</h3>
        ${platforms}
      </div>
      <div style="flex:1;min-width:200px">
        <div style="display:flex;gap:32px;margin-top:24px">
          <div style="text-align:center">
            <div style="font-size:36px;font-weight:800;color:${SOCIAL_BLUE}">${formatNumber(totalSocialVideos)}</div>
            <div style="color:#666;font-size:14px">totaal aantal video's</div>
          </div>
          <div style="text-align:center">
            <div style="font-size:36px;font-weight:800;color:${SOCIAL_BLUE}">${formatNumber(totalFollowers)}</div>
            <div style="color:#666;font-size:14px">totaal aantal volgers</div>
          </div>
        </div>
      </div>
    </div>
${buildFooter(pageNum)}
  </div>`);
  }

  // ── Accessibility page ──
  pageNum++;
  const { html: auditTable, matches: auditMatches } = generateAuditSection(playerSummary);
  const barChart = generateBarChartHTML(auditMatches);
  const html5Section = generateHtml5NativeSection(playerNames);

  pages.push(fillTemplate(loadTemplate("accessibility.html"), {
    barChart: barChart || "",
    auditTable: auditTable || "",
    html5Section: html5Section || "",
    footer: buildFooter(pageNum),
  }));

  // ── Privacy page ──
  pageNum++;
  const privacyRisks = [];
  if (playerNames.includes("YouTube"))
    privacyRisks.push({ player: "YouTube", risk: "Google verzamelt gebruikersgegevens via tracking cookies en plaatst marketing cookies bij het afspelen van video." });
  if (playerNames.includes("Vimeo"))
    privacyRisks.push({ player: "Vimeo", risk: "Vimeo plaatst third-party cookies en deelt data met advertentienetwerken." });
  if (playerNames.includes("Instagram"))
    privacyRisks.push({ player: "Instagram", risk: "Meta/Instagram verzamelt uitgebreide gebruikersdata en plaatst tracking pixels." });
  if (playerNames.includes("Spotify (podcast)"))
    privacyRisks.push({ player: "Spotify", risk: "Spotify embedded players plaatsen cookies en tracken luistergedrag." });
  if (playerNames.includes("TikTok"))
    privacyRisks.push({ player: "TikTok", risk: "TikTok verzamelt data en slaat deze op buiten de EU (China)." });

  const nonEUPlayers = playerNames.filter(p =>
    ["YouTube", "Vimeo", "Instagram", "TikTok", "DailyMotion", "Wistia", "Vidyard", "Loom"].includes(p)
  );

  const privacyRiskItems = privacyRisks.map(r =>
    `          <li><div class="privacy-list-icon"></div><span><strong>${r.player}:</strong> ${r.risk}</span></li>`
  ).join("\n");

  // Cookie section (only if YouTube)
  let cookieSection = "";
  if (playerNames.includes("YouTube")) {
    cookieSection = `
    <div class="cookie-row">
      <div style="flex: 1.1; display: flex; justify-content: flex-start;">
        <div class="cookie-card-wrapper">
          <div class="cookie-card-bg"></div>
          <div class="cookie-card">
            <i class="fa-solid fa-triangle-exclamation cookie-card-icon"></i>
            <div class="cookie-card-text">Accepteer de cookies om dit te bekijken</div>
            <div class="cookie-card-btn">Accepteren</div>
          </div>
        </div>
      </div>
      <div style="flex: 0.9;">
        <p class="text-intro">YouTube embedded video's vereisen cookie-consent. Dit leidt tot minder kijkers doordat bezoekers eerst cookies moeten accepteren.</p>
      </div>
    </div>`;
  }

  pages.push(fillTemplate(loadTemplate("privacy.html"), {
    nonEuCount: String(nonEUPlayers.length),
    privacyRiskItems,
    cookieSection,
    footer: buildFooter(pageNum),
  }));

  // ── Checklist page ──
  pageNum++;
  pages.push(fillTemplate(loadTemplate("checklist.html"), {
    footer: buildFooter(pageNum),
  }));

  // ── Contact page ──
  const hasContact = options.contactName || options.contactPhone || options.contactEmail;
  const contactSection = hasContact
    ? `<div class="contact-item" style="margin-top: 10px;">
          <h3 style="margin-bottom: 12px;">Weet mij te vinden</h3>
          ${options.contactName ? `<p>${options.contactName}</p>` : ""}
          ${options.contactPhone ? `<p>${options.contactPhone}</p>` : ""}
          ${options.contactEmail ? `<p>${options.contactEmail}</p>` : ""}
        </div>`
    : "";

  pages.push(fillTemplate(loadTemplate("contact.html"), {
    contactSection,
    contactImageUrl: options.contactImageUrl || "",
  }));

  // ── Assemble document ──
  const styles = loadTemplate("styles.css");
  return fillTemplate(loadTemplate("document.html"), {
    title: `Video Quick Scan - ${orgNameCap}`,
    styles,
    pages: pages.join("\n\n"),
  });
}

// ── Preview report ──

function generatePreviewReport(scanData, options = {}) {
  const { domain, scanDate, pagesScanned, playerSummary, details } = scanData;
  const derivedName = domain.replace(/^www\./, "").replace(/\.\w+$/, "");
  const orgNameCap = options.orgName || (derivedName.charAt(0).toUpperCase() + derivedName.slice(1));
  const dateStr = new Date(scanDate).toLocaleDateString("nl-NL", { year: "numeric", month: "long", day: "numeric" });

  const players = Object.entries(playerSummary || {});
  const totalVideos = players.reduce((s, [, v]) => s + v.count, 0);
  const pagesWithVideo = scanData.pagesWithVideo || details?.length || 0;
  const playerNames = players.map(([n]) => n);

  // Pie chart
  const pieData = players
    .sort((a, b) => b[1].count - a[1].count)
    .map(([name, data]) => ({ label: name, value: data.count }));
  const pieChart = generatePieChartSVG(pieData, 180);

  // Privacy flags
  const trackerPlayers = playerNames.filter(p =>
    ["YouTube", "Vimeo", "Instagram", "TikTok", "Facebook Video", "X (Twitter)"].includes(p)
  );
  let privacyFlags = "";
  if (trackerPlayers.length > 0) {
    privacyFlags = `
        <h2>Privacy</h2>
        <div>${trackerPlayers.map(p => `<span class="flag flag-red">&#9888; ${p}</span>`).join("")}</div>
        <p style="font-size:13px;color:#666;margin-top:8px">${trackerPlayers.length} player${trackerPlayers.length > 1 ? "s" : ""} met third-party tracking / data buiten EU.</p>`;
  }

  // Accessibility flags
  const auditMatches = [];
  for (const name of playerNames) {
    const auditName = SCANNER_TO_AUDIT[name];
    if (auditName && AUDIT_DATA.players[auditName]) {
      auditMatches.push({ name: auditName, ...AUDIT_DATA.players[auditName] });
    }
  }
  // A kale <video> ("HTML5 native") also can't meet the time-based-media criteria
  // on its own, so count it as a non-conform player type alongside audited players.
  const hasHtml5Native = playerNames.includes("HTML5 native");
  const totalConsidered = auditMatches.length + (hasHtml5Native ? 1 : 0);
  const failCount = auditMatches.filter(m => m.status === "fail").length + (hasHtml5Native ? 1 : 0);
  let accessibilityFlags = "";
  if (totalConsidered > 0) {
    accessibilityFlags = `
        <h2>Toegankelijkheid</h2>
        <div>${failCount > 0
          ? `<span class="flag flag-orange">&#9888; ${failCount} van ${totalConsidered} playertype${totalConsidered > 1 ? "s" : ""} niet WCAG-conform</span>`
          : `<span class="flag flag-green">&#10003; Alle players WCAG-conform</span>`}</div>
        <p style="font-size:13px;color:#666;margin-top:8px">${auditMatches.length > 0 ? `Bron: ${AUDIT_DATA.source} audit (${AUDIT_DATA.date})` : "Incl. kale HTML5 &lt;video&gt;-spelers zonder ondertiteling/transcript."}</p>`;
  }

  const pageNum = 1;
  const previewPage = fillTemplate(loadTemplate("preview.html"), {
    orgName: orgNameCap,
    dateStr,
    pagesScanned: String(pagesScanned),
    pagesWithVideo: String(pagesWithVideo),
    playerCount: String(players.length),
    videoEmbeds: String(totalVideos),
    pieChart,
    privacyFlags,
    accessibilityFlags,
    footer: buildFooter(pageNum),
  });

  const previewCSS = `
    /* Preview overrides */
    .page { height: auto; min-height: 0; }
    .preview-stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 16px 0; }
    .flag { display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; border-radius: 8px; font-size: 13px; font-weight: 600; margin: 4px 4px 4px 0; }
    .flag-red { background: #fff5f5; color: #c0392b; border: 1px solid #f5c6cb; }
    .flag-orange { background: #fff8f0; color: #e67e22; border: 1px solid #fde2c8; }
    .flag-green { background: #f0faf4; color: var(--accent-green); border: 1px solid #c3e6cb; }
    .cta-bar { background: linear-gradient(135deg, var(--text-dark) 0%, var(--primary) 100%); color: var(--white); padding: 20px 24px; border-radius: 0 0 20px 0; margin-top: 20px; display: flex; justify-content: space-between; align-items: center; }
  `;

  const styles = loadTemplate("styles.css") + previewCSS;
  return fillTemplate(loadTemplate("document.html"), {
    title: `Video Quick Scan Preview - ${orgNameCap}`,
    styles,
    pages: previewPage,
  });
}

// ── CLI ──

const args = process.argv.slice(2);
if (args.length === 0) {
  console.log("Usage: node report.mjs <scan.json> [--preview] [--social <file>] [--org-name <name>] [--cover-image <url>] [--contact-image <url>] [--contact-name <name>] [--contact-phone <phone>] [--contact-email <email>] [--exclude-example-sections <csv>] [--all-video-pages]");
  process.exit(0);
}

function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

const scanFile = args[0];
const scanData = JSON.parse(readFileSync(scanFile, "utf-8"));

const options = {
  orgName: getArg("--org-name"),
  coverImageUrl: getArg("--cover-image"),
  contactImageUrl: getArg("--contact-image"),
  contactName: getArg("--contact-name"),
  contactPhone: getArg("--contact-phone"),
  contactEmail: getArg("--contact-email"),
  excludeExampleSections: (getArg("--exclude-example-sections") || "")
    .split(",").map((s) => s.trim()).filter(Boolean),
  allVideoPages: args.includes("--all-video-pages"),
};

if (args.includes("--preview")) {
  const html = generatePreviewReport(scanData, options);
  const outFile = scanFile.replace(".json", "-preview.html");
  writeFileSync(outFile, html);
  console.log(`Preview rapport gegenereerd: ${outFile}`);
} else {
  let socialData = null;
  const socialIdx = args.indexOf("--social");
  if (socialIdx !== -1 && args[socialIdx + 1]) {
    socialData = JSON.parse(readFileSync(args[socialIdx + 1], "utf-8"));
  }
  const html = generateReport(scanData, socialData, options);
  const outFile = scanFile.replace(".json", ".html");
  writeFileSync(outFile, html);
  console.log(`Rapport gegenereerd: ${outFile}`);
}
