# Nationale Monitor Digitale Toegankelijkheid — videoscan CLI

Eenmalige onderzoeksflow voor BB's deelname aan de Nationale Monitor (~700 NL-organisaties, 10 segmenten). Per organisatie wordt het domein gecrawld — startend op de support/FAQ-pagina — tot 10 pagina's met video gevonden zijn (RQ1), classificeert gevonden video's als uitlegvideo (RQ2), en aggregeert toegankelijkheids-signalen (RQ3 techniek + elementen). RQ3 content blijft handmatig.

## Vereisten vóór het draaien

1. **Input CSV** met headers (volgorde vrij, hoofdletter-ongevoelig):
   ```
   segment,organisatie,url_homepage,url_support,url_product
   ```
   Geconverteerd uit de SharePoint-Excel. `url_support`/`url_product` mogen leeg zijn — stap 0 vult `url_support` aan.

2. **`explainer-definition.md` in deze map** — definitie 'uitlegvideo' + 3 positieve en 3 negatieve voorbeelden. **De onderzoeker levert dit aan**; de placeholder die nu staat moet worden vervangen. (Alleen nodig voor stap 2.)

3. **Claude CLI beschikbaar** (`claude --print` werkend in dezelfde shell). Nodig voor stap 0 (LLM-tiebreak) en stap 2.

## Run-volgorde

```bash
# 0. (optioneel) url_support automatisch vinden uit de homepage-nav
#    Heuristiek + Claude-tiebreak. Vult url_support, voegt _method/_score kolommen toe.
node src/videoscan/monitor/find-support-urls.mjs \
  --input ./monitor-input/zorg.csv \
  --output ./monitor-input/zorg-enriched.csv
#    → spot-check rijen met method=llm / heuristic-weak / none vóór de scan.

# 1. Scan — crawlt per org tot 10 pagina's met video, support eerst
node src/videoscan/monitor/run-monitor.mjs \
  --input ./monitor-input/zorg-enriched.csv \
  --segment zorg

# 2. Classificeer (RQ2) — Claude per batch van 15 video's
node src/videoscan/monitor/classify-explainer.mjs --segment zorg

# 3. Aggregeer naar CSV
node src/videoscan/monitor/aggregate-monitor.mjs --segment zorg
```

Voor een pilot op een klein aantal orgs:
```bash
node src/videoscan/monitor/run-monitor.mjs --input ./monitor-input/zorg-enriched.csv --segment zorg --limit 5
```

## Scan-gedrag per organisatie

`run-monitor.mjs` start de crawl op `url_support` (valt terug op homepage als die leeg is) en seedt homepage + product in de queue. De crawl stopt zodra **10 pagina's met video** gevonden zijn (`--max-videos`, standaard 10) of bij de veiligheidslimiet van **40 pagina's** (`--max-pages`). Zo krijgt de support/FAQ-sectie voorrang (waar uitlegvideo's te verwachten zijn) zonder de hele site te crawlen.

## Output

Alles landt in `videoscans/monitor/<segment>/`:

```
videoscans/monitor/<segment>/
  <org-slug>/
    videoscan-<domain>-<ts>.json     ← ruwe scan-output (incl. accessibility-blok)
  <org-slug>.meta.json               ← org ↔ scan koppeling, scanFiles-lijst
  classify-output.json               ← RQ2 classificaties (Claude)
  monitor-results-<segment>.csv      ← één rij per org (RQ1 + RQ2 + RQ3 tech/elem)
  monitor-manual-review-<segment>.csv ← één rij per pagina met video (handmatig RQ3 Content)
```

De per-org subdir voorkomt collisions als twee orgs hetzelfde host gebruiken. Stap 0 levert daarnaast `<input>-enriched.csv` op (met `url_support`, `url_support_method`, `url_support_score`).

## Handmatige stap

Open `monitor-manual-review-<segment>.csv`, bekijk per pagina de video, vul `rq3_content_score` en `rq3_content_notes` in (Voldoet / Voldoet gedeeltelijk / Voldoet niet). Daarna een korte aggregatie per org (Excel VLOOKUP of `awk`) en de scores terugzetten in `monitor-results-<segment>.csv`.

## Drempelwaarden (placeholder)

`aggregate-monitor.mjs` gebruikt nu deze afleiding voor RQ3 (zie `SCORE_THRESHOLDS` bovenin het script):

- **Techniek** (3 criteria): geen autoplay-zonder-controls, aria-label/title aanwezig, `<video>`-controls of iframe-embed.
- **Elementen** (4 criteria): `<track>`-children, CC-knop, transcript-link, audiodescription-track.

`Voldoet` = alle criteria, `Voldoet gedeeltelijk` = ≥ ~1/3, anders `Voldoet niet`. `N.v.t.` als geen video. **Onderzoeker bevestigt of bijslijpt deze drempels** voor de definitieve run.

## Wat dit script NIET doet

- Geen dashboard-integratie (data leeft als bestanden op disk).
- Geen DB-persistentie (geen Supabase-rij).
- Geen RQ3 Content automatisering (vereist videotranscript-pipeline — apart project).
- Geen eindrapport (Word/PDF) — onderzoeker maakt zelf vanuit de CSV's.
