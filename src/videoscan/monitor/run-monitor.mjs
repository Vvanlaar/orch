#!/usr/bin/env node
// Nationale Monitor Digitale Toegankelijkheid — orchestrator.
// Reads a CSV with (segment, organisatie, url_homepage, url_support, url_product)
// and, per organisation, crawls the domain starting at url_support (so support/
// FAQ content is scanned first) until --max-videos pages with video are found or
// --max-pages is reached. Writes a .meta.json sidecar per org so the aggregator
// can stitch scan-output ↔ organisation later.
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
import { slugify, parseCsv, rowsToObjects } from "./_lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCAN_SCRIPT = resolve(__dirname, "..", "scan.mjs");

function parseArgs(argv) {
  const out = { maxPages: 40, maxVideos: 10, delay: 3000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--input") out.input = argv[++i];
    else if (a === "--segment") out.segment = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--max-pages") out.maxPages = Number(argv[++i]);
    else if (a === "--max-videos") out.maxVideos = Number(argv[++i]);
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--delay") out.delay = Number(argv[++i]);
    else if (a === "--fresh") out.fresh = true;
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

Per org: crawls the domain starting at url_support (so support/FAQ content is
scanned first), then homepage + product, stopping once --max-videos pages with
video are found, or --max-pages is reached. Falls back to homepage as start
when url_support is empty.

Options:
  --segment <name>      Filter rows to this segment (required)
  --input <csv>         Path to input CSV (required)
  --out <dir>           Output dir (default: videoscans/monitor/<segment>)
  --max-videos <n>      Stop crawl after n pages with video (default: 10)
  --max-pages <n>       Safety cap on pages crawled per org (default: 40)
  --delay <ms>          Inter-page delay in scan.mjs (default: 3000)
  --fresh               Re-scan every org (default: skip orgs already scanned)
  --limit <n>           Only process first N orgs (smoke test)

Example:
  node run-monitor.mjs --input ./monitor-input/zorg.csv --segment zorg
`);
}

function runScan({ startUrl, seedFile, segment, maxPages, maxVideos, delay, cwd }) {
  return new Promise((resolveFn, reject) => {
    const args = [
      SCAN_SCRIPT,
      startUrl,
      "--max-videos",
      String(maxVideos),
      "--max-pages",
      String(maxPages),
      "--delay",
      String(delay),
      "--no-sitemap",
      "--batch-label",
      segment,
    ];
    if (seedFile) args.push("--seed", seedFile);
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

  // Deterministic slug per row (stable across runs so --resume can match):
  // first claimant of a base slug keeps it, later identical slugs get -2, -3…
  const slugCounts = new Map();
  const claimSlug = (org, i) => {
    const base = slugify(org) || `org-${i + 1}`;
    const n = (slugCounts.get(base) || 0) + 1;
    slugCounts.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  };

  for (let i = 0; i < limit; i++) {
    const row = rows[i];
    const orgSlug = claimSlug(row.organisatie, i);
    const metaPath = join(outDir, `${orgSlug}.meta.json`);

    const homepage = (row.url_homepage || "").trim();
    const support = (row.url_support || "").trim();
    const product = (row.url_product || "").trim();
    // Crawl starts at the homepage: it's the richest link hub and fixes the
    // crawl domain to the main site (a deep support/FAQ page is a poor seed and
    // a support subdomain traps the crawl). support + product are seeded so
    // they're still scanned in the first batch (RQ2). Fall back to support if
    // there's no homepage.
    const startUrl = homepage || support;
    if (!startUrl) {
      console.log(`[${i + 1}/${limit}] ${row.organisatie} — no URLs, skip`);
      continue;
    }

    // Resume: skip orgs already scanned (meta with at least one scan file),
    // unless --fresh. Makes a long run survivable across a crash/reboot.
    if (!opts.fresh && existsSync(metaPath)) {
      try {
        const prev = JSON.parse(readFileSync(metaPath, "utf-8"));
        if ((prev.scanFiles || []).length > 0) {
          console.log(`[${i + 1}/${limit}] ${row.organisatie} — already scanned, skip`);
          continue;
        }
      } catch { /* unreadable meta → re-scan */ }
    }

    const seeds = [homepage, support, product].filter(
      (u) => u && u !== startUrl
    );

    console.log(
      `\n[${i + 1}/${limit}] ${row.organisatie} — start=${startUrl}${seeds.length ? ` (+${seeds.length} seed)` : ""}`
    );

    // Per-org subdir isolates scan output filenames — prevents
    // videoscan-<domain>-<ts>.json collisions when two orgs share a hostname.
    // Clean any stale dir from a crashed prior run with the same slug so
    // findScanOutputs() doesn't pick up leftover JSON from that run.
    const orgDir = join(outDir, orgSlug);
    if (existsSync(orgDir)) rmSync(orgDir, { recursive: true, force: true });
    mkdirSync(orgDir, { recursive: true });

    let seedFile = null;
    if (seeds.length) {
      seedFile = join(orgDir, "_seed.json");
      writeFileSync(seedFile, JSON.stringify(seeds, null, 2));
    }

    const startedAt = Date.now();
    try {
      await runScan({
        startUrl,
        seedFile,
        segment: opts.segment,
        maxPages: opts.maxPages,
        maxVideos: opts.maxVideos,
        delay: opts.delay,
        cwd: orgDir,
      });
    } catch (err) {
      console.error(`  scan failed: ${err.message}`);
    } finally {
      if (seedFile) { try { rmSync(seedFile); } catch {} }
    }

    const meta = {
      organisatie: row.organisatie,
      segment: opts.segment,
      url_homepage: homepage || null,
      url_support: support || null,
      url_product: product || null,
      startUrl,
      seeds,
      maxVideos: opts.maxVideos,
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
