#!/usr/bin/env node
// Nationale Monitor — aggregator.
// Reads <dir>/*.meta.json + referenced scan JSONs + classify-output.json,
// emits two CSVs:
//   monitor-results-<segment>.csv      — one row per organisation
//   monitor-manual-review-<segment>.csv — orgs with video, for manual RQ3 Content
//
// RQ3 scoring uses placeholder thresholds — researcher to confirm (plan §12).

import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Placeholder thresholds — Open Punten §12. Researcher to confirm.
const RQ3_TECHNIEK_CRITERIA = 3;
const RQ3_ELEMENTEN_CRITERIA = 4;
const SCORE_THRESHOLDS = {
  // ratio of passes / total criteria
  voldoet: 1.0,        // all criteria
  gedeeltelijk: 0.34,  // ≥ ~1/3
  // anything below → "Voldoet niet"
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--segment") out.segment = argv[++i];
    else if (a === "--dir") out.dir = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function printUsage() {
  console.log(`
Nationale Monitor — aggregator

Usage:
  node aggregate-monitor.mjs --segment <name> [--dir <path>]

Reads:  videoscans/monitor/<segment>/  (or --dir)
Writes: <dir>/monitor-results-<segment>.csv
        <dir>/monitor-manual-review-<segment>.csv
`);
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

function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvRow(cells) {
  return cells.map(csvCell).join(",");
}

function ratioToScore(passes, total) {
  if (total === 0) return "N.v.t.";
  const r = passes / total;
  if (r >= SCORE_THRESHOLDS.voldoet) return "Voldoet";
  if (r >= SCORE_THRESHOLDS.gedeeltelijk) return "Voldoet gedeeltelijk";
  return "Voldoet niet";
}

// Aggregate accessibility across all pages with video for one org.
function scoreAccessibility(pagesWithA11y) {
  if (pagesWithA11y.length === 0) {
    return {
      techniek: "N.v.t.",
      elementen: "N.v.t.",
      notes: "",
    };
  }

  const notes = [];

  // Techniek — 3 criteria
  let techPasses = 0;
  const autoplayWithoutControls = pagesWithA11y.some((a) =>
    (a.videos || []).some((v) => v.autoplay && !v.controls)
  );
  if (!autoplayWithoutControls) techPasses++;
  else notes.push("autoplay without controls");

  const ariaPresent = pagesWithA11y.some(
    (a) =>
      (a.videos || []).some((v) => v.ariaLabel) ||
      (a.videoIframes || []).some((f) => f.title || f.ariaLabel)
  );
  if (ariaPresent) techPasses++;
  else notes.push("no aria-label / iframe title");

  const controlsPresent = pagesWithA11y.some((a) =>
    (a.videos || []).some((v) => v.controls)
  );
  // For iframe-only embeds we can't see internal controls; treat that as pass
  // when there are no native <video> elements to evaluate.
  const hasNativeVideo = pagesWithA11y.some(
    (a) => (a.videos || []).length > 0
  );
  if (!hasNativeVideo || controlsPresent) techPasses++;
  else notes.push("native <video> without controls attr");

  // Elementen — 4 criteria
  let elemPasses = 0;
  const tracksPresent = pagesWithA11y.some((a) =>
    (a.videos || []).some((v) => (v.tracks || []).length > 0)
  );
  if (tracksPresent) elemPasses++;

  const ccButton = pagesWithA11y.some((a) => a.ccButtonPresent);
  if (ccButton) elemPasses++;

  const transcriptLink = pagesWithA11y.some((a) => a.transcriptLinkNearby);
  if (transcriptLink) elemPasses++;

  const audioDescription = pagesWithA11y.some((a) =>
    (a.videos || []).some((v) =>
      (v.tracks || []).some((t) => t.kind === "descriptions")
    )
  );
  if (audioDescription) elemPasses++;

  const elemNotes = [];
  if (!tracksPresent) elemNotes.push("no <track>");
  if (!ccButton) elemNotes.push("no CC button");
  if (!transcriptLink) elemNotes.push("no transcript link");
  if (!audioDescription) elemNotes.push("no audio description");

  return {
    techniek: ratioToScore(techPasses, RQ3_TECHNIEK_CRITERIA),
    elementen: ratioToScore(elemPasses, RQ3_ELEMENTEN_CRITERIA),
    techniekNotes: notes.join("; "),
    elementenNotes: elemNotes.join("; "),
  };
}

function loadOrgScans(dir, meta) {
  const allDetails = [];
  let totalVideoCount = 0;
  const playerSet = new Set();
  const orgDir = meta.orgDir ? join(dir, meta.orgDir) : dir;
  for (const scanFile of meta.scanFiles || []) {
    const full = join(orgDir, scanFile);
    if (!existsSync(full)) continue;
    const scan = JSON.parse(readFileSync(full, "utf-8"));
    for (const d of scan.details || []) {
      allDetails.push(d);
      for (const p of d.players || []) playerSet.add(p.name);
    }
    totalVideoCount += scan.pagesWithVideo || 0;
  }
  return {
    details: allDetails,
    videoCount: totalVideoCount,
    players: [...playerSet],
  };
}

function summarizeExplainer(orgSlug, classify) {
  const rows = classify.filter((c) => c.orgSlug === orgSlug);
  if (rows.length === 0) return { score: "", confidence: "" };
  const yes = rows.filter((r) => r.isExplainer === "yes").length;
  const no = rows.filter((r) => r.isExplainer === "no").length;
  const uncertain = rows.filter((r) => r.isExplainer === "uncertain").length;
  const errors = rows.filter((r) => r.isExplainer === "error").length;
  if (yes > 0) return { score: "ja", confidence: `${yes}/${rows.length}` };
  if (uncertain > 0 && no === 0)
    return { score: "onzeker", confidence: `${uncertain}/${rows.length}` };
  if (errors === rows.length) return { score: "", confidence: "error" };
  return { score: "nee", confidence: `${no}/${rows.length}` };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.segment) {
    printUsage();
    process.exit(opts.help ? 0 : 1);
  }

  const segmentSlug = slugify(opts.segment);
  const dir = resolve(
    opts.dir || join("videoscans", "monitor", segmentSlug)
  );
  if (!existsSync(dir)) {
    console.error(`Segment dir not found: ${dir}`);
    process.exit(1);
  }

  const classifyPath = join(dir, "classify-output.json");
  const classify = existsSync(classifyPath)
    ? JSON.parse(readFileSync(classifyPath, "utf-8"))
    : [];
  if (classify.length === 0) {
    console.warn("No classify-output.json — RQ2 column will be empty.");
  }

  const metaFiles = readdirSync(dir).filter((f) => f.endsWith(".meta.json"));
  const resultsHeader = [
    "segment",
    "organisatie",
    "url_homepage",
    "url_support",
    "url_product",
    "rq1_video_aanwezig",
    "rq1_player_types",
    "rq1_video_pages",
    "rq2_uitlegvideo",
    "rq2_confidence",
    "rq3_techniek_score",
    "rq3_techniek_notes",
    "rq3_elementen_score",
    "rq3_elementen_notes",
    "rq3_content_score",
  ];
  const reviewHeader = [
    "segment",
    "organisatie",
    "page_url",
    "player_types",
    "page_title",
    "rq3_content_score",
    "rq3_content_notes",
  ];

  const resultsRows = [];
  const reviewRows = [];

  for (const metaFile of metaFiles) {
    const orgSlug = metaFile.replace(/\.meta\.json$/, "");
    const meta = JSON.parse(readFileSync(join(dir, metaFile), "utf-8"));
    const { details, videoCount, players } = loadOrgScans(dir, meta);

    const pagesWithA11y = details
      .map((d) => d.accessibility)
      .filter(Boolean);

    const a11y = scoreAccessibility(pagesWithA11y);
    const explainer = summarizeExplainer(orgSlug, classify);

    resultsRows.push([
      meta.segment,
      meta.organisatie,
      meta.url_homepage || "",
      meta.url_support || "",
      meta.url_product || "",
      videoCount > 0 ? "ja" : "nee",
      players.join("; "),
      videoCount,
      explainer.score,
      explainer.confidence,
      a11y.techniek,
      a11y.techniekNotes || "",
      a11y.elementen,
      a11y.elementenNotes || "",
      "", // rq3_content_score — handmatig
    ]);

    if (videoCount > 0) {
      for (const d of details) {
        reviewRows.push([
          meta.segment,
          meta.organisatie,
          d.url,
          (d.players || []).map((p) => p.name).join("; "),
          d.accessibility?.pageTitle || "",
          "", // rq3_content_score
          "",
        ]);
      }
    }
  }

  const resultsFile = join(dir, `monitor-results-${segmentSlug}.csv`);
  const reviewFile = join(dir, `monitor-manual-review-${segmentSlug}.csv`);

  writeFileSync(
    resultsFile,
    [csvRow(resultsHeader), ...resultsRows.map(csvRow)].join("\n") + "\n"
  );
  writeFileSync(
    reviewFile,
    [csvRow(reviewHeader), ...reviewRows.map(csvRow)].join("\n") + "\n"
  );

  console.log(`Wrote ${resultsRows.length} orgs to ${resultsFile}`);
  console.log(`Wrote ${reviewRows.length} pages to ${reviewFile}`);
  console.log(
    `\nNext: vul rq3_content_score in ${reviewFile} handmatig, merge terug in ${resultsFile}.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
