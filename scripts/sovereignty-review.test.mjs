// Regressions for scripts/sovereignty-review.mjs. Every case here is a bug the
// tool actually had: each one made a run read better than it was.
import test from "node:test";
import assert from "node:assert";
import { findGaps, gradeKey, gradeMoves, metrics, parseArgs, resolutionRan } from "./sovereignty-review.mjs";

const host = (over = {}) => ({
  firstParty: false,
  phases: { crawl: { requests: 4, pages: 1 }, pre: { requests: 1, pages: 1 }, play: { requests: 2, pages: 1 } },
  types: ["script"],
  players: [],
  chain: [],
  eu: true,
  ...over,
});

const scanWith = (hosts, players = {}) => ({
  domain: "x.nl",
  pagesScanned: 10,
  sovereignty: { consent: { accepted: true, given: true, cookies: 1 }, pages: { crawl: 10, pre: 5, play: 2 }, hosts, players, cookies: [], storage: {} },
});

const site = (players = [], unrated = []) => ({ players, unrated, grade: "C", pagesPerGrade: {} });
const rated = (player, grade = "C") => ({ player, grade, rated: true, pages: 1 });

// ── resolution failure vs. table gaps ────────────────────────────────

test("resolutionRan: a scan where resolveHosts failed has no chain on any host", () => {
  assert.equal(resolutionRan([]), true, "no hosts at all is not a failure");
  assert.equal(resolutionRan([["a.nl", host()]]), true);
  assert.equal(resolutionRan([["a.nl", { ...host(), chain: undefined }]]), true, "an explicit undefined chain is still the key");
  const noChain = { ...host() };
  delete noChain.chain;
  assert.equal(resolutionRan([["a.nl", noChain]]), false);
});

test("findGaps: a whole-scan resolution failure is not reported as operators.json gaps", () => {
  const noChain = { ...host({ eu: null }) };
  delete noChain.chain;
  const gaps = findGaps(scanWith({ "youtube.com": noChain }), site(), new Map());
  // The hosts still land in the list, but `resolved` tells the caller not to
  // print it as a table gap — operators.json is not the fix for this run.
  assert.equal(gaps.resolved, false);
});

// ── counting ─────────────────────────────────────────────────────────

test("findGaps: first-party and zero-request hosts are left out of every list", () => {
  const gaps = findGaps(scanWith({
    "x.nl": host({ firstParty: true, eu: null }),
    "idle.nl": host({ eu: null, phases: { crawl: { requests: 0, pages: 0 }, pre: { requests: 0, pages: 0 }, play: { requests: 0, pages: 0 } } }),
    "real.nl": host({ eu: null }),
  }), site(), new Map());
  assert.deepEqual(gaps.unresolved.map((u) => u.host), ["real.nl"]);
  assert.equal(gaps.thirdParty, 1, "the host total counts the same set as the gap lists");
});

test("metrics: unresolvedRequestShare over zero third-party requests is 0, not NaN", () => {
  const gaps = findGaps(scanWith({}), site(), new Map());
  const m = metrics("f.json", scanWith({}), site(), gaps);
  assert.equal(m.unresolvedRequestShare, 0);
});

test("findGaps: a player with no play pages is listed, one with play pages is not", () => {
  const players = { P: { pages: { crawl: 2, pre: 1, play: 0 }, hosts: [] }, Q: { pages: { crawl: 2, pre: 1, play: 1 }, hosts: [] } };
  const gaps = findGaps(scanWith({}, players), site([rated("P"), rated("Q")]), new Map());
  assert.deepEqual(gaps.noPlay, ["P"]);
});

test("findGaps: unsampled comes from the measurement, so an unmeasured player is not listed", () => {
  const measured = new Map([["P", { sampled: false }], ["Q", { sampled: true }], ["R", null]]);
  const gaps = findGaps(scanWith({}), site([rated("P"), rated("Q"), rated("R")]), measured);
  assert.deepEqual(gaps.unsampled, ["P"]);
});

// ── the flake detector ───────────────────────────────────────────────

test("gradeKey: key order follows page counts, which reorder between crawls", () => {
  assert.equal(gradeKey({ YouTube: "E", Vimeo: "E" }), gradeKey({ Vimeo: "E", YouTube: "E" }));
  assert.notEqual(gradeKey({ YouTube: "E" }), gradeKey({ YouTube: "D" }));
  assert.equal(gradeKey(null), "");
});

test("gradeMoves: names the player that moved, and what it moved to", () => {
  assert.deepEqual(gradeMoves({ A: "B" }, { A: "C" }), ["A B→C"]);
  assert.deepEqual(gradeMoves({ A: "B" }, { A: "B" }), []);
  assert.deepEqual(gradeMoves({ A: "B" }, { A: "B", N: "E" }), ["N —→E"]);
  assert.deepEqual(gradeMoves({ G: "A" }, {}), ["G A→—"]);
});

// ── args ─────────────────────────────────────────────────────────────

test("parseArgs: --log without a path is an error, not a silent default", () => {
  assert.throws(() => parseArgs(["scan.json", "--log"]), /--log needs a path/);
  assert.throws(() => parseArgs(["--nope"]), /unknown flag/);
  assert.deepEqual(parseArgs(["a.json", "--log", "l.jsonl", "b.json"]), { files: ["a.json", "b.json"], log: "l.jsonl", trend: false });
  assert.equal(parseArgs(["--trend"]).trend, true);
});
