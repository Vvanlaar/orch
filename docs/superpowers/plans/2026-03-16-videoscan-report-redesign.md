# Videoscan Report Redesign Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reskin the videoscan HTML report + preview to match the designer's new visual direction, using HTML templates with `{{variable}}` replacement.

**Architecture:** HTML template files in `src/videoscan/templates/` with `{{placeholder}}` string replacement orchestrated by `report.mjs`. Dynamic fragments (table rows, charts, risk cards) built in JS, injected into templates. New CLI args for cover image, contact info. Dashboard gets a popover form for report options.

**Tech Stack:** Node.js ESM (report.mjs), HTML/CSS templates, Svelte 5 (dashboard), TypeScript (server/runner), Playwright (PDF generation)

**Spec:** `docs/superpowers/specs/2026-03-16-videoscan-report-redesign.md`

**Designer reference:** `Video Quick Scan - Menzis.html` (local download, also readable at `C:\Users\vince\Downloads\Video Quick Scan - Menzis.html`)

---

## Chunk 1: Templates (CSS + static HTML templates)

### Task 1: Create styles.css

**Files:**
- Create: `src/videoscan/templates/styles.css`

This is the full CSS extracted from the designer's HTML. All colors as CSS variables, A4 page layout, responsive fallback, print styles, all component classes.

- [ ] **Step 1: Create the styles.css file**

Extract the complete `<style>` block from the designer's HTML file (`Video Quick Scan - Menzis.html` lines 12-325) into `src/videoscan/templates/styles.css`. Keep all CSS variables, font-face declarations, component styles exactly as-is. Add these additions at the end:

```css
/* Screen fallback for browser viewing */
@media screen {
  .page {
    max-width: 900px;
    height: auto;
    margin: 0 auto 24px;
  }
}
```

The existing `@media print` rule from the designer is already present (line 324).

- [ ] **Step 2: Commit**

```bash
git add src/videoscan/templates/styles.css
git commit -m "add report styles.css from designer template"
```

---

### Task 2: Create document.html shell

**Files:**
- Create: `src/videoscan/templates/document.html`

The outer HTML document that wraps all page content. Contains `<head>` with font links, FontAwesome, and `{{styles}}` injection point.

- [ ] **Step 1: Create document.html**

```html
<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{title}}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Montserrat:ital,wght@0,400;0,500;0,700;1,400;1,700&display=swap">
  <script src="https://kit.fontawesome.com/7e772fa0fe.js" crossorigin="anonymous" defer></script>
  <style>
{{styles}}
  </style>
</head>
<body>
{{pages}}
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add src/videoscan/templates/document.html
git commit -m "add report document.html shell template"
```

---

### Task 3: Create footer.html

**Files:**
- Create: `src/videoscan/templates/footer.html`

Reusable footer fragment injected into every content page via `{{footer}}`.

- [ ] **Step 1: Create footer.html**

```html
  <div class="footer">
    <div class="footer-container">
      <div class="svg-logo-white">
        <img src="https://d3bn524hv76vco.cloudfront.net/upload/newskin.acc/780b5079ecb7d44a8d5a2d090d06882962d5ab17.svg" alt="Blue Billywig">
      </div>
      <div class="footer-page">{{pageNumber}}</div>
    </div>
  </div>
```

- [ ] **Step 2: Commit**

```bash
git add src/videoscan/templates/footer.html
git commit -m "add report footer.html template"
```

---

### Task 4: Create cover.html

**Files:**
- Create: `src/videoscan/templates/cover.html`

Cover page matching designer's layout: hero image with rounded corner, white text box with inverted corners, blue bottom section with BB logo.

- [ ] **Step 1: Create cover.html**

Extract the cover page structure from the designer's HTML (lines 329-348). Replace hardcoded values with placeholders:
- `Menzis` → `{{orgName}}`
- The image URL in `.cover-image-bg` → `{{coverImageUrl}}`
- The intro `<p>` text → `{{introText}}`
- BB logo `<img>` src stays hardcoded (it's always the BB logo — spec lists `{{bbLogoSvg}}` but we hardcode the URL since it's always the same BB logo and Playwright loads network resources for PDF)

The cover page has NO footer (matches designer). Structure:

```html
  <div class="page page-cover">
    <div class="cover-top-section">
      <h1 class="cover-title">Video quick scan voor<br><span class="highlight-line">{{orgName}}</span></h1>
      <div class="cover-image-bg" style="background-image: url('{{coverImageUrl}}')"></div>
      <div class="cover-separator"></div>
    </div>
    <div class="cover-mid-section">
      <div class="cover-text-box">
        <p class="cover-text">{{introText}}</p>
      </div>
    </div>
    <div class="cover-bottom-section">
      <div style="display:flex;align-items:center;gap:24px">
        <div class="svg-logo-white main-logo">
          <img src="https://d3bn524hv76vco.cloudfront.net/upload/newskin.acc/780b5079ecb7d44a8d5a2d090d06882962d5ab17.svg" alt="Blue Billywig">
        </div>
        <div style="color:rgba(255,255,255,0.7);font-size:14px">{{dateStr}}</div>
      </div>
      <a href="#page1" class="btn btn-cover">Lees snel verder</a>
    </div>
  </div>
```

Note: the `cover-image-bg` in the designer uses `background: url(...) center/cover` directly in the class. We move the URL to an inline style so it's dynamic. The CSS class `.cover-image-bg` retains `height: 540px`, `border-bottom-right-radius: 150px`, `position: relative` — but we need to modify styles.css to remove the hardcoded `background` property from `.cover-image-bg` and keep only layout properties. Add `background-size: cover; background-position: center;` to the class instead.

- [ ] **Step 2: Update styles.css — make cover-image-bg dynamic**

In `styles.css`, find `.cover-image-bg` and change from:
```css
.cover-image-bg { height: 540px; background: url('...') center/cover; border-bottom-right-radius: 150px; position: relative; }
```
to:
```css
.cover-image-bg { height: 540px; background-size: cover; background-position: center; border-bottom-right-radius: 150px; position: relative; }
```

Same for `.split-right-img` (contact page image) — remove hardcoded URL, keep `background-size: cover; background-position: center;` and other properties.

- [ ] **Step 3: Commit**

```bash
git add src/videoscan/templates/cover.html src/videoscan/templates/styles.css
git commit -m "add cover.html template with dynamic image URL"
```

---

### Task 5: Create overview.html

**Files:**
- Create: `src/videoscan/templates/overview.html`

Stats page: stat boxes, section table, pie chart, detail table. Matching designer's page 2 (lines 350-407) plus the detail table from current report.mjs.

- [ ] **Step 1: Create overview.html**

```html
  <div class="page" id="page1">
    <h1><span class="highlight-line">Overzicht videogebruik</span></h1>

    <p>We hebben het videolandschap van {{orgName}} in kaart gebracht. Er zijn in totaal <strong class="text-primary">{{pagesWithVideo}} pagina's met video</strong> gevonden op de onderzochte domeinen.</p>

    <table>
      <thead>
        <tr>
          <th>Sectie URL</th>
          <th>Aantal pagina's</th>
          <th>Aangetroffen Players</th>
        </tr>
      </thead>
      <tbody>
{{sectionTableRows}}
      </tbody>
    </table>

    <div class="stats-overview">
      <div class="grid-3">
{{statsBoxes}}
      </div>
      <div class="pie-row">
{{pieChart}}
      </div>
    </div>

{{detailTable}}

{{footer}}
  </div>
```

- [ ] **Step 2: Commit**

```bash
git add src/videoscan/templates/overview.html
git commit -m "add overview.html template"
```

---

### Task 6: Create accessibility.html

**Files:**
- Create: `src/videoscan/templates/accessibility.html`

Matching designer's page 3 (lines 409-505): bar chart, WCAG tag grids, tip box.

- [ ] **Step 1: Create accessibility.html**

Extract the full accessibility page structure from the designer's HTML. Replace dynamic parts:
- Bar chart section → `{{barChart}}`
- Audit results table (not in designer but in current report) → `{{auditTable}}`
- The tag grids are static content (same WCAG requirements always) — keep hardcoded with FontAwesome icons

```html
  <div class="page">
    <h1><span class="highlight-line">Voor iedereen toegankelijk?</span></h1>

    <p>Als je video's wil embedden op je eigen website, moet je videoplayer aan de <strong>55 succescriteria</strong> van de WCAG 2.2 AA voldoen om een A-status te behalen. Geen van de gevonden videospelers voldoet momenteel volledig.</p>

{{barChart}}
    <p class="text-danger chart-label">&#9632; Aantal afgekeurde WCAG-criteria per speler</p>

{{auditTable}}

    <h2>Wat is er nodig voor toegankelijkheid?</h2>

    <div class="acc-subtitle">Techniek</div>
    <div class="acc-tag-grid">
      <div class="acc-tag"><i class="fa-solid fa-heading"></i> Tekstalternatief</div>
      <div class="acc-tag"><i class="fa-regular fa-file-lines"></i> Transcriptie</div>
      <div class="acc-tag"><i class="fa-solid fa-hands-asl-interpreting"></i> Gebarentolk</div>
      <div class="acc-tag"><i class="fa-solid fa-check"></i> WCAG 2.1 AA Video player</div>
      <div class="acc-tag"><i class="fa-regular fa-closed-captioning"></i> Ondertiteling</div>
      <div class="acc-tag"><i class="fa-regular fa-keyboard"></i> Toetsenbordbediening</div>
      <div class="acc-tag"><i class="fa-solid fa-audio-description"></i> Audiodescriptie</div>
      <div class="acc-tag"><i class="fa-solid fa-glasses"></i> Schermlezerondersteuning</div>
      <div class="acc-tag"><i class="fa-solid fa-download"></i> Bestanden downloaden</div>
    </div>

    <div class="acc-row">
      <div class="acc-col">
        <div class="acc-subtitle">Content</div>
        <div class="acc-tag-grid" style="margin-bottom: 0;">
          <div class="acc-tag"><i class="fa-regular fa-moon"></i> Contrast</div>
          <div class="acc-tag"><i class="fa-solid fa-paintbrush"></i> Kleurgebruik</div>
          <div class="acc-tag"><i class="fa-solid fa-clock-rotate-left"></i> Minder dan 3 flitsen per seconden</div>
        </div>
      </div>
      <div class="acc-col" style="flex: 1.15;">
        <div class="acc-tip-box">
          <i class="fa-solid fa-lightbulb-exclamation-on"></i>
          <p>Gebruik een transcript indien er geen ruimte is voor audiodescriptie (AD) en maak je video's volledig toegankelijk door een gebarentolk toe te voegen.</p>
        </div>
      </div>
    </div>

{{footer}}
  </div>
```

- [ ] **Step 2: Commit**

```bash
git add src/videoscan/templates/accessibility.html
git commit -m "add accessibility.html template"
```

---

### Task 7: Create privacy.html

**Files:**
- Create: `src/videoscan/templates/privacy.html`

Matching designer's page 4 (lines 507-575): shield icons, risk list, tip box, cookie card.

- [ ] **Step 1: Create privacy.html**

```html
  <div class="page">
    <h1><span class="highlight-line">Privacy</span></h1>

    <div class="privacy-row" style="margin-bottom: 40px;">
      <div class="privacy-content-col">
        <p class="text-intro" style="margin-bottom: 0;">
          Bij het gebruik van third-party videoplayers worden er vaak cookies geplaatst en gebruikersgegevens gedeeld met externe partijen.
          <strong class="text-primary highlight-number">{{nonEuCount}}</strong> van de gevonden players slaan data op buiten de EU.
        </p>

        <h2 style="margin: 24px 0 12px 0;">Privacy risico's</h2>

        <ul class="privacy-list">
{{privacyRiskItems}}
        </ul>

        <div class="acc-tip-box acc-tip-box--compact">
          <i class="fa-solid fa-lightbulb-exclamation"></i>
          <div style="display: flex; flex-direction: column; gap: 4px;">
            <strong class="tip-title">Aanbeveling</strong>
            <p class="tip-body">Duidelijke privacyverklaring en mogelijk overstappen op een privacyvriendelijk platform dat data binnen de EU opslaat en geen tracking cookies plaatst.</p>
          </div>
        </div>
      </div>

      <div class="privacy-shield-col">
        <i class="fa-solid fa-shield shield-icon-bg"></i>
        <i class="fa-solid fa-shield-keyhole shield-icon-fg"></i>
      </div>
    </div>

{{cookieSection}}

{{footer}}
  </div>
```

- [ ] **Step 2: Commit**

```bash
git add src/videoscan/templates/privacy.html
git commit -m "add privacy.html template"
```

---

### Task 8: Create checklist.html

**Files:**
- Create: `src/videoscan/templates/checklist.html`

Static content — matching designer's page 5 (lines 577-654). No dynamic placeholders except `{{footer}}`.

- [ ] **Step 1: Create checklist.html**

Copy the checklist page structure from the designer's HTML verbatim (lines 577-654). Only change: replace the inline footer with `{{footer}}`.

- [ ] **Step 2: Commit**

```bash
git add src/videoscan/templates/checklist.html
git commit -m "add checklist.html template"
```

---

### Task 9: Create contact.html

**Files:**
- Create: `src/videoscan/templates/contact.html`

Matching designer's page 6 (lines 656-701) with dynamic contact info and image.

**Note:** The contact page uses its own hardcoded footer layout (no page number, different structure from other pages) — so it does NOT use `{{footer}}`. The spec lists `{{footer}}` for contact.html, but the designer's contact page has a distinct `contact-footer` class. We follow the designer here.

- [ ] **Step 1: Create contact.html**

```html
  <div class="page page-contact">
    <h1 class="contact-title">
      Samen tillen we je videoprestaties<br>
      <span class="highlight-line">naar een hoger niveau</span>
    </h1>

    <div class="split-layout">
      <div class="split-left">
        <div>
          <h3>Vraag een demo aan</h3>
          <p>Vraag vrijblijvend een demo aan voor jou en je collega's.</p>
          <a href="https://www.bluebillywig.com/nl/demo/" class="btn btn-red" target="_blank">Klik hier</a>
        </div>
        <div>
          <h3>Bekijk onze blogs</h3>
          <p>Bekijk ons blogs en webinars over video management en toegankelijkheid.</p>
          <a href="https://www.bluebillywig.com/nl/blog/" class="btn btn-red" target="_blank">Klik hier</a>
        </div>
        <div>
          <h3>Plan een kop koffie</h3>
          <p>Maak een afspraak voor een heerlijke koffie!</p>
          <a href="https://www.bluebillywig.com/nl/contact/" class="btn btn-red" target="_blank">Klik hier</a>
        </div>
        <div class="contact-item" style="margin-top: 10px;">
          <h3 style="margin-bottom: 12px;">Weet mij te vinden</h3>
          <p>{{contactName}}</p>
          <p>{{contactPhone}}</p>
          <p>{{contactEmail}}</p>
        </div>
      </div>
      <div class="split-right-img" style="background-image: url('{{contactImageUrl}}')"></div>
    </div>

    <div class="contact-footer">
      <div class="footer-container">
        <div class="svg-logo-white">
          <img src="https://d3bn524hv76vco.cloudfront.net/upload/newskin.acc/780b5079ecb7d44a8d5a2d090d06882962d5ab17.svg" alt="Blue Billywig">
        </div>
      </div>
    </div>
  </div>
```

- [ ] **Step 2: Commit**

```bash
git add src/videoscan/templates/contact.html
git commit -m "add contact.html template"
```

---

### Task 10: Create preview.html

**Files:**
- Create: `src/videoscan/templates/preview.html`

Single-page preview with same new styling. This is a **full document** (includes its own styles since it's a standalone file).

- [ ] **Step 1: Create preview.html**

This template is a complete HTML document (standalone file). Uses designer's palette and fonts with a compact single-page layout.

```html
<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{title}}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Montserrat:ital,wght@0,400;0,500;0,700;1,400;1,700&display=swap">
  <style>
    @font-face { font-family: 'Gustavo'; src: url('https://d3bn524hv76vco.cloudfront.net/upload/newskin.acc/f26146ff9bc1ae4ad6541812c26349c0f5d0c493.otf') format('opentype'); font-weight: 500; }
    @font-face { font-family: 'Gustavo'; src: url('https://d3bn524hv76vco.cloudfront.net/upload/newskin.acc/8077700769db7db2280aa07ecc0d70bdd665ade3.otf') format('opentype'); font-weight: 700; }
    :root { --primary: #3578BB; --primary-light: #9ABBDD; --text-dark: #002837; --bg-box: #FAFBFB; --border-box: #F5F6F7; --accent-red: #ED6A5B; --accent-green: #46AF91; --white: #FFFFFF; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Montserrat', sans-serif; color: var(--text-dark); background: #f5f5f5; line-height: 1.5; }
    .page { background: var(--white); max-width: 900px; margin: 0 auto; padding: 40px 48px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); position: relative; }
    .page::after { content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 4px; background: var(--primary); }
    h1 { font-family: 'Gustavo', sans-serif; font-size: 28px; font-weight: 700; color: var(--text-dark); }
    h2 { font-family: 'Gustavo', sans-serif; font-size: 18px; font-weight: 700; color: var(--text-dark); margin: 20px 0 8px; }
    .highlight-line { display: inline; background-image: linear-gradient(var(--primary-light), var(--primary-light)); background-repeat: no-repeat; background-size: 100% 10px; background-position: 0 112%; }
    .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 16px 0; }
    .stat-box { background: var(--bg-box); border: 1px solid var(--border-box); border-radius: 8px; padding: 14px; text-align: center; }
    .stat-box .number { font-family: 'Gustavo', sans-serif; font-size: 28px; font-weight: 700; color: var(--text-dark); }
    .stat-box .label { font-size: 10px; text-transform: uppercase; color: var(--primary); font-weight: 700; letter-spacing: 0.5px; margin-top: 2px; }
    .flag { display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; border-radius: 8px; font-size: 13px; font-weight: 600; margin: 4px 4px 4px 0; }
    .flag-red { background: #fff5f5; color: #c0392b; border: 1px solid #f5c6cb; }
    .flag-orange { background: #fff8f0; color: #e67e22; border: 1px solid #fde2c8; }
    .flag-green { background: #f0faf4; color: var(--accent-green); border: 1px solid #c3e6cb; }
    .cta-bar { background: linear-gradient(135deg, var(--text-dark) 0%, var(--primary) 100%); color: var(--white); padding: 20px 24px; border-radius: 0 0 20px 0; margin-top: 20px; display: flex; justify-content: space-between; align-items: center; }
    .cta-btn { display: inline-block; background: var(--accent-red); color: var(--white); padding: 10px 24px; border-radius: 0 0 12px 0; text-decoration: none; font-family: 'Gustavo', sans-serif; font-weight: 700; font-size: 14px; }
    @media print { body { background: white; } .page { box-shadow: none; margin: 0; } }
  </style>
</head>
<body>
  <div class="page">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <div>
        <h1><span class="highlight-line">Video Quick Scan</span></h1>
        <div style="color:#666;font-size:15px;margin-top:4px">{{orgName}} — {{dateStr}}</div>
      </div>
      <div><img src="https://d3bn524hv76vco.cloudfront.net/upload/newskin.acc/780b5079ecb7d44a8d5a2d090d06882962d5ab17.svg" alt="Blue Billywig" style="height:32px"></div>
    </div>

    <div class="stat-grid">
      <div class="stat-box"><div class="number">{{pagesScanned}}</div><div class="label">Pagina's gescand</div></div>
      <div class="stat-box"><div class="number">{{pagesWithVideo}}</div><div class="label">Pagina's met video</div></div>
      <div class="stat-box"><div class="number">{{playerCount}}</div><div class="label">Videospelers</div></div>
      <div class="stat-box"><div class="number">{{videoEmbeds}}</div><div class="label">Video-embeds</div></div>
    </div>

    <div style="display:flex;gap:32px;flex-wrap:wrap">
      <div style="flex:1;min-width:240px">
        <h2>Gevonden players</h2>
        {{pieChart}}
      </div>
      <div style="flex:1;min-width:240px">
        {{privacyFlags}}
        {{accessibilityFlags}}
      </div>
    </div>

    <div class="cta-bar">
      <div>
        <div style="font-weight:700;font-size:16px">Benieuwd naar het volledige rapport?</div>
        <div style="font-size:14px;opacity:0.85;margin-top:4px">Privacy-analyse, toegankelijkheidsdetails en aanbevelingen.</div>
      </div>
      <a class="cta-btn" href="https://www.bluebillywig.com/nl/demo/">Plan een afspraak</a>
    </div>

    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:16px;padding-top:8px;border-top:2px solid var(--primary);font-size:12px;color:#999">
      <span>Video Quick Scan — {{orgName}}</span>
      <img src="https://d3bn524hv76vco.cloudfront.net/upload/newskin.acc/780b5079ecb7d44a8d5a2d090d06882962d5ab17.svg" alt="Blue Billywig" style="height:20px">
    </div>
  </div>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add src/videoscan/templates/preview.html
git commit -m "add preview.html template"
```

---

## Chunk 2: Rewrite report.mjs

### Task 11: Rewrite report.mjs — template loader + helper functions

**Files:**
- Modify: `src/videoscan/report.mjs`

Complete rewrite. Keep the file's role (CLI tool that reads JSON, outputs HTML) but replace string concatenation with template loading.

- [ ] **Step 1: Rewrite the imports and constants section**

Replace the old color constants with the new palette. Add `readFileSync` for template loading. Add `dirname`/`fileURLToPath` for resolving template paths.

```js
#!/usr/bin/env node
import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { AUDIT_DATA, SCANNER_TO_AUDIT } from "./audit-data.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(__dirname, "templates");

// New palette matching designer
const CHART_COLORS = [
  "#3578BB", "#ED6A5B", "#46AF91", "#FAB44B",
  "#9b59b6", "#e67e22", "#1abc9c", "#34495e", "#e74c3c", "#2ecc71",
];

const BB_LOGO_URL = "https://d3bn524hv76vco.cloudfront.net/upload/newskin.acc/780b5079ecb7d44a8d5a2d090d06882962d5ab17.svg";
```

- [ ] **Step 2: Add template utility functions**

```js
function loadTemplate(name) {
  return readFileSync(join(TEMPLATE_DIR, name), "utf-8");
}

function fillTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    vars[key] !== undefined ? vars[key] : match
  );
}

function buildFooter(pageNumber) {
  const footerTpl = loadTemplate("footer.html");
  return fillTemplate(footerTpl, { pageNumber: String(pageNumber).padStart(2, "0") });
}
```

- [ ] **Step 3: Keep existing helper functions with updates**

Keep `generatePieChartSVG()`, `truncateUrl()`, `formatNumber()` — they already work. Just the `CHART_COLORS` reference is updated (done in step 1).

**Update `generateAuditSection()`** — replace old hardcoded inline style colors with new palette:
- `#f0faf4` (pass row bg) → keep (neutral green tint is fine)
- `background:#2ecc71` (pass badge) → `background:#46AF91` (new accent-green)
- `background:#e74c3c` (fail badge) → `background:#ED6A5B` (new accent-red)
- `color:#4a90d9` (link color) → `color:#3578BB` (new primary)
- `color:#666` (subtitle) → `color:#525659` (new bg-body)

**Keep social page color constants** for the inline social HTML assembly. Add these alongside the new constants (they're only used by the social page which is out of scope for redesign):

```js
// Legacy colors for social page inline HTML (out of scope for redesign)
const SOCIAL_BLUE = "#3578BB";
const SOCIAL_LIGHT = "#9ABBDD";
```

Then update the social page HTML builder to use these instead of the deleted `BB_BLUE`/`BB_LIGHT_BLUE`.

Add new helper `generateBarChartHTML(auditMatches)`:

```js
function generateBarChartHTML(auditMatches) {
  if (!auditMatches.length) return "";
  const maxFindings = Math.max(...auditMatches.map(m => m.findings));
  const bars = auditMatches
    .sort((a, b) => b.findings - a.findings)
    .map(m => {
      const heightPct = maxFindings > 0 ? (m.findings / maxFindings) * 100 : 0;
      return `<div class="bar-col">
        <div class="bar-number">${m.findings}</div>
        <div class="bar"><div class="bar-fill" style="height: ${heightPct}%;"></div></div>
        <div class="bar-label">${m.auditName}</div>
      </div>`;
    }).join("\n");
  return `<div class="bar-chart">\n${bars}\n</div>`;
}
```

- [ ] **Step 4: Commit**

```bash
git add src/videoscan/report.mjs
git commit -m "report.mjs: template loader, new palette, bar chart helper"
```

---

### Task 12: Rewrite generateReport()

**Files:**
- Modify: `src/videoscan/report.mjs`

Replace the old `generateReport()` with template-based assembly.

- [ ] **Step 1: Write generateReport()**

The function:
1. Extracts data from scanData (same as current)
2. Builds HTML fragments for dynamic sections (stat boxes, table rows, pie chart, risk items, etc.)
3. Loads each page template, fills placeholders, collects into `pages` array
4. Wraps in document.html shell

Key fragment builders (keep in this function or as local helpers):
- `statsBoxes` — 3 stat-box divs
- `sectionTableRows` — `<tr>` rows grouped by URL section (same logic as current `sectionGroups`)
- `detailTable` — representative pages table (up to 15 rows, same logic as current)
- `pieChart` — call `generatePieChartSVG()` + legend wrapper
- `barChart` — call `generateBarChartHTML()` with audit matches
- `auditTable` — call existing `generateAuditSection()` (keep this function)
- `privacyRiskItems` — `<li>` items for each privacy risk
- `cookieSection` — cookie consent card HTML (only if YouTube present, else empty string)
- Social page — inline HTML assembly (kept from current code, just with new font/color references)

Each page template is loaded, filled, and pushed to the pages array. Footer is built with incrementing page numbers (cover = no footer, page 2 = "02", etc.).

**Important: footer injection order** — for each page, build the footer first via `buildFooter(pageNum)`, then pass it as `footer` key in the vars object to `fillTemplate()`. All placeholders including `footer` are replaced in a single `fillTemplate` call per page template. Example:

```js
const overviewPage = fillTemplate(loadTemplate("overview.html"), {
  orgName: orgNameCap,
  pagesWithVideo: String(pagesWithVideo),
  statsBoxes,
  sectionTableRows,
  pieChart,
  detailTable,
  footer: buildFooter(2),
});
pages.push(overviewPage);
```

Contact page: use provided options or defaults (`contactName` defaults to empty, etc.). If `coverImageUrl` not provided, omit the background-image style (or use a placeholder).

Final assembly:
```js
const styles = loadTemplate("styles.css");
const docTpl = loadTemplate("document.html");
return fillTemplate(docTpl, {
  title: `Video Quick Scan - ${orgNameCap}`,
  styles,
  pages: pages.join("\n\n"),
});
```

- [ ] **Step 2: Commit**

```bash
git add src/videoscan/report.mjs
git commit -m "report.mjs: rewrite generateReport() with template assembly"
```

---

### Task 13: Rewrite generatePreviewReport()

**Files:**
- Modify: `src/videoscan/report.mjs`

- [ ] **Step 1: Write generatePreviewReport()**

Load `preview.html` template. Build fragments:
- Stat values (pagesScanned, pagesWithVideo, playerCount, videoEmbeds)
- Pie chart SVG
- Privacy flags (tracker player badges)
- Accessibility flags (audit pass/fail badges)

Fill template and return.

- [ ] **Step 2: Commit**

```bash
git add src/videoscan/report.mjs
git commit -m "report.mjs: rewrite generatePreviewReport() with template"
```

---

### Task 14: Update CLI argument parsing

**Files:**
- Modify: `src/videoscan/report.mjs`

- [ ] **Step 1: Update the main block to parse new CLI args**

```js
const args = process.argv.slice(2);
if (args.length === 0) {
  console.log("Usage: node report.mjs <scan.json> [--preview] [--social <file>] [--cover-image <url>] [--contact-image <url>] [--contact-name <name>] [--contact-phone <phone>] [--contact-email <email>]");
  process.exit(0);
}

const scanFile = args[0];
const scanData = JSON.parse(readFileSync(scanFile, "utf-8"));

function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

const options = {
  coverImageUrl: getArg("--cover-image"),
  contactImageUrl: getArg("--contact-image"),
  contactName: getArg("--contact-name"),
  contactPhone: getArg("--contact-phone"),
  contactEmail: getArg("--contact-email"),
};

if (args.includes("--preview")) {
  const html = generatePreviewReport(scanData, options);
  const outFile = scanFile.replace(".json", "-preview.html");
  writeFileSync(outFile, html);
  console.log(`Preview rapport gegenereerd: ${outFile}`);
} else {
  let socialData = null;
  const socialIdx = args.indexOf("--social");
  if (socialIdx !== -1 && args[socialIdx + 1]) {
    socialData = JSON.parse(readFileSync(args[socialIdx + 1], "utf-8"));
  }
  const html = generateReport(scanData, socialData, options);
  const outFile = scanFile.replace(".json", ".html");
  writeFileSync(outFile, html);
  console.log(`Rapport gegenereerd: ${outFile}`);
}
```

Update function signatures:
- `generateReport(scanData, socialData, options = {})` — third param
- `generatePreviewReport(scanData, options = {})` — second param

- [ ] **Step 2: Commit**

```bash
git add src/videoscan/report.mjs
git commit -m "report.mjs: new CLI args for cover/contact options"
```

---

### Task 15: Manual test — generate report from existing scan JSON

- [ ] **Step 1: Find an existing scan JSON file**

```bash
ls ../videoscans/*.json | head -3
```

- [ ] **Step 2: Generate a report and open it**

```bash
cd ../videoscans && node ../orch/src/videoscan/report.mjs <scan-file>.json
```

Open the generated HTML in a browser. Visually compare with the designer's reference. Check:
- Cover page renders (even without cover image)
- Stats, tables, pie chart display correctly
- Accessibility page has bar chart + tags
- Privacy page has risk list + shield icons
- Checklist renders
- Contact page renders (with empty contact info = defaults)
- Footer on every content page with correct page numbers
- A4 sizing in browser, responsive fallback

- [ ] **Step 3: Generate a preview and check it**

```bash
node ../orch/src/videoscan/report.mjs <scan-file>.json --preview
```

Open preview HTML and verify styling.

- [ ] **Step 4: Test with cover image arg**

```bash
node ../orch/src/videoscan/report.mjs <scan-file>.json --cover-image "https://picsum.photos/800/600"
```

Verify the cover image appears.

---

## Chunk 3: Backend integration (runner + server)

### Task 16: Add ReportOptions to videoscan-runner.ts

**Files:**
- Modify: `src/core/videoscan-runner.ts:36-43` (after VideoscanResult interface)

- [ ] **Step 1: Add ReportOptions interface and update generateReport/generatePreview**

After the `VideoscanResult` interface, add:

```ts
export interface ReportOptions {
  coverImageUrl?: string;
  contactImageUrl?: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
}
```

Helper to build CLI args from options:

```ts
function reportOptionsToArgs(options?: ReportOptions): string[] {
  if (!options) return [];
  const args: string[] = [];
  if (options.coverImageUrl) args.push('--cover-image', options.coverImageUrl);
  if (options.contactImageUrl) args.push('--contact-image', options.contactImageUrl);
  if (options.contactName) args.push('--contact-name', options.contactName);
  if (options.contactPhone) args.push('--contact-phone', options.contactPhone);
  if (options.contactEmail) args.push('--contact-email', options.contactEmail);
  return args;
}
```

Update `generateReport` signature:
```ts
export async function generateReport(jsonFilename: string, options?: ReportOptions): Promise<{ htmlFile?: string; pdfFile?: string }> {
```

In the spawn call (line 231), change:
```ts
const proc = spawn('node', [REPORT_SCRIPT, jsonFilename, ...reportOptionsToArgs(options)], { cwd: VIDEOSCAN_DIR, shell: true });
```

**Also update `generatePreview`** (line 252 — same pattern):
```ts
export async function generatePreview(jsonFilename: string, options?: ReportOptions): Promise<{ htmlFile?: string; pdfFile?: string }> {
```

And its spawn call (line 258):
```ts
const proc = spawn('node', [REPORT_SCRIPT, jsonFilename, '--preview', ...reportOptionsToArgs(options)], { cwd: VIDEOSCAN_DIR, shell: true });
```

- [ ] **Step 2: Commit**

```bash
git add src/core/videoscan-runner.ts
git commit -m "videoscan-runner: add ReportOptions, pass to report.mjs"
```

---

### Task 17: Update server API endpoints

**Files:**
- Modify: `src/server/index.ts:1613-1630` (generate-report and generate-preview endpoints)

- [ ] **Step 1: Update generate-report endpoint**

Change from:
```ts
const { filename } = req.body;
```
to:
```ts
const { filename, coverImageUrl, contactImageUrl, contactName, contactPhone, contactEmail } = req.body;
```

Pass options to runner:
```ts
const result = await generateReport(filename, { coverImageUrl, contactImageUrl, contactName, contactPhone, contactEmail });
```

- [ ] **Step 2: Update generate-preview endpoint**

Same pattern — destructure new fields, pass to `generatePreview()`.

- [ ] **Step 3: Update the import**

Make sure `ReportOptions` is imported if needed (or just pass inline object — TypeScript will infer).

- [ ] **Step 4: Commit**

```bash
git add src/server/index.ts
git commit -m "server: accept report options in generate-report/preview endpoints"
```

---

## Chunk 4: Dashboard integration

### Task 18: Update videoscan store

**Files:**
- Modify: `src/dashboard/stores/videoscan.svelte.ts:59-68`

- [ ] **Step 1: Add ReportOptions type and update store functions**

Add type (can be inline or imported from a shared types file — use inline for simplicity):

```ts
export interface ReportOptions {
  coverImageUrl?: string;
  contactImageUrl?: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
}
```

Update functions:
```ts
export async function regenerateReport(filename: string, options?: ReportOptions) {
  const result = await postJson('/api/videoscans/generate-report', { filename, ...options });
  await fetchScans();
  return result;
}

export async function regeneratePreview(filename: string, options?: ReportOptions) {
  const result = await postJson('/api/videoscans/generate-preview', { filename, ...options });
  await fetchScans();
  return result;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/stores/videoscan.svelte.ts
git commit -m "videoscan store: accept ReportOptions in regenerate functions"
```

---

### Task 19: Add report options popover to VideoscanPage

**Files:**
- Modify: `src/dashboard/components/VideoscanPage.svelte`

- [ ] **Step 1: Add state for report options form**

Near the existing `generating` state (line 166), add:

```ts
let showReportOptions = $state<string | null>(null); // filename when popover is open
let reportOptions = $state<ReportOptions>({});
```

Import `ReportOptions` from the store.

- [ ] **Step 2: Add popover/form component inline**

Near the Gen/Regen button area (around line 434), add a small inline form that shows when `showReportOptions === scan.filename`. Replace the direct `handleGenerateReport` call with a two-step: click Gen → show form → click "Generate" in form → call with options.

The form should have:
- Cover Image URL (text input)
- Contact Name, Phone, Email (text inputs)
- Contact Image URL (text input)
- "Generate" button (calls `handleGenerateReport` with options)
- "Cancel" link (hides form)

Style it as a small dropdown/popover using existing dashboard styling (dark theme, `#0d1117` background, border `#30363d`).

- [ ] **Step 3: Update handleGenerateReport to accept and pass options**

```ts
async function handleGenerateReport(scan: ScanSummary, options?: ReportOptions) {
  if (generating) return;
  generating = scan.filename;
  showReportOptions = null;
  try {
    await regenerateReport(scan.filename, options);
  } catch (err: any) {
    error = err.message;
  } finally {
    generating = null;
  }
}
```

Same for `handleGeneratePreview`.

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/components/VideoscanPage.svelte
git commit -m "dashboard: add report options popover for Gen/Regen buttons"
```

---

### Task 20: End-to-end test via dashboard

- [ ] **Step 1: Start dev server**

```bash
npm.cmd run dev
```

- [ ] **Step 2: Open dashboard, navigate to Videoscans tab**

Find an existing scan. Click "Gen" or "Regen". Verify the options popover appears. Fill in a cover image URL and contact details. Click Generate.

- [ ] **Step 3: Verify generated report**

Click the report link to open the HTML. Verify:
- New designer styling is applied
- Cover image shows the URL you entered
- Contact page shows the name/phone/email you entered
- All pages have correct footer with page numbers
- PDF generation still works (check for .pdf file)

- [ ] **Step 4: Test preview generation**

Click "Teaser" button. Verify preview HTML uses new styling.

- [ ] **Step 5: Final commit — update any remaining issues**

```bash
git add -u
git commit -m "fix: polish report redesign after e2e testing"
```
