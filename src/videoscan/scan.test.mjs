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

test("Video inside IE downlevel-hidden conditional comment → ignored", () => {
  // asnbank.nl ships an IE ≤9 fallback <video> inside a conditional comment.
  // It never renders in a modern browser, so it must not count as a video page.
  const html = `
    <div class="content">
      <!--[if lt IE 9]>
        <video controls><source src="/fallback.mp4" type="video/mp4"></video>
      <![endif]-->
    </div>`;
  const result = detectFromCorpus(html);
  assert.deepEqual(names(result), []);
});

test("Real video alongside an IE conditional comment → still detected", () => {
  const html = `
    <!--[if lt IE 9]><video src="/ie.mp4"></video><![endif]-->
    <video controls><source src="/real.mp4" type="video/mp4"></video>`;
  const result = detectFromCorpus(html);
  assert.deepEqual(names(result), ["HTML5 native"]);
});

test("Video inside downlevel-revealed conditional (html5-boilerplate) → still detected", () => {
  // `<!--[if gt IE 8]><!-->` closes the comment, so the inner content renders
  // for every non-IE browser. It must NOT be stripped.
  const html = `
    <!--[if gt IE 8]><!-->
      <video controls><source src="/real.mp4" type="video/mp4"></video>
    <!--<![endif]-->`;
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

test("Shadow DOM <video> → HTML5 native (light DOM has no <video>)", () => {
  // page.content() serializes only the light DOM, so the <video> inside a custom
  // element's shadow tree is absent from `html`. extractShadowDomMarkup emits it
  // as a blob appended to the corpus — this is what that blob looks like.
  const html = `<html><body><ing-video></ing-video></body></html>`;
  const shadowBlob =
    `<video controls><source src="/clip.mp4" type="video/mp4"></video>\n` +
    `<!-- shadow host: ing-video -->`;
  const result = detectFromCorpus(html, shadowBlob);
  assert.deepEqual(names(result), ["HTML5 native"]);
});

test("Shadow DOM <iframe> youtube → YouTube via existing patterns", () => {
  const html = `<html><body><my-player></my-player></body></html>`;
  const shadowBlob =
    `<iframe src="https://www.youtube.com/embed/abc123">\n` +
    `<!-- shadow host: my-player -->`;
  const result = detectFromCorpus(html, shadowBlob);
  assert.deepEqual(names(result), ["YouTube"]);
});

test("YouTube share link (youtu.be) is NOT a player — anchor href", () => {
  // youtu.be is a share/watch domain, never an embed src. A plain link to it
  // must not be reported as a YouTube player. stripAnchorHrefs handles anchors…
  const html = `<p>Watch it here: <a href="https://youtu.be/abc123">on YouTube</a></p>`;
  const result = detectFromCorpus(html);
  assert.deepEqual(names(result), []);
});

test("YouTube share link (youtu.be) is NOT a player — bare text / data attr", () => {
  // …and even outside an anchor (plain text, data-*, JSON) it must not match,
  // since the youtu.be pattern was removed entirely.
  const html = `<div data-share-url="https://youtu.be/abc123">see youtu.be/abc123</div>`;
  const result = detectFromCorpus(html);
  assert.deepEqual(names(result), []);
});

test("YouTube embed iframe still detected (guard against over-removal)", () => {
  const html = `<iframe src="https://www.youtube.com/embed/abc123"></iframe>`;
  const result = detectFromCorpus(html);
  assert.deepEqual(names(result), ["YouTube"]);
});

// ── Non-video socials must not annihilate real players ───────────────
// Regression: filterToHighestTier used to run first, so an unconfirmed tier-2
// social embed dropped every lower-tier player, and filterNonVideoSocials then
// removed the social too — reporting NO player on a page that has one.

test("unconfirmed X (Twitter) embed does not hide a real Video.js player", () => {
  const html = `
    <blockquote class="twitter-tweet"><p>just text, no video</p></blockquote>
    <video class="video-js vjs-default-skin"><source src="/a.mp4" type="video/mp4"></video>`;
  const result = detectFromCorpus(html);
  assert.deepEqual(names(result), ["HTML5 native", "Video.js"]);
});

test("unconfirmed Instagram post embed does not hide a real Video.js player", () => {
  const html = `
    <blockquote data-instgrm-permalink="https://www.instagram.com/p/ABC123/"></blockquote>
    <video class="video-js vjs-default-skin"><source src="/a.mp4" type="video/mp4"></video>`;
  const result = detectFromCorpus(html);
  assert.deepEqual(names(result), ["HTML5 native", "Video.js"]);
});

test("unconfirmed social embed alone still yields nothing", () => {
  const html = `<blockquote class="twitter-tweet"><p>just text</p></blockquote>`;
  const result = detectFromCorpus(html);
  assert.deepEqual(names(result), []);
});

test("CONFIRMED social still wins the tier over a lower-tier player", () => {
  // twitter-video confirms real video, so tier 2 legitimately outranks tier 5.
  const html = `
    <blockquote class="twitter-tweet twitter-video"><p>clip</p></blockquote>
    <video class="video-js vjs-default-skin"><source src="/a.mp4" type="video/mp4"></video>`;
  const result = detectFromCorpus(html);
  assert.deepEqual(names(result), ["X (Twitter)"]);
});

test("unconfirmed social does not hide a higher-tier OVP player either", () => {
  const html = `
    <blockquote data-instgrm-permalink="https://www.instagram.com/p/ABC123/"></blockquote>
    <iframe src="https://demo.bbvms.com/p/default/c/1234.json"></iframe>`;
  const result = detectFromCorpus(html);
  assert.deepEqual(names(result), ["Blue Billywig"]);
});

test("Network evidence keeps the matched token when the URL is truncated", () => {
  // Long URL: the region that fires sits past the 80-char cut, so the URL alone
  // carries no trace of it (this is what made the data.oss.nl Video.js false
  // positive undiagnosable from the stored report).
  const url =
    "https://example.nl/sites/default/files/js/js_" +
    "A".repeat(43) +
    ".js?include=xx_vjs-yy";
  const result = detectPlayers("<p>x</p>", [url]);
  const evidence = result.flatMap((r) => r.evidence);
  assert.deepEqual(names(result), ["Video.js"]);
  assert.ok(
    evidence.some((e) => e.includes('matched: "vjs"')),
    `expected the matched token in evidence, got ${JSON.stringify(evidence)}`
  );
  assert.ok(
    evidence.some((e) => e.includes("xx_vjs-yy")),
    `expected a context window around the match, got ${JSON.stringify(evidence)}`
  );
});

test("Network evidence: short URL shows the match, no context window needed", () => {
  const result = detectPlayers("<p>x</p>", ["https://players.brightcove.net/1/x_default/index.min.js"]);
  const evidence = result.flatMap((r) => r.evidence);
  assert.deepEqual(names(result), ["Brightcove"]);
  assert.ok(
    evidence.some((e) => e === 'Network: https://players.brightcove.net/1/x_default/index.min.js [matched: "players.brightcove.net"]'),
    `unexpected evidence: ${JSON.stringify(evidence)}`
  );
});
