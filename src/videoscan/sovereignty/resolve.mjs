// Host → who runs it. Two layers, both by company HQ, never by edge location:
// an anycast CDN answers from Amsterdam for a US company (Cloudflare, Fastly,
// CloudFront), so geo-IP would call it Dutch.
//   service: the product the hostname belongs to (youtube.com → Google)
//   infra:   the network behind it — CNAME chain first (d1x.cloudfront.net →
//            Amazon), then the ASN of its IPv4 address, then the ASN's own
//            registry country as a last resort.
import { Resolver } from "node:dns/promises";
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { isIPv4, isIPv6 } from "node:net";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

const OPERATORS = JSON.parse(readFileSync(new URL("./operators.json", import.meta.url), "utf-8"));

// EU + EEA. GB and CH have adequacy decisions but are outside EU jurisdiction.
const EU_EEA = new Set("AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO".split(" "));
export const isEuCountry = (cc) => EU_EEA.has(cc);

const bySuffixLength = (a, b) => b.suffix.length - a.suffix.length;
const SERVICES = [...OPERATORS.services].sort(bySuffixLength);
const CNAMES = [...OPERATORS.cnames].sort(bySuffixLength);

const hostMatches = (host, suffix) => host === suffix || host.endsWith("." + suffix);

function company(name, via, extra = {}) {
  const c = OPERATORS.companies[name];
  const country = c?.country ?? null;
  return { company: name, country, eu: country ? isEuCountry(country) : null, via, ...extra };
}

/** The product a hostname belongs to, or null. */
export function classifyService(host) {
  const s = SERVICES.find((s) => hostMatches(host, s.suffix));
  if (!s) return null;
  return { service: s.service, category: s.category, ...(s.company ? company(s.company, "service") : {}) };
}

/** Infra company from the CNAME chain, else ASN, else the ASN registry. */
export function classifyInfra(chain, asn) {
  for (const name of chain) {
    const c = CNAMES.find((c) => hostMatches(name, c.suffix));
    if (c) return company(c.company, "cname", c.service ? { service: c.service } : {});
  }
  if (!asn) return null;
  const known = OPERATORS.asns[String(asn.asn)];
  if (known) return company(known, "asn", { asn: asn.asn });
  return { company: asn.name, country: asn.country, eu: asn.country ? isEuCountry(asn.country) : null, via: "asn-registry", asn: asn.asn };
}

// ── ASN database ─────────────────────────────────────────────────────
// iptoasn.com ip2asn-v4 (public domain): "start end asn country description",
// one range per line, sorted by start. ~500k lines; parsed once per scan.

const ASN_DB_URL = "https://iptoasn.com/data/ip2asn-v4.tsv.gz";
const ASN_DB_MAX_AGE_MS = 35 * 24 * 3600 * 1000;

export function defaultAsnDbPath() {
  return process.env.VIDEOSCAN_ASN_DB || join(process.cwd(), "_data", "ip2asn-v4.tsv.gz");
}

const ipToInt = (ip) => ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);

export function parseAsnDb(tsv) {
  const lines = tsv.split("\n");
  const start = new Float64Array(lines.length);
  const end = new Float64Array(lines.length);
  const rows = [];
  let n = 0;
  for (const line of lines) {
    const [s, e, asn, country, name] = line.split("\t");
    if (!e || asn === "0") continue; // asn 0 = not routed
    start[n] = ipToInt(s);
    end[n] = ipToInt(e);
    rows[n] = { asn: Number(asn), country: country === "None" ? null : country, name: (name || "").trim() };
    n++;
  }
  return {
    lookup(ip) {
      const x = ipToInt(ip);
      let lo = 0, hi = n - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (start[mid] > x) hi = mid - 1;
        else if (end[mid] < x) lo = mid + 1;
        else return rows[mid];
      }
      return null;
    },
  };
}

/** The ASN db, downloaded when missing or older than 35 days; null when unavailable. */
export async function loadAsnDb(path = defaultAsnDbPath(), { fetchImpl = fetch, log = console.log } = {}) {
  const stale = !existsSync(path) || Date.now() - statSync(path).mtimeMs > ASN_DB_MAX_AGE_MS;
  if (stale) {
    try {
      const res = await fetchImpl(ASN_DB_URL, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      // A 200 can be a challenge page or cut short: check before it replaces
      // the copy that works
      parseAsnDb(gunzipSync(body).toString("utf-8"));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.tmp`, body);
      renameSync(`${path}.tmp`, path);
    } catch (err) {
      // An old copy still beats none: ASN ownership changes slowly
      if (!existsSync(path)) {
        log(`  ASN database unavailable (${err.message}): hosts resolve by name and CNAME only`);
        return null;
      }
      log(`  ASN database refresh failed (${err.message}), using the old copy`);
    }
  }
  try {
    return parseAsnDb(gunzipSync(readFileSync(path)).toString("utf-8"));
  } catch (err) {
    log(`  ASN database unreadable (${err.message}): hosts resolve by name and CNAME only`);
    return null;
  }
}

// ── DNS ──────────────────────────────────────────────────────────────

/**
 * CNAME chain (aliases only, not the host itself) and first IPv4 address.
 * ipv6Only: no A record but an AAAA one (no ASN lookup: the db is IPv4).
 * blocked: an answer of 0.0.0.0 or 127/8 — a filtering resolver, not the host.
 */
export async function resolveDns(host, resolver) {
  const bare = host.replace(/^\[|\]$/g, "");
  if (isIPv4(bare)) return { chain: [], ip: bare };
  if (isIPv6(bare)) return { chain: [], ip: null, ipv6Only: true };
  const chain = [];
  let name = host;
  for (let i = 0; i < 8; i++) {
    const next = await resolver.resolveCname(name).then((r) => r[0], () => null);
    if (!next || chain.includes(next)) break;
    chain.push(next);
    name = next;
  }
  const ip = await resolver.resolve4(name).then((r) => r[0], () => null);
  if (ip && /^(0\.0\.0\.0|127\.)/.test(ip)) return { chain, ip: null, blocked: true };
  if (!ip && (await resolver.resolve6(name).then((r) => r.length > 0, () => false))) return { chain, ip: null, ipv6Only: true };
  return { chain, ip };
}

/**
 * Resolve every host. Returns { [host]: { chain, ip, asn, service, infra, country, eu } }.
 * country/eu: the service company when there is one (it controls the data),
 * else the infra company. nonEuInfra flags an EU service on a non-EU network
 * (an EU vendor behind CloudFront).
 */
export async function resolveHosts(hosts, { asnDb = null, resolver = new Resolver({ timeout: 3000, tries: 2 }), concurrency = 16 } = {}) {
  const out = {};
  const list = [...hosts];
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const host = list[next++];
      const { chain, ip, ...dnsFlags } = await resolveDns(host, resolver).catch(() => ({ chain: [], ip: null }));
      const asn = ip && asnDb ? asnDb.lookup(ip) : null;
      const service = classifyService(host);
      const infra = classifyInfra(chain, asn);
      const owner = service?.company ? service : infra;
      out[host] = {
        chain,
        ip,
        ...dnsFlags,
        ...(asn ? { asn: asn.asn, asnName: asn.name } : {}),
        ...(service ? { service } : {}),
        ...(infra ? { infra } : {}),
        country: owner?.country ?? null,
        eu: owner?.eu ?? null,
        ...(owner?.eu && infra && infra.eu === false ? { nonEuInfra: true } : {}),
      };
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return out;
}
