// Run: node --test src/videoscan/coverage.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COVERAGE_FLAGS, coverageFlags, isPartialScan } from "./coverage.mjs";

const SCAN = join(dirname(fileURLToPath(import.meta.url)), "scan.mjs");
// scan.mjs launches Playwright's Chromium even when it fetches nothing
const NO_BROWSER = existsSync(chromium.executablePath()) ? false : "Playwright Chromium not installed";

test("coverageFlags keeps the known flags that are true, and nothing else", () => {
  assert.deepEqual(coverageFlags({ queueCapped: true, queueCleared: true, batchId: "b" }), { queueCapped: true, queueCleared: true });
  assert.deepEqual(coverageFlags({ queueCapped: "true", queueCleared: false, stray: true }), {});
  assert.deepEqual(coverageFlags(undefined), {});
  assert.deepEqual(COVERAGE_FLAGS, ["queueCapped", "queueCleared"]);
});

test("isPartialScan: a flag, or links left in the queue", () => {
  assert.equal(isPartialScan({ _state: { visited: [], queue: [] } }), false);
  assert.equal(isPartialScan({ _state: { visited: [], queue: ["https://x.nl/a"] } }), true);
  assert.equal(isPartialScan({ queueCapped: true, _state: { queue: [] } }), true);
  assert.equal(isPartialScan({ queueCleared: true }), true);
  assert.equal(isPartialScan({ queueCleared: false }), false);
});

// The real scan.mjs --resume, end to end: crawlSite reads the flags, returns
// them and generateReport writes them. The stored queue is empty, so the crawl
// starts from the start URL, which is already visited and skipped: nothing is
// fetched (port 9 refuses anyway). It still launches a browser.
async function resume(stored) {
  const dir = mkdtempSync(join(tmpdir(), "videoscan-resume-"));
  try {
    const name = "videoscan-127.0.0.1-2026-10-14T00-00-00.json";
    writeFileSync(join(dir, name), JSON.stringify({
      domain: "127.0.0.1",
      scanDate: "2026-10-14T00:00:00.000Z",
      pagesScanned: 1,
      pagesWithVideo: 0,
      uniquePlayers: 0,
      playerSummary: {},
      details: [],
      batchId: "b1",
      _state: { visited: ["http://127.0.0.1:9/"], queue: [] },
      ...stored,
    }));
    const { stdout } = await promisify(execFile)(process.execPath, [SCAN, "--resume", name, "http://127.0.0.1:9/", "--max-pages", "1", "--no-sitemap"], {
      cwd: dir, encoding: "utf-8", timeout: 120_000,
    });
    assert.match(stdout, new RegExp(`VIDEOSCAN_JSON: ${name.replace(/\./g, "\\.")}`));
    return JSON.parse(readFileSync(join(dir, name), "utf-8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("scan.mjs --resume keeps the coverage flags of the file it resumes", { timeout: 150_000, skip: NO_BROWSER }, async () => {
  const out = await resume({ queueCapped: true, queueCleared: true });
  assert.equal(out.queueCapped, true);
  assert.equal(out.queueCleared, true);
  // The run rewrote the file: not the stored copy read back
  assert.notEqual(out.scanDate, "2026-10-14T00:00:00.000Z");
  assert.equal(out.batchId, "b1");
});

test("scan.mjs --resume of an unflagged file adds no flag", { timeout: 150_000, skip: NO_BROWSER }, async () => {
  const out = await resume({});
  assert.equal("queueCapped" in out, false);
  assert.equal("queueCleared" in out, false);
  assert.notEqual(out.scanDate, "2026-10-14T00:00:00.000Z");
});
