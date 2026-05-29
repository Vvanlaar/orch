#!/usr/bin/env node
// Nationale Monitor — support/FAQ URL finder.
// For each org row that has a homepage but no url_support, loads the homepage
// with Playwright, extracts navigation links, and picks the best support /
// klantenservice / FAQ / help URL. A heuristic resolves most; ambiguous cases
// fall back to a single Claude call. Writes an enriched CSV.
//
// Run BEFORE run-monitor.mjs:
//   node find-support-urls.mjs --input in.csv --output in-enriched.csv

import { chromium } from "playwright";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseCsv,
  rowsToObjects,
  csvRow,
  callClaudeWithRetry,
  extractJsonArray,
} from "./_lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = { delay: 1500, timeout: 20000, minScore: 7 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--input") out.input = argv[++i];
    else if (a === "--output") out.output = argv[++i];
    else if (a === "--segment") out.segment = argv[++i];
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--delay") out.delay = Number(argv[++i]);
    else if (a === "--no-llm") out.noLlm = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function printUsage() {
  console.log(`
Nationale Monitor — support/FAQ URL finder

Usage:
  node find-support-urls.mjs --input <csv> [--output <csv>] [opts]

Adds/fills the url_support column by inspecting each homepage. Existing
non-empty url_support values are kept. Adds two transparency columns:
url_support_method (existing|heuristic|llm|none) and url_support_score.

Options:
  --input <csv>     Input CSV (segment, organisatie, url_homepage, ...)
  --output <csv>    Output CSV (default: <input>-enriched.csv)
  --segment <name>  Only process rows for this segment
  --delay <ms>      Delay between sites (default: 1500)
  --no-llm          Heuristic only — no Claude tie-break
  --limit <n>       Only process first N rows (smoke test)
`);
}

// Score a candidate link by how strongly its text/href signals a support page.
// Higher = stronger. 0 = not a candidate.
const SCORE_RULES = [
  { weight: 10, re: /klantenservice|klantcontact|customer[-\s]?service/i },
  { weight: 10, re: /helpdesk|servicedesk|service[-\s]?desk/i },
  { weight: 9, re: /\bsupport\b|ondersteuning/i },
  { weight: 8, re: /\bhulp\b|\bhelp\b/i },
  { weight: 7, re: /veelgestelde\s*vragen|veelgesteldevragen|\bfaq\b|vraag\s*(en|&)\s*antwoord/i },
  { weight: 5, re: /\bservice(loket)?\b/i },
  { weight: 3, re: /\bcontact\b/i },
];

function scoreCandidate(href, text) {
  let pathPart = "";
  try {
    pathPart = decodeURIComponent(new URL(href).pathname);
  } catch {
    return 0;
  }
  const haystackText = text || "";
  let best = 0;
  for (const { weight, re } of SCORE_RULES) {
    if (re.test(pathPart) || re.test(haystackText)) best = Math.max(best, weight);
  }
  return best;
}

// Is `href` on the same registrable domain as `baseHost` (allowing subdomains
// such as support.example.com)?
function sameSite(href, baseHost) {
  try {
    const h = new URL(href).hostname.replace(/^www\./, "");
    const b = baseHost.replace(/^www\./, "");
    return h === b || h.endsWith("." + b) || b.endsWith("." + h);
  } catch {
    return false;
  }
}

async function extractNavLinks(page) {
  return page.evaluate(() => {
    const out = [];
    const seen = new Set();
    for (const a of document.querySelectorAll("a[href]")) {
      const href = a.href;
      if (!href || href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("tel:")) continue;
      if (seen.has(href)) continue;
      seen.add(href);
      out.push({ href, text: (a.textContent || "").trim().slice(0, 80) });
    }
    return out.slice(0, 400);
  });
}

async function findForHomepage(page, homepage, { timeout, minScore, noLlm, errorLog }) {
  let baseHost;
  try {
    baseHost = new URL(homepage).hostname;
  } catch {
    return { url: "", method: "none", score: 0, note: "invalid homepage URL" };
  }

  try {
    await page.goto(homepage, { waitUntil: "domcontentloaded", timeout });
  } catch (e) {
    return { url: "", method: "none", score: 0, note: `load failed: ${(e?.message || "").slice(0, 60)}` };
  }

  const links = (await extractNavLinks(page)).filter((l) => sameSite(l.href, baseHost));

  // Heuristic: highest-scoring same-site link.
  let best = null;
  for (const l of links) {
    const score = scoreCandidate(l.href, l.text);
    if (score > 0 && (!best || score > best.score)) best = { ...l, score };
  }
  if (best && best.score >= minScore) {
    return { url: best.href, method: "heuristic", score: best.score };
  }

  if (noLlm) {
    return best
      ? { url: best.href, method: "heuristic-weak", score: best.score }
      : { url: "", method: "none", score: 0 };
  }

  // LLM tie-break: hand the candidate links to Claude.
  const candidates = links
    .map((l) => ({ ...l, score: scoreCandidate(l.href, l.text) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);
  if (candidates.length === 0) {
    return { url: "", method: "none", score: 0, note: "no internal links" };
  }

  const prompt = `Je krijgt navigatielinks van de homepage ${homepage}.
Kies de URL die het meest waarschijnlijk de klantenservice / support / hulp /
veelgestelde-vragen sectie is (waar instructie-/uitlegvideo's te verwachten zijn).
Liever een specifieke support/FAQ-pagina dan een algemene contactpagina.

Antwoord ALLEEN met JSON: [{ "url": "<gekozen url of lege string>", "reden": "<max 1 zin>" }]

LINKS:
${candidates.map((c, i) => `[${i + 1}] ${c.href}  — "${c.text}"`).join("\n")}
`;
  try {
    const resp = await callClaudeWithRetry(prompt, errorLog);
    const parsed = extractJsonArray(resp);
    const pick = parsed?.[0]?.url?.trim();
    if (pick && sameSite(pick, baseHost)) {
      return { url: pick, method: "llm", score: 0, note: parsed[0].reden || "" };
    }
    return { url: "", method: "none", score: 0, note: "llm: no pick" };
  } catch (e) {
    return { url: "", method: "none", score: 0, note: `llm failed: ${(e?.message || "").slice(0, 60)}` };
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.input) {
    printUsage();
    process.exit(opts.help ? 0 : 1);
  }
  if (!existsSync(opts.input)) {
    console.error(`Input CSV not found: ${opts.input}`);
    process.exit(1);
  }
  const outFile = resolve(opts.output || opts.input.replace(/\.csv$/i, "") + "-enriched.csv");

  const rowObjs = rowsToObjects(parseCsv(readFileSync(opts.input, "utf-8")));
  // Preserve original column order; ensure the extra columns exist.
  const baseCols = Object.keys(rowObjs[0] || {});
  for (const c of ["url_support", "url_support_method", "url_support_score"]) {
    if (!baseCols.includes(c)) baseCols.push(c);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
  });

  const errorLog = [];
  let considered = 0; // rows past the --segment filter — drives --limit
  let processed = 0; // rows actually fetched
  let filled = 0;
  const limit = opts.limit || rowObjs.length;

  for (let i = 0; i < rowObjs.length; i++) {
    const row = rowObjs[i];
    if (opts.segment && (row.segment || "").toLowerCase() !== opts.segment.toLowerCase()) {
      continue;
    }
    if (considered >= limit) break;
    considered++;

    if ((row.url_support || "").trim()) {
      row.url_support_method = row.url_support_method || "existing";
      continue;
    }
    const homepage = (row.url_homepage || "").trim();
    if (!homepage) {
      row.url_support_method = "none";
      row.url_support_score = "0";
      continue;
    }

    processed++;
    const page = await context.newPage();
    let res;
    try {
      res = await findForHomepage(page, homepage, {
        timeout: opts.timeout,
        minScore: opts.minScore,
        noLlm: opts.noLlm,
        errorLog,
      });
    } finally {
      await page.close().catch(() => {});
    }

    row.url_support = res.url;
    row.url_support_method = res.method;
    row.url_support_score = String(res.score || 0);
    if (res.url) filled++;

    console.log(
      `[${considered}/${limit}] ${row.organisatie || homepage} → ${res.url || "(none)"} [${res.method}${res.score ? ` ${res.score}` : ""}]${res.note ? ` — ${res.note}` : ""}`
    );

    await sleep(opts.delay);
  }

  await browser.close();

  const outRows = rowObjs.map((r) => baseCols.map((c) => r[c] ?? ""));
  writeFileSync(
    outFile,
    "﻿" + [csvRow(baseCols), ...outRows.map(csvRow)].join("\r\n") + "\r\n"
  );
  if (errorLog.length) {
    writeFileSync(outFile.replace(/\.csv$/i, "") + "-llm-errors.log", errorLog.join("\n"));
  }

  console.log(`\nProcessed ${processed} sites, filled ${filled} url_support values.`);
  console.log(`Wrote ${outFile}`);
  console.log(`Spot-check low-confidence rows (method=llm / heuristic-weak / none) before scanning.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
