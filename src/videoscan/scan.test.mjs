import { test } from "node:test";
import assert from "node:assert/strict";
import { detectPlayers, ACTIVATE_SELECTORS, isCrawlerTrap, shouldSkipUrl, normalizeUrl, reprioritizeQueue, orderQueue, urlSection, rebalanceQueue, spreadPick, orderSitemaps, discoverSitemapUrls, recordSubresource } from "./scan.mjs";

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
    <iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>`;
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
    `<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ">\n` +
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

test("YouTube strings in tracking code, cookie banners and footer icons are NOT a player", () => {
  // stadsarchief.breda.nl: GTM's inlined YouTube trigger + a footer channel icon
  const gtm = `<script>(function(m){var a=m.createElement("script");a.src="//www.youtube.com/iframe_api";
    function u(a){a=a.src||"";return a.indexOf("youtube.com/embed/")>-1||a.indexOf("youtube-nocookie.com/embed/")>-1}})(document)</script>
    <li class="youtube-li"><span>YouTube</span></li>`;
  assert.deepEqual(names(detectFromCorpus(gtm)), []);
  // werkenindeleidseregio.nl: the cookie banner lists the API as a vendor
  const banner = `<div class="cookie-list__vendor__platform__li__name">https://www.youtube.com/iframe_api</div>`;
  assert.deepEqual(names(detectFromCorpus(banner)), []);
});

test("YouTube embeds with a video id still detected, consent-gated and playlist ones too", () => {
  const consent = `<div class="youtube-responsive consent-ce no-consent">
    <iframe class="consent-ce--iframe" src="https://www.youtube-nocookie.com/embed/LssNqQcxhz8?iv_load_policy=1"></iframe></div>`;
  assert.deepEqual(names(detectFromCorpus(consent)), ["YouTube"]);
  const playlist = `<iframe src="https://www.youtube.com/embed/videoseries?list=PL123"></iframe>`;
  assert.deepEqual(names(detectFromCorpus(playlist)), ["YouTube"]);
});

test("self-hosted Flowplayer library with no player is NOT Flowplayer (and doesn't hide YouTube)", () => {
  // GemeenteOplossingen council template: loads the library on every page
  const html = `<link href="/flowplayer/skin/skin.css" rel="stylesheet">
    <script src="/flowplayer/flowplayer.min.js?v=352f703e"></script>
    <iframe src="https://www.youtube-nocookie.com/embed/1cpBCq4gK7Y"></iframe>`;
  const network = ["https://gemeenteraad.haarlemmermeer.nl/flowplayer/flowplayer.min.js?v=352f703e"];
  assert.deepEqual(names(detectFromCorpus(html, "", network)), ["YouTube"]);
});

test("Flowplayer still detected on a real player: container markup or its CDN", () => {
  const selfHosted = `<div class="flowplayer is-splash" data-ratio="0.5625"><video><source src="/a.m3u8"></video></div>`;
  assert.ok(names(detectFromCorpus(selfHosted)).includes("Flowplayer"));
  const cdn = ["https://cdn.flowplayer.com/releases/native/3/stable/flowplayer.min.js"];
  assert.ok(names(detectFromCorpus("<div id='player'></div>", "", cdn)).includes("Flowplayer"));
});

test("YouTube embed iframe still detected (guard against over-removal)", () => {
  const html = `<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>`;
  const result = detectFromCorpus(html);
  assert.deepEqual(names(result), ["YouTube"]);
});

test("Vimeo share link (vimeo.com/<id>) is NOT a player", () => {
  // Same trap as youtu.be: a raadsinformatie meeting page carried the recording
  // URL in escaped body text, with no player anywhere on it.
  const html = `<p>Bekijk de opname: &lt;a href="https://vimeo.com/461441500/bfcbfb5945"&gt;link&lt;/a&gt;</p>`;
  const result = detectFromCorpus(html);
  assert.deepEqual(names(result), []);
});

test("Vimeo embed iframe still detected (guard against over-removal)", () => {
  const html = `<iframe src="https://player.vimeo.com/video/461441500"></iframe>`;
  const result = detectFromCorpus(html);
  assert.deepEqual(names(result), ["Vimeo"]);
});

test("zoekwidget is NOT Kaltura", () => {
  // /kWidget/i matched inside "zoekwidget1.php" — an unrelated Netwerk
  // Oorlogsbronnen search widget — and flagged news pages with no video.
  const html = `<iframe src="http://www.netwerkoorlogsbronnen.nl/publications/zoekwidget1.php"></iframe>`;
  const result = detectFromCorpus(html);
  assert.deepEqual(names(result), []);
});

test("a lowercase kwidget.embed is NOT Kaltura (case lock)", () => {
  // The word boundary alone would accept this; only case-sensitivity rejects it.
  // Restoring the /i flag must turn this test red.
  const html = `<script src="/js/kwidget.min.js"></script><script>kwidget.embed({});</script>`;
  const result = detectFromCorpus(html);
  assert.deepEqual(names(result), []);
});

test("a kWidget mention without an API call is NOT Kaltura", () => {
  // Deliberate: the dot is what makes it embed code rather than a stray
  // identifier, so a feature test on its own is not evidence of a player.
  const html = `<script>if (typeof kWidget === "undefined") { warn(); }</script>`;
  const result = detectFromCorpus(html);
  assert.deepEqual(names(result), []);
});

test("Kaltura kWidget.embed still detected", () => {
  const html = `<div id="kaltura_player"></div><script>kWidget.embed({targetId: "kaltura_player", wid: "_1234"});</script>`;
  const result = detectFromCorpus(html);
  assert.deepEqual(names(result), ["Kaltura"]);
});

test("Vimeo embed path still detected (guard against over-removal)", () => {
  // No data-vimeo-* here: that pattern matches on its own and would keep this
  // green even if the vimeo.com/video path pattern were deleted.
  const html = `<iframe src="https://vimeo.com/video/461441500"></iframe>`;
  const result = detectFromCorpus(html);
  assert.deepEqual(names(result), ["Vimeo"]);
});

test("Vimeo event/showcase embed is a player, a bare event link is not", () => {
  const embed = `<iframe src="https://vimeo.com/event/1234567/embed/abcdef"></iframe>`;
  assert.deepEqual(names(detectFromCorpus(embed)), ["Vimeo"]);
  const showcase = `<iframe src="https://vimeo.com/showcase/7654321/embed"></iframe>`;
  assert.deepEqual(names(detectFromCorpus(showcase)), ["Vimeo"]);
  const link = `<p>Kijk live mee: &lt;a href="https://vimeo.com/event/1234567"&gt;link&lt;/a&gt;</p>`;
  assert.deepEqual(names(detectFromCorpus(link)), []);
  // The match may not run across markup to reach a later /embed.
  const spanning = `<a href=x>vimeo.com/event/1234567</a><b>/embed</b>`;
  assert.deepEqual(names(detectFromCorpus(spanning)), []);
});

test("Kaltura kWidget.addReadyCallback still detected (self-hosted, no kaltura.com)", () => {
  const html = `<div id="kaltura_player"></div><script>kWidget.addReadyCallback(function (id) {});</script>`;
  const result = detectFromCorpus(html);
  assert.deepEqual(names(result), ["Kaltura"]);
});

test("a word ending in kWidget is NOT Kaltura (word boundary)", () => {
  assert.deepEqual(names(detectFromCorpus(`<script>zoekWidget.embed({});</script>`)), []);
  assert.deepEqual(names(detectFromCorpus(`<script>mijnkWidget.embed();</script>`)), []);
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
  // The token sits in the path: `scripts` patterns never see the query string.
  const url =
    "https://example.nl/sites/default/files/js/js_" +
    "A".repeat(43) +
    "/xx_vjs-yy.js?v=1";
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
  const url = "https://example.com/" + "b".repeat(55) + "/video.js?x=1";
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
    <iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>`;
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

test("reprioritizeQueue survives a queue past V8's spread-argument limit", () => {
  // 124k–125k queued URLs overflowed the stack when the queue was spread into
  // splice(); sportintilburg, leerplicht… and werkenvoortilburg all died there.
  const queue = Array.from({ length: 200_000 }, (_, i) => `https://example.nl/page/${i}`);
  queue.push("https://example.nl/video/intro");
  assert.doesNotThrow(() => reprioritizeQueue(queue));
  assert.equal(queue.length, 200_001);
  assert.equal(new Set(queue).size, 200_001);
});

test("rebalanceQueue keeps rate-limited URLs in front of the re-sorted queue", () => {
  const visited = Array.from({ length: 50 }, (_, i) => `https://gemeente.nl/wonen/oud-${i}`);
  const queue = [
    ...Array.from({ length: 10 }, (_, i) => `https://gemeente.nl/zorg/pagina-${i}`),
    "https://gemeente.nl/wonen/pagina-1",
  ];
  // wonen is far ahead on pages scanned, so the sort alone would put it last
  const retryNext = ["https://gemeente.nl/wonen/retry"];
  rebalanceQueue(queue, visited, retryNext);
  assert.equal(queue[0], "https://gemeente.nl/wonen/retry");
  assert.equal(queue.length, 12);
  assert.deepEqual(retryNext, []);
});

test("orderQueue gives every section a share instead of draining the news archive first", () => {
  const news = Array.from({ length: 5000 }, (_, i) => `https://gemeente.nl/nieuws/bericht-${i}`);
  const other = ["wonen", "zorg", "werk", "afval", "parkeren"].flatMap((s) =>
    Array.from({ length: 50 }, (_, i) => `https://gemeente.nl/${s}/pagina-${i}`),
  );
  const first100 = orderQueue([...news, ...other]).slice(0, 100);
  const bySection = Object.groupBy(first100, (u) => urlSection(u).section);
  // Five sections at weight 1, nieuws at weight 2 (video-likely): 100 / 7 ≈ 14 each
  for (const s of ["wonen", "zorg", "werk", "afval", "parkeren"]) assert.ok(bySection[s].length >= 13, s);
  assert.ok(bySection.nieuws.length <= 30);
  // A sample of the archive, not its first 28 items
  assert.ok(bySection.nieuws.some((u) => Number(u.split("-").pop()) > 1000));
});

test("orderQueue favours sections that are behind on pages already scanned", () => {
  const visited = Array.from({ length: 40 }, (_, i) => `https://gemeente.nl/wonen/oud-${i}`);
  const queue = [
    ...Array.from({ length: 20 }, (_, i) => `https://gemeente.nl/wonen/pagina-${i}`),
    ...Array.from({ length: 20 }, (_, i) => `https://gemeente.nl/zorg/pagina-${i}`),
  ];
  assert.ok(orderQueue(queue, visited).slice(0, 20).every((u) => u.includes("/zorg/")));
});

test("orderQueue puts hub pages before deep pages and ignores arrival order", () => {
  const queue = ["https://gemeente.nl/wonen/a/b/c", "https://gemeente.nl/wonen/a", "https://gemeente.nl/wonen/a/b"];
  assert.deepEqual(orderQueue(queue).map((u) => urlSection(u).depth), [2, 3, 4]);
  // Same depth, so only the hash decides: the order must not follow arrival
  const flat = Array.from({ length: 50 }, (_, i) => `https://gemeente.nl/wonen/pagina-${i}`);
  assert.deepEqual(orderQueue([...flat].reverse()), orderQueue(flat));
  assert.notDeepEqual(orderQueue(flat), flat);
});

test("orderQueue weighs the path, not the host", () => {
  // Every URL on this host contains "media"; a host match would weigh them all
  const queue = ["https://media.gemeente.nl/wonen/a", "https://media.gemeente.nl/zorg/video-a"];
  assert.equal(orderQueue(queue)[0], "https://media.gemeente.nl/zorg/video-a");
});

test("urlSection skips a language prefix and files top-level pages under root", () => {
  assert.equal(urlSection("https://x.nl/nl/wonen/huur").section, "wonen");
  assert.equal(urlSection("https://x.nl/contact").section, "");
  assert.equal(urlSection("https://x.nl/").section, "");
});

test("spreadPick samples across the whole list and every prefix stays spread", () => {
  const list = Array.from({ length: 1000 }, (_, i) => i);
  assert.deepEqual(spreadPick(list, 4), [0, 500, 250, 750]);
  const all = spreadPick(list, 1000);
  assert.equal(new Set(all).size, 1000);
  assert.deepEqual(spreadPick(["a", "b", "c"], 10), ["a", "b", "c"]);
});

test("orderSitemaps puts the lone page sitemap next to a 60-part archive up front", () => {
  const posts = Array.from({ length: 60 }, (_, i) => `https://x.nl/post-sitemap${i + 1}.xml`);
  const { ordered, kinds } = orderSitemaps([...posts, "https://x.nl/page-sitemap.xml"]);
  assert.equal(kinds, 2);
  assert.ok(ordered.slice(0, 2).includes("https://x.nl/page-sitemap.xml"));
  assert.equal(new Set(ordered).size, 61);
});

test("orderSitemaps files TYPO3 children by sitemap type, not by cHash", () => {
  const typo3 = (q, hash) => `https://x.nl/sitemap.xml?${q}&cHash=${hash}`;
  const { kinds } = orderSitemaps([
    typo3("sitemap=pages", "ac1865cfaf92b9d876e50ceeca1f137c"),
    typo3("page=1&sitemap=pages", "be6861e0d33b46b9bafd96ebd84714d1"),
    typo3("page=2&sitemap=pages", "0d33b46b9bafd96ebd84714d1be6861e"),
    typo3("sitemap=news", "c89354b8445ab53b9b3715786866eb03"),
  ]);
  // pages, page=N&pages, news: the parts of one type and the cHash add no kinds
  assert.equal(kinds, 3);
});

test("discoverSitemapUrls shares the cap round-robin across urlsets", async (t) => {
  const urlset = (n, path) =>
    `<urlset>${Array.from({ length: n }, (_, i) => `<loc>https://x.nl/${path}/p-${i}</loc>`).join("")}</urlset>`;
  const bodies = {
    "https://x.nl/robots.txt": "Sitemap: https://x.nl/index.xml",
    "https://x.nl/index.xml":
      "<sitemapindex><loc>https://x.nl/nieuws.xml</loc><loc>https://x.nl/agenda.xml</loc><loc>https://x.nl/wonen.xml</loc><loc>https://x.nl/leeg.xml</loc></sitemapindex>",
    "https://x.nl/nieuws.xml": urlset(500, "nieuws"),
    "https://x.nl/agenda.xml": urlset(500, "agenda"),
    "https://x.nl/wonen.xml": urlset(20, "wonen"),
  };
  t.mock.method(globalThis, "fetch", async (url) =>
    url in bodies ? new Response(bodies[url]) : new Response("", { status: 404 }),
  );
  const urls = await discoverSitemapUrls("https://x.nl/", "x.nl", { maxUrls: 90 });
  // wonen can use only 20 and leeg nothing, so nieuws and agenda split the rest
  assert.equal(urls.length, 90);
  const count = (s) => urls.filter((u) => u.includes(`/${s}/`)).length;
  assert.equal(count("wonen"), 20);
  assert.equal(count("nieuws"), 35);
  assert.equal(count("agenda"), 35);
  // Sampled across the whole archive, not its first 35 items
  assert.ok(urls.some((u) => /\/nieuws\/p-4\d\d$/.test(u)));
});

test("discoverSitemapUrls unescapes locs: TYPO3 &amp;, WordPress &#038;, CDATA", async (t) => {
  const bodies = {
    "https://x.nl/robots.txt": "Sitemap: https://x.nl/sitemap.xml",
    "https://x.nl/sitemap.xml":
      "<sitemapindex><loc>https://x.nl/sitemap.xml?page=1&amp;sitemap=pages</loc><loc>https://x.nl/?sitemap=posts&#038;paged=1</loc></sitemapindex>",
    "https://x.nl/sitemap.xml?page=1&sitemap=pages": "<urlset><loc>https://x.nl/wonen/a?b=1&amp;c=2</loc></urlset>",
    "https://x.nl/?sitemap=posts&paged=1": "<urlset><loc><![CDATA[https://x.nl/nieuws/b]]></loc></urlset>",
  };
  t.mock.method(globalThis, "fetch", async (url) =>
    url in bodies ? new Response(bodies[url]) : new Response("", { status: 404 }),
  );
  const urls = await discoverSitemapUrls("https://x.nl/", "x.nl");
  assert.deepEqual(urls.sort(), ["https://x.nl/nieuws/b", "https://x.nl/wonen/a?b=1&c=2"]);
});

test("discoverSitemapUrls bounds the fetches of nested indexes and spreads them", async (t) => {
  // No Sitemap line in robots.txt: two fallback candidates, the first an index
  // of years, each an index of months. An even budget split per branch left
  // each year a single fetch, so almost no month was ever reached.
  const index = (urls) => `<sitemapindex>${urls.map((u) => `<loc>${u}</loc>`).join("")}</sitemapindex>`;
  const years = Array.from({ length: 40 }, (_, y) => `https://x.nl/sm-${2000 + y}.xml`);
  let fetched = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    fetched++;
    if (url === "https://x.nl/robots.txt" || url === "https://x.nl/sitemap") return new Response("", { status: 404 });
    if (url === "https://x.nl/sitemap.xml") return new Response(index(years));
    const year = url.match(/sm-(\d+)\.xml$/);
    if (year) return new Response(index(Array.from({ length: 40 }, (_, m) => `https://x.nl/sm-${year[1]}-m${m}.urls`)));
    return new Response(`<urlset><loc>https://x.nl/nieuws/${url.split("/").pop()}/a</loc></urlset>`);
  });
  const urls = await discoverSitemapUrls("https://x.nl/", "x.nl", { maxUrls: 5000 });
  assert.ok(fetched <= 101, `fetched ${fetched}`);
  assert.ok(urls.length >= 50, `${urls.length} URLs`);
  // Spread over the years, not spent on the first two
  assert.ok(new Set(urls.map((u) => u.match(/sm-(\d+)/)[1])).size >= 30);
});

// WP Rocket's lazyload boilerplate, inlined on every page of a WP Rocket site
// whether or not it embeds anything (readspeaker.com: 1397 pages).
const WP_ROCKET_BOILERPLATE =
  '<style id="rocket-lazyload-inline-css">.rll-youtube-player{position:relative;padding-bottom:56.23%}' +
  ".rll-youtube-player iframe{position:absolute}</style>" +
  `<script>function lazyLoadThumb(e,alt,l){var t='<img src="https://i.ytimg.com/vi_webp/ID/hqdefault.webp">'}` +
  'var a=document.getElementsByClassName("rll-youtube-player");</script>';

test("WP Rocket lazyload boilerplate alone → no YouTube", () => {
  assert.deepEqual(names(detectFromCorpus(WP_ROCKET_BOILERPLATE)), []);
});

test("WP Rocket lazy YouTube placeholder element → YouTube", () => {
  const html = WP_ROCKET_BOILERPLATE + '<div class="rll-youtube-player" data-id="6a-2QWvNhWY" data-query=""></div>';
  assert.deepEqual(names(detectFromCorpus(html)), ["YouTube"]);
});

test("YouTube thumbnail of a real video id → YouTube", () => {
  const html = WP_ROCKET_BOILERPLATE + '<img src="https://i.ytimg.com/vi/6a-2QWvNhWY/hqdefault.jpg">';
  assert.deepEqual(names(detectFromCorpus(html)), ["YouTube"]);
});

// ── OpenGemeenten: the CMS brand is not the player ─────────────────
// Verbatim shape of nieuwegein.nl's head: every page of the site carries it.
const OPENGEMEENTEN_CMS =
  '<!-- TYPO3 website by OpenGemeenten, www.opengemeenten.nl. Hosting by Cobytes -->' +
  '<script defer src="/_assets/317130fb/Js/OpenGemeentenSite-Media.min.js?1789965298"></script>';

test("OpenGemeenten CMS signature alone is NOT a player", () => {
  const network = ["https://www.nieuwegein.nl/_assets/317130fb/Js/OpenGemeentenSite-Media.min.js?1789965298"];
  assert.deepEqual(names(detectFromCorpus(OPENGEMEENTEN_CMS, "", network)), []);
});

test("OpenGemeenten CMS signature does not hide a real YouTube embed", () => {
  const html = OPENGEMEENTEN_CMS + '<iframe src="https://www.youtube-nocookie.com/embed/6a-2QWvNhWY"></iframe>';
  assert.deepEqual(names(detectFromCorpus(html)), ["YouTube"]);
});

test("OpenGemeenten Mediaplayer content element still detected", () => {
  const html = OPENGEMEENTEN_CMS +
    '<script src="/_assets/8916/Js/OpenGemeentenMediaPlayer-MediaPlayer.min.js?1789965336"></script>' +
    '<div class="mediaplayer__container flow"><video class="mejs__player"><source src="/fileadmin/Videos/a.mp4" type="video/mp4"></video></div>';
  assert.deepEqual(names(detectFromCorpus(html)), ["OpenGemeenten"]);
});

// ── TikTok / Spotify: pixels and share links are not embeds ────────
test("TikTok ad pixel is NOT a TikTok player (and does not hide a <video>)", () => {
  const network = ["https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=CVE38T3C77U2KF3E5SQG&lib=ttq"];
  assert.deepEqual(names(detectFromCorpus('<video src="/a.mp4"></video>', "", network)), ["HTML5 native"]);
});

test("TikTok embed still detected", () => {
  const html = '<blockquote class="tiktok-embed" cite="https://www.tiktok.com/@x/video/1"></blockquote>';
  const network = ["https://www.tiktok.com/embed.js"];
  assert.deepEqual(names(detectFromCorpus(html, "", network)), ["TikTok"]);
});

test("Spotify show link in a social-links JSON is NOT a player", () => {
  const html = '<script>{"tiktok":"https://www.tiktok.com/@amsterdam_museum",' +
    '"spotify":"https://open.spotify.com/show/3cvkC0FnIVAIipKZIDbHCK?si=ee4d"}</script>';
  const network = ["https://pixel.byspotify.com/ping?url=x"];
  assert.deepEqual(names(detectFromCorpus(html, "", network)), []);
});

test("Spotify embeds still detected — open.spotify.com and podcasters", () => {
  const open = '<iframe src="https://open.spotify.com/embed/episode/4rOoJ6Egrf8K2IrywzwOMk"></iframe>';
  assert.deepEqual(names(detectFromCorpus(open)), ["Spotify (podcast)"]);
  const pod = "https://podcasters.spotify.com/pod/show/fries-museum/embed/episodes/Luisterwandeling-e2a";
  assert.deepEqual(names(detectFromCorpus("<p>x</p>", "", [pod])), ["Spotify (podcast)"]);
});

// ── Host allow-lists: a CSP or preconnect names vendors, embeds nothing ─
const WERKENBIJOSS_CSP =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; frame-src 'self' ` +
  `https://player.vimeo.com https://www.google.com/recaptcha/ https://*.bbvms.com; script-src 'self'">`;

test("CSP meta allow-list naming bbvms.com / player.vimeo.com is NOT a player", () => {
  assert.deepEqual(names(detectFromCorpus(WERKENBIJOSS_CSP + "<p>Vacatures</p>")), []);
});

test("preconnect / dns-prefetch hints to a video host are NOT a player", () => {
  const html = '<link rel="preconnect" href="https://player.vimeo.com">' +
    "<link rel=dns-prefetch href=//fast.wistia.net><link href=\"https://cdn.jwplayer.com\" rel=\"preconnect\">";
  assert.deepEqual(names(detectFromCorpus(html)), []);
});

test("real Blue Billywig embed next to a CSP allow-list still detected", () => {
  const html = WERKENBIJOSS_CSP + '<script src="https://demo.bbvms.com/p/default/c/1234.js"></script>';
  assert.deepEqual(names(detectFromCorpus(html)), ["Blue Billywig"]);
});

// ── Video.js: WordPress script handles and *-video.js names ────────
test("WordPress script id parallax-video-js is NOT Video.js", () => {
  const html = '<script src="https://cdnjs.cloudflare.com/ajax/libs/jarallax/1.12.1/jarallax-video.min.js?ver=1.12.1" id="parallax-video-js"></script>';
  const network = ["https://cdnjs.cloudflare.com/ajax/libs/jarallax/1.12.1/jarallax-video.js"];
  assert.deepEqual(names(detectFromCorpus(html, "", network)), []);
});

test("Video.js still detected — video-js class, <video-js> tag, video.js path", () => {
  assert.deepEqual(names(detectFromCorpus('<div class="video-js"></div>')), ["Video.js"]);
  assert.deepEqual(names(detectFromCorpus("<video-js id=p></video-js>")), ["Video.js"]);
  const network = ["https://cdn.jsdelivr.net/npm/video.js@8/dist/video.min.js"];
  assert.deepEqual(names(detectFromCorpus("<p>x</p>", "", network)), ["Video.js"]);
});

// ── Network: trackers carry the page URL in their query ────────────
test("a tracker query naming a player is NOT that player", () => {
  const network = [
    "https://www.google.com/pagead/1p-user-list/1015767948/?random=1778&url=https%3A%2F%2Fx.nl%2Fmediasite-colleges%2Fvideo.js",
    "https://region1.google-analytics.com/g/collect?v=2&dl=https%3A%2F%2Fx.nl%2Fplayers.brightcove.net&dt=Flowplayer%20Panopto",
  ];
  assert.deepEqual(names(detectFromCorpus("<p>x</p>", "", network)), []);
});

test("a player whose own request carries a query is still detected", () => {
  const network = ["https://players.brightcove.net/3910869727001/default_default/index.min.js?v=7"];
  assert.deepEqual(names(detectFromCorpus("<p>x</p>", "", network)), ["Brightcove"]);
});

// ── Bare vendor words in body text ─────────────────────────────────
test("vendor names in body text are NOT players (Mediasite, hihaho.com, vixy.nl)", () => {
  const html = "<p>Colleges terugkijken via Mediasite. Interactief gemaakt met hihaho.com, gehost door vixy.nl.</p>";
  assert.deepEqual(names(detectFromCorpus(html)), []);
});

test("Mediasite / Hihaho embeds still detected", () => {
  assert.deepEqual(names(detectFromCorpus('<iframe src="https://mediasite.hva.nl/Mediasite/Play/0d1e2f3a1d"></iframe>')), ["Mediasite"]);
  assert.deepEqual(names(detectFromCorpus('<iframe src="https://player.hihaho.com/1b2c3d4e-aaaa"></iframe>')), ["Hihaho"]);
});

test("rel=preload is kept, a hint later in the rel token list is stripped", () => {
  assert.deepEqual(
    names(detectFromCorpus('<link rel="preload" as="script" href="https://players.brightcove.net/1/x_default/index.min.js">')),
    ["Brightcove"]
  );
  assert.deepEqual(names(detectFromCorpus('<link rel="preload preconnect" href="https://player.vimeo.com">')), []);
});

test("CSP meta with content before http-equiv is stripped too", () => {
  const html = `<meta content="frame-src https://*.bbvms.com https://player.vimeo.com" http-equiv="Content-Security-Policy">`;
  assert.deepEqual(names(detectFromCorpus(html)), []);
});

test("narrowed vendors still detected on their embed shapes", () => {
  const cases = [
    ['<iframe src="https://platform.vixyvideo.com/p/1/sp/100/embedIframeJs/uiconf_id/2"></iframe>', "Vixy Video"],
    ['<iframe src="https://hihaho.com/embed/1b2c3d4e"></iframe>', "Hihaho"],
    ['<div data-block=\'{"url":"https:\/\/mediasite.uu.nl\/Mediasite\/Play\/0d1e2f"}\'></div>', "Mediasite"],
    ['<iframe src="https://creators.spotify.com/pod/profile/museum/embed/episodes/ep-1"></iframe>', "Spotify (podcast)"],
    ['<iframe src="https://anchor.fm/museum/embed/episodes/ep-1"></iframe>', "Spotify (podcast)"],
    ['<script src="/typo3conf/ext/opengemeenten_mediaplayer/Resources/Public/player.js"></script>', "OpenGemeenten"],
  ];
  for (const [html, player] of cases) assert.deepEqual(names(detectFromCorpus(html)), [player], html);
  assert.deepEqual(names(detectFromCorpus("<p>x</p>", "", ["https://www.tiktok.com/player/v1/7300000000000000000"])), ["TikTok"]);
});

test("recordSubresource drops the page's own navigation, keeps iframes and assets", () => {
  const mainFrame = {};
  const page = { mainFrame: () => mainFrame };
  const req = (url, nav, frame) => ({ url: () => url, isNavigationRequest: () => nav, frame: () => frame });
  const seen = [];
  const record = recordSubresource(page, seen);
  record(req("https://www.ngf.nl/publicaties/youtube.com/watch?v=19lqfVgbBws", true, mainFrame));
  record(req("https://www.youtube.com/embed/19lqfVgbBws", true, {}));
  record(req("https://www.ngf.nl/app.js", false, mainFrame));
  record({ url: () => "https://www.ngf.nl/sw-fetch", isNavigationRequest: () => true, frame: () => { throw new Error("sw"); } });
  assert.deepEqual(seen, ["https://www.youtube.com/embed/19lqfVgbBws", "https://www.ngf.nl/app.js", "https://www.ngf.nl/sw-fetch"]);
});
