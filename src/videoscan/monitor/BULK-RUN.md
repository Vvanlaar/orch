# Bulk-run handoff — Nationale Monitor videoscan (9 resterende segmenten)

**Doel:** de RQ1/RQ2/RQ3-pijplijn draaien voor de 9 nog niet gescande segmenten (~603 orgs). Sportwereld (42) is al gedaan en gevalideerd. Dit is bewust een *verse, lichte* sessie: puur het recept draaien + bewaken. De pilot-context (debugging) staat in git en hoeft niet herhaald.

## Waar alles staat
- **Worktree (hier werken!):** `C:\dev\orch\.claude\worktrees\festive-wing-5a90e8` — branch `claude/festive-wing-5a90e8`, remote `git@github.com:Vvanlaar/orch.git`. Werk in déze worktree, niet in een andere `worktrees/...` map.
- **Operationele gids (autoritatief, lees eerst):** `src/videoscan/monitor/README.md`.
- **Input-CSV's (klaar):** `monitor-input/<slug>.csv` (formaat `segment,organisatie,url_homepage,url_support,url_product`; `url_support` leeg → stap 0 vult).
- **Output per segment:** `videoscans/monitor/<slug>/` (gitignored, lokaal).

## Reeds gecommit (werkt — niet opnieuw doen)
- RQ1 filter-fix (non-video socials vóór tier-filter) — voorkwam false-zero ondertelling.
- RQ2 videotitel-fix + dedupe in `classify-explainer.mjs` — classifier weegt nu de embed-titel mee.
- RQ3-drempels bevestigd; `explainer-definition.md` ingevuld (mag later bijgeschaafd na collega-review).

## De 9 te draaien segmenten

| segment (gebruik exact, met quotes) | slug | orgs |
|---|---|---|
| `Financiele sector` | financiele-sector | 75 |
| `Reis en vakantie` | reis-en-vakantie | 55 |
| `Culturele sector` | culturele-sector | 79 |
| `Media` | media | 71 |
| `Energie en nutsbedrijven` | energie-en-nutsbedrijven | 67 |
| `E-commerce` | e-commerce | 74 |
| `Wonen` | wonen | 53 |
| `Zorg` | zorg | 78 |
| `Onderwijs` | onderwijs | 51 |

(Sportwereld = klaar.)

## Recept per segment (4 stappen)
Draai vanuit de worktree-root. Gebruik **dezelfde** `--segment`-string in stap 1/2/3.

```bash
SEG="Zorg"; SLUG="zorg"   # pas per segment aan (zie tabel)

# 0. Support-URL's vinden (heuristiek + Claude-tiebreak). Resumable.
node src/videoscan/monitor/find-support-urls.mjs --input ./monitor-input/$SLUG.csv --output ./monitor-input/$SLUG-enriched.csv
#    → SPOT-CHECK vóór de scan: rijen met method=llm / heuristic-weak / none / error (zie kolom _note).

# 1. Scan = RQ1 + RQ3 tech/elem-capture. Resumable (skip al-gescande orgs; --fresh = opnieuw). Lang → draai in achtergrond.
node src/videoscan/monitor/run-monitor.mjs --input ./monitor-input/$SLUG-enriched.csv --segment "$SEG"

# 2. RQ2-classificatie (heeft `claude` CLI nodig).
node src/videoscan/monitor/classify-explainer.mjs --segment "$SEG"

# 3. Aggregeren → monitor-results-<slug>.csv + monitor-manual-review-<slug>.csv.
node src/videoscan/monitor/aggregate-monitor.mjs --segment "$SEG"
```

## Aanpak / volgorde (aanbevolen)
- **Doe segment-voor-segment** (of een paar parallel in de achtergrond), niet blind alle 9 tegelijk. Bekijk bij het **eerste** segment de find-support-output kritisch — dat is waar de pilot-fouten zaten.
- Lange stappen (0 en 1) met **`run_in_background: true`** → je krijgt automatisch een seintje bij afronding; keten ze: `find-support && run-monitor && classify && aggregate && echo DONE`.
- **Reboot-veilig:** alles is resumable; wake-lock houdt de laptop wakker tijdens de scan. Na onderbreking gewoon hetzelfde commando opnieuw.

## Gotchas
- **Windows:** npm/npx als `.cmd`. `claude` CLI werkt hier als subprocess (geverifieerd). Playwright chromium moet geïnstalleerd zijn (`npx.cmd playwright install chromium`).
- **Bot-block / age-gate sites** (zoals olympics.com HTTP2-block, alcohol-age-gates): de headless scanner kan die niet bereiken → false-zero. Per segment grote bot-protected mega-sites apart checken; indien echt video → handmatige `ja`-override in de results-CSV (aggregate overschrijft, dus override als láátste).
- **RQ2** draait op de scan-data; de videotitel-fix zit erin. Re-classify is goedkoop/herhaalbaar als de definitie wijzigt.
- **Niet trust-en op één scan** van een social-heavy site voor één player-type; org-niveau RQ1 (video j/n) is stabiel.

## Handmatig / onderzoeker (parallel of achteraf — niet blokkerend)
- **RQ3-content** invullen in `monitor-manual-review-<slug>.csv`, terugmergen.
- **Collega-review RQ2:** per segment kan een review-CSV gemaakt worden zoals voor Sportwereld (zie `videoscans/monitor/sportwereld/RQ2-review-sportwereld.csv` als voorbeeld). Mede-onderzoeker is met vakantie.
- **Olympics-achtige overrides** waar de scanner geblokkeerd werd.

## Suggested skills
- `diagnose` — voor elke scan/detectie-bug (vond eerder de filter-volgorde- en TikTok-bugs).
- `proc-inspect` — bij vragen over draaiende node/bash-processen.
- Lees `src/videoscan/monitor/README.md` vóór je de pijplijn aanraakt.
