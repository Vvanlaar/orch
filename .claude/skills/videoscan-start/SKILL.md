---
name: videoscan-start
description: Start a videoscan on the running orch service for a DigiToegankelijk organisation (dashboard.digitoegankelijk.nl/organisaties/<id>) or a single site, report what else the server has open, watch the batch until it settles, then hand over to videoscan-validate. Triggers on "start een videoscan voor <gemeente>", "scan <gemeente>", "start videoscan", a digitoegankelijk organisation URL, "houd de scan in de gaten", "start a videoscan", "watch the scan".
---

# Start and watch a videoscan

Five steps: look, launch, watch, validate, report. The scripts talk to the always-on LAN
service on `127.0.0.1:3011` (never start a second server for this) and find the
admin token themselves — `$ORCH_TOKEN`, else `~/.claude/bb-support-web/tokens.json`.
Run them from anywhere, a worktree included.

## 1. Look — dry run

```bash
node .claude/skills/videoscan-start/scripts/scan-start.mjs https://dashboard.digitoegankelijk.nl/organisaties/13
```

The target is an organisation URL, a bare organisation id, or a plain site URL.
Without `--apply` nothing is started. It prints two things to act on.

**Open tasks on the server.** Tell the user what is there; do not stop any of it
yourself. A paused videoscan titled `HOLD …` is deliberate — it keeps its
batch's auto-merge from firing — and stopping it changes that batch, not this
one. The list covers the 100 newest tasks; `videoscan-validate`'s
`scan-status.mjs` shows crawls that are live right now.

**The plan.** One batch, built the way the dashboard's import builds it: per
host, a site listed at its root is crawled, anything else (`/p/login`,
`supplier.nl/<gemeente>`) is scanned as that one page. Read it before
launching:

- **Sites that are not this organisation's alone** stay under 500 pages. A
  national or supplier site is in every customer's list and is not their
  content: `verlorenofgevonden.nl` (tens of thousands of lost-item pages, no
  video in the first thousand), `multisignaal.nl` (a vendor's product site).
  Name them in `--shared host,host`; they are still crawled, capped at 499
  pages (`--shared-max-pages`). The dry run marks every crawl whose hostname
  does not carry the organisation's name with `? shared site?` — a hint, not a
  verdict. The organisation's own tenant on a platform (`<org>.archiefweb.eu`,
  `hlmr.sharepoint.com`) and its project sites (`tegenstroom.nl`) are theirs;
  open the homepage when the name does not say, and ask the user when the
  homepage does not either. `--exclude host,host` drops a site altogether —
  only when the user asks for that.
- **`! overwrites a stopped crawl's checkpoint`** — scan.mjs checkpoints to one
  fixed `…-INPROGRESS.json` per host, so a fresh crawl replaces what an
  earlier, stopped crawl left. Fine when that crawl is abandoned; if it is
  worth keeping, resume it instead (`/api/actions/resume-videoscan`).
  **`! a crawl of this host is LIVE`** is the same file with a crawl still
  writing it: do not start a second one.
- **Bottomless hosts** (`archiefweb.eu`, a `beeldbank.*`, a raadsinformatie
  archive) run to the page cap. That is what `--max-pages` is for; the default
  20000 is the dashboard's, and a capped crawl is reported as cut off, not as
  finished.

## Ask the user

Two questions, unless the request already answered them. Ask them together
with the dry-run findings:

1. **Report title** — the organisation's name as the customer reads it on the
   cover, e.g. "Gemeente Haarlemmermeer". The import only knows a lowercase
   domain slug ("haarlemmermeer"), which is not a title.
2. **Cover image** — URL of a photo for the report cover.

Neither is needed until the report is generated, so do not hold the launch for
them: launch, and store the answers when they come.

```bash
# known up front: pass them at launch
node …/scan-start.mjs <target> --title "Gemeente Haarlemmermeer" --cover "https://…/photo.jpg" --apply
# answered after launch
node …/scan-report.mjs <batchId> --title "Gemeente Haarlemmermeer" --cover "https://…/photo.jpg" --save
```

Both values come from a chat message: quote them, and pass nothing through the
shell that the user did not type.

## 2. Launch

Same command, same flags, plus `--apply`. It prints the batch id and writes a
launch manifest (task ids, title, cover) for the later steps. The service runs
a fixed number of crawls at once and queues the rest; a 50-site organisation
takes hours.

## 3. Watch

```bash
node .claude/skills/videoscan-start/scripts/scan-watch.mjs <batchId> --interval 120 --step 8
```

Run it **in the background** (`run_in_background`) so its exit wakes the
session — do not poll by hand. It prints a line when the counts change and
exits when nothing is pending or running:

| exit | meaning |
|---|---|
| 0 | every scan completed |
| 1 | settled, but some scans failed or were dismissed — listed in the output |
| 2 | usage error, or the server refused the request (token, scope) |
| 3 | only paused tasks left; someone has to resume or stop them |
| 4 | the server stopped answering |
| 10 | `--step N`: N more scans completed, batch still busy |

**Validate as scans finish, not only at the end.** With `--step N` the watcher
exits 10 each time N more scans have completed and names their hosts. Run
phases 2 and 3 of `videoscan-validate` on the batch then (the audit only sees
finished files), and start the watcher again. A finished scan's file is final,
so pruning it now is safe — and it means the merge the service does at the end
is built from rows that were already checked. Look at coverage too while the
crawl is fresh: a scan that stopped at one page (a redirect off the host, an
expired certificate, a login wall, a single-page app) or lost a quarter of its
requests to timeouts is a finding for the user, not a clean zero.

`--once` prints the current state and returns (exit 0 while still busy), for a
progress question in between. A failed task (`scan.mjs exited with code null`
is a killed process) keeps its `…-INPROGRESS.json`; say which hosts those are
rather than calling the batch complete. A scan the service restarted on its
own (a resume or retry is a new task in the same batch) is followed too, and
only its latest attempt counts.

There is no changing a task's page cap after launch. To re-cap a site in a
running batch: delete its task while it is still pending
(`DELETE /api/tasks/<id>`) and start it again with
`/api/actions/start-videoscan` and the same `batchId` / `batchLabel`; the
watcher picks the new task up by its batch id.

When the batch's last task reaches a final state — failed counts — the service
merges the completed scans into one `videoscan-<org>-organisatie-…-merged.json`
and renders its report, provided at least two scans completed. That merged file
is the organisation's report. The batch itself stays open: a `…-summary.json`
and the closed mark come only from a manual wrap-up (see `videoscan-validate`).

## 4. Validate

Invoke the `videoscan-validate` skill with the batch id. Its phase 1 confirms
nothing is still live and names the hosts that stopped at the page cap; phases
2 and 3 check the detections against the live pages and prune what does not
hold.

## 5. Report

Last, after any pruning — the report is rendered from the data as it stands:

```bash
node .claude/skills/videoscan-start/scripts/scan-report.mjs <batchId>
```

It regenerates the batch's merged (or wrapped-up summary) report with the
stored title and cover image; `--title` / `--cover` override them. The cover
URL is checked first — an unreachable image does not fail the render, it
leaves the cover empty. The service stores both inside the scan JSON, so later
regenerations from the dashboard keep them. If the questions were never
answered, ask now rather than shipping the slug as a title.

## Reporting back

At launch: the batch id, the number of tasks, which sites were capped as shared
(or excluded) and why, and the open tasks found on the server. At the end: which hosts failed or were cut
off at the cap, the validation result, and the report files with the title and
cover that went on them.
