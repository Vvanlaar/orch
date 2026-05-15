import { test } from "node:test";
import assert from "node:assert/strict";
import { detectPlayers, ACTIVATE_SELECTORS } from "./scan.mjs";

const names = (result) => result.map((r) => r.player).sort();

// Mimics the wiring in scanOnePage: pure HTML + the entity-decoded blob from
// extractEncodedMarkup, joined with "\n".
function detectFromCorpus(html, decodedBlob = "", network = []) {
  const corpus = decodedBlob ? html + "\n" + decodedBlob : html;
  return detectPlayers(corpus, network);
}

// Decode a raw data-* attribute value the same way extractEncodedMarkup does
// in the page context, so tests don't need a real DOMParser.
function decodeAttr(encoded) {
  return encoded
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

test("IProX deferred markup → MediaElement.js after entity-decode", () => {
  const encoded =
    "&lt;video class=&quot;media-element&quot; id=&quot;media_container_54135&quot; " +
    "controls=&quot;controls&quot; data-playerlanguage=&quot;nl&quot; " +
    "data-playerfeatures=&quot;playpause,current,progress,duration,tracks," +
    "audioDescription,volume,fullscreen&quot;&gt;" +
    "&lt;source src=&quot;/foo.mp4&quot; type=&quot;video/mp4&quot; /&gt;" +
    "&lt;/video&gt;";
  const html = `
    <div class="media-content mediatype-mp4" data-media-location="lokaal">
      <button class="activate-media">Start video</button>
      <div class="media-container" data-media-markup="${encoded}"></div>
    </div>`;
  const decoded = decodeAttr(encoded);
  const result = detectFromCorpus(html, decoded);
  // Both MediaElement.js (the player) and HTML5 native (the underlying <video>)
  // legitimately match at tier 5 once the attribute is decoded; both surviving
  // the tier filter is expected — what matters is that MediaElement.js is found.
  assert.ok(
    names(result).includes("MediaElement.js"),
    `expected MediaElement.js, got ${JSON.stringify(names(result))}`
  );
});

test("IProX page even without decode — playerfeatures regex fires on raw attr", () => {
  // The encoded data-playerfeatures string itself is enough to fingerprint
  // MediaElement.js; entity-decode just adds belt-and-braces.
  const html = `
    <div data-media-markup='data-playerfeatures="playpause,current,progress,duration,tracks"'></div>`;
  const result = detectFromCorpus(html);
  assert.deepEqual(names(result), ["MediaElement.js"]);
});

test("Plain HTML5 video → HTML5 native", () => {
  const html = `<video controls><source src="/x.mp4" type="video/mp4"></video>`;
  const result = detectFromCorpus(html);
  assert.deepEqual(names(result), ["HTML5 native"]);
});

test("Empty page → no players", () => {
  const result = detectFromCorpus("<html><body></body></html>");
  assert.deepEqual(names(result), []);
});

test("Negative: partial playerfeatures string doesn't match MediaElement.js", () => {
  // Only 'playpause' present — MediaElement regex requires the full prefix
  // up to ',duration' to keep false positives down.
  const html = `<div data-foo="playpause"></div>`;
  const result = detectFromCorpus(html);
  assert.ok(
    !names(result).includes("MediaElement.js"),
    `expected no MediaElement.js match, got ${JSON.stringify(names(result))}`
  );
});

test("ACTIVATE_SELECTORS includes IProX + lite-youtube + aria play patterns", () => {
  const joined = ACTIVATE_SELECTORS.join(" | ");
  assert.match(joined, /button\.activate-media/);
  assert.match(joined, /lite-youtube/);
  assert.match(joined, /aria-label\*="play" i/);
});

test("Tier filter: when IProX (MediaElement.js, T5) co-occurs with YouTube (T2), only YouTube survives", () => {
  // Sanity check: ensures the new MediaElement enrichment doesn't override
  // higher-tier hits on multi-player pages.
  const html = `
    <div data-media-markup='data-playerfeatures="playpause,current,progress,duration"'></div>
    <iframe src="https://www.youtube.com/embed/abc123"></iframe>`;
  const result = detectFromCorpus(html);
  assert.deepEqual(names(result), ["YouTube"]);
});
