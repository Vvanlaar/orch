#!/usr/bin/env node
// Nationale Monitor — RQ2 'uitlegvideo' classifier.
// Reads scan outputs + meta sidecars from a segment dir, batches video
// candidates, asks Claude to classify each as uitlegvideo (yes/no/uncertain),
// writes classify-output.json next to the meta files.
//
// Definition + examples come from monitor/explainer-definition.md (researcher
// input — placeholder until filled).

import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { slugify, callClaudeWithRetry, extractJsonArray } from "./_lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFINITION_PATH = join(__dirname, "explainer-definition.md");
const BATCH_SIZE = 15;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--segment") out.segment = argv[++i];
    else if (a === "--dir") out.dir = argv[++i];
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function printUsage() {
  console.log(`
RQ2 classifier — uitlegvideo yes/no/uncertain

Usage:
  node classify-explainer.mjs --segment <name> [--dir <path>] [--dry-run]

Reads from:  videoscans/monitor/<segment>/  (override with --dir)
Writes:      <dir>/classify-output.json
`);
}

// Build candidate list: one entry per (org, scan-page) where video was detected.
// We classify per-page, not per-player — a single page usually contains one
// logical video; if it carries multiple players (e.g. fallback HTML5 + JW), the
// classification still applies to the same content.
function collectCandidates(dir) {
  // Keyed by org+url so the same page scanned twice (resume / re-crawl) collapses
  // to one candidate instead of duplicate classifications.
  const byKey = new Map();
  const metas = readdirSync(dir).filter((f) => f.endsWith(".meta.json"));
  for (const metaFile of metas) {
    const meta = JSON.parse(readFileSync(join(dir, metaFile), "utf-8"));
    const orgDir = meta.orgDir ? join(dir, meta.orgDir) : dir;
    const orgSlug = metaFile.replace(/\.meta\.json$/, "");
    for (const scanFile of meta.scanFiles || []) {
      const full = join(orgDir, scanFile);
      if (!existsSync(full)) continue;
      const scan = JSON.parse(readFileSync(full, "utf-8"));
      for (const d of scan.details || []) {
        const a = d.accessibility || {};
        const players = (d.players || []).map((p) => p.name);
        // The embed/video title is the single strongest RQ2 signal (e.g.
        // "Instructievideo voor hinderniscontroleurs"). The scanner already
        // captures it in capturePageA11y; feed it to the classifier so explainers
        // on news/discipline pages aren't undercounted as uncertain/no.
        const videoTitles = [
          ...(a.videoIframes || []).map((f) => f.title || f.ariaLabel),
          ...(a.videos || []).map((v) => v.ariaLabel),
        ].map((t) => (t || "").replace(/"/g, "'").trim()).filter(Boolean);
        const key = `${orgSlug}\n${d.url}`;
        const prev = byKey.get(key);
        if (prev) {
          prev.playerTypes = [...new Set([...prev.playerTypes, ...players])];
          prev.videoTitles = [...new Set([...prev.videoTitles, ...videoTitles])];
        } else {
          byKey.set(key, {
            orgSlug,
            organisatie: meta.organisatie,
            pageUrl: d.url,
            playerTypes: players,
            pageTitle: a.pageTitle || "",
            nearestHeading: a.nearestHeading || "",
            videoTitles: [...new Set(videoTitles)],
          });
        }
      }
    }
  }
  return [...byKey.values()];
}

function buildPrompt(definitionText, batch) {
  const items = batch
    .map((c, i) => {
      return [
        `[${i + 1}] org="${c.organisatie}"`,
        `    page_url=${c.pageUrl}`,
        `    page_title="${c.pageTitle}"`,
        `    nearest_heading="${c.nearestHeading}"`,
        `    video_titles=[${(c.videoTitles || []).map((t) => `"${t}"`).join(", ")}]`,
        `    player_types=[${c.playerTypes.join(", ")}]`,
      ].join("\n");
    })
    .join("\n\n");

  return `Je bent een onderzoeksassistent voor de Nationale Monitor Digitale Toegankelijkheid.

Hieronder de definitie van 'uitlegvideo' (vraag RQ2 in het onderzoek):

${definitionText}

Weeg \`video_titles\` zwaar mee — dat is vaak het doorslaggevende signaal: een titel als "Instructievideo ...", "Hoe ...", "Uitleg ...", "Webinar ..." of "zo doe/gebruik je ..." duidt sterk op uitleg; een titel als "Highlights", "Aftermovie", "Best of", "... interview", een documentaire of een sfeer-/promotitel juist niet. Ontbreekt de titel, val dan terug op de pagina-context.

Klassificeer onderstaande gevonden video's. Geef per item een JSON-object:
{ "index": <nr>, "isExplainer": "yes" | "no" | "uncertain", "reasoning": "<max 1 zin>" }

Antwoord ALLEEN met een JSON array, geen tekst eromheen.

ITEMS:

${items}
`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.segment) {
    printUsage();
    process.exit(opts.help ? 0 : 1);
  }

  const dir = resolve(
    opts.dir || join("videoscans", "monitor", slugify(opts.segment))
  );
  if (!existsSync(dir)) {
    console.error(`Segment dir not found: ${dir}`);
    process.exit(1);
  }

  if (!existsSync(DEFINITION_PATH)) {
    console.error(
      `Definition file missing: ${DEFINITION_PATH}\nResearcher must provide this before classification can run.`
    );
    process.exit(1);
  }
  const definitionText = readFileSync(DEFINITION_PATH, "utf-8");

  const candidates = collectCandidates(dir);
  console.log(
    `RQ2 classifier — ${candidates.length} candidate pages in ${dir}`
  );

  if (opts.dryRun) {
    console.log("Dry run — would classify in batches of " + BATCH_SIZE);
    candidates.slice(0, 5).forEach((c, i) =>
      console.log(`  ${i + 1}. ${c.organisatie} — ${c.pageUrl}`)
    );
    return;
  }

  const results = [];
  const errorLog = [];
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(candidates.length / BATCH_SIZE);
    console.log(
      `  Batch ${batchNum}/${totalBatches} — ${batch.length} items...`
    );
    try {
      const response = await callClaudeWithRetry(
        buildPrompt(definitionText, batch),
        errorLog
      );
      const parsed = extractJsonArray(response);
      for (const r of parsed) {
        const c = batch[r.index - 1];
        if (!c) continue;
        results.push({
          orgSlug: c.orgSlug,
          organisatie: c.organisatie,
          pageUrl: c.pageUrl,
          isExplainer: r.isExplainer,
          reasoning: r.reasoning,
        });
      }
    } catch (err) {
      console.error(`    batch ${batchNum} failed: ${err.message}`);
      for (const c of batch) {
        results.push({
          orgSlug: c.orgSlug,
          organisatie: c.organisatie,
          pageUrl: c.pageUrl,
          isExplainer: "error",
          reasoning: err.message.slice(0, 200),
        });
      }
    }
  }

  const outFile = join(dir, "classify-output.json");
  writeFileSync(outFile, JSON.stringify(results, null, 2));
  if (errorLog.length > 0) {
    const errFile = join(dir, "classify-errors.log");
    writeFileSync(errFile, errorLog.join("\n"));
    console.warn(`  ${errorLog.length} attempt failure(s) logged to ${errFile}`);
  }
  console.log(`\nWrote ${results.length} classifications to ${outFile}`);
  console.log(`Next: node monitor/aggregate-monitor.mjs --segment ${opts.segment}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
