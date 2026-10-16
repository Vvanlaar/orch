# Videoscan Sovereignty Quick Scan — Plan

**Goal:** A videoscan mode that crawls ~500 pages of a prospect site, measures how European-sovereign each video player on it is, and adds a sovereignty topic to the quick-scan report (accessibility / privacy / sovereignty, selectable per segment).

**Status:** plan, not started. Research notes: [Appendix A](#appendix-a--what-sovereignty-means). Player list: [Appendix B](#appendix-b--player-sovereignty-list-draft).

## Decisions (from grill, 2026-10-16)

| Topic | Decision |
|---|---|
| Purpose | Sales report for a prospect. BB is the alternative. Claims must hold up (cite, date, no overclaim). |
| Measure | Network hosts → operator/country/ASN; cookies + storage before consent; whole-page third parties (always on since the meeting). |
| Output | ~~Own report/PDF~~ → one report with selectable topics (see meeting decisions). |
| Audience | Government/municipalities, media/publishers, corporates/education. |
| Consent | Measure before AND after consent. |
| Play click | Sample: per player type max 3 pages with a long settle (~8 s). |
| Page choice | Reuse the newest scan of the domain: all its video pages first, then crawl up to 500. No scan → normal crawl. |
| BB rating | BB has two offerings: "standard" (measured as is) and "BB Sovereign" (opt-in, fully EU, in progress). The report shows BB Sovereign only when a config flag says it is live. |

## Decisions (sales meeting, 2026-10-16) — supersede the rows above where they conflict

Source: machine transcript of the meeting recording (not in repo).

| Topic | Decision |
|---|---|
| Report modes | One report, three topics: **accessibility**, **privacy** (cookie consent), **sovereignty**. Pick per segment: accessibility only, sovereignty only, or combined. Media: no accessibility. |
| Scan scope | Always scan everything on the page (CMP/cookie wall, Google Analytics, fonts, other third parties). Extra checks on pages we already load = low cost. `--third-party` is no longer optional. |
| Report scope | Short, video-focused quick scan. It is a lead magnet (website download, sales sequence) that leads to a 15-min meeting. Do not give everything away. |
| Back pocket | Full-page findings stay internal (dashboard) for the follow-up meeting. Use them to show "only 1–2 non-EU modules → easy switch" vs "all US". |
| Out of scope | Full-website sovereignty advice is not BB's core. A partner does that; refer, do not sell. |
| Grey area | Website analytics (Google Analytics) is not video, but BB sells EU video analytics. Possible hook, not a report section yet. |

## Scoring model

Five dimensions, aligned with the EU Cloud Sovereignty Framework (SOV-1..8, SEAL-0..4). One grade per player per site, A–E.

| Dim | Weight | Source | What |
|---|---|---|---|
| J Jurisdiction | 30 | desk (vendor table) | HQ, ultimate owner, US/CN operating entity |
| D Delivery path | 25 | crawl | Share of player requests (JS, API, manifest, segments, thumbnails) to hosts run by non-EU operators |
| T Tracking | 25 | crawl | Player cookies/storage/third-party requests before consent; again after play |
| O Openness & exit | 10 | mixed | HLS/DASH/MP4 seen, open-source player, export API (desk) |
| C Certification | 10 | desk | ISO 27001, NEN 7510, BIO, C5, SecNumCloud |

**Grade:** A (SEAL-4) ≥ 85, B (SEAL-3) ≥ 70, C (SEAL-2) ≥ 50, D (SEAL-1) ≥ 30, E (SEAL-0) < 30.

**Hard caps** (applied after the weighted sum):
- US or CN operating entity → max C.
- Third-party tracking cookie before consent → max D.
- Vendor not in the table → "unrated", never a guess.

**Site grade:** worst player grade, plus the share of video pages per grade.

**Operator rule:** country = HQ of the company that runs the host (ASN owner / CDN brand), not the geo-IP of the edge. Anycast edges in Amsterdam still count as US when Cloudflare/Akamai/Fastly/AWS run them.

## Architecture

```
scan.mjs --mode sovereignty
  ├─ phase A: first N pages, no consent  → requests, cookies, storage per page
  ├─ phase B: accept consent, rest       → same
  ├─ play sample: ≤3 pages per player    → media/CDN hosts
  └─ JSON: sovereignty { hosts, cookies, players, phases }
sovereignty/resolve.mjs  host → CNAME chain → IP → ASN → operator → country
sovereignty/score.mjs    vendor table + measurements → grade per player/site
report.mjs --topics a11y,privacy,sovereignty → HTML → PDF
```

Data files (hand-kept, each row has `sources[]` + `lastVerified`):
- `src/videoscan/sovereignty/vendors.json` — key = DETECTORS name.
- `src/videoscan/sovereignty/operators.json` — host suffix + ASN org → operator, HQ country, EU yes/no.

ASN lookup: offline iptoasn.com dataset (public domain), cached in `videoscans/_data/`, monthly refresh. No per-IP calls to external APIs during a scan.

## Tasks

### Chunk 1 — Data + scoring (no scanner changes)
**Done 2026-10-16:** `sovereignty/vendors.json` (40 players; `verified` = ownership line sourced), `sovereignty/score.mjs` (desk + measured; unknown desk values score half), `scripts/sovereignty-from-scans.mjs` (market view → `<scanDir>/_reports`). Vendor facts were re-checked; corrections vs Appendix B: Kaltura EU regions predate Apr 2026; DailyMotion owner Canal+; Vidyard Canadian, hosted in US; JW Player is now JWX (JWP Connatix); iBabs 100% Euronext (EUR 53.2m, 2021); Vixy co-owner NEP NL belongs to US NEP Group (Carlyle, 26North); 23 Video on UpCloud/AWS IE with Fastly CDN; PingVP shows no ISO certificate. First market view (desk-only, 137 sites with video): 121 E, 16 unrated (self-hosted engines, not measured).
Open for BB: ownership/ISO 27001 are self-claims in the table (`verified: false`); openness/tracking for BB not filled.
1. Create `vendors.json` from Appendix B; resolve all **[V]** rows → verify: every row has ≥1 source URL.
2. Create `operators.json` (Google, Amazon, Microsoft, Akamai, Cloudflare, Fastly, Meta, ByteDance, Bunny, Leaseweb, OVH, Hetzner, Scaleway, KPN, …) → verify: unit test maps 20 known hosts.
3. `score.mjs` pure functions + tests (weights, caps, unrated) → verify: `pnpm test` green.
4. `scripts/sovereignty-from-scans.mjs`: desk-only grades for all existing scans (vendor table × `playerSummary`) → verify: CSV/markdown overview of 231 scans. Gives a market view now, before the scanner work.

### Chunk 2 — Scanner mode — **done 2026-10-16** (tasks 2 + 5–11)
As built: `src/videoscan/sovereignty/{collect,resolve}.mjs`, `operators.json`, tests in `sovereignty.test.mjs`. Deviations:
- Phases: `crawl` (with consent when `consent.given`), `pre` (≤20 pages reloaded without consent: start page, video pages round-robin, then others; only when consent took), `play`. Pre-consent leaks = `pre` when `consent.given`, else `crawl`.
- Play: ≤3 pages per player, in the bundled Chromium (headless Chrome ignores the YouTube click). Only requests after the play start count as "play".
- Sample contexts load images/media/fonts (pixels set cookies); the crawl keeps blocking them, so crawl cookie counts are a floor.
- All players per page, except generic engines (Video.js, MediaElement.js, …) next to a vendor player.
- Seeds ≤80% of max pages. Checkpoint carries mode, crawl data and unscanned seeds; a resume redoes the samples.
- Live checks 2026-10-16: ondernemendschiedam.nl (no banner clicked; YouTube + Vimeo cookies on load), menzis.nl (consent given; YouTube gated, pre-consent GTM/Azure/webchat; googlevideo via play).
- ASN: iptoasn.com db, auto-downloaded to `./_data/` (35-day refresh, `VIDEOSCAN_ASN_DB` overrides).
- Not yet: runner/dashboard flag (chunk 4); `--urls` + sovereignty is refused.
5. `--mode sovereignty`: default `--max-pages 500`, skip `filterToHighestTier` (keep all players per page) → verify: page with BB + YouTube reports both.
6. Request inventory per page: host, resource type, frame URL, phase; attribute to player via frame origin + detector script hosts + post-play window → verify: test fixture with an iframe player.
7. Consent phases: phase A = first `max(20, 10%)` pages without accept/replay; then accept once and continue. Record `context.cookies()` + storage keys per page → verify: YouTube page shows pre-consent cookies (or none, with nocookie).
8. Play sample: ≤3 pages per player type, unblock `media` in that context or log aborted media URLs, settle ~8 s → verify: Vimeo sample logs `vimeocdn`/`akamaized` hosts.
9. `resolve.mjs`: DNS CNAME chain + ASN + operator, cached per scan → verify: unit tests with recorded DNS answers.
10. Whole-page third parties (always on): CMP/cookie wall, analytics, fonts, other hosts → operator map. Store in JSON, not in the report → verify: GA site lists `google-analytics.com` as US.
11. `--seed-from <scan.json>`: video pages first in the queue, crawl fills up to max → verify: resume tests still pass.

### Chunk 3 — Report
12. `report.mjs --topics <a11y,privacy,sovereignty>` + segment presets (media = privacy+sovereignty; govt/corporate = all). Keep it short. New sovereignty template (Dutch): site grade, per-player cards (grade, why, evidence hosts, pre-consent leaks), map of operators/countries, "BB as alternative" (BB Sovereign only if live), method + sources + date, disclaimer → verify: HTML + PDF of 2 real sites, visual check.

### Chunk 4 — Runner, dashboard, DB
**Done 2026-10-16** (13, 14 minus report button, 15 `scan_mode` only): dashboard Mode select (Video/Sovereignty, 500 pages default), `mode` on `start-videoscan` (refused on `start-videoscan-urls`; URL-list subpages are skipped in sovereignty mode), `scanMode` on task/runner/list, badge in scan list, `videoscans.scan_mode` column applied to Supabase. Not yet: report button, `sovereignty` jsonb in DB, add-urls into a sovereignty scan keeps no sovereignty data.
13. Runner/server: `mode` option for start-videoscan; report spawn for the new report → verify: API start returns task.
14. Dashboard: mode toggle + 500 default + topic choice for the report + internal "full findings" view (all third parties, EU vs non-EU ratio) for the follow-up meeting → verify: browser check.
15. Supabase: add `scan_mode text`, `sovereignty jsonb` on `videoscans` (+ fix schema drift: `has_preview`, `has_preview_pdf`, `batch_id`, `batch_label` missing in `supabase-schema.sql`) → verify: upsert of a sovereignty scan.

## Risks
- **Legal claims in a sales report.** Print only verified rows. Every claim has a source + date. Do not call Vimeo/Brightcove "EU" because Bending Spoons is Italian — the US operating companies stay. DPF still stands (appeal C-703/25 P pending).
- **No primary source** for an AP ruling on YouTube embeds on government sites. Do not cite one until found.
- **Attribution** of requests to a player is heuristic; show evidence, not only a grade.
- **BB itself** gets measured. The standard offering may score B or C (US CDN?). Check before the first customer report.
- **Tracker lists:** DuckDuckGo Tracker Radar is CC BY-NC-SA (not for commercial use). Keep our own operator map.
- **Scan time:** play sample + two phases add time; 500 pages must stay under ~1 h.

## Open questions
1. BB Sovereign: launch date, and which parts (storage, transcoding, CDN, player JS, analytics) change?
2. Legal/marketing review of the report text before the first prospect?
3. Weights: is Tracking (privacy) or Jurisdiction (CLOUD Act) the stronger sales angle per audience? Media sites care less about jurisdiction, more about ad-tech.
4. ~~Teaser line about non-video findings?~~ **Decided:** not in the teaser report; maybe in the full report.
5. ~~GA as hook?~~ **Decided:** sales talk only for now.
6. Report review: done by us (Claude self-review), no separate legal round for now.

**Order:** scanner extension first (chunk 2 + resolver/operator map). Scoring, report and the other open questions later.

## Appendix A — What sovereignty means

See research summary in the chat log of 2026-10-16. Key points:
- **Jurisdiction:** a US parent or US operating entity → CLOUD Act / FISA 702 reach, also with data in an EU region.
- **EU-US DPF:** General Court dismissed Latombe (T-553/23, 3 Sep 2025); appeal C-703/25 P pending. Legally fragile.
- **Delivery:** AWS, GCP, Azure, Akamai, Cloudflare, Fastly are US-owned. EU region ≠ sovereign.
- **Tracking:** `youtube-nocookie` defers cookies until play; Google data flows still occur on play.
- **Openness:** Data Act (since 12 Sep 2025) gives switching rights; switching charges end 12 Jan 2027.
- **Frameworks:** EU Cloud Sovereignty Framework v1.2.1 (Oct 2025): SOV-1..8, SEAL-0..4. EUCS sovereignty clauses dropped (verify). National: SecNumCloud (FR), C5 (DE), NEN 7510, BIO.
- **NL context:** Kamer motions June 2025 (more EU cloud), Rijksbreed cloudbeleid 2026 (exit plans, geopolitical risk), DigiD/Solvinity motion Apr 2026.

## Appendix B — Player sovereignty list (draft)

Desk research + one DNS/ASN/header probe per host from NL (2026-10-16). **[V]** = unverified or vendor self-claim. "Sites" = count in 231 existing scans. Grades are provisional; the crawl measurement can lower them (tracking cap). Raw probe table + vendor sources: [2026-10-16-videoscan-sovereignty-probe.md](2026-10-16-videoscan-sovereignty-probe.md).

### Seen in existing scans

| Player | Sites | HQ / owner | Front door (measured ASN) | US/CN control | Grade |
|---|---|---|---|---|---|
| YouTube | 120 | US, Alphabet | Google AS15169 | yes | **E** |
| Vimeo | 43 | US op. entity; owner Bending Spoons (IT) since 24 Nov 2025 | Cloudflare + Fastly | yes | **D** (C with Enterprise EU residency) |
| Spotify (podcast) | 18 | SE / Spotify Technology S.A. (LU) [V] | Fastly; backend GCP | no (EU) but all-US infra | **C** [V tracking] |
| Video.js | 16 | OSS | depends on host → measure | depends | measured |
| HTML5 native | 16 | n/a | depends on host → measure | depends | measured |
| TikTok | 7 | ByteDance (CN), IE entity | Akamai AS20940 | yes (CN) | **E** |
| PingVP | 6 | NL (Amersfoort), owner not stated | KPN AS1136; storage CloudNL, CDN Gcore (LU) | no | **B** [V ISO, owner] |
| Brightcove | 5 | US; Bending Spoons since 4 Feb 2025 | Fastly | yes | **D** |
| OpenGemeenten | 5 | NL CMS, no own player found [V] | — | — | unrated → grade underlying source |
| Kaltura | 4 | US/IL, listed | Akamai AS16625; EU region since Apr 2026 | yes | **D** (C with EU region) |
| Instagram | 4 | US, Meta | Meta | yes | **E** |
| Facebook Video | 4 | US, Meta | Meta | yes | **E** |
| Blue Billywig | 2 | NL (Hilversum), independent since 2006 | `bbvms.com` → **AWS CloudFront AS16509**; `cdn.bluebillywig.com` → Bunny (SI); storage Scaleway (FR) | no | **B** standard; **A** target for BB Sovereign |
| X (Twitter) | 2 | US | — | yes | **E** |
| LinkedIn | 2 | US, Microsoft | — | yes | **E** |
| DailyMotion | 1 | FR, Canal+/Vivendi [V] | AWS CloudFront | no, but ad-tech heavy | **D** [V tracking] |

### Detected but not seen yet

| Player | HQ / owner | Front door | Grade |
|---|---|---|---|
| JW Player | US | CloudFront | D |
| Wistia | US | CloudFront → Fastly | D |
| Vidyard | CA, US presence | Fastly | D |
| Flowplayer | SE; Wowza (US, Clearhaven PE) since 2022 | — | D |
| Panopto | US | — | D |
| Hihaho | NL (Assen); app AWS EU, video stored at JW Player (US) | CloudFront | C [V ISO lapsed 2025-11] |
| Ivory | NL, 3 staff; hosting unknown | — | unrated |
| Rijksoverheidsplayer | NL govt; media `*.rovid.nl` | Cloudflare / Akamai | C [V builder/host] |
| Vixy | NL; NEP NL (US parent NEP Group) [V] | Cloudflare (site only) | C [V] |
| Company Webcast | Euronext (NL/FR), 51%+ | AWS eu-west-1 | C |
| iBabs | Euronext (100% since 2021 [V]) | AWS eu-west-1 | C |
| StreamPartner | NL; owner unknown | Serverius AS50673 (NL) | B [V] |
| 23 Video | DK, independent [V] | Fastly | C [V hosting] |
| bunny.net Stream | SI, independent | Bunny / Datacamp (UK) [V] | B |
| PeerTube | OSS (Framasoft FR) | instance host → measure | measured |
| Cloudflare Stream / Mux | US | Cloudflare / Fastly | D |
| Loom | US, Atlassian | — | D |
| Twitch | US, Amazon | — | E |
| Mediasite | Enghouse (CA) | — | D |

### Key finding for BB
BB claims "Scaleway + Bunny, EU", but the player front door `bbvms.com` answers via AWS CloudFront. A US CDN on the player path makes BB standard a **B**, not an **A**, in its own scan. Fix this in the sovereignty push before the first prospect report.
