# Videoscan Sovereignty Quick Scan — Plan

**Goal:** A videoscan mode that crawls ~500 pages of a prospect site, measures how European-sovereign each video player on it is, and produces a separate sales report (PDF).

**Status:** plan, not started. Research notes: [Appendix A](#appendix-a--what-sovereignty-means). Player list: [Appendix B](#appendix-b--player-sovereignty-list-draft).

## Decisions (from grill, 2026-10-16)

| Topic | Decision |
|---|---|
| Purpose | Sales report for a prospect. BB is the alternative. Claims must hold up (cite, date, no overclaim). |
| Measure | Network hosts → operator/country/ASN; cookies + storage before consent; whole-page third parties as an option (`--third-party`). |
| Output | Own report/PDF, next to the current videoscan report. |
| Audience | Government/municipalities, media/publishers, corporates/education. |
| Consent | Measure before AND after consent. |
| Play click | Sample: per player type max 3 pages with a long settle (~8 s). |
| Page choice | Reuse the newest scan of the domain: all its video pages first, then crawl up to 500. No scan → normal crawl. |
| BB rating | BB has two offerings: "standard" (measured as is) and "BB Sovereign" (opt-in, fully EU, in progress). The report shows BB Sovereign only when a config flag says it is live. |

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
report-sovereignty.mjs   own templates → HTML → PDF
```

Data files (hand-kept, each row has `sources[]` + `lastVerified`):
- `src/videoscan/sovereignty/vendors.json` — key = DETECTORS name.
- `src/videoscan/sovereignty/operators.json` — host suffix + ASN org → operator, HQ country, EU yes/no.

ASN lookup: offline iptoasn.com dataset (public domain), cached in `videoscans/_data/`, monthly refresh. No per-IP calls to external APIs during a scan.

## Tasks

### Chunk 1 — Data + scoring (no scanner changes)
1. Create `vendors.json` from Appendix B; resolve all **[V]** rows → verify: every row has ≥1 source URL.
2. Create `operators.json` (Google, Amazon, Microsoft, Akamai, Cloudflare, Fastly, Meta, ByteDance, Bunny, Leaseweb, OVH, Hetzner, Scaleway, KPN, …) → verify: unit test maps 20 known hosts.
3. `score.mjs` pure functions + tests (weights, caps, unrated) → verify: `pnpm test` green.
4. `scripts/sovereignty-from-scans.mjs`: desk-only grades for all existing scans (vendor table × `playerSummary`) → verify: CSV/markdown overview of 231 scans. Gives a market view now, before the scanner work.

### Chunk 2 — Scanner mode
5. `--mode sovereignty`: default `--max-pages 500`, skip `filterToHighestTier` (keep all players per page) → verify: page with BB + YouTube reports both.
6. Request inventory per page: host, resource type, frame URL, phase; attribute to player via frame origin + detector script hosts + post-play window → verify: test fixture with an iframe player.
7. Consent phases: phase A = first `max(20, 10%)` pages without accept/replay; then accept once and continue. Record `context.cookies()` + storage keys per page → verify: YouTube page shows pre-consent cookies (or none, with nocookie).
8. Play sample: ≤3 pages per player type, unblock `media` in that context or log aborted media URLs, settle ~8 s → verify: Vimeo sample logs `vimeocdn`/`akamaized` hosts.
9. `resolve.mjs`: DNS CNAME chain + ASN + operator, cached per scan → verify: unit tests with recorded DNS answers.
10. `--third-party`: classify all non-player third-party hosts with the operator map → verify: flag off = no extra output.
11. `--seed-from <scan.json>`: video pages first in the queue, crawl fills up to max → verify: resume tests still pass.

### Chunk 3 — Report
12. `report-sovereignty.mjs` + templates (Dutch): cover, site grade, per-player cards (grade, why, evidence hosts, pre-consent leaks), map of operators/countries, "BB as alternative" (BB Sovereign only if live), method + sources + date, disclaimer → verify: HTML + PDF of 2 real sites, visual check.

### Chunk 4 — Runner, dashboard, DB
13. Runner/server: `mode` option for start-videoscan; report spawn for the new report → verify: API start returns task.
14. Dashboard: mode toggle + 500 default + "sovereignty report" button → verify: browser check.
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
