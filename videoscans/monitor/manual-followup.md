# Handmatige nazorg — false-zero kandidaten (bot-block / cookiewall)

Per segment: orgs met rq1=nee waar de scanner vermoedelijk geblokkeerd werd.
Werkwijze (zie BULK-RUN.md gotchas): site handmatig checken; indien echt video →
`ja`-override in `monitor-results-<slug>.csv` als LAATSTE stap (aggregate overschrijft).

## Zorg
- Isala, Rijnstate, Amerpoort, Esdégé-Reigersdaal, Sherpa, Lentis — find-support: "no internal links" (cookiewall/JS-nav) én rq1=nee.

## Reis en vakantie (zwaarste segment — travel bot-protection)
- KLM — find-support error: ERR_HTTP2_PROTOCOL_ERROR; rq1=nee. Zeker false-zero (KLM heeft video).
- Hotels.com — zelfde HTTP2-block; rq1=nee.
- Booking.com — rq1=nee; zware bot-protection, hoogst waarschijnlijk false-zero.
- Expedia (2× in input — duplicaat-rij!) — rq1=nee; bot-wall.
- Transavia — rq1=nee; bot-protection waarschijnlijk.
- NS — rq1=nee; verdacht (NS heeft uitlegvideo's), check handmatig.
- Eurostar — rq1=nee; verdacht.
- BlaBlaCar, interrail, Kras reizen — find-support "no pick" én rq1=nee.
- Overige nee's (natuurhuisje, nightjet, Sixt share, spoordeelwinkel, TravelBird,
  Treinreiswinkel, Vakantiediscounter, Vliegwinkel, Zoover) — kunnen legitiem zijn, steekproef.

## Financiele sector
- ING — find-support error: ERR_HTTP2_PROTOCOL_ERROR; **rq1=nee bevestigd false-zero** (ING heeft uitlegvideo's) → ja-override.
- Zilveren Kruis — rq1=nee, verdacht voor een verzekeraar; handmatig checken.
- Overige nee's (Anadolu, Argenta, Bitvavo, BMW FS, Brand New Day, Coinmerce, Hiltermann,
  Holland Gold, MeDirect, Monuta, Openbank, Pensioen vervoer, Stellantis FS, YapiKredi, Zekur) — steekproef.

## Media (zwaarste override-segment: 28 nee waarvan ~15+ evident false-zero)
- **Telegraaf** — eindigde toch rq1=ja (1 pagina vóór throttle); data mager, RQ2/RQ3 dun.
- **Evident false-zero (alle bot-walled, hebben aantoonbaar video) → ja-override:**
  AD, Het Financieele Dagblad, Parool, Trouw, Volkskrant, NPO, NPO Start, RTL Nieuws,
  Viaplay, SkyShowtime, X (Twitter), Pinterest, Threads, Podimo (audio? check), Storytel (audio? check).
- Twijfel/steekproef: AutoWeek, Bladen, Business Insider, Elle*, Elsevier*, KPN, Libelle,
  Margriet, Nieuwsvisie, Omroep Fryslân/Gelderland/MAX, RTV Rijnmond*.
  (* = kapotte input-URL, zie hieronder; herscan met juiste URL.)
- **Input-URL-fouten (fix + herscan deze 3 orgs):**
  - Elsevier: `https://elsevier.nl` weigert verbinding — magazine heet nu EW, probeer `https://www.ewmagazine.nl`.
  - Elle: `https://elle.nl` connection refused — probeer `https://www.elle.com/nl/`.
  - RTV Rijnmond: `https://rtvrijnmond.nl` cert-fout — echte site is `https://www.rijnmond.nl`.
- Social/streaming met bot-wall (none + waarschijnlijk geblokkeerde scan): TikTok, Pinterest, Threads, Viaplay, NPO Start — "video aanwezig" is daar inhoudelijk triviaal **ja**; handmatige override voor de hand liggend.
- Overige none: Libelle, Vogue NL, Nat Geo NL, RTL Nieuws, Business Insider, Omroep Gelderland, Omroep Fryslân, KPN — homepage-fallback, check rq1=nee uitkomsten.

## Culturele sector (gezond: 72/79 ja)
- Verdachte nee's: **IFFR** (filmfestival zonder video onaannemelijk), Mauritshuis, Kunsthal,
  Corpus, DGTL, Grachtenfestival, Philharmonie Haarlem — steekproef.

## E-commerce (27% zonder seed — retail bot-walls)
- Errors: Zalando, Jumbo (timeout), Nespresso (HTTP2-block).
- "no internal links" (cookie/bot-wall): ASOS, H&M, WE Fashion, Zara, Adidas, Decathlon,
  XXL Nutrition, Albert Heijn Online, Douglas, ICI Paris XL, Kruidvat.
- "llm: no pick": Coolblue, Gamma, Karwei, VidaXL, Albelli, Foot Locker.
- Na scan: alle rq1=nee uit deze lijst handmatig checken; grote retailers hebben vrijwel
  allemaal productvideo/uitlegvideo → veel ja-overrides verwacht.
- **org-timeout (20min cap, Cloudflare-WAF):** cameranu.nl, etos.nl — partial/geen data; handmatig checken.
- **Uitkomst rq1=nee (25):** Adidas, Allekabels, ASOS, Cameranu, Coolblue, De Bijenkorf,
  Decathlon, Douglas, Etos, **Gall & Gall (age-gate!)**, H&M, ICI Paris XL, JD Sports, Jumbo,
  Kruidvat, Leen Bakker, Nespresso, Specsavers, Thuisbezorgd, Toolstation, VidaXL, WE Fashion,
  XXL Nutrition, Zalando, Zara — grote meerderheid vermoedelijk false-zero; bulk-override ronde nodig.

## Onderwijs
- **org-timeout:** breda-university-of-applied-sciences — handmatig checken.

## Energie en nutsbedrijven (gezond: 58/67 ja, 37 RQ2-ja)
- KPN — nee, óók nee in Media-segment → bevestigd bot-wall patroon; ja-override waarschijnlijk.
- Waternet — nee, verdacht voor nutsbedrijf; steekproef.
- Overige nee's (Caiway, Clean Energy (2×?), Delta Energie, Energyzero, HollandseNieuwe, Lebara) — steekproef.

## Wonen
- **Staedion** — find-support crash: `href.startsWith is not a function` (code-bug in
  link-extractie, niet-string href bv. SVG). Fix guard in find-support-urls.mjs vóór herscans.
- 12× none (WoningNet, Studentenwoningweb, Holland2Stay, Xior, Camelot, e.a.) — veel
  login-walled platforms; check rq1=nee uitkomsten.

(verder aanvullen per segment)
