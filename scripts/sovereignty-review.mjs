#!/usr/bin/env node
// Per-run diagnostic for a --mode sovereignty scan: the grade it produced, and
// everything that kept it from being better evidence. Where
// sovereignty-from-scans.mjs answers "what does the market look like", this one
// answers "do I believe this run, and what do I fix before the next one".
//
//   node scripts/sovereignty-review.mjs <scan.json> [more.json ...] [--log <file>]
//   node scripts/sovereignty-review.mjs --trend [--log <file>]
//
// Every run appends one JSON line to the log, so --trend shows whether a fix
// moved the numbers. The log lives beside the first scan in _reports/; with no
// scan to go by (--trend on its own) it falls back to $VIDEOSCAN_DIR/_reports,
// like sovereignty-from-scans.mjs. Read-only on the scans.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { loadVendors, measurePlayer, scoreSite } from '../src/videoscan/sovereignty/score.mjs';

const DEFAULT_LOG = 'sovereignty-runs.jsonl';
const TOP_GAPS = 12; // per list: enough to act on, short enough to read

// ── args ─────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const files = [];
  let log = null;
  let trend = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--log') {
      log = argv[++i];
      if (!log) throw new Error('--log needs a path');
    } else if (argv[i] === '--trend') trend = true;
    else if (argv[i].startsWith('-')) throw new Error(`unknown flag: ${argv[i]}`);
    else files.push(argv[i]);
  }
  return { files, log, trend };
}

/** Beside the scan, in _reports/, unless --log says otherwise. */
export function logPath(explicit, firstScan) {
  if (explicit) return resolve(explicit);
  const base = firstScan ? dirname(resolve(firstScan)) : (process.env.VIDEOSCAN_DIR || 'videoscans');
  return join(base, '_reports', DEFAULT_LOG);
}

// ── gaps ─────────────────────────────────────────────────────────────

const PHASES = ['crawl', 'pre', 'play'];
const hostRequests = (h) => PHASES.reduce((n, p) => n + (h.phases?.[p]?.requests || 0), 0);
// Not only media: a player's config call is xhr and its loader is script, so
// an unclaimed host of any of these types is worth a look. Tag managers and
// analytics beacons land here too — the list is a prompt, not a defect count.
const INTERESTING_TYPES = new Set(['media', 'xhr', 'fetch', 'script']);

/**
 * True when resolveHosts() ran for this scan. It writes `chain` on every host
 * (resolve.mjs), so not one host carrying it means the whole resolution step
 * failed and scan.mjs fell back to toJSON() without it — every host then looks
 * unresolved for one reason that has nothing to do with the operator tables.
 */
export function resolutionRan(hosts) {
  return !hosts.length || hosts.some(([, h]) => 'chain' in h);
}

/**
 * What this run could not answer, each list pointing at the one file that
 * fixes it. A gap is not a bug in the site — it is a blind spot in the scan.
 * `measured` maps player → measurePlayer(), computed once by the caller.
 */
export function findGaps(scan, site, measured) {
  const sov = scan.sovereignty || {};
  const hosts = Object.entries(sov.hosts || {});
  const thirdParty = hosts.filter(([, h]) => !h.firstParty && hostRequests(h) > 0);

  // operators.json: no service suffix, no CNAME, no ASN could name an owner
  const unresolved = thirdParty
    .filter(([, h]) => h.eu == null)
    .map(([host, h]) => ({
      host,
      requests: hostRequests(h),
      asn: h.asnName || null,
      ip: h.ip || null,
      blocked: Boolean(h.blocked),
      ipv6Only: Boolean(h.ipv6Only),
    }))
    .sort((a, b) => b.requests - a.requests);

  // DETECTORS / attributeRequest: busy third-party hosts no player claimed
  const unattributed = thirdParty
    .filter(([, h]) => !h.players?.length && h.types?.some((t) => INTERESTING_TYPES.has(t)))
    .map(([host, h]) => ({ host, requests: hostRequests(h), types: h.types.join(','), service: h.service?.service || h.infra?.company || null }))
    .sort((a, b) => b.requests - a.requests);

  // EU service, non-EU network under it: the D dimension already counts these
  // as non-EU, so this is a finding to show a customer, not a blind spot
  const nonEuInfra = thirdParty
    .filter(([, h]) => h.nonEuInfra)
    .map(([host, h]) => ({ host, service: h.service?.service || null, infra: h.infra?.company || null, country: h.infra?.country || null }));

  // pickSamples: a player the pre pass never loaded falls back to desk tracking
  const unsampled = site.players.filter((p) => measured.get(p.player) && !measured.get(p.player).sampled).map((p) => p.player);
  const noPlay = site.players.filter((p) => {
    const pages = sov.players?.[p.player]?.pages;
    return pages && !pages.play;
  }).map((p) => p.player);

  return { unresolved, unattributed, nonEuInfra, unsampled, noPlay, unrated: site.unrated, resolved: resolutionRan(hosts), thirdParty: thirdParty.length };
}

// ── printing ─────────────────────────────────────────────────────────

const gradeColor = (g) => ({ A: chalk.green, B: chalk.greenBright, C: chalk.yellow, D: chalk.redBright, E: chalk.red })[g] || chalk.gray;

function printGapList(title, rows, fixIn, render) {
  if (!rows.length) return;
  console.log(chalk.bold.yellow(`\n  ${title}`) + chalk.gray(`  → ${fixIn}`));
  for (const r of rows.slice(0, TOP_GAPS)) console.log('    ' + render(r));
  if (rows.length > TOP_GAPS) console.log(chalk.gray(`    ... and ${rows.length - TOP_GAPS} more`));
}

/** Why a host has no owner: a blocked answer is this machine's resolver, not the site. */
function unresolvedReason(r) {
  if (r.blocked) return 'A record blocked by the resolver';
  if (r.ipv6Only) return 'IPv6 only (no A record)';
  return r.asn ? `${r.asn}${r.ip ? ` · ${r.ip}` : ''}` : `no ASN match${r.ip ? ` · ${r.ip}` : ''}`;
}

function printScan(file, scan, vendors) {
  const sov = scan.sovereignty || null;
  const site = scoreSite(scan, vendors);
  const measured = new Map(site.players.map((p) => [p.player, measurePlayer(sov, p.player)]));
  const gaps = findGaps(scan, site, measured);

  console.log('\n' + chalk.bold.blue('═'.repeat(72)));
  console.log(chalk.bold.blue(`  ${scan.domain}`) + chalk.gray(`   ${scan.scanDate?.slice(0, 19) || '?'}   ${file}`));
  console.log(chalk.bold.blue('═'.repeat(72)));

  if (!sov) console.log(chalk.red('\n  Not a sovereignty scan (no measurements) — the grades below are desk-only.'));

  // Consent first: it decides which phase counts as "before consent", so a
  // failed banner click quietly turns T into a desk value for every player.
  if (sov) {
    const c = sov.consent;
    const pages = sov.pages || {};
    console.log(chalk.bold(`\n  Pages   crawl ${pages.crawl || 0} · pre ${pages.pre || 0} · play ${pages.play || 0}`));
    if (!c?.accepted) {
      console.log(chalk.bold.red('  Consent  no banner accepted — "before consent" is the crawl itself; T is measured, but the site may simply have no banner'));
    } else if (!c.given) {
      console.log(chalk.bold.red('  Consent  banner clicked but no consent state stuck — the pre/crawl split is unreliable, treat T with suspicion'));
    } else {
      console.log(chalk.green(`  Consent  accepted, ${c.cookies} consent cookie(s) — the pre pass is the pre-consent evidence`));
    }
    if (!pages.pre) console.log(chalk.yellow('  No pre pass ran: every player falls back to desk tracking facts'));
    if (!pages.play) console.log(chalk.yellow('  No play pass ran: the media path (manifest, segments, CDN) is unmeasured'));
  }

  // Scorecard
  console.log(chalk.bold.yellow('\n  ── Players ───────────────────────────────────────────────────'));
  for (const p of site.players) {
    const m = measured.get(p.player);
    if (!p.rated) {
      console.log(`\n  ${chalk.gray('?')} ${chalk.bold(p.player)} ${chalk.gray(`(${p.pages} pages)`)} ${chalk.red('unrated')} — ${p.reasons.join('; ')}`);
      continue;
    }
    const col = gradeColor(p.grade);
    const dims = Object.entries(p.dims).map(([k, v]) => `${k}${v}`).join(' ');
    console.log(`\n  ${col.bold(p.grade)} ${chalk.bold(p.player)} ${chalk.gray(`(${p.pages} pages)`)}  ${col(`${p.score}/100`)} ${chalk.gray(dims)}${p.verified ? '' : chalk.yellow('  desk facts unverified')}`);
    if (m) {
      // euShare is also null when every host resolved to an unknown country,
      // which is a different thing from having measured no hosts at all
      const eu = m.euShare != null ? `${Math.round(m.euShare * 100)}% EU-run`
        : m.hosts.length ? 'no host placed in or out of the EU'
          : 'no hosts measured';
      console.log(chalk.gray(`     ${eu}, ${m.hosts.length} host(s)${m.unknownRequests ? `, ${m.unknownRequests} request(s) to unresolved hosts` : ''}${m.sampled ? '' : ', not sampled before consent'}`));
    }
    for (const r of p.reasons) console.log(chalk.gray(`     · ${r}`));
    for (const cap of p.caps) console.log(chalk.redBright(`     ! capped: ${cap}`));
  }

  const siteGrade = site.grade ? gradeColor(site.grade).bold(site.grade) : chalk.gray('unrated');
  console.log(chalk.bold(`\n  Site grade: ${siteGrade}`) + chalk.gray(`  (worst rated player)   pages per grade: ${Object.entries(site.pagesPerGrade).map(([g, n]) => `${g}:${n}`).join(' ') || '—'}`));

  // A finding, not a blind spot — so it sits with the scorecard
  printGapList('EU service on a non-EU network', gaps.nonEuInfra, 'worth showing a customer', (r) =>
    `${chalk.white(r.host.padEnd(44))} ${chalk.gray(`${r.service || '?'} via ${r.infra || '?'}${r.country ? ` (${r.country})` : ''}`)}`);

  if (!sov) {
    console.log(chalk.gray('\n  No measurements in this file — nothing to review beyond the desk grades above.'));
    return metrics(file, scan, site, gaps);
  }

  console.log(chalk.bold.yellow('\n  ── What this run could not answer ────────────────────────────'));
  if (!gaps.resolved) {
    console.log(chalk.bold.red(
      '\n  Host resolution never ran for this scan (resolveHosts failed): no host has an owner.' +
      '\n  Re-resolve before reading the list below — operators.json is not the fix.'
    ));
  }
  printGapList('Unrated players (no vendor row)', gaps.unrated.map((p) => ({ p })), 'sovereignty/vendors.json', (r) => chalk.white(r.p));
  if (gaps.resolved) {
    printGapList('Unresolved hosts (no owner, no country)', gaps.unresolved, 'sovereignty/operators.json', (r) =>
      `${chalk.white(r.host.padEnd(44))} ${String(r.requests).padStart(5)} req  ${chalk.gray(unresolvedReason(r))}`);
  }
  printGapList('Busy third-party hosts no player claimed', gaps.unattributed, 'scan.mjs DETECTORS / attributeRequest', (r) =>
    `${chalk.white(r.host.padEnd(44))} ${String(r.requests).padStart(5)} req  ${chalk.gray(`${r.types}${r.service ? ` · ${r.service}` : ''}`)}`);
  printGapList('Players never loaded before consent', gaps.unsampled.map((p) => ({ p })), 'sovereignty/collect.mjs pickSamples', (r) => chalk.white(r.p));
  printGapList('Players with no play sample', gaps.noPlay.map((p) => ({ p })), 'sovereignty/collect.mjs playVideos', (r) => chalk.white(r.p));

  const clean = gaps.resolved && !gaps.unrated.length && !gaps.unresolved.length && !gaps.unattributed.length && !gaps.unsampled.length && !gaps.noPlay.length;
  if (clean) console.log(chalk.green('\n  Nothing unresolved — the tables covered every host and player this run saw.'));

  return metrics(file, scan, site, gaps);
}

// ── metrics log ──────────────────────────────────────────────────────

/** One line per run: the numbers a fix is supposed to move. */
export function metrics(file, scan, site, gaps) {
  const sov = scan.sovereignty || {};
  const requests = Object.entries(sov.hosts || {})
    .filter(([, h]) => !h.firstParty)
    .reduce((n, [, h]) => n + hostRequests(h), 0);
  const unresolvedRequests = gaps.unresolved.reduce((n, g) => n + g.requests, 0);
  return {
    date: new Date().toISOString(),
    file,
    domain: scan.domain,
    scanDate: scan.scanDate,
    measured: Boolean(scan.sovereignty),
    resolved: gaps.resolved,
    pagesScanned: scan.pagesScanned,
    pages: sov.pages || null,
    consent: sov.consent ? { accepted: sov.consent.accepted, given: sov.consent.given } : null,
    grade: site.grade,
    grades: Object.fromEntries(site.players.map((p) => [p.player, p.rated ? p.grade : 'unrated'])),
    hostsThirdParty: gaps.thirdParty,
    hostsUnresolved: gaps.unresolved.length,
    unresolvedRequestShare: requests ? Math.round((unresolvedRequests / requests) * 1000) / 1000 : 0,
    playersTotal: site.players.length,
    playersUnrated: gaps.unrated.length,
    playersUnsampled: gaps.unsampled.length,
    playersNoPlay: gaps.noPlay.length,
    hostsUnattributed: gaps.unattributed.length,
  };
}

/** Grades as a comparable string: the log's key order follows page counts, which reorder between crawls. */
export const gradeKey = (g) => Object.keys(g || {}).sort().map((k) => `${k}=${g[k]}`).join('|');

/** Which players changed grade between two runs, as "YouTube B→C". */
export function gradeMoves(prev, now) {
  const moves = [];
  for (const k of new Set([...Object.keys(prev || {}), ...Object.keys(now || {})])) {
    if (prev?.[k] !== now?.[k]) moves.push(`${k} ${prev?.[k] ?? '—'}→${now?.[k] ?? '—'}`);
  }
  return moves;
}

/**
 * The log grouped by domain, by scan date: the same site re-scanned after a fix
 * should show the gap counts falling, and its grades standing still. A grade
 * that moves between two runs of an unchanged site is a flake, not a finding.
 */
function printTrend(file) {
  if (!existsSync(file)) {
    console.log(chalk.yellow(`No run log yet at ${file}`));
    return;
  }
  const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean);
  const runs = [];
  let skipped = 0;
  for (const l of lines) {
    try { runs.push(JSON.parse(l)); } catch { skipped++; } // a killed run can leave a partial line
  }
  if (skipped) console.log(chalk.yellow(`  ${skipped} unreadable log line(s) skipped`));

  const byDomain = new Map();
  for (const r of runs) {
    if (!byDomain.has(r.domain)) byDomain.set(r.domain, []);
    byDomain.get(r.domain).push(r);
  }
  console.log(chalk.bold.blue(`\n  ${runs.length} run(s) across ${byDomain.size} domain(s) — ${file}\n`));
  for (const [domain, list] of byDomain) {
    console.log(chalk.bold(`  ${domain}`));
    list.sort((a, b) => (a.scanDate || '').localeCompare(b.scanDate || ''));
    let prev = null;
    for (const r of list) {
      const g = r.grade ? gradeColor(r.grade).bold(r.grade) : chalk.gray('—');
      const moves = prev && gradeKey(prev) !== gradeKey(r.grades) ? gradeMoves(prev, r.grades) : [];
      console.log(
        `    ${r.scanDate?.slice(0, 16) || '?'}  site ${g}  ` +
        chalk.gray(`unresolved ${r.hostsUnresolved} (${Math.round(r.unresolvedRequestShare * 100)}% of req) · unrated ${r.playersUnrated} · unsampled ${r.playersUnsampled} · unclaimed hosts ${r.hostsUnattributed}`) +
        (r.measured && !r.resolved ? chalk.redBright('  ← host resolution failed') : '') +
        (moves.length ? chalk.redBright(`  ← ${moves.join(', ')}`) : '')
      );
      prev = r.grades;
    }
    console.log('');
  }
}

// ── main ─────────────────────────────────────────────────────────────

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(chalk.red(err.message));
    process.exit(2);
  }
  const log = logPath(args.log, args.files[0]);

  if (args.trend) {
    printTrend(log);
    return;
  }
  if (!args.files.length) {
    console.error('usage: sovereignty-review.mjs <scan.json> [...] [--log <file>]   |   --trend [--log <file>]');
    process.exit(2);
  }

  const vendors = loadVendors();
  const lines = [];
  let failed = 0;
  for (const file of args.files) {
    let scan;
    try {
      scan = JSON.parse(readFileSync(file, 'utf-8'));
    } catch (err) {
      console.error(chalk.red(`  ${file}: unreadable (${err.message})`));
      failed++;
      continue;
    }
    lines.push(printScan(file, scan, vendors));
  }
  if (failed) process.exitCode = 1;
  if (!lines.length) return;

  try {
    mkdirSync(dirname(log), { recursive: true });
    appendFileSync(log, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    console.log(chalk.gray(`\n  ${lines.length} run(s) logged to ${log}${failed ? `, ${failed} file(s) unreadable` : ''} — compare with --trend\n`));
  } catch (err) {
    console.log(chalk.yellow(`\n  Could not append to ${log} (${err.message}) — the report above is still valid\n`));
  }
}

// Importable for tests; runs only when invoked directly.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
