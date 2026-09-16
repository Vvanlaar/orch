import { test } from "node:test";
import assert from "node:assert/strict";
import { detectPlayers, ACTIVATE_SELECTORS, isCrawlerTrap, shouldSkipUrl, normalizeUrl } from "./scan.mjs";

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
  // The filler length is tuned so "vjs" lands past the 80-char URL cut; if
  // that cut ever changes, lengthen it or this stops testing truncation.
  const url =
    "https://example.nl/sites/default/files/js/js_" +
    "A".repeat(43) +
    ".js?include=xx_vjs-yy";
  const result = detectPlayers("<p>x</p>", [url]);
  const evidence = result.flatMap((r) => r.evidence);
  assert.deepEqual(names(result), ["Video.js"]);
  assert.ok(
    evidence.some((e) => e.startsWith(`Network: ${url.slice(0, 80)}…`)),
    `expected the URL capped at 80 chars and marked as cut, got ${JSON.stringify(evidence)}`
  );
  assert.ok(
    // The anchored `scripts` pattern requires a boundary char around "vjs"
    // (see DETECTORS["Video.js"]), so the reported token is "_vjs-", not bare "vjs".
    evidence.some((e) => e.includes('matched: "_vjs-"')),
    `expected the matched token in evidence, got ${JSON.stringify(evidence)}`
  );
  assert.ok(
    evidence.some((e) => e.includes("xx_vjs-yy")),
    `expected a context window around the match, got ${JSON.stringify(evidence)}`
  );
});

test("Network evidence: short URL shows the match, no context window needed", () => {
  // URL fits inside the cut, so no ellipsis anywhere and no redundant window.
  const result = detectPlayers("<p>x</p>", ["https://players.brightcove.net/1/x_default/index.min.js"]);
  const evidence = result.flatMap((r) => r.evidence);
  assert.deepEqual(names(result), ["Brightcove"]);
  assert.ok(
    evidence.some((e) => e === 'Network: https://players.brightcove.net/1/x_default/index.min.js [matched: "players.brightcove.net"]'),
    `unexpected evidence: ${JSON.stringify(evidence)}`
  );
});

test("Network evidence: a match straddling the 80-char cut still gets a window", () => {
  // Starts before the cut, ends after it — the branch keys off the match END
  // for exactly this case; keying off match.index would drop the window and
  // leave the evidence showing only the first half of what fired.
  const url = "https://example.com/" + "b".repeat(56) + "video.js?x=1";
  const result = detectPlayers("<p>x</p>", [url]);
  const evidence = result.flatMap((r) => r.evidence);
  assert.deepEqual(names(result), ["Video.js"]);
  assert.ok(
    evidence.some((e) => e.includes('matched: "video.js" in "…') && e.includes("video.js?x=1")),
    `expected a context window spanning the cut, got ${JSON.stringify(evidence)}`
  );
});


test("Generic data-video-id wrapper is NOT Brightcove (tier-1 suppression)", () => {
  // data-video-id is a generic attribute used by many CMSes and embed wrappers.
  // Brightcove is tier 1, so matching it bare suppressed the real YouTube hit
  // at tier 2 and misattributed the page.
  const html = `
    <div class="video-embed" data-video-id="dQw4w9WgXcQ"></div>
    <iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>`;
  const result = detectFromCorpus(html);
  assert.deepEqual(names(result), ["YouTube"]);
});

test("Generic data-account + data-video-id wrapper is NOT Brightcove", () => {
  // data-account is generic too (analytics/CMS wrappers carry one), so pairing
  // it with data-video-id would reproduce the same tier-1 suppression. Only
  // data-account + data-player is Brightcove-specific.
  const html = `
    <div data-account="GA-123" data-video-id="abc"></div>
    <iframe src="https://www.youtube.com/embed/abc"></iframe>`;
  const result = detectFromCorpus(html);
  assert.deepEqual(names(result), ["YouTube"]);
});

test("Bare data-video-id with no other player evidence → no players", () => {
  const html = `<div class="embed" data-video-id="12345"></div>`;
  const result = detectFromCorpus(html);
  assert.deepEqual(names(result), []);
});

test("Brightcove attrs split across sibling elements → not Brightcove", () => {
  // The pattern uses [^>]*, not .*, so the pair must live inside one tag.
  const html = `<div data-account="ga-123"></div><div data-player="x"></div>`;
  const result = detectFromCorpus(html);
  assert.deepEqual(names(result), []);
});

test("Real Brightcove in-page embed still detected (data-account + data-player)", () => {
  const html = `
    <video-js data-account="1234567890" data-player="default" data-embed="default"
      data-video-id="6301234567001" controls></video-js>`;
  const result = detectFromCorpus(html);
  assert.deepEqual(names(result), ["Brightcove"]);
});

test("Brightcove attrs in reverse order still detected", () => {
  const html = `<video-js data-player="default" data-account="1234567890"></video-js>`;
  const result = detectFromCorpus(html);
  assert.deepEqual(names(result), ["Brightcove"]);
});

test("Brightcove script alone still detected (no data attrs)", () => {
  const html = `<video-js controls></video-js>
    <script src="https://players.brightcove.net/1234567890/default_default/index.min.js"></script>`;
  const result = detectFromCorpus(html);
  assert.deepEqual(names(result), ["Brightcove"]);
});

// --- Video.js: Drupal aggregated-JS false positive (data.oss.nl, 29/29 pages) ---
// The real bundle URL that produced the false positive. Drupal appends an
// urlsafe-base64 `include=` blob listing the aggregated libraries; the blob
// happens to contain "vjS", which bare /vjs/i matched.
const DRUPAL_AGG_URL =
  "https://data.oss.nl/sites/default/files/js/js_YZ5G-oqjDb8uFMrQh1rQ3-MOiDZUsYPqPbnGqosXgaU.js" +
  "?scope=footer&delta=0&language=nl&theme=portals&include=eJxNjmEKwzAIhS80CexCxSSyhToNaqG9_WrHoL_U" +
  "9z2f7pMsnJhalKkWyA7ebMzwx35jv_IEHtXQDkB3SosvHQPPvjSdB_ThYaNuMVQuqMJLU5HMyAFYdd1mshcJGXLB_hkCpylM" +
  "-Yp0QmtvrEy5GyR5PyWorG39P_gFl7ZKeg";

test("Drupal aggregated-JS bundle is NOT Video.js — network evidence", () => {
  // The bundle URL is byte-identical on every page of the site, so a collision
  // here flags 100% of pages, not a stray one.
  const result = detectFromCorpus("<p>Dataset page, no video.</p>", "", [DRUPAL_AGG_URL]);
  assert.deepEqual(names(result), []);
});

test("Drupal aggregated-JS bundle is NOT Video.js — same URL in HTML markup", () => {
  // Same blob reached the `patterns` array too, via the <script src> in the HTML
  // corpus. `_vjs-` / `-vjs-` can occur in urlsafe-base64, so the HTML anchor
  // excludes `_` and `-`.
  const html = `<script src="${DRUPAL_AGG_URL}"></script>`;
  const result = detectFromCorpus(html);
  assert.deepEqual(names(result), []);
});

test("Synthetic urlsafe-base64 blobs with vjs- inside do not match", () => {
  for (const blob of ["aa_vjs-bb", "aa-vjs-bb", "XvjS-Y"]) {
    const html = `<script src="/sites/default/files/js/js_a.js?include=${blob}"></script>`;
    assert.deepEqual(names(detectFromCorpus(html)), [], `blob ${blob} should not match`);
  }
});

test("Real Video.js CDN script still detected (guard against over-narrowing)", () => {
  // vjs.zencdn.net is the only shape the `vjs` pattern is load-bearing for.
  const result = detectFromCorpus("<p>x</p>", "", ["https://vjs.zencdn.net/8.10.0/video.min.js"]);
  assert.deepEqual(names(result), ["Video.js"]);
});

test("Real Video.js markup still detected — vjs- skin classes", () => {
  const html = `<video class="video-js vjs-default-skin" controls><source src="/a.mp4"></video>`;
  // HTML5 native rides along: a real <video> tag matches it too, and both sit in
  // tier 5 so filterToHighestTier keeps the pair.
  assert.deepEqual(names(detectFromCorpus(html)), ["HTML5 native", "Video.js"]);
});

test("Real Video.js markup still detected — quoted vjs- class alone", () => {
  const html = `<div class="vjs-poster"></div>`;
  assert.deepEqual(names(detectFromCorpus(html)), ["Video.js"]);
});

// ── Crawler traps ───────────────────────────────────────────────────
// Thresholds here were measured against the 573,359 URLs in this repo's scan
// history; the fixtures below are real URLs from those files.

test("crawler trap: repeated path segments are rejected", () => {
  const trap =
    "https://waardwijzer.krimpenerwaard.nl/is/product/154586/220638/" +
    "www.chrisvoorkom.nl/docs.google.com/forms/d/1MDX/www.chrisvoorkom.nl/" +
    "docs.google.com/forms/d/1MDX/www.chrisvoorkom.nl/aanbod";
  assert.equal(isCrawlerTrap(trap), true);
  assert.equal(shouldSkipUrl(trap), true);
});

test("crawler trap: excessive path depth is rejected", () => {
  const deep = "https://example.nl/" + Array.from({ length: 13 }, (_, i) => `s${i}`).join("/");
  assert.equal(isCrawlerTrap(deep), true);
});

test("crawler trap: the deepest real page in scan history is kept", () => {
  // 10 segments — rijksmuseum.nl, deepest genuine page across 573k URLs.
  const real =
    "https://www.rijksmuseum.nl/nl/onderwijs/voortgezet-onderwijs/havo-vwo/" +
    "talentprogrammas/docnljr/pop-up-doc-nl-jr/joel/story/joel-pop-up-tentoonstelling";
  assert.equal(new URL(real).pathname.split("/").filter(Boolean).length, 10);
  assert.equal(isCrawlerTrap(real), false);
  assert.equal(shouldSkipUrl(real), false);
});

test("crawler trap: a segment repeating 3x is real traffic, not a trap", () => {
  // Measured: 8 real URLs repeat a segment 3x; none repeat one 4x.
  const real = "https://example.nl/nieuws/archief/nieuws/2024/nieuws";
  assert.equal(isCrawlerTrap(real), false);
});

test("crawler trap: a malformed URL is not treated as a trap", () => {
  assert.equal(isCrawlerTrap("not-a-url"), false);
});

// ── normalizeUrl query canonicalization ─────────────────────────────

test("normalizeUrl drops a verbatim-repeated parameter", () => {
  // size=6 appears twice identically; from= carries two real values and stays.
  const got = normalizeUrl(
    "https://waardwijzer.krimpenerwaard.nl/is/producten?view=list&size=6&from=162&size=6&from=150",
    "https://waardwijzer.krimpenerwaard.nl/",
  );
  assert.equal(
    got,
    "https://waardwijzer.krimpenerwaard.nl/is/producten?view=list&size=6&from=162&from=150",
  );
});

test("normalizeUrl keeps multi-value facets intact", () => {
  // 4,429 real URLs in this repo's scan history repeat a key with DIFFERENT
  // values; ?filter=a&filter=b is a different result set than ?filter=b, so
  // collapsing by key would silently halve every faceted listing.
  const url = "https://www.rijksmuseum.nl/nl/zien-en-doen?filter=toegankelijkheid&filter=tentoonstellingen";
  assert.equal(normalizeUrl(url, "https://www.rijksmuseum.nl/"), url);
});

test("normalizeUrl does not re-encode parameters it did not touch", () => {
  // Rebuilding the query via URLSearchParams would turn %20 into + on b.
  assert.equal(
    normalizeUrl("https://example.nl/z?a=1&b=x%20y&a=1", "https://example.nl/"),
    "https://example.nl/z?a=1&b=x%20y",
  );
});

test("crawler trap: a query key stacked past real multi-value use is rejected", () => {
  // No real URL repeats a key more than twice; the paginator trap grows past it.
  assert.equal(isCrawlerTrap("https://example.nl/p?from=1&from=2"), false);
  assert.equal(isCrawlerTrap("https://example.nl/p?from=1&from=2&from=3"), true);
});

test("normalizeUrl collapses a CMS param re-appended to itself", () => {
  const got = normalizeUrl(
    "https://www.kunstmuseum.nl/nl/collectie/aan-den-arbeid?origin=gm&origin=gm",
    "https://www.kunstmuseum.nl/",
  );
  assert.equal(got, "https://www.kunstmuseum.nl/nl/collectie/aan-den-arbeid?origin=gm");
});

test("normalizeUrl leaves a URL without repeated keys byte-identical", () => {
  const url = "https://example.nl/zoek?q=video%20speler&page=2&sort=date";
  assert.equal(normalizeUrl(url, "https://example.nl/"), url);
});

test("normalizeUrl still strips hash and trailing slash", () => {
  assert.equal(normalizeUrl("https://example.nl/pad/#sectie", "https://example.nl/"), "https://example.nl/pad");
});

test("resume restore: trap URLs are filtered, real pagination survives", () => {
  // The restore pipeline from the --resume branch, run over a queue shaped like
  // the real one: deep repeated-segment traps plus ?from= re-appended per link.
  const start = "https://waardwijzer.krimpenerwaard.nl/";
  const stored = [
    "https://waardwijzer.krimpenerwaard.nl/is/product/154586/a/b/a/b/a/b/a/b/a/b/aanbod",
    "https://waardwijzer.krimpenerwaard.nl/is/producten?view=list&from=162&from=150",
    "https://waardwijzer.krimpenerwaard.nl/is/producten?view=list&from=99&from=150",
    "https://waardwijzer.krimpenerwaard.nl/is/organisaties?size=12&from=372",
  ];
  const restored = [
    ...new Set(stored.map((u) => normalizeUrl(u, start)).filter((u) => u && !shouldSkipUrl(u))),
  ];
  assert.deepEqual(restored, [
    // Real from= values are preserved; only trap output is dropped.
    "https://waardwijzer.krimpenerwaard.nl/is/producten?view=list&from=162&from=150",
    "https://waardwijzer.krimpenerwaard.nl/is/producten?view=list&from=99&from=150",
    "https://waardwijzer.krimpenerwaard.nl/is/organisaties?size=12&from=372",
  ]);
});

// ── Company Webcast / iBabs (bestuurlijkeinformatie.nl meeting portals) ──

test("iBabs stream embed detected from the markup marker alone", () => {
  // No data-video-url here on purpose: with the player host present the host
  // pattern carries the test and the marker regex could be deleted unnoticed.
  const html = `
    <div class="cwc" data-video-type="iBabsStream" data-video-id="b49a8b6d"
      data-language="nl"></div>`;
  const result = detectFromCorpus(html);
  assert.deepEqual(names(result), ["iBabs"]);
});

test("iBabs stream embed detected from the player URL alone", () => {
  const html = `<div class="cwc" data-video-url="https://player.ibabs.eu/0efe653a"></div>`;
  const result = detectFromCorpus(html);
  assert.deepEqual(names(result), ["iBabs"]);
});

test("iBabs detected from the player host in network traffic", () => {
  const result = detectPlayers("<p>x</p>", [
    "https://player.ibabs.eu/0efe653a-55f4-4db3-a26f-d2b7a0968c18",
    "https://vod.babscast.com/hls/2026/9/9/0efe653a/video.mp4/master.m3u8",
  ]);
  assert.deepEqual(names(result), ["iBabs"]);
});

test("iBabs branding alone is NOT a video (whole-site false positive)", () => {
  // bestuurlijkeinformatie.nl is iBabs-built: every page carries these, video
  // or not. A bare /ibabs/i token flagged all 3253 pages of the Krimpenerwaard
  // site, and at tier 1 it would suppress every real player found alongside.
  const html = `
    <link rel="icon" href="/Images/icons/ibabs/favicon-32x32.png">
    <footer><a href="//www.ibabs.com">iBabs</a>
      <a href="//portal.ibabs.eu/">Portal</a></footer>`;
  const result = detectFromCorpus(html);
  assert.deepEqual(names(result), []);
});

test("Company Webcast embed detected from the marker alone", () => {
  // The SDK <script> is omitted on purpose: were it present it would satisfy
  // the host pattern by itself, and the marker regex could be deleted without
  // failing a test. A Cwc slot carries an empty data-video-url, so if the SDK
  // ever moves into a bundle the marker is the only in-page signal left.
  const html = `<div class="cwc" data-video-type="Cwc" data-video-id="gemeente/20260303_3"
      data-video-url=""></div>`;
  const result = detectFromCorpus(html);
  assert.deepEqual(names(result), ["Company Webcast"]);
});

test("Company Webcast detected from the SDK script alone", () => {
  const html = `<div class="cwc"></div>
    <script src="//sdk.companywebcast.com/sdk/player/client.js"></script>`;
  const result = detectFromCorpus(html);
  assert.deepEqual(names(result), ["Company Webcast"]);
});

test("Company Webcast poster on an iBabs page is NOT a second player", () => {
  // The iBabs player pulls its poster from sdk.companywebcast.com/customers/…,
  // so a bare host match would report both providers for one video. Only the
  // /sdk/ path and player.companywebcast.com count.
  const result = detectPlayers(
    `<div class="cwc" data-video-type="iBabsStream" data-video-url="https://player.ibabs.eu/x"></div>`,
    [
      "https://player.ibabs.eu/x",
      "https://sdk.companywebcast.com/customers/gemeente/poster/poster-original.jpg",
    ]
  );
  assert.deepEqual(names(result), ["iBabs"]);
});

test("Empty meeting page with no data-video-type → no players", () => {
  // The 2 of 49 pages whose agenda item carries no video slot at all.
  const html = `<div class="box-content"><h2>Agendapunten</h2><ol><li>Opening</li></ol></div>`;
  const result = detectFromCorpus(html);
  assert.deepEqual(names(result), []);
});
