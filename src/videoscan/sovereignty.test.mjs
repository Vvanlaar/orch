import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONSENT_SELECTORS, DETECTORS, isBrowserRefusal, loadSeeds, dropEnginesUnderVendors } from "./scan.mjs";
import { attributeRequest, createSovereigntyCollector, isFirstParty, pickSamples, playVideos, startCapture } from "./sovereignty/collect.mjs";
import { classifyInfra, classifyService, loadAsnDb, parseAsnDb, resolveDns, resolveHosts } from "./sovereignty/resolve.mjs";
import { gzipSync } from "node:zlib";
import { gradeOf, measurePlayer, scorePlayer, scoreSite } from "./sovereignty/score.mjs";

test("classifyService: longest suffix wins, company HQ decides EU", () => {
  assert.equal(classifyService("www.youtube-nocookie.com").company, "Google");
  assert.equal(classifyService("www.youtube-nocookie.com").eu, false);
  assert.equal(classifyService("fonts.googleapis.com").service, "Google Fonts");
  assert.equal(classifyService("maps.googleapis.com").service, "Google Maps");
  assert.equal(classifyService("px.ads.linkedin.com").category, "ads");
  assert.equal(classifyService("cdn.bluebillywig.com").eu, true);
  assert.equal(classifyService("consent.cookiebot.com").category, "cmp");
  assert.equal(classifyService("notyoutube.com"), null);
  assert.equal(classifyService("example.org"), null);
});

test("classifyInfra: CNAME chain before ASN, registry country last", () => {
  assert.equal(classifyInfra(["d1i254ftm0zvcw.cloudfront.net"], { asn: 16509 }).via, "cname");
  assert.equal(classifyInfra(["d1i254ftm0zvcw.cloudfront.net"], null).company, "Amazon");
  const kpn = classifyInfra([], { asn: 1136, country: "NL", name: "KPN" });
  assert.deepEqual([kpn.company, kpn.eu, kpn.via], ["KPN", true, "asn"]);
  const unknown = classifyInfra([], { asn: 64999, country: "DE", name: "Some GmbH" });
  assert.deepEqual([unknown.company, unknown.eu, unknown.via], ["Some GmbH", true, "asn-registry"]);
  assert.equal(classifyInfra([], null), null);
});

test("parseAsnDb: binary search over ranges, asn 0 skipped", () => {
  const db = parseAsnDb([
    "1.0.0.0\t1.0.0.255\t13335\tUS\tCLOUDFLARENET",
    "1.0.1.0\t1.0.3.255\t0\tNone\tNot routed",
    "18.239.0.0\t18.239.255.255\t16509\tUS\tAMAZON-02",
  ].join("\n"));
  assert.equal(db.lookup("1.0.0.7").asn, 13335);
  assert.equal(db.lookup("1.0.2.1"), null);
  assert.equal(db.lookup("18.239.18.67").name, "AMAZON-02");
  assert.equal(db.lookup("9.9.9.9"), null);
});

test("resolveHosts: EU vendor on a US CDN is flagged nonEuInfra", async () => {
  const dns = {
    "www.bbvms.com": ["d1i254ftm0zvcw.cloudfront.net"],
    "www.youtube.com": [],
    "cdn.gemeente.nl": [],
  };
  const resolver = {
    resolveCname: async (n) => { if (dns[n]?.length) return dns[n]; throw new Error("ENODATA"); },
    resolve4: async (n) => (n === "cdn.gemeente.nl" ? ["193.141.100.162"] : ["18.239.18.67"]),
  };
  const asnDb = parseAsnDb("193.141.100.0\t193.141.100.255\t1136\tNL\tKPN\n18.239.0.0\t18.239.255.255\t16509\tUS\tAMAZON-02");
  const out = await resolveHosts(Object.keys(dns), { resolver, asnDb });
  assert.equal(out["www.bbvms.com"].eu, true);
  assert.equal(out["www.bbvms.com"].nonEuInfra, true);
  assert.equal(out["www.bbvms.com"].infra.company, "Amazon");
  assert.equal(out["www.youtube.com"].eu, false);
  assert.equal(out["www.youtube.com"].nonEuInfra, undefined);
  assert.deepEqual([out["cdn.gemeente.nl"].infra.company, out["cdn.gemeente.nl"].eu], ["KPN", true]);
});

test("isFirstParty: domain and subdomains, not lookalikes", () => {
  assert.ok(isFirstParty("www.schiedam.nl", "schiedam.nl"));
  assert.ok(isFirstParty("cdn.schiedam.nl", "schiedam.nl"));
  assert.ok(!isFirstParty("notschiedam.nl", "schiedam.nl"));
});

test("attributeRequest: by URL, by frame, media to the only player", () => {
  const yt = { url: "https://googleads.g.doubleclick.net/pagead/id", type: "xhr", frameUrl: "https://www.youtube-nocookie.com/embed/abcdefghijk" };
  assert.equal(attributeRequest(yt, ["YouTube", "Vimeo"], DETECTORS), "YouTube");
  const vimeo = { url: "https://player.vimeo.com/video/123", type: "document", frameUrl: "" };
  assert.equal(attributeRequest(vimeo, ["YouTube", "Vimeo"], DETECTORS), "Vimeo");
  const media = { url: "https://media.site.nl/v/clip.mp4", type: "media", frameUrl: "" };
  assert.equal(attributeRequest(media, ["HTML5 native"], DETECTORS), "HTML5 native");
  assert.equal(attributeRequest(media, ["HTML5 native", "YouTube"], DETECTORS), null);
  const ga = { url: "https://www.google-analytics.com/g/collect", type: "fetch", frameUrl: "" };
  assert.equal(attributeRequest(ga, ["YouTube"], DETECTORS), null);
});

const capture = (requests, cookies = [], storage = {}) => ({ requests, cookies, storage });

test("collector: hosts, cookies and players per phase", () => {
  const c = createSovereigntyCollector({ domain: "site.nl", detectors: DETECTORS });
  const ytPage = [{ player: "YouTube", evidence: [] }];
  c.recordPage({
    url: "https://site.nl/a",
    phase: "pre",
    players: ytPage,
    capture: capture(
      [
        { url: "https://www.youtube.com/embed/abcdefghijk", type: "document", frameUrl: "" },
        { url: "https://www.youtube.com/s/player.js", type: "script", frameUrl: "https://www.youtube.com/embed/abcdefghijk" },
        { url: "https://site.nl/app.js", type: "script", frameUrl: "" },
      ],
      [{ name: "VISITOR_INFO1_LIVE", domain: "youtube.com", session: false, expires: Date.now() / 1000 + 180 * 86400 }],
      { "https://www.youtube.com": ["yt-remote-device-id"] },
    ),
  });
  c.recordPage({
    url: "https://site.nl/a",
    phase: "play",
    players: ytPage,
    capture: capture([{ url: "https://rr1.googlevideo.com/videoplayback", type: "xhr", frameUrl: "https://www.youtube.com/embed/abcdefghijk", play: true }]),
  });
  const j = c.toJSON({ "www.youtube.com": { country: "US", eu: false, service: { service: "YouTube" } } });
  assert.deepEqual(j.pages, { crawl: 0, pre: 1, play: 1 });
  assert.deepEqual(j.hosts["www.youtube.com"].phases.pre, { requests: 2, pages: 1 });
  assert.deepEqual(j.hosts["www.youtube.com"].players, ["YouTube"]);
  assert.equal(j.hosts["site.nl"].firstParty, true);
  assert.deepEqual(j.hosts["site.nl"].players, []);
  assert.equal(j.hosts["rr1.googlevideo.com"].phases.play.requests, 1);
  assert.deepEqual(j.players.YouTube.hosts, ["rr1.googlevideo.com", "www.youtube.com"]);
  assert.deepEqual(j.players.YouTube.requests, { crawl: {}, pre: { "www.youtube.com": 2 }, play: { "rr1.googlevideo.com": 1 } });
  const cookie = j.cookies[0];
  assert.deepEqual([cookie.firstParty, cookie.eu, cookie.phases.pre, cookie.players], [false, false, 1, ["YouTube"]]);
  assert.ok(cookie.maxDays >= 179 && cookie.maxDays <= 180);
  assert.deepEqual(j.storage["https://www.youtube.com"].keys, ["yt-remote-device-id"]);
});

test("collector: a resume keeps the crawl phase, drops the samples", () => {
  const c = createSovereigntyCollector({ domain: "site.nl", detectors: DETECTORS });
  const req = { url: "https://cdn.x.com/a.js", type: "script", frameUrl: "" };
  c.recordPage({ url: "https://site.nl/", phase: "crawl", players: [], capture: capture([req], [{ name: "a", domain: "x.com", session: true }]) });
  c.recordPage({ url: "https://site.nl/", phase: "pre", players: [], capture: capture([req, { ...req, url: "https://only.pre.com/x" }]) });
  const resumed = createSovereigntyCollector({ domain: "site.nl", detectors: DETECTORS, prev: JSON.parse(JSON.stringify(c.toJSON())) });
  const j = resumed.toJSON();
  assert.deepEqual(j.pages, { crawl: 1, pre: 0, play: 0 });
  assert.deepEqual(j.hosts["cdn.x.com"].phases.pre, { requests: 0, pages: 0 });
  assert.equal(j.hosts["only.pre.com"], undefined);
  assert.equal(j.cookies[0].phases.crawl, 1);
});

test("pickSamples: start page, video pages round-robin, then the rest", () => {
  const results = [
    { url: "https://s.nl/", players: [] },
    { url: "https://s.nl/y1", players: [{ player: "YouTube" }] },
    { url: "https://s.nl/y2", players: [{ player: "YouTube" }] },
    { url: "https://s.nl/v1", players: [{ player: "Vimeo" }] },
    { url: "https://s.nl/err", players: [], error: "Timeout" },
    { url: "https://s.nl/plain", players: [] },
  ];
  const { pre, play } = pickSamples(results, "https://s.nl/", { pre: 4, perPlayer: 1 });
  assert.deepEqual(pre, ["https://s.nl/", "https://s.nl/y1", "https://s.nl/v1", "https://s.nl/y2"]);
  assert.deepEqual(play, [{ player: "YouTube", urls: ["https://s.nl/y1"] }, { player: "Vimeo", urls: ["https://s.nl/v1"] }]);
});

test("loadSeeds: pages with network evidence come first", () => {
  const dir = mkdtempSync(join(tmpdir(), "seeds-"));
  try {
    const file = join(dir, "seed.json");
    const row = (url, evidence) => ({ url, players: [{ name: "YouTube", evidence }] });
    writeFileSync(file, JSON.stringify({ details: [
      row("https://s.nl/weak1", "HTML: youtube-player"),
      row("https://s.nl/real", "HTML: youtube.com/embed,Network: https://www.youtube.com/embed/x"),
      row("https://s.nl/weak2", "HTML: youtube-player"),
    ] }));
    assert.deepEqual(loadSeeds(file, "https://s.nl", dir), ["https://s.nl/real", "https://s.nl/weak1", "https://s.nl/weak2"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Blue Billywig detector: the company's own website is not a player", () => {
  const bb = DETECTORS["Blue Billywig"];
  const hit = (s) => [...bb.patterns, ...bb.scripts].some((re) => re.test(s));
  assert.equal(hit("https://www.bluebillywig.com/nl/workshops"), false);
  assert.equal(hit("https://bluebillywig.com/"), false);
  assert.equal(hit("https%3A%2F%2Fwww.bluebillywig.com%2Fnl"), false);
  assert.equal(hit("https://support.bluebillywig.com/kb/x"), false);
  assert.equal(hit("https%3A%2F%2Fcdn.bluebillywig.com%2Fp.js"), true);
  assert.equal(hit("https://a.cdn.bluebillywig.com/p.js"), true);
  assert.equal(hit("https://cdn.bluebillywig.com/apps/player.js"), true);
  assert.equal(hit("https:\\/\\/stats.bluebillywig.com\\/x"), true);
  assert.equal(hit("https://d2rvackbgybhru.cloudfront.net/bluebillywig/media/a.mp4"), true);
});

test("consent: the scan's selectors find Cookiebot's newer accept button", () => {
  assert.ok(CONSENT_SELECTORS.some((s) => s === "#CybotCookiebotDialogBodyButtonAccept"));
});

test("isBrowserRefusal: a protocol reset is retried, a rate limit or a left page is not", () => {
  assert.equal(isBrowserRefusal(new Error("page.goto: net::ERR_HTTP2_PROTOCOL_ERROR at https://www.ing.be/")), true);
  assert.equal(isBrowserRefusal(new Error("play sample left the page for https://x/")), false);
  assert.equal(isBrowserRefusal(new Error("Rate limited: connection: ERR_HTTP2_PROTOCOL_ERROR")), true, "how the page load reports it");
  assert.equal(isBrowserRefusal(new Error("Rate limited: HTTP 429")), false);
});

// A page with just enough surface for playVideos
function fakePlayPage({ links = [], videos = [] }) {
  const clicks = [];
  const main = { evaluate: async () => {} };
  const link = (l) => ({
    getAttribute: async () => l.url,
    evaluate: async () => { clicks.push(`link:${l.url}`); },
  });
  // evaluate runs the real predicate against a stand-in <video>
  const video = (v) => ({
    evaluate: async (fn) => fn({ paused: v.paused, currentSrc: v.src ?? "", closest: () => (v.inLink ? {} : null) }),
    scrollIntoViewIfNeeded: async () => {},
    boundingBox: async () => v.box,
  });
  return {
    clicks,
    mainFrame: () => main,
    frames: () => [main],
    $$: async (sel) => (sel.startsWith("a[data-video-url]") ? links.map(link) : sel === "video" ? videos.map(video) : []),
    mouse: { click: async (x, y) => { clicks.push(`mouse:${x},${y}`); } },
    waitForTimeout: async () => {},
  };
}
const VIMEO = { patterns: [/player\.vimeo\.com/], scripts: [] };
const BOX = { x: 0, y: 0, width: 200, height: 100 };

test("playVideos: clicks a click-to-load link of this player, and no other", async () => {
  const page = fakePlayPage({ links: [{ url: "https://player.vimeo.com/video/1" }, { url: "https://other.example/2" }] });
  assert.equal(await playVideos(page, VIMEO, { settleMs: 0 }), 1);
  assert.deepEqual(page.clicks, ["link:https://player.vimeo.com/video/1"]);
});

test("playVideos: a started link is not followed by a click on another player", async () => {
  const page = fakePlayPage({ links: [{ url: "https://player.vimeo.com/video/1" }], videos: [{ paused: true, src: "a.mp4", box: BOX }] });
  assert.equal(await playVideos(page, VIMEO, { settleMs: 0 }), 1);
  assert.deepEqual(page.clicks, ["link:https://player.vimeo.com/video/1"]);
});

test("playVideos: clicks a video play() could not start: paused, or without a source", async () => {
  const none = { patterns: [], scripts: [] };
  const clicks = async (videos) => {
    const page = fakePlayPage({ videos });
    await playVideos(page, none, { settleMs: 0 });
    return page.clicks.length;
  };
  assert.equal(await clicks([{ paused: true, src: "a.mp4", box: BOX }]), 1);
  assert.equal(await clicks([{ paused: false, src: "", box: BOX }]), 1, "paused turns false on a <video> with no source");
  assert.equal(await clicks([{ paused: false, src: "a.mp4", box: BOX }]), 0, "really playing");
  assert.equal(await clicks([{ paused: true, src: "a.mp4", box: { ...BOX, width: 10 } }]), 0, "too small");
  assert.equal(await clicks([{ paused: true, src: "a.mp4", box: BOX, inLink: true }]), 0, "a card: the click would leave the page");
});

test("playVideos: click false starts nothing by clicking", async () => {
  const page = fakePlayPage({ links: [{ url: "https://player.vimeo.com/video/1" }], videos: [{ paused: true, box: { x: 0, y: 0, width: 200, height: 100 } }] });
  assert.equal(await playVideos(page, VIMEO, { settleMs: 0, click: false }), 0);
  assert.deepEqual(page.clicks, []);
});

test("collector: sample failures reach the scan file", () => {
  const c = createSovereigntyCollector({ domain: "s.nl", detectors: {} });
  assert.deepEqual(c.toJSON().sampleFailures, []);
  c.setSampleFailures([{ url: "https://s.nl/", phase: "play", error: "boom" }]);
  assert.equal(c.toJSON().sampleFailures[0].error, "boom");
});

test("measurePlayer: only a player that sent nothing in any phase is unsampled", () => {
  const sov = (requests, given = false) => ({
    consent: { given },
    hosts: {},
    cookies: [],
    storage: {},
    players: { Vimeo: { pages: { crawl: 56, pre: 3, play: 0 }, hosts: [], ...(requests ? { requests } : {}) } },
  });
  assert.equal(measurePlayer(sov({ crawl: {}, pre: {}, play: {} }), "Vimeo").sampled, false);
  assert.equal(measurePlayer(sov({ crawl: { "a.nl": 1 }, pre: {}, play: {} }), "Vimeo").sampled, true);
  assert.equal(measurePlayer(sov({ crawl: { "a.nl": 1 }, pre: {}, play: {} }, true), "Vimeo").sampled, true, "held back until consent: a clean measurement");
  assert.equal(measurePlayer(sov({ crawl: {}, pre: {}, play: { "a.nl": 1 } }, true), "Vimeo").sampled, true, "held back until a click");
  assert.equal(measurePlayer(sov(null), "Vimeo").sampled, true, "older scans have only the pages");
});

test("collector: media requests are counted per player, a loader is not media", () => {
  const c = createSovereigntyCollector({ domain: "s.nl", detectors: { JW: { patterns: [/jwpcdn/], scripts: [] } } });
  const capture = { requests: [
    { url: "https://x.jwpcdn.com/player.js", type: "script", frameUrl: "" },
    { url: "https://s.nl/stream/a.m3u8?t=1", type: "xhr", frameUrl: "" },
  ], cookies: [], storage: {} };
  c.recordPage({ url: "https://s.nl/", phase: "crawl", players: [{ player: "JW" }], capture });
  assert.deepEqual(c.toJSON().players.JW.mediaRequests.crawl, { "s.nl": 1 });
});

test("collector: a resumed scan keeps its crawl media", () => {
  const c = createSovereigntyCollector({ domain: "s.nl", detectors: { JW: { patterns: [/jwpcdn/], scripts: [] } } });
  const capture = { requests: [{ url: "https://s.nl/a.m3u8", type: "xhr", frameUrl: "" }], cookies: [], storage: {} };
  c.recordPage({ url: "https://s.nl/", phase: "crawl", players: [{ player: "JW" }], capture });
  const resumed = createSovereigntyCollector({ domain: "s.nl", detectors: {}, prev: c.toJSON() });
  assert.deepEqual(resumed.toJSON().players.JW.mediaRequests.crawl, { "s.nl": 1 });
});

test("attributeRequest: YouTube's extensionless segments count as media", () => {
  const c = createSovereigntyCollector({ domain: "s.nl", detectors: { YT: { patterns: [/youtube/], scripts: [] } } });
  const capture = { requests: [{ url: "https://x.googlevideo.com/videoplayback?id=1", type: "xhr", frameUrl: "https://www.youtube.com/embed/abc" }], cookies: [], storage: {} };
  c.recordPage({ url: "https://s.nl/", phase: "play", players: [{ player: "YT" }], capture });
  assert.deepEqual(c.toJSON().players.YT.mediaRequests.play, { "x.googlevideo.com": 1 });
});

// Fairness: unclaimed media must not credit the wrong vendor
const VENDOR = { Vendor: { patterns: [/vendor\.com/], scripts: [] } };
const media = (url, over = {}) => ({ url, type: "media", frameUrl: "", ...over });

test("attributeRequest: the fallback takes a main-frame video for the page's only player", () => {
  assert.equal(attributeRequest(media("https://cdn.nl/a.mp4"), ["Vendor"], VENDOR), "Vendor");
});

test("attributeRequest: media from an undetected iframe is not the page player's", () => {
  assert.equal(attributeRequest(media("https://eu.nl/a.ts", { frameUrl: "https://eu.nl/embed" }), ["Vendor"], VENDOR), null);
});

test("attributeRequest: audio on the page is not a video player's media", () => {
  assert.equal(attributeRequest(media("https://site.nl/podcast.mp3"), ["Vendor"], VENDOR), null);
  assert.equal(attributeRequest(media("https://site.nl/x", { contentType: "audio/mpeg" }), ["Vendor"], VENDOR), null);
});

test("collector: a hero video next to an iframe vendor leaves its delivery alone", () => {
  const c = createSovereigntyCollector({ domain: "site.nl", detectors: VENDOR });
  const capture = { requests: [
    media("https://site.nl/hero.mp4"),
    { url: "https://vendor.com/embed/1", type: "document", frameUrl: "" },
    media("https://cdn.vendor-video.net/seg.m4s", { type: "xhr", frameUrl: "https://vendor.com/embed/1" }),
  ], cookies: [], storage: {} };
  c.recordPage({ url: "https://site.nl/", phase: "play", players: [{ player: "Vendor" }], capture });
  assert.deepEqual(c.toJSON().players.Vendor.mediaRequests.play, { "cdn.vendor-video.net": 1 });
});

test("collector: a click-to-load vendor's frame in the play sample clears the crawl's hero credits", () => {
  const c = createSovereigntyCollector({ domain: "site.nl", detectors: VENDOR });
  const crawl = { requests: [media("https://site.nl/hero.mp4")], cookies: [], storage: {} };
  c.recordPage({ url: "https://site.nl/", phase: "crawl", players: [{ player: "Vendor" }], capture: crawl });
  assert.deepEqual(c.toJSON().players.Vendor.mediaRequests.crawl, { "site.nl": 1 }, "no frame seen yet: could be its own");
  const seg = media("https://cdn.vendor-video.net/seg.m4s", { type: "xhr", frameUrl: "https://vendor.com/embed/1" });
  c.recordPage({ url: "https://site.nl/", phase: "play", players: [{ player: "Vendor" }], capture: { requests: [seg], cookies: [], storage: {} } });
  const m = c.toJSON().players.Vendor.mediaRequests;
  assert.deepEqual(m.crawl, {});
  assert.deepEqual(m.play, { "cdn.vendor-video.net": 1 });
});

test("collector: an iframe that loaded before the play window still counts as the player's", () => {
  const c = createSovereigntyCollector({ domain: "site.nl", detectors: VENDOR });
  const early = { url: "https://cdn.vendor-video.net/p.js", type: "script", frameUrl: "https://vendor.com/embed/1" };
  const hero = media("https://site.nl/hero.m3u8", { play: true });
  c.recordPage({ url: "https://site.nl/", phase: "play", players: [{ player: "Vendor" }], capture: { requests: [hero], cookies: [], storage: {} }, allRequests: [early, hero] });
  assert.deepEqual(c.toJSON().players.Vendor.mediaRequests.play, {});
});

test("collector: an unrelated iframe fetching a matching URL doesn't take a main-frame player's media", () => {
  const c = createSovereigntyCollector({ domain: "site.nl", detectors: VENDOR });
  const capture = { requests: [
    { url: "https://vendor.com/v.js", type: "script", frameUrl: "https://helper.nl/x" },
    media("https://site.nl/a.mp4"),
  ], cookies: [], storage: {} };
  c.recordPage({ url: "https://site.nl/", phase: "crawl", players: [{ player: "Vendor" }], capture });
  assert.deepEqual(c.toJSON().players.Vendor.mediaRequests.crawl, { "site.nl": 1 });
});

test("media: a redirect hop, an error page and a script are not delivery; the target is", () => {
  const c = createSovereigntyCollector({ domain: "site.nl", detectors: VENDOR });
  const capture = { requests: [
    { url: "https://vendor.com/r.mp4", type: "media", frameUrl: "", status: 302, contentType: "" },
    { url: "https://vendor.com/final.mp4", type: "media", frameUrl: "", status: 200, contentType: "video/mp4" },
    { url: "https://vendor.com/err.m3u8", type: "fetch", frameUrl: "", status: 403, contentType: "text/html" },
    { url: "https://vendor.com/app.ts", type: "fetch", frameUrl: "", status: 200, contentType: "text/javascript" },
    { url: "https://vendor.com/live.m3u8", type: "fetch", frameUrl: "", status: 200, contentType: "text/plain" },
    { url: "https://vendor.com/gone.mp4", type: "media", frameUrl: "", status: 403, contentType: "application/xml" },
  ], cookies: [], storage: {} };
  c.recordPage({ url: "https://site.nl/", phase: "play", players: [{ player: "Vendor" }], capture });
  assert.deepEqual(c.toJSON().players.Vendor.mediaRequests.play, { "vendor.com": 2 });
});

test("collector: a dropped hero's host and cookies are not the iframe vendor's", () => {
  const cookie = { name: "visitor", domain: "heroco.com", session: false, expires: Date.now() / 1000 + 86400 * 90 };
  const frame = "https://vendor.com/embed/1";
  const run = (requests) => {
    const c = createSovereigntyCollector({ domain: "site.nl", detectors: VENDOR });
    c.recordPage({ url: "https://site.nl/", phase: "crawl", players: [{ player: "Vendor" }], capture: { requests, cookies: [cookie], storage: {} } });
    return c.toJSON();
  };
  const dropped = run([media("https://heroco.com/h.mp4"), { url: "https://vendor.com/p.js", type: "script", frameUrl: frame }]);
  assert.deepEqual(dropped.players.Vendor.hosts, ["vendor.com"]);
  assert.deepEqual(dropped.hosts["heroco.com"].players, []);
  assert.deepEqual(dropped.cookies[0].players, []);

  // A main-frame player keeps it: hosts, requests and cookies all count
  const kept = run([media("https://heroco.com/h.mp4")]);
  assert.deepEqual(kept.players.Vendor.hosts, ["heroco.com"]);
  assert.deepEqual(kept.players.Vendor.requests.crawl, { "heroco.com": 1 });
  assert.deepEqual(kept.hosts["heroco.com"].players, ["Vendor"]);
  assert.deepEqual(kept.cookies[0].players, ["Vendor"]);
});

test("startCapture: the response's content type and status reach the request", async () => {
  const handlers = {};
  const main = { url: () => "https://site.nl/", parentFrame: () => null };
  const request = { url: () => "https://x.nl/seg", resourceType: () => "xhr", frame: () => main };
  const page = {
    on: (e, fn) => { handlers[e] = fn; },
    mainFrame: () => main,
    frames: () => [],
    context: () => ({ cookies: async () => [] }),
  };
  const cap = startCapture(page);
  handlers.request(request);
  handlers.response({ request: () => request, headers: () => ({ "content-type": "video/mp2t" }), status: () => 200 });
  const [req] = (await cap.snapshot()).requests;
  assert.equal(req.contentType, "video/mp2t");
  assert.equal(req.status, 200);
  assert.equal(req.frameUrl, "");
});

test("startCapture: an about:blank wrapper doesn't hide the embed's frame", () => {
  const handlers = {};
  const main = { url: () => "https://site.nl/", parentFrame: () => null };
  const wrapper = { url: () => "about:blank", parentFrame: () => main };
  const embed = { url: () => "https://vendor.com/embed/1", parentFrame: () => wrapper };
  const page = { on: (e, fn) => { handlers[e] = fn; }, mainFrame: () => main, frames: () => [], context: () => ({ cookies: async () => [] }) };
  const cap = startCapture(page);
  handlers.request({ url: () => "https://x.nl/a", resourceType: () => "xhr", frame: () => embed });
  return cap.snapshot().then(({ requests }) => assert.equal(requests[0].frameUrl, "https://vendor.com/embed/1"));
});

test("collector: the content type finds a segment no URL rule knows, and a .ts script is not media", () => {
  const c = createSovereigntyCollector({ domain: "site.nl", detectors: VENDOR });
  const capture = { requests: [
    { url: "https://vendor.com/QualityLevels(1)/Fragments(video=0)", type: "xhr", frameUrl: "", contentType: "video/mp4" },
    { url: "https://vendor.com/app.ts", type: "script", frameUrl: "", contentType: "text/javascript" },
  ], cookies: [], storage: {} };
  c.recordPage({ url: "https://site.nl/", phase: "crawl", players: [{ player: "Vendor" }], capture });
  assert.deepEqual(c.toJSON().players.Vendor.mediaRequests.crawl, { "vendor.com": 1 });
});

test("engine: unseen media keeps it rated, on all its requests, so a failed click can't lift the site", () => {
  const sov = {
    consent: { given: false }, cookies: [], storage: {},
    hosts: { "loader.us.com": { eu: false, phases: { crawl: { requests: 5, pages: 1 }, pre: { requests: 0, pages: 0 }, play: { requests: 0, pages: 0 } } } },
    players: { E: { pages: { crawl: 1, pre: 0, play: 0 }, hosts: ["loader.us.com"], requests: { crawl: { "loader.us.com": 5 }, pre: {}, play: {} }, mediaRequests: { crawl: {}, pre: {}, play: {} } } },
  };
  const r = scorePlayer("E", { type: "engine", openness: 10, certifications: [] }, measurePlayer(sov, "E"));
  assert.equal(r.rated, true);
  assert.equal(r.dims.J, 0);
  assert.match(r.reasons.join(" "), /0% of all requests/);

  // An unresolved host gets half, so it neither inflates nor unrates the engine
  sov.hosts["loader.us.com"].eu = null;
  assert.equal(measurePlayer(sov, "E").hostShare, 0.5);
  assert.equal(scorePlayer("E", { type: "engine", openness: 10, certifications: [] }, measurePlayer(sov, "E")).dims.J, 15);
});

test("delivery: D counts media, so beacons and loaders no longer outweigh video", () => {
  const phases = (n) => ({ crawl: { requests: n, pages: 1 }, pre: { requests: 0, pages: 0 }, play: { requests: 0, pages: 0 } });
  const sov = (extra) => ({
    consent: { given: false },
    cookies: [],
    storage: {},
    hosts: {
      "stats.eu.nl": { eu: true, phases: phases(90) },
      "video.us.com": { eu: false, phases: phases(10) },
    },
    players: { P: { pages: { crawl: 1, pre: 0, play: 0 }, hosts: ["stats.eu.nl", "video.us.com"], requests: { crawl: { "stats.eu.nl": 90, "video.us.com": 10 }, pre: {}, play: {} }, ...extra } },
  });
  const onlyVideo = measurePlayer(sov({ mediaRequests: { crawl: { "video.us.com": 10 }, pre: {}, play: {} } }), "P");
  assert.equal(onlyVideo.euShare, 0);
  assert.equal(onlyVideo.shareOf, "media requests");
  assert.equal(scorePlayer("P", { controlCountry: "NL", delivery: "eu" }, onlyVideo).dims.D, 0);

  // A player that sent no media is unmeasured, not 100% EU: desk value, and it says so
  const noMedia = measurePlayer(sov({ mediaRequests: { crawl: {}, pre: {}, play: {} } }), "P");
  assert.equal(noMedia.euShare, null);
  const r = scorePlayer("P", { controlCountry: "NL", delivery: "mixed" }, noMedia);
  assert.equal(r.dims.D, 13);
  assert.match(r.reasons.join(" "), /delivery \(not measured\): mixed/);

  // Older scans have only all requests, and the reason names that basis
  const old = measurePlayer(sov({}), "P");
  assert.equal(old.euShare, 0.9);
  assert.match(scorePlayer("P", { controlCountry: "NL" }, old).reasons.join(" "), /90% of measured requests/);
});

test("loadSeeds: newest finished scan of the domain, not a subdomain's", () => {
  const dir = mkdtempSync(join(tmpdir(), "seeds-"));
  try {
    const write = (f, urls) => writeFileSync(join(dir, f), JSON.stringify({ details: urls.map((url) => ({ url })) }));
    write("videoscan-site.nl-2026-01-01T00-00-00.json", ["https://site.nl/old"]);
    write("videoscan-site.nl-2026-05-01T00-00-00.json", ["https://site.nl/new"]);
    write("videoscan-site.nl-INPROGRESS.json", ["https://site.nl/wip"]);
    write("videoscan-site.nl.sub-2026-09-01T00-00-00.json", ["https://x/"]);
    assert.deepEqual(loadSeeds("auto", "https://www.site.nl", dir), ["https://site.nl/new"]);
    assert.deepEqual(loadSeeds("none", "https://www.site.nl", dir), []);
    assert.deepEqual(loadSeeds("auto", "https://other.nl", dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("attributeRequest: the page URL is no frame evidence", () => {
  // A main-frame request on a page whose path names a player
  const gtag = { url: "https://www.googletagmanager.com/gtag/js", type: "script", frameUrl: "" };
  assert.equal(attributeRequest(gtag, ["Rijksoverheidsplayer", "Panopto"], DETECTORS), null);
});

test("dropEnginesUnderVendors: engines go, vendors of any tier stay", () => {
  const p = (...names) => names.map((player) => ({ player }));
  const names = (list) => list.map((x) => x.player);
  assert.deepEqual(names(dropEnginesUnderVendors(p("Brightcove", "Video.js"))), ["Brightcove"]);
  assert.deepEqual(names(dropEnginesUnderVendors(p("Blue Billywig", "YouTube", "MediaElement.js"))), ["Blue Billywig", "YouTube"]);
  assert.deepEqual(names(dropEnginesUnderVendors(p("Video.js", "HTML5 native"))), ["Video.js", "HTML5 native"]);
});

test("resolveDns: IP literals, filtering resolvers, IPv6-only hosts", async () => {
  const resolver = {
    resolveCname: async () => { throw new Error("ENODATA"); },
    resolve4: async (n) => { if (n === "ads.blocked.com") return ["0.0.0.0"]; throw new Error("ENODATA"); },
    resolve6: async (n) => (n === "v6.only.com" ? ["2001:db8::1"] : []),
  };
  assert.deepEqual(await resolveDns("93.184.216.34", resolver), { chain: [], ip: "93.184.216.34" });
  assert.equal((await resolveDns("[2001:db8::1]", resolver)).ipv6Only, true);
  assert.equal((await resolveDns("ads.blocked.com", resolver)).blocked, true);
  assert.equal((await resolveDns("v6.only.com", resolver)).ipv6Only, true);
  assert.deepEqual(await resolveDns("gone.com", resolver), { chain: [], ip: null });
});

test("loadAsnDb: a bad download keeps the old copy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "asn-"));
  try {
    const path = join(dir, "ip2asn.tsv.gz");
    const tsv = "1.0.0.0	1.0.0.255	13335	US	CLOUDFLARENET";
    const silent = () => {};
    const ok = { ok: true, arrayBuffer: async () => gzipSync(tsv) };
    assert.equal((await loadAsnDb(path, { fetchImpl: async () => ok, log: silent })).lookup("1.0.0.1").asn, 13335);
    // Force a refresh, with an HTML challenge page as the answer
    const { utimesSync } = await import("node:fs");
    utimesSync(path, new Date(0), new Date(0));
    const challenge = { ok: true, arrayBuffer: async () => Buffer.from("<html>challenge</html>") };
    assert.equal((await loadAsnDb(path, { fetchImpl: async () => challenge, log: silent })).lookup("1.0.0.1").asn, 13335);
    assert.equal(await loadAsnDb(join(dir, "none.gz"), { fetchImpl: async () => challenge, log: silent }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── score.mjs ────────────────────────────────────────────────────────

const usVendor = { controlCountry: "US", delivery: "non-eu", tracking: "ads", openness: 2, certifications: ["ISO 27001"], verified: true };
const euVendor = { controlCountry: "NL", delivery: "eu", tracking: "none", openness: 8, certifications: ["ISO 27001", "NEN 7510"], verified: true };

test("gradeOf: A ≥ 85 … E < 30, with SEAL levels", () => {
  assert.deepEqual([85, 84, 70, 50, 30, 29, 0].map((n) => gradeOf(n).grade), ["A", "B", "B", "C", "D", "E", "E"]);
  assert.equal(gradeOf(90).seal, "SEAL-4");
});

test("scorePlayer desk-only: EU vendor A, US vendor capped", () => {
  const eu = scorePlayer("X", euVendor);
  assert.deepEqual([eu.score, eu.grade, eu.measured], [98, "A", false]);
  const us = scorePlayer("Y", { ...usVendor, delivery: "eu", tracking: "none", openness: 10, certifications: ["ISO 27001", "C5"] });
  // 0 + 25 + 25 + 10 + 10 = 70, capped to 69 by US control
  assert.deepEqual([us.score, us.grade], [69, "C"]);
  assert.match(us.caps[0], /CLOUD Act/);
  assert.equal(scorePlayer("Z", usVendor).grade, "E");
  assert.equal(scorePlayer("Q", { ...euVendor, controlCountry: "GB" }).dims.J, 15);
});

test("scorePlayer: no vendor row → unrated, never guessed", () => {
  assert.deepEqual(scorePlayer("Mystery", undefined), { player: "Mystery", rated: false, reasons: ["not in the vendor table"] });
});

const sovFixture = (overrides = {}) => ({
  consent: { accepted: true, given: true, cookies: 3 },
  hosts: {
    "cdn.eu.nl": { eu: true, phases: { crawl: { requests: 6, pages: 2 }, pre: { requests: 0, pages: 0 }, play: { requests: 2, pages: 1 } } },
    "edge.us.com": { eu: true, nonEuInfra: true, phases: { crawl: { requests: 2, pages: 2 }, pre: { requests: 0, pages: 0 }, play: { requests: 0, pages: 0 } } },
    "ads.tracker.com": { eu: false, service: { category: "ads", company: "AdCo" }, phases: { crawl: { requests: 1, pages: 1 }, pre: { requests: 1, pages: 1 }, play: { requests: 0, pages: 0 } } },
  },
  cookies: [
    { name: "sid", domain: "edge.us.com", session: true, maxDays: 0, firstParty: false, players: ["P"], eu: true, phases: { crawl: 1, pre: 1, play: 0 } },
  ],
  storage: {},
  players: { P: { pages: { crawl: 2, pre: 1, play: 1 }, hosts: ["cdn.eu.nl", "edge.us.com"] } },
  ...overrides,
});

test("measurePlayer: an EU service on a US CDN counts as non-EU delivery", () => {
  const m = measurePlayer(sovFixture(), "P");
  assert.equal(m.leakPhase, "pre");
  assert.equal(m.euShare, 0.8); // 8 EU of 10 requests
  assert.deepEqual(m.preConsent.trackingCookies, []);
  assert.equal(m.preConsent.cookies.length, 1);
  assert.equal(measurePlayer(sovFixture(), "Nope"), null);
  assert.equal(measurePlayer(null, "P"), null);
});

test("scorePlayer measured: delivery and tracking from the scan win over desk", () => {
  const r = scorePlayer("P", euVendor, measurePlayer(sovFixture(), "P"));
  assert.equal(r.dims.D, 20); // 25 × 0.8
  assert.equal(r.dims.T, 13); // session cookie only
  assert.equal(r.measured, true);
});

test("scorePlayer measured: a persistent cookie before consent caps at D", () => {
  const sov = sovFixture({
    cookies: [{ name: "vuid", domain: "edge.us.com", session: false, maxDays: 400, firstParty: false, players: ["P"], eu: true, phases: { crawl: 1, pre: 1, play: 0 } }],
  });
  const r = scorePlayer("P", euVendor, measurePlayer(sov, "P"));
  assert.equal(r.dims.T, 0);
  assert.equal(r.score, 49);
  assert.equal(r.grade, "D");
  assert.match(r.caps[0], /vuid@edge.us.com/);
});

test("measurePlayer: without consent the crawl is the pre-consent phase", () => {
  const sov = sovFixture({ consent: { accepted: false, given: false, cookies: 0 } });
  sov.players.P.hosts.push("ads.tracker.com");
  const m = measurePlayer(sov, "P");
  assert.equal(m.leakPhase, "crawl");
  assert.deepEqual(m.preConsent.adHosts, ["ads.tracker.com"]);
});

test("scorePlayer: self-hosted engine takes jurisdiction from its hosts", () => {
  const engine = { type: "engine", openness: 10, verified: true };
  assert.equal(scorePlayer("HTML5 native", engine).rated, false);
  const r = scorePlayer("HTML5 native", engine, measurePlayer(sovFixture(), "P"));
  assert.equal(r.dims.J, 24); // 30 × 0.8
});

test("measurePlayer: per-player request counts win; unknown hosts and first-party storage left out", () => {
  const sov = sovFixture({
    storage: { "https://site.nl": { keys: ["cart"], phases: { crawl: 1, pre: 1, play: 0 } } },
  });
  sov.hosts["site.nl"] = { firstParty: true, eu: null, phases: { crawl: { requests: 50, pages: 2 }, pre: { requests: 9, pages: 1 }, play: { requests: 0, pages: 0 } } };
  sov.players.P.hosts.push("site.nl");
  // Only 1 of the host's 50 crawl requests to cdn.eu.nl belongs to P
  sov.players.P.requests = { crawl: { "cdn.eu.nl": 1, "edge.us.com": 1, "site.nl": 4 }, pre: {}, play: {} };
  const m = measurePlayer(sov, "P");
  assert.equal(m.euShare, 0.5);
  assert.equal(m.unknownRequests, 4);
  assert.deepEqual(m.preConsent.storage, []);
});

test("scorePlayer: no pre sample for the player → desk tracking, no cookie cap", () => {
  const sov = sovFixture({
    cookies: [{ name: "vuid", domain: "edge.us.com", session: false, maxDays: 400, firstParty: false, players: ["P"], eu: true, phases: { crawl: 1, pre: 0, play: 0 } }],
  });
  sov.players.P.pages.pre = 0;
  const m = measurePlayer(sov, "P");
  assert.equal(m.sampled, false);
  const r = scorePlayer("P", { ...euVendor, tracking: "ads" }, m);
  assert.equal(r.dims.T, 0);
  assert.deepEqual(r.caps, []);
  assert.match(r.reasons.join(" "), /not sampled before consent/);
});

test("scorePlayer: storage-only before consent is half T", () => {
  const sov = sovFixture({
    cookies: [],
    storage: { "https://cdn.eu.nl": { keys: ["vol"], phases: { crawl: 1, pre: 1, play: 0 } } },
  });
  assert.equal(scorePlayer("P", euVendor, measurePlayer(sov, "P")).dims.T, 13);
});

test("scorePlayer: unknown desk facts get half points; no control country gets none", () => {
  const r = scorePlayer("U", { controlCountry: "NL", delivery: "unknown", tracking: "unknown", openness: null, certifications: [] });
  assert.deepEqual([r.dims.D, r.dims.T, r.dims.O, r.dims.C], [13, 13, 5, 0]);
  assert.equal(scorePlayer("N", { ...euVendor, controlCountry: null }).dims.J, 0);
});

test("scoreSite: worst player is the site grade; pages count at their worst player", () => {
  const scan = {
    domain: "s.nl",
    playerSummary: { Good: { count: 2 }, Bad: { count: 1 }, Odd: { count: 1 } },
    details: [
      { url: "a", players: [{ name: "Good" }] },
      { url: "b", players: [{ name: "Good" }, { name: "Bad" }] },
      { url: "c", players: [{ name: "Odd" }] },
    ],
  };
  const r = scoreSite(scan, { Good: euVendor, Bad: usVendor });
  assert.equal(r.grade, "E");
  assert.deepEqual(r.pagesPerGrade, { A: 1, E: 1, unrated: 1 });
  assert.deepEqual(r.unrated, ["Odd"]);
  assert.equal(r.measured, false);
});

test("vendors.json: keys are detector names; every vendor row is sourced", async () => {
  const { loadVendors } = await import("./sovereignty/score.mjs");
  const vendors = loadVendors();
  for (const [name, v] of Object.entries(vendors)) {
    assert.ok(DETECTORS[name], `${name} is not a detector`);
    if (v.type === "engine") continue;
    assert.ok(v.controlCountry, `${name}: controlCountry`);
    assert.ok(v.sources?.length, `${name}: sources`);
    assert.ok(["eu", "mixed", "non-eu", "unknown"].includes(v.delivery), `${name}: delivery`);
    assert.ok(["none", "analytics", "ads", "unknown"].includes(v.tracking), `${name}: tracking`);
  }
});
