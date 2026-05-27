# Nationale Monitor Digitale Toegankelijkheid — videoscan CLI

Eenmalige onderzoeksflow voor BB's deelname aan de Nationale Monitor (~700 NL-organisaties, 10 segmenten). Scant per organisatie 3 pagina's (homepage + support + optioneel product) op video-aanwezigheid (RQ1), classificeert gevonden video's als uitlegvideo (RQ2), en aggregeert toegankelijkheids-signalen (RQ3 techniek + elementen). RQ3 content blijft handmatig.

## Vereisten vóór het draaien

1. **Input CSV per segment** met headers:
   ```
   segment,organisatie,url_homepage,url_support,url_product
   ```
   Geconverteerd uit de SharePoint-Excel (één blad per segment, of een gemerged blad gefilterd op segment).

2. **`explainer-definition.md` in deze map** — definitie 'uitlegvideo' + 3 positieve en 3 negatieve voorbeelden. **De onderzoeker levert dit aan**; de placeholder die nu staat moet worden vervangen.

3. **Claude CLI beschikbaar** (`claude --print` werkend in dezelfde shell als waar deze scripts draaien).

## Run-volgorde

```bash
# 1. Scan (sequentieel, ~3s delay per URL — 700 orgs × 3 URLs ≈ 1u45)
node src/videoscan/monitor/run-monitor.mjs \
  --input ./monitor-input/zorg.csv \
  --segment zorg \
  --max-pages 3

# 2. Classificeer (RQ2) — Claude per batch van 15 video's
node src/videoscan/monitor/classify-explainer.mjs --segment zorg

# 3. Aggregeer naar CSV
node src/videoscan/monitor/aggregate-monitor.mjs --segment zorg
```

Voor een pilot op een klein aantal orgs:
```bash
node src/videoscan/monitor/run-monitor.mjs --input ./monitor-input/zorg.csv --segment zorg --limit 5
```

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

De per-org subdir voorkomt collisions als twee orgs hetzelfde host gebruiken.

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
