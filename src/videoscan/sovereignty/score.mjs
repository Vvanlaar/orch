// Sovereignty grade per player and per site, A–E (SEAL-4..0, after the EU
// Cloud Sovereignty Framework). Five dimensions; desk facts come from
// vendors.json, measured ones from a --mode sovereignty scan, and a measured
// value always wins over the desk default.
//   J jurisdiction  30  who controls the vendor (CLOUD Act / national law reach)
//   D delivery      25  share of the player's requests to EU-run hosts
//   T tracking      25  what the player sets or sends before consent
//   O openness      10  open formats, export, open-source player
//   C certification 10  ISO 27001 and national schemes
// Caps after the sum: US/CN control → max C; a persistent third-party cookie
// before consent → max D. A desk value nobody could confirm ("unknown") gets
// half the points and says so; a player without a vendor row is "unrated",
// never guessed.
import { readFileSync } from "node:fs";
import { PHASES } from "./collect.mjs";
import { isEuCountry } from "./resolve.mjs";

export const WEIGHTS = { J: 30, D: 25, T: 25, O: 10, C: 10 };

const GRADES = [
  { grade: "A", min: 85, seal: "SEAL-4" },
  { grade: "B", min: 70, seal: "SEAL-3" },
  { grade: "C", min: 50, seal: "SEAL-2" },
  { grade: "D", min: 30, seal: "SEAL-1" },
  { grade: "E", min: 0, seal: "SEAL-0" },
];
export const GRADE_ORDER = GRADES.map((g) => g.grade);
const CAP_CONTROL = 69; // top of C
const CAP_TRACKING = 49; // top of D

// Outside the EU but with an adequacy decision: personal data may go there,
// but EU law does not govern the vendor. Half the jurisdiction points.
const ADEQUACY = new Set(["GB", "CH", "CA", "JP", "KR", "NZ", "IL", "UY", "AR", "AD", "FO", "GG", "IM", "JE"]);
const NATIONAL_SCHEMES = new Set(["NEN 7510", "BIO", "C5", "SecNumCloud"]);

const half = (n) => Math.round(n / 2);

export function gradeOf(score) {
  return GRADES.find((g) => score >= g.min);
}

export function loadVendors(path = new URL("./vendors.json", import.meta.url)) {
  return JSON.parse(readFileSync(path, "utf-8")).vendors;
}

/**
 * What the scan measured for one player: its hosts (EU or not, by request
 * count) and what it left before consent. null when the scan has no
 * sovereignty data for it (a plain videoscan: desk facts only).
 */
export function measurePlayer(sov, player) {
  const p = sov?.players?.[player];
  if (!p) return null;
  // Before consent: the pre sample when consent took, else the crawl itself
  const leak = sov.consent?.given ? "pre" : "crawl";
  let eu = 0, nonEu = 0, unknown = 0;
  const hosts = [];
  const adHosts = [];
  for (const host of p.hosts) {
    const h = sov.hosts[host];
    if (!h) continue;
    // The player's own requests to the host; scans before per-player counts
    // fall back to the host total
    const requests = p.requests
      ? PHASES.reduce((n, ph) => n + (p.requests[ph]?.[host] || 0), 0)
      : PHASES.reduce((n, ph) => n + h.phases[ph].requests, 0);
    if (!requests) continue;
    // EU only when both the service and the network under it are
    const isEu = h.eu === true && !h.nonEuInfra;
    if (h.eu == null) unknown += requests;
    else if (isEu) eu += requests;
    else nonEu += requests;
    hosts.push({ host, requests, eu: h.eu == null ? null : isEu, country: h.country, company: h.service?.company || h.infra?.company || null });
    if (h.service?.category === "ads" && h.phases[leak].requests > 0) adHosts.push(host);
  }
  const playerHosts = new Set(p.hosts);
  const cookies = (sov.cookies || []).filter((c) => c.players.includes(player) && !c.firstParty && c.phases[leak] > 0);
  // A persistent cookie identifies the visitor across visits; a session or
  // bot-check cookie (Cloudflare __cf_bm, 30 min) does not
  const tracking = cookies.filter((c) => !c.session && c.maxDays > 1);
  const storage = Object.entries(sov.storage || {})
    .filter(([origin, s]) => {
      const host = new URL(origin).hostname;
      return s.phases[leak] > 0 && playerHosts.has(host) && !sov.hosts[host]?.firstParty;
    })
    .map(([origin, s]) => ({ origin, keys: s.keys }));
  return {
    leakPhase: leak,
    // false when no page with this player was loaded in the leak phase (pre
    // sample skipped, failed or left the player out) or the player sent nothing
    // in any phase (stedelijk.nl's Vimeo got full marks for a player that never
    // loaded): T falls back to desk. Quiet in the leak phase but active later is
    // a clean measurement: a site holding the embed back until consent or a
    // click. Scans before per-player counts have only the pages.
    sampled: (p.pages?.[leak] || 0) > 0 && (!p.requests || PHASES.some((ph) => Object.values(p.requests[ph] || {}).some(Boolean))),
    hosts: hosts.sort((a, b) => b.requests - a.requests),
    euShare: eu + nonEu > 0 ? eu / (eu + nonEu) : null,
    unknownRequests: unknown,
    preConsent: {
      cookies: cookies.map((c) => ({ name: c.name, domain: c.domain, days: c.session ? 0 : c.maxDays, eu: c.eu ?? null })),
      trackingCookies: tracking.map((c) => `${c.name}@${c.domain}`),
      nonEuCookies: cookies.filter((c) => c.eu === false).length,
      adHosts,
      storage,
    },
  };
}

/**
 * Grade one player. vendor: its vendors.json row; measured: measurePlayer()
 * or null. Every point comes with a reason, so the report can say why.
 */
export function scorePlayer(player, vendor, measured = null) {
  if (!vendor) return { player, rated: false, reasons: ["not in the vendor table"] };
  const reasons = [];
  const dims = {};
  const caps = [];

  // J — for a self-hosted engine the host's operator is the vendor
  if (vendor.type === "engine") {
    if (measured?.euShare == null) return { player, rated: false, reasons: ["self-hosted player: no host measured"] };
    dims.J = Math.round(WEIGHTS.J * measured.euShare);
    reasons.push(`self-hosted: ${Math.round(measured.euShare * 100)}% of requests to EU-run hosts`);
  } else {
    const cc = vendor.controlCountry;
    if (isEuCountry(cc)) {
      dims.J = WEIGHTS.J;
      reasons.push(`controlled from the EU (${cc})`);
    } else if (ADEQUACY.has(cc)) {
      dims.J = WEIGHTS.J / 2;
      reasons.push(`controlled from ${cc}: outside the EU, adequacy decision`);
    } else {
      dims.J = 0;
      reasons.push(`controlled from ${cc || "unknown"}: outside EU law`);
    }
    if (cc === "US" || cc === "CN") caps.push({ max: CAP_CONTROL, why: `${cc} control: ${cc === "US" ? "CLOUD Act / FISA 702" : "Chinese national law"} reaches the data, also in an EU region` });
  }

  // D
  if (measured?.euShare != null) {
    dims.D = Math.round(WEIGHTS.D * measured.euShare);
    reasons.push(`delivery: ${Math.round(measured.euShare * 100)}% of measured requests to EU-run hosts`);
  } else {
    dims.D = { eu: WEIGHTS.D, mixed: half(WEIGHTS.D), "non-eu": 0 }[vendor.delivery] ?? half(WEIGHTS.D);
    reasons.push(`delivery (not measured): ${vendor.delivery || "unknown"}`);
  }

  // T
  if (measured?.sampled) {
    const pc = measured.preConsent;
    if (pc.trackingCookies.length || pc.adHosts.length) {
      dims.T = 0;
      reasons.push(`before consent: ${[...pc.trackingCookies, ...pc.adHosts].slice(0, 4).join(", ")}`);
    } else if (pc.cookies.length || pc.storage.length) {
      dims.T = half(WEIGHTS.T);
      reasons.push(`before consent: session cookies or storage only${pc.nonEuCookies ? ` (${pc.nonEuCookies} from a non-EU host)` : ""}`);
    } else {
      dims.T = WEIGHTS.T;
      reasons.push("before consent: no cookies, storage or ad requests");
    }
    if (pc.trackingCookies.length) caps.push({ max: CAP_TRACKING, why: `persistent third-party cookie before consent (${pc.trackingCookies[0]})` });
  } else {
    dims.T = { none: WEIGHTS.T, analytics: half(WEIGHTS.T), ads: 0 }[vendor.tracking] ?? half(WEIGHTS.T);
    reasons.push(`tracking (${measured ? "not sampled before consent" : "not measured"}): ${vendor.tracking || "unknown"}`);
  }

  // O, C
  dims.O = vendor.openness == null ? half(WEIGHTS.O) : Math.max(0, Math.min(WEIGHTS.O, vendor.openness));
  if (vendor.openness == null) reasons.push("openness: unknown");
  const certs = vendor.certifications || [];
  dims.C = Math.min(WEIGHTS.C, (certs.includes("ISO 27001") ? 6 : 0) + (certs.some((c) => NATIONAL_SCHEMES.has(c)) ? 4 : 0));

  const sum = Object.values(dims).reduce((a, b) => a + b, 0);
  const cap = caps.reduce((m, c) => Math.min(m, c.max), 100);
  const score = Math.min(sum, cap);
  const g = gradeOf(score);
  return {
    player,
    rated: true,
    verified: vendor.verified === true,
    measured: Boolean(measured),
    score,
    grade: g.grade,
    seal: g.seal,
    dims,
    caps: caps.filter((c) => c.max < sum).map((c) => c.why),
    reasons,
  };
}

const worse = (a, b) => (GRADE_ORDER.indexOf(a) >= GRADE_ORDER.indexOf(b) ? a : b);

/**
 * Grade every player of a scan, and the site: its worst rated player, plus how
 * many video pages fall in each grade (a page counts at its worst player).
 */
export function scoreSite(scan, vendors) {
  const sov = scan.sovereignty || null;
  const names = Object.keys(scan.playerSummary || {});
  const players = names.map((name) => ({
    ...scorePlayer(name, vendors[name], measurePlayer(sov, name)),
    pages: scan.playerSummary[name].count,
  }));
  const byName = Object.fromEntries(players.map((p) => [p.player, p]));
  const pagesPerGrade = {};
  for (const d of scan.details || []) {
    const grades = d.players.map((p) => byName[p.name]).filter((p) => p?.rated).map((p) => p.grade);
    const key = grades.length ? grades.reduce(worse) : "unrated";
    pagesPerGrade[key] = (pagesPerGrade[key] || 0) + 1;
  }
  const rated = players.filter((p) => p.rated);
  return {
    domain: scan.domain,
    measured: Boolean(sov),
    grade: rated.length ? rated.map((p) => p.grade).reduce(worse) : null,
    players: players.sort((a, b) => b.pages - a.pages),
    pagesPerGrade,
    unrated: players.filter((p) => !p.rated).map((p) => p.player),
  };
}
