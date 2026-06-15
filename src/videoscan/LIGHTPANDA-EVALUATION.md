# Lightpanda evaluation for videoscan

**Verdict:** Evaluated [Lightpanda](https://github.com/lightpanda-io/browser) as a browser engine for videoscan — **not adopted today**. Revisit when the gating features below land.

## Why we considered it

Lightpanda is a from-scratch, Zig-based headless browser for AI/automation that speaks CDP (Puppeteer/Playwright-compatible) and claims **~16x less memory** (123 MB vs 2 GB for 100 pages) and **~9x faster** than Chromium.

That matters because **memory is videoscan's throughput limiter**. We launch Playwright/Chromium at ~60–150 MB per page, which caps concurrency at 2–8 (`pickInitialConcurrency` / AutoTuner, [scan.mjs](scan.mjs) ~976–1074). A browser that holds pages at a fraction of the RAM could lift that ceiling dramatically. That is the real upside — *if* Lightpanda ever covers what we need.

## Feature gap

The overlap is almost perfectly inverse: Lightpanda supports the baseline videoscan needs, but lacks every advanced affordance videoscan was deliberately built around. Those affordances exist because real publisher targets are consent-gated and lazy-loaded — Lightpanda's exact weak spot.

| Videoscan dependency | Code ref | Lightpanda status |
|---|---|---|
| `MutationObserver` (dynamically-injected embeds) | [scan.mjs](scan.mjs) ~760–792 | ❌ not implemented |
| Scroll-to-trigger lazy embeds | [scan.mjs](scan.mjs) ~706–716 | ❌ not implemented |
| Click cookie banners + play buttons | [scan.mjs](scan.mjs) ~584–609, 720–758 | ❌ no proper click events |
| `waitUntil: "networkidle"` | [scan.mjs](scan.mjs) ~851, 915, 940 | ❌ not implemented |
| Full iframe extraction | throughout | ❌ partial only |
| `page.pdf()` report generation | [videoscan-runner.ts](../core/videoscan-runner.ts) ~361 | ❌ not implemented |
| Network interception, JS exec, DOM, cookies, proxy | [scan.mjs](scan.mjs) ~845 | ✅ supported |

## Why not now

For a compliance/monitoring scanner, the costly error is a **false negative** — missing a video that's actually there. A swap to Lightpanda today would trade recall for speed: it would silently drop the consent-gated, scroll-, and click-activated embeds that the unsupported features above were added to catch. The speed/memory win is only realizable on "simple" pages, which are a minority of our targets.

Lightpanda is also self-described **beta** ("you may still encounter errors or crashes"), and Playwright's runtime feature-detection makes its Playwright compatibility fragile across versions — a script that works today may break on a future Playwright bump.

## Revisit trigger

Re-evaluate when Lightpanda's coverage adds **all** of:

- `MutationObserver`
- `networkidle` wait condition
- scroll simulation
- real click events
- full iframe support

Track via Lightpanda's changelog/roadmap. When met, the cheapest first step is **not** a swap — add a behind-a-flag `--engine lightpanda` path plus a benchmark harness that compares detection recall against Chromium on a known URL sample, and only adopt if recall holds.

## Sources

- https://github.com/lightpanda-io/browser
- https://lightpanda.io/docs/
- https://docs.bswen.com/blog/2026-03-19-lightpanda-cdp-puppeteer-playwright/
- https://www.scrapingbee.com/blog/lightpanda-headless-browser/
