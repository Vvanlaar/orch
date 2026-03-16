# Videoscan Report Redesign

Reskin the videoscan HTML report and preview to match the designer's new visual direction, using an HTML template system with `{{variable}}` replacement.

## Reference

Designer file: `Video Quick Scan - Menzis.html` (local download). Key visual elements:
- A4 page layout (210mm x 297mm) with responsive web fallback
- Gustavo font (headings, from BB CloudFront), Montserrat (body, Google Fonts), FontAwesome 6 icons
- Color palette: `--primary: #3578BB`, `--text-dark: #002837`, `--accent-red: #ED6A5B`, `--accent-yellow: #FAB44B`, `--accent-green: #46AF91`, `--bg-box: #FAFBFB`
- Cover page: hero image with `border-bottom-right-radius: 150px`, white text box with inverted-corner pseudo-elements, BB SVG logo, blue bottom section
- Highlight-line underline on h1 (`background-image: linear-gradient` trick)
- Blue footer bar on every page with BB SVG logo + page number
- Stat boxes, CSS conic-gradient pie chart, bar chart for WCAG failures, accessibility tag grid, privacy risk list with shield icons, cookie consent mockup card, checklist with custom checkboxes, contact page with split layout

## Architecture

### Template system

Simple `{{placeholder}}` string replacement. No template engine dependency.

**How it works:**
1. `report.mjs` reads scan JSON + options (cover image URL, contact info)
2. For each page, reads the corresponding `.html` template file
3. Builds dynamic HTML fragments in JS (table rows, risk cards, pie chart SVG, bar chart bars)
4. Replaces `{{placeholders}}` in templates with the pre-built fragments
5. Wraps all pages in the document shell (head + styles + body) to produce final HTML

**Loops and conditionals stay in report.mjs** — templates contain only static structure with `{{var}}` holes for pre-assembled HTML.

### File structure

```
src/videoscan/
  report.mjs                    ← orchestrator (rewritten): reads templates, builds fragments, assembles
  audit-data.mjs                ← unchanged
  templates/
    styles.css                  ← full CSS from designer (CSS variables, all component styles)
    document.html               ← outer HTML shell: <!DOCTYPE>, <head>, font links, {{title}}, {{styles}}, <body>{{pages}}</body>
    cover.html                  ← cover page: {{orgName}}, {{coverImageUrl}}, {{introText}}, {{dateStr}} (BB logo hardcoded as <img> URL)
    overview.html               ← {{orgName}}, {{pagesWithVideo}}, {{statsBoxes}}, {{sectionTableRows}}, {{pieChart}}, {{detailTable}}, {{footer}}
    accessibility.html          ← {{barChart}}, {{auditTable}}, {{footer}} (tech/content tag grids are static HTML, not placeholders)
    privacy.html                ← risks + cookie card: {{nonEuCount}}, {{privacyRiskItems}}, {{cookieSection}}, {{footer}}
    checklist.html              ← static content, {{footer}}
    contact.html                ← {{contactName}}, {{contactPhone}}, {{contactEmail}}, {{contactImageUrl}} (own footer layout, no {{footer}})
    footer.html                 ← reusable footer fragment: {{pageNumber}} — injected into each page template via {{footer}}
    preview.html                ← single-page preview: {{orgName}}, {{dateStr}}, {{pagesScanned}}, {{pagesWithVideo}}, {{playerCount}}, {{videoEmbeds}}, {{pieChart}}, {{privacyFlags}}, {{accessibilityFlags}}
```

### Template placeholder convention

- `{{variableName}}` — replaced with string or pre-built HTML fragment
- Fragments for repeating items (table rows, risk cards, tags) are built in JS and injected as a single `{{placeholder}}`
- If a section should be hidden (e.g. no YouTube = no cookie section), report.mjs replaces `{{cookieSection}}` with empty string
- `{{footer}}` — every content page template includes this placeholder. `report.mjs` reads `footer.html`, replaces `{{pageNumber}}` with the current page number, then injects the result into each page's `{{footer}}`

### New parameters

**CLI (`report.mjs`):**
- `--cover-image <url>` — hero image URL for cover page (defaults to a generic BB placeholder or omitted)
- `--contact-image <url>` — image URL for contact page split layout
- `--contact-name <name>` — contact person name
- `--contact-phone <phone>` — contact phone number
- `--contact-email <email>` — contact email address
- `--social <file>` — existing arg, kept as-is. Social page rendered between overview and accessibility pages using inline HTML assembly (no template — it's out of scope for this redesign but must not break)

**Server API (`/api/videoscans/generate-report` and `/api/videoscans/generate-preview`):**
- Add optional body fields: `coverImageUrl`, `contactImageUrl`, `contactName`, `contactPhone`, `contactEmail`
- Pass as CLI args to `report.mjs` spawn

**Dashboard (`VideoscanPage.svelte`):**
- Add a small form/popover when clicking "Gen" or "Regen" button
- Fields: Cover Image URL (text input), Contact Name, Phone, Email, Contact Image URL
- Values stored in component state (not persisted — these are per-generation inputs)
- `regenerateReport()` and `regeneratePreview()` pass these as body params

**videoscan-runner.ts:**

```ts
export interface ReportOptions {
  coverImageUrl?: string;
  contactImageUrl?: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
}
```

- `generateReport(jsonFilename: string, options?: ReportOptions)` — second param optional
- `generatePreview(jsonFilename: string, options?: ReportOptions)` — same
- Both build CLI args array from options and pass to `report.mjs` spawn
- **Post-scan inline generation** (`runVideoscan()` line 164): does NOT receive `ReportOptions` — generates report with defaults. Users can re-generate with custom options via the dashboard "Regen" button after scan completes.

**Dashboard store (`videoscan.svelte.ts`):**
- `regenerateReport(filename: string, options?: ReportOptions)` — passes options in POST body
- `regeneratePreview(filename: string, options?: ReportOptions)` — same

**Server endpoints (`index.ts`):**
- Destructure `{ filename, coverImageUrl, contactImageUrl, contactName, contactPhone, contactEmail }` from `req.body`
- Pass as `ReportOptions` to runner functions

### Pages in full report (matching designer)

1. **Cover** — hero image, org name with highlight-line, intro text, scan date, BB logo, "Lees snel verder" button
2. **Overzicht videogebruik** — stat boxes (pages scanned, pages with video, unique players), section table (URL section / count / players), pie chart with legend, representative pages detail table (up to 15 pages with clickable URLs)
3. **Voor iedereen toegankelijk?** — bar chart (WCAG failures per player), audit results table, technique tags, content tags, tip box
4. **Privacy** — privacy risks list with shield icon, recommendation tip box, cookie consent mockup card (if YouTube present)
5. **Checklist Online Video** — three sections (Digitaal toegankelijk, Privacy compliant, Video workflow) with checkbox items, large checkmark decoration
6. **Contact** — split layout: CTAs (demo, blogs, coffee) + contact info on left, image on right

### Preview report (single page)

Same new visual styling condensed:
- Header: org name + date + BB SVG logo
- Stat boxes (4-column grid): pages scanned, pages with video, players, video-embeds
- Two-column: pie chart left, privacy flags + accessibility flags right
- CTA bar with blue gradient background
- Footer line

### CSS approach

- All CSS in `templates/styles.css`, loaded into `document.html` via `{{styles}}`
- A4 page dimensions as default (`.page { width: 210mm; height: 297mm; }`)
- `@media screen` fallback: `max-width: 900px; height: auto; margin: 0 auto 24px;` for browser viewing
- `@media print`: no box-shadow, page-break-after, zero margins
- CSS variables for all colors (easy future theming)

### Pie chart

Keep current SVG-based `generatePieChartSVG()` function — it's more reliable than CSS conic-gradient for dynamic data. Style the legend to match designer's layout (horizontal with colored boxes). **Update `CHART_COLORS` array** to use new palette: `#3578BB` (primary), `#ED6A5B` (red), `#46AF91` (green), `#FAB44B` (yellow), then additional distinct colors for 5+ player charts.

### Bar chart

New JS function `generateBarChartHTML(auditMatches)` — renders HTML/CSS bar chart matching designer's style (vertical bars, red fill, player labels, failure count above each bar).

### BB Logo

The designer uses an SVG logo from CloudFront: `https://d3bn524hv76vco.cloudfront.net/upload/newskin.acc/780b5079ecb7d44a8d5a2d090d06882962d5ab17.svg`

Use this URL directly in `<img>` tags (same as designer). Alternatively embed the SVG inline for offline PDF rendering — but since Playwright loads network resources, external URL is fine.

## Changes summary

| File | Change |
|------|--------|
| `src/videoscan/report.mjs` | Rewrite: template-based assembly, new CLI args, keep helper functions (pie chart, truncateUrl, formatNumber) |
| `src/videoscan/templates/` (new dir) | 9 template files: document.html, styles.css, cover.html, overview.html, accessibility.html, privacy.html, checklist.html, contact.html, preview.html |
| `src/core/videoscan-runner.ts` | Add `ReportOptions` interface, pass new args to report.mjs spawn |
| `src/server/index.ts` | Accept new body fields in generate-report/generate-preview endpoints |
| `src/dashboard/stores/videoscan.svelte.ts` | Pass new fields in `regenerateReport()` / `regeneratePreview()` |
| `src/dashboard/components/VideoscanPage.svelte` | Add report options form/popover for Gen/Regen buttons |

## Out of scope

- Social media page — keep as inline HTML assembly in report.mjs (no template). Apply new font/color variables for basic visual consistency but no structural redesign. Injected into `{{pages}}` between overview and accessibility pages when `--social` is provided.
- Audit one-pager (`audit-summary.mjs`) — separate file, not part of this redesign
- Supabase sync / merge logic — unchanged
- scan.mjs — unchanged (scanner, not report)
