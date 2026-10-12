// Run: node --test src/videoscan/report.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPORT = join(dirname(fileURLToPath(import.meta.url)), "report.mjs");

function scan(over = {}) {
  return {
    domain: "gemeente.nl",
    scanDate: "2026-10-12T10:00:00.000Z",
    pagesScanned: 41250,
    pagesWithVideo: 1,
    uniquePlayers: 1,
    playerSummary: { YouTube: { count: 1, pages: ["https://www.gemeente.nl/wonen/film"] } },
    details: [{ url: "https://www.gemeente.nl/wonen/film", players: [{ name: "YouTube", evidence: [] }] }],
    _state: { visited: [], queue: [] },
    ...over,
  };
}

// report.mjs is a CLI: it writes the HTML next to the JSON it was given
function render(data, ...flags) {
  const dir = mkdtempSync(join(tmpdir(), "videoscan-report-"));
  try {
    const file = join(dir, "videoscan-gemeente.nl-2026-10-12T10-00-00.json");
    writeFileSync(file, JSON.stringify(data));
    execFileSync(process.execPath, [REPORT, file, ...flags], { stdio: "pipe" });
    return readFileSync(file.replace(".json", flags.includes("--preview") ? "-preview.html" : ".html"), "utf-8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ONE_SITE = "Deze website is niet volledig gescand";
const SEVERAL_SITES = "Niet elke website in dit overzicht is volledig gescand";

test("a capped scan's report says the site was not fully scanned", () => {
  const html = render(scan({ queueCapped: true }));
  assert.ok(html.includes(ONE_SITE));
  assert.equal(html.includes(SEVERAL_SITES), false);
  // Filled in, not left as a placeholder
  assert.equal(html.includes("{{coverageNote}}"), false);
});

test("an uncapped scan's report carries no coverage note", () => {
  for (const data of [scan(), scan({ queueCapped: false })]) {
    const html = render(data);
    assert.equal(html.includes(ONE_SITE), false);
    assert.equal(html.includes(SEVERAL_SITES), false);
    assert.equal(html.includes("{{coverageNote}}"), false);
    // The class is in the stylesheet either way; the paragraph is not in the page
    assert.equal(html.includes('<p class="coverage-note">'), false);
  }
});

test("the preview carries the same note", () => {
  assert.ok(render(scan({ queueCapped: true }), "--preview").includes(ONE_SITE));
  const clean = render(scan(), "--preview");
  assert.equal(clean.includes(ONE_SITE), false);
  assert.equal(clean.includes("{{coverageNote}}"), false);
});

test("a batch summary or a merge across sites does not blame one website", () => {
  // Wrap-up's summary: capped because one of its scans was
  const summary = render(scan({ domain: "Gemeenten test", isSummary: true, queueCapped: true }));
  assert.ok(summary.includes(SEVERAL_SITES));
  assert.equal(summary.includes(ONE_SITE), false);

  // A labelled merge has no isSummary; its pages are on more than one host
  const merged = render(scan({
    domain: "Tilburg",
    queueCapped: true,
    details: [
      { url: "https://www.werkenvoortilburg.nl/vacatures/film", players: [{ name: "YouTube", evidence: [] }] },
      { url: "https://sportintilburg.nl/nieuws/film", players: [{ name: "YouTube", evidence: [] }] },
    ],
  }));
  assert.ok(merged.includes(SEVERAL_SITES));
  assert.equal(merged.includes(ONE_SITE), false);

  // Video on one host only: the other site shows in what was visited
  const videoOnOneHost = scan({
    domain: "Tilburg",
    queueCapped: true,
    details: [{ url: "https://www.werkenvoortilburg.nl/vacatures/film", players: [{ name: "YouTube", evidence: [] }] }],
    _state: { visited: ["https://www.werkenvoortilburg.nl/vacatures/film", "https://sportintilburg.nl/agenda"], queue: [] },
  });
  assert.ok(render(videoOnOneHost).includes(SEVERAL_SITES));
  assert.ok(render(videoOnOneHost, "--preview").includes(SEVERAL_SITES));

  // www and non-www of one site are one website
  const oneSite = render(scan({
    queueCapped: true,
    details: [
      { url: "https://www.gemeente.nl/wonen/film", players: [{ name: "YouTube", evidence: [] }] },
      { url: "https://gemeente.nl/zorg/film", players: [{ name: "YouTube", evidence: [] }] },
    ],
    _state: { visited: ["https://www.gemeente.nl/wonen/film", "https://gemeente.nl/zorg/film", "https://gemeente.nl/"], queue: [] },
  }));
  assert.ok(oneSite.includes(ONE_SITE));
});
