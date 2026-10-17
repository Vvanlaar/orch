// Sovereignty mode (scan.mjs --mode sovereignty): what each page loads, from
// whom, and what it stores, per phase:
//   crawl  the crawl itself — with consent when consent.given, else without
//   pre    sample reloaded without consent (only run when consent.given)
//   play   sample with the player started (with consent when consent.given)
// What leaks before consent: "pre" when consent.given, else "crawl".
// scan.mjs captures per page; the collector aggregates per host, cookie and
// player, so 500 pages of request logs never sit in memory.

export const PHASES = ["crawl", "pre", "play"];
const zero = () => Object.fromEntries(PHASES.map((p) => [p, 0]));
const MAX_EXAMPLES = 3;
const MAX_STORAGE_KEYS = 50;

const stripQuery = (url) => url.split(/[?#]/)[0];
const hostOf = (url) => {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

/** Same organisation as the scanned site: the domain itself or a subdomain. */
export function isFirstParty(host, domain) {
  const h = host.replace(/^www\./, "");
  return h === domain || h.endsWith("." + domain);
}

// ── Per-page capture ─────────────────────────────────────────────────

/**
 * Start recording on a page. Every request with its resource type and the URL
 * of the frame that made it: a request from inside the YouTube iframe belongs
 * to YouTube even when its own host (doubleclick.net) says nothing.
 * mark() starts the play window: requests after it get the "play" phase.
 */
export function startCapture(page) {
  const requests = [];
  let playFrom = Infinity;
  page.on("request", (req) => {
    // The outermost embedded frame: an ad iframe nested in the YouTube iframe
    // is still YouTube's. Main-frame requests carry no frame URL — the page's
    // own URL would match a player pattern on a path like /video/...
    let frameUrl = "";
    try {
      let frame = req.frame();
      const main = page.mainFrame();
      while (frame && frame.parentFrame() && frame.parentFrame() !== main) frame = frame.parentFrame();
      if (frame && frame !== main) frameUrl = frame.url();
    } catch { /* service worker, or a frame already gone */ }
    requests.push({ url: req.url(), type: req.resourceType(), frameUrl });
  });
  return {
    mark() { playFrom = requests.length; },
    /** Forget what came before (the first page's reload after its banner click). */
    reset() { requests.length = 0; playFrom = Infinity; },
    /** Requests, cookies and storage keys so far. */
    async snapshot() {
      const cookies = await page.context().cookies().catch(() => []);
      return {
        requests: requests.map((r, i) => (i >= playFrom ? { ...r, play: true } : r)),
        cookies: cookies.map((c) => ({ name: c.name, domain: c.domain.replace(/^\./, ""), session: c.expires === -1, expires: c.expires })),
        storage: await readFrameStorage(page),
      };
    },
  };
}

// localStorage keys per frame origin (keys only: values can hold personal
// data). Cross-origin frames included — yt-remote-device-id lives in the
// YouTube iframe, not on the site.
async function readFrameStorage(page) {
  const out = {};
  for (const frame of page.frames()) {
    let origin;
    try { origin = new URL(frame.url()).origin; } catch { continue; }
    if (!/^https?:/.test(origin) || out[origin]) continue;
    const keys = await frame.evaluate(() => Object.keys(localStorage)).catch(() => null);
    if (keys?.length) out[origin] = keys.slice(0, MAX_STORAGE_KEYS);
  }
  return out;
}

// ── Play sample ──────────────────────────────────────────────────────

/**
 * Start one player on a page, so its media path (manifest, segments, CDN)
 * shows up. Iframe player: a click in the middle of up to 3 iframes that match
 * its detector, plus muted play() inside them. No matching iframe: the player
 * is in the page, so muted play() on the page's own <video> elements.
 * click: false when an activation placeholder already started it — a second
 * click on the playing iframe would pause it.
 */
export async function playVideos(page, detector, { settleMs = 8000, click = true } = {}) {
  const matches = (src) => [...(detector?.patterns || []), ...(detector?.scripts || [])].some((re) => {
    re.lastIndex = 0;
    return re.test(src);
  });
  const main = page.mainFrame();
  const playerFrames = page.frames().filter((f) => f !== main && matches(f.url()));
  let clicked = 0;
  for (const handle of click ? await page.$$("iframe[src]").catch(() => []) : []) {
    if (clicked >= 3) break;
    const src = (await handle.getAttribute("src").catch(() => null)) || "";
    if (!matches(src)) continue;
    await handle.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    const box = await handle.boundingBox().catch(() => null);
    if (!box || box.width < 100 || box.height < 60) continue;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
    clicked++;
  }
  for (const frame of playerFrames.length ? playerFrames : [main]) {
    await frame.evaluate(() => {
      for (const v of document.querySelectorAll("video")) {
        v.muted = true;
        v.play?.()?.catch?.(() => {});
      }
    }).catch(() => {});
  }
  await page.waitForTimeout(settleMs);
  return clicked;
}

// ── Sample choice ────────────────────────────────────────────────────

/**
 * Pages for the pre-consent and play passes, from the crawl results.
 * pre: the start page, then video pages round-robin over players, then pages
 * without video, up to `pre`. play: up to `perPlayer` pages per player.
 */
export function pickSamples(results, startUrl, { pre = 20, perPlayer = 3 } = {}) {
  const ok = results.filter((r) => !r.error);
  const byPlayer = new Map();
  for (const r of ok) {
    for (const { player } of r.players) {
      if (!byPlayer.has(player)) byPlayer.set(player, []);
      byPlayer.get(player).push(r.url);
    }
  }
  const play = [...byPlayer].map(([player, urls]) => ({ player, urls: urls.slice(0, perPlayer) }));

  const preUrls = [];
  const add = (u) => { if (preUrls.length < pre && !preUrls.includes(u)) preUrls.push(u); };
  if (ok.some((r) => r.url === startUrl)) add(startUrl);
  const lists = [...byPlayer.values()].map((urls) => [...urls]);
  while (preUrls.length < pre && lists.some((l) => l.length)) {
    for (const l of lists) if (l.length) add(l.shift());
  }
  for (const r of ok) if (!r.players.length) add(r.url);
  return { pre: preUrls, play };
}

// ── Aggregation ──────────────────────────────────────────────────────

const emptyRequests = () => Object.fromEntries(PHASES.map((p) => [p, {}]));
const emptyPhases = () => Object.fromEntries(PHASES.map((p) => [p, { requests: 0, pages: 0 }]));

/**
 * Which detected player a request belongs to: a detector pattern on the
 * request URL or on its frame URL. A media request (manifest, segment, <video>
 * source) nobody claims goes to the page's only player, if it has one.
 */
export function attributeRequest(req, pagePlayers, detectors) {
  const url = stripQuery(req.url);
  const frame = stripQuery(req.frameUrl || ""); // empty for the main frame
  for (const name of pagePlayers) {
    const d = detectors[name];
    if (!d) continue;
    for (const re of [...d.scripts, ...d.patterns]) {
      re.lastIndex = 0;
      if (re.test(url)) return name;
      re.lastIndex = 0;
      if (frame && re.test(frame)) return name;
    }
  }
  const media = req.type === "media" || /\.(m3u8|mpd|mp4|webm|m4s|ts)$/i.test(url);
  if (media && pagePlayers.length === 1) return pagePlayers[0];
  return null;
}

/**
 * Collector for one scan. `prev` is an earlier run's toJSON() (a resumed
 * scan, or its checkpoint): its crawl phase is kept, its samples are redone.
 */
export function createSovereigntyCollector({ domain, detectors, prev = null }) {
  const hosts = new Map();   // host → { phases, types, players, examples, pages }
  const cookies = new Map(); // name|domain → { name, domain, session, maxDays, phases }
  const storage = new Map(); // origin → { keys, phases }
  const players = new Map(); // name → { phases: { crawl|pre|play: pages }, hosts, requests: { phase: { host: n } } }
  const pages = zero();
  // accepted: a banner button was clicked. given: that click left consent
  // cookies/storage behind, which every crawl page then carries.
  const meta = { accepted: false, given: false, cookies: 0 };

  if (prev) restore(prev);

  function restore(prev) {
    pages.crawl = prev.pages?.crawl || 0;
    Object.assign(meta, prev.consent || {});
    for (const [host, h] of Object.entries(prev.hosts || {})) {
      if (!h.phases?.crawl?.requests) continue;
      hosts.set(host, {
        phases: { ...emptyPhases(), crawl: { ...h.phases.crawl } },
        types: new Set(h.types),
        players: new Set(h.players),
        examples: (h.examples || []).filter((e) => e.phase === "crawl"),
        firstParty: h.firstParty,
      });
    }
    const crawlOnly = (n) => ({ ...zero(), crawl: n });
    for (const c of prev.cookies || []) {
      if (!c.phases?.crawl) continue;
      cookies.set(`${c.name}|${c.domain}`, { name: c.name, domain: c.domain, session: c.session, maxDays: c.maxDays, phases: crawlOnly(c.phases.crawl) });
    }
    for (const [origin, s] of Object.entries(prev.storage || {})) {
      if (s.phases?.crawl) storage.set(origin, { keys: new Set(s.keys), phases: crawlOnly(s.phases.crawl) });
    }
    // Hosts are restored from the hosts that were seen in the crawl
    for (const [name, p] of Object.entries(prev.players || {})) {
      if (!p.pages?.crawl) continue;
      players.set(name, {
        phases: crawlOnly(p.pages.crawl),
        hosts: new Set(p.hosts.filter((h) => hosts.has(h))),
        requests: { ...emptyRequests(), crawl: { ...p.requests?.crawl } },
      });
    }
  }

  function player(name) {
    if (!players.has(name)) players.set(name, { phases: zero(), hosts: new Set(), requests: emptyRequests() });
    return players.get(name);
  }

  return {
    setConsent({ accepted, given, cookies: count }) {
      Object.assign(meta, { accepted, given, cookies: count });
    },

    /** One page load. players: detectPlayers() output; capture: startCapture().snapshot(). */
    recordPage({ url, phase, players: detected = [], capture }) {
      if (!capture) return;
      const names = detected.map((d) => d.player);
      pages[phase]++;
      for (const n of names) player(n).phases[phase]++;

      const seenOnPage = new Set();
      for (const req of capture.requests) {
        const host = hostOf(req.url);
        if (!host) continue;
        const reqPhase = req.play ? "play" : phase;
        let h = hosts.get(host);
        if (!h) {
          h = { phases: emptyPhases(), types: new Set(), players: new Set(), examples: [], firstParty: isFirstParty(host, domain) };
          hosts.set(host, h);
        }
        h.phases[reqPhase].requests++;
        if (!seenOnPage.has(host + reqPhase)) {
          seenOnPage.add(host + reqPhase);
          h.phases[reqPhase].pages++;
        }
        h.types.add(req.type);
        const owner = attributeRequest(req, names, detectors);
        if (owner) {
          h.players.add(owner);
          const p = player(owner);
          p.hosts.add(host);
          p.requests[reqPhase][host] = (p.requests[reqPhase][host] || 0) + 1;
        }
        const example = stripQuery(req.url).slice(0, 150);
        if (h.examples.length < MAX_EXAMPLES && !h.examples.some((e) => e.url === example)) {
          h.examples.push({ url: example, page: url, phase: reqPhase });
        }
      }

      for (const c of capture.cookies) {
        const key = `${c.name}|${c.domain}`;
        let k = cookies.get(key);
        if (!k) {
          k = { name: c.name, domain: c.domain, session: c.session, maxDays: 0, phases: zero() };
          cookies.set(key, k);
        }
        k.phases[phase]++;
        if (!c.session) k.maxDays = Math.max(k.maxDays, Math.round((c.expires * 1000 - Date.now()) / 86_400_000));
      }

      for (const [origin, keys] of Object.entries(capture.storage)) {
        let s = storage.get(origin);
        if (!s) {
          s = { keys: new Set(), phases: zero() };
          storage.set(origin, s);
        }
        s.phases[phase]++;
        for (const k of keys) if (s.keys.size < MAX_STORAGE_KEYS) s.keys.add(k);
      }
    },

    hosts: () => [...hosts.keys()],

    /**
     * JSON for the scan file. resolved: resolveHosts() output, merged into each
     * host; cookies get the players and resolution of the hosts they belong to.
     */
    toJSON(resolved = {}) {
      const hostJson = {};
      const seen = (h) => h.phases.crawl.pages + h.phases.pre.pages;
      for (const [host, h] of [...hosts].sort((a, b) => seen(b[1]) - seen(a[1]))) {
        hostJson[host] = {
          firstParty: h.firstParty,
          phases: h.phases,
          types: [...h.types].sort(),
          players: [...h.players].sort(),
          examples: h.examples,
          ...(resolved[host] || {}),
        };
      }
      const cookieOwner = (domainName) => Object.entries(hostJson).find(([host]) => host === domainName || host.endsWith("." + domainName));
      const cookieJson = [...cookies.values()].map((c) => {
        const match = cookieOwner(c.domain);
        const owner = match?.[1];
        return {
          ...c,
          firstParty: isFirstParty(c.domain, domain),
          players: owner?.players || [],
          ...(owner ? { country: owner.country ?? null, eu: owner.eu ?? null, ...(owner.service ? { service: owner.service.service } : {}) } : {}),
        };
      });
      return {
        consent: meta,
        pages,
        hosts: hostJson,
        cookies: cookieJson,
        storage: Object.fromEntries([...storage].map(([o, s]) => [o, { keys: [...s.keys], phases: s.phases }])),
        players: Object.fromEntries([...players].map(([n, p]) => [n, { pages: p.phases, hosts: [...p.hosts].sort(), requests: p.requests }])),
      };
    },
  };
}
