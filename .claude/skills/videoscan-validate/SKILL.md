---
name: videoscan-validate
description: Check whether a videoscan or scan batch is finished, verify its player detections against the live pages, and fix the false positives (detector regex + the already-written report data). Triggers on "is de scan klaar", "check de scan", "valideer de scan", "kloppen de resultaten", "false positives", "wrap up the scan", "validate videoscan".
---

# Validate a videoscan

Three phases, in order. Each one can be the whole job — stop when the answer is
in. Everything below runs against the **main checkout** (`C:\dev\orch`), because
that is where the always-on LAN service writes `videoscans/`; the scripts
resolve that path themselves, so run them from anywhere including a worktree.

```bash
node .claude/skills/videoscan-validate/scripts/scan-status.mjs
```

The API needs a bearer token (`~/.claude/bb-support-web/tokens.json`, the row
named "Vince (admin)"). Export it once: `export ORCH_TOKEN=<admin token>`.

## Phase 1 — is it done?

`scan-status.mjs [target]` — target is a batch id, part of a batch label, or a
domain. It reports, per batch: running scans, queued-but-unfinished scans,
dead hosts, duplicate scan files, and whether the batch is already closed.

What "done" means:

- **Nothing live.** A running scan is a `_heartbeat-<taskId>.json` newer than
  60s. Older heartbeats are crashed runs whose file was never cleaned up — they
  look alarming and mean nothing.
- **No queue left.** `_state.queue.length > 0` means the crawl stopped early —
  usually because it reached the `--max-pages` its caller passed (the API
  defaults to 50; the dashboard's big crawls are launched with far more). That
  ceiling is a stopping point, not a finish line, and wrap-up accepts the
  partial coverage as final.
- **A live scan in the SAME batch blocks wrap-up.** scan.mjs writes its JSON on
  exit, so a write landing after the merge silently undoes it.
- **A running scan may not admit which batch it is in.** Only a scan launched
  as part of a batch carries `batchId`, and an in-progress file often has none
  at all, so it cannot be matched to the batch from disk. `scan-status.mjs`
  lists those separately and refuses to print "ready" while anything crawls —
  check the hostnames against the batch yourself.

Decide with the user before wrapping up a batch that still has queue left —
accepting partial coverage is their call, and resuming a crawl that already ran
for tens of thousands of pages costs hours. Then:

```bash
curl -s -X POST -H "Authorization: Bearer $ORCH_TOKEN" -H 'Content-Type: application/json' \
  -d '{"batchId":"<id>"}' http://127.0.0.1:3011/api/videoscans/batch/wrap-up
```

That clears the queues, merges same-domain duplicates, writes a
`…-summary.json` plus HTML/PDF, and marks the batch closed. It only groups
files that carry the batch id — an orphaned `…-INPROGRESS.json` for a domain
already in the batch stays behind as a duplicate. Delete it once you have
confirmed the batch file covers strictly more pages:

```bash
curl -s -X DELETE -H "Authorization: Bearer $ORCH_TOKEN" -H 'Content-Type: application/json' \
  -d '{"filenames":["videoscan-<host>-INPROGRESS.json"]}' http://127.0.0.1:3011/api/videoscans
```

## Phase 2 — do the results hold up?

```bash
node .claude/skills/videoscan-validate/scripts/scan-audit.mjs <batch|file|domain>
```

Per detected player it prints the page count, which evidence strings actually
fired, the hosts, sample URLs, and a risk verdict. The verdict only ranks what
to open first — **the live page decides, never the audit**.

What earns a flag, and why:

- **Markup match with no network evidence.** Nothing was loaded; a substring in
  the HTML is the entire case.
- **One marker carries every hit.** Whole player rests on a single regex, so a
  single bad regex takes the whole count with it.
- **Share/watch link shape** (`vimeo.com/<id>`, `youtu.be/…`, `youtube.com/watch`).
  A link to a recording is not a player on the page.
- **≤3 pages** — verify all of them, it is free.
- **Hundreds of hits on one host** — one template, so one page settles it.
- **Generic players co-occurring** (Video.js / HTML5 native / MediaElement.js /
  Plyr). Video.js *is* a `<video>` tag, so both fire on the same embed. Not a
  bug, but never report those counts as two separate findings.

Then open at least one sample page per player in the built-in browser and read
the DOM — a screenshot cannot tell a poster image from a player:

```js
await new Promise(r => setTimeout(r, 4000));
({
  title: document.title,
  videos: [...document.querySelectorAll('video')].map(v => ({ src: v.currentSrc || v.src, srcs: [...v.querySelectorAll('source')].map(s => s.src), dur: v.duration, w: v.offsetWidth, h: v.offsetHeight })),
  iframes: [...document.querySelectorAll('iframe')].map(f => ({ src: f.src, w: f.offsetWidth, h: f.offsetHeight })),
  jw: window.jwplayer ? (window.jwplayer().getPlaylist() || []).map(i => i.file) : null,
})
```

A detection passes when the page yields a real media URL (`.mp4`, `.m3u8`,
`.mpd`), an embed iframe on a video host, or a player API with a playlist. It
fails when the only match sits in body text, a `data-*` payload, a link href,
or an unrelated word. `<video>` with an empty `src` is inconclusive: JW Player
and friends fill it on play — ask the player API instead (`getPlaylist()`), and
check the media URL over HTTP before calling it real:

```bash
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" "<media url>"
```

## Phase 3 — fix what is wrong

### 3a. The detector (`src/videoscan/scan.mjs`)

Players live in one object of `{ patterns: [...], scripts: [...] }`. Read the
patterns for the player you disproved before writing anything — the shape of
the false positive decides the fix. Two shapes have bitten this scanner
already, and the comment beside each surviving pattern records which string
fooled it:

- **Unanchored substring.** `/kWidget/i` matched the tail of `zoekwidget1.php`,
  an unrelated search widget. Now `/\bkWidget\s*\./`: word-anchored, followed by
  the API dot, and case-sensitive because the vendor spells it in camelCase
  (which holds only as long as the corpus keeps its case — `extractEncodedMarkup`
  lowercases for needle tests only).
- **Share link mistaken for an embed.** `/vimeo\.com\/\d+/i` and `/youtu\.be\//i`
  fired on pages that merely linked to a recording. `stripAnchorHrefs` only
  strips `<a href>`, so the URL still reaches the corpus from body text, JSON
  and `data-*`. Both are gone; the embed shapes stayed (`player.vimeo.com`,
  `youtube.com/embed`, `vimeocdn.com`, `data-vimeo-id`) and the embed-only
  paths a share link cannot reach were added
  (`vimeo.com/event|showcase/<id>/embed`).

Rules for a fix: narrow the pattern, never the detector — the player must still
be found on a real embed. Leave a one-line comment saying which string fooled
it, the way the `youtu.be` removal does. Then add **two** tests to
`src/videoscan/scan.test.mjs`: the false positive must go, and a real embed of
that same player must survive.

```bash
node --test src/videoscan/scan.test.mjs   # or: pnpm.cmd test
```

### 3b. The report that already shipped

A regex fix does not touch scans that already ran, and re-crawling tens of
thousands of pages to correct four rows is not worth it. Prune the
confirmed-false detections and regenerate:

```bash
node .claude/skills/videoscan-validate/scripts/scan-prune.mjs <batch> --player Kaltura --evidence kwidget
# dry run first; add --apply to write (keeps a .bak per file)
```

`--evidence` drops a detection when *any* evidence string matches. When the
bad marker is boilerplate that real embeds carry too (WP Rocket's
`youtube-player` CSS), use `--only-evidence "HTML: youtube-player,HTML: ytimg.com"`
instead: it drops only detections whose *every* evidence string is on the list.

It removes the matching detections, drops pages that had no other player, and
recomputes `pagesWithVideo` / `uniquePlayers` / `playerSummary` — in every file
of the batch, the summary included, since the summary carries its own copy of
every member's rows. Report the scan-file totals it prints, not those plus the
summary's: the summary's rows are the same findings counted again.

Afterwards regenerate the HTML/PDF and push the corrected rows (the script
prints both calls). Do **not** re-run wrap-up to rebuild the summary:
`mergeScansData` keeps whichever copy of a URL has the most players, so any
same-domain duplicate still holding the pruned rows brings them straight back.

Prune only what a browser check disproved. A detection you merely find
suspicious stays in, with a note to the user.

## Reporting back

Give the user a table of player → pages → verified sample → verdict, and state
plainly what the corrected totals are. Say which numbers overlap (generic
players on the same `<video>`) and which domains were cut off at the page cap —
both change how the report reads to a customer.

Commit detector fixes and their tests; the running LAN service only picks them
up after a merge and rebuild, so say so rather than implying the fix is live.
