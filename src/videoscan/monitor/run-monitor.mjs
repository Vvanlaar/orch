#!/usr/bin/env node
// Nationale Monitor Digitale Toegankelijkheid — orchestrator.
// Reads a CSV with (segment, organisatie, url_homepage, url_support, url_product),
// spawns scan.mjs per organisation in --urls mode (no crawl, just the listed
// pages), and writes a .meta.json sidecar per org so the aggregator can stitch
// scan-output ↔ organisation later.
//
// Sequential by design — see plan §verification (traceability over throughput).

import { spawn } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCAN_SCRIPT = resolve(__dirname, "..", "scan.mjs");

function parseArgs(argv) {
  const out = { maxPages: 3, delay: 3000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--input") out.input = argv[++i];
    else if (a === "--segment") out.segment = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--max-pages") out.maxPages = Number(argv[++i]);
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--delay") out.delay = Number(argv[++i]);
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function printUsage() {
  console.log(`
Nationale Monitor — videoscan orchestrator

Usage:
  node run-monitor.mjs --input <csv> --segment <name> [opts]

CSV columns (header row required, case-insensitive):
  segment, organisatie, url_homepage, url_support, url_product

Options:
  --segment <name>      Filter rows to this segment (required)
  --input <csv>         Path to input CSV (required)
  --out <dir>           Output dir (default: videoscans/monitor/<segment>)
  --max-pages <n>       Max pages per org scan (default: 3)
  --delay <ms>          Inter-page delay in scan.mjs (default: 3000)
  --limit <n>           Only process first N orgs (smoke test)

Example:
  node run-monitor.mjs --input ./monitor-input/zorg.csv --segment zorg
`);
}

// Minimal RFC-4180-ish CSV parser. Handles quoted fields, doubled-quote escape,
// CRLF and LF line endings. No streaming — the input is ~700 rows.
function parseCsv(text) {
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") {
        row.push(field);
        field = "";
      } else if (ch === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (ch === "\r") {
        // swallow — \n handles row break
      } else {
        field += ch;
      }
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function rowsToObjects(rows) {
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => {
    const obj = {};
    for (let i = 0; i < header.length; i++) {
      obj[header[i]] = (r[i] || "").trim();
    }
    return obj;
  });
}

function slugify(s) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function runScan(urlsFile, segment, maxPages, delay, cwd) {
  return new Promise((resolveFn, reject) => {
    const args = [
      SCAN_SCRIPT,
      "--urls",
      urlsFile,
      "--max-pages",
      String(maxPages),
      "--delay",
      String(delay),
      "--no-sitemap",
      "--batch-label",
      segment,
    ];
    const child = spawn(process.execPath, args, {
      cwd,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolveFn();
      else reject(new Error(`scan.mjs exited ${code}`));
    });
  });
}

function findScanOutputs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(
    (f) => f.startsWith("videoscan-") && f.endsWith(".json")
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.input || !opts.segment) {
    printUsage();
    process.exit(opts.help ? 0 : 1);
  }
  if (!existsSync(opts.input)) {
    console.error(`Input CSV not found: ${opts.input}`);
    process.exit(1);
  }

  const segmentSlug = slugify(opts.segment);
  const outDir = resolve(opts.out || join("videoscans", "monitor", segmentSlug));
  mkdirSync(outDir, { recursive: true });

  const csvText = readFileSync(opts.input, "utf-8");
  const allRows = rowsToObjects(parseCsv(csvText));
  const rows = allRows.filter(
    (r) => slugify(r.segment || "") === segmentSlug && r.organisatie
  );
  const limit = opts.limit ? Math.min(opts.limit, rows.length) : rows.length;

  console.log(
    `Monitor: segment="${opts.segment}" — ${rows.length} orgs in CSV, processing ${limit}, out=${outDir}`
  );

  for (let i = 0; i < limit; i++) {
    const row = rows[i];
    const baseSlug = slugify(row.organisatie) || `org-${i + 1}`;
    // Bump suffix until <slug>.meta.json is free. Prevents two orgs that
    // slugify identically (truncated/normalised) from overwriting each other.
    let orgSlug = baseSlug;
    let suffix = 1;
    while (existsSync(join(outDir, `${orgSlug}.meta.json`))) {
      suffix++;
      orgSlug = `${baseSlug}-${suffix}`;
    }

    const urls = [row.url_homepage, row.url_support, row.url_product]
      .map((u) => (u || "").trim())
      .filter(Boolean);

    if (urls.length === 0) {
      console.log(`[${i + 1}/${limit}] ${row.organisatie} — no URLs, skip`);
      continue;
    }

    console.log(
      `\n[${i + 1}/${limit}] ${row.organisatie} (${urls.length} URL${urls.length === 1 ? "" : "s"})`
    );

    // Per-org subdir isolates scan output filenames — prevents
    // videoscan-<domain>-<ts>.json collisions when two orgs share a hostname.
    // Clean any stale dir from a crashed prior run with the same slug so
    // findScanOutputs() doesn't pick up leftover JSON from that run.
    const orgDir = join(outDir, orgSlug);
    if (existsSync(orgDir)) rmSync(orgDir, { recursive: true, force: true });
    mkdirSync(orgDir, { recursive: true });

    const urlsFile = join(orgDir, "_urls.json");
    writeFileSync(urlsFile, JSON.stringify(urls, null, 2));

    const startedAt = Date.now();
    try {
      await runScan(urlsFile, opts.segment, opts.maxPages, opts.delay, orgDir);
    } catch (err) {
      console.error(`  scan failed: ${err.message}`);
    } finally {
      try { rmSync(urlsFile); } catch {}
    }

    const meta = {
      organisatie: row.organisatie,
      segment: opts.segment,
      url_homepage: row.url_homepage || null,
      url_support: row.url_support || null,
      url_product: row.url_product || null,
      urls,
      orgDir: orgSlug,
      scanFiles: findScanOutputs(orgDir),
      scannedAt: new Date(startedAt).toISOString(),
    };
    writeFileSync(
      join(outDir, `${orgSlug}.meta.json`),
      JSON.stringify(meta, null, 2)
    );
  }

  console.log(`\nDone — outputs in ${outDir}`);
  console.log(`Next: node monitor/classify-explainer.mjs --segment ${opts.segment}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
