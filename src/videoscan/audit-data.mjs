/**
 * Proper Access audit results — structured data for reports.
 * Source: https://audit.properaccess.nl/reports/202512_videospelers_v2/
 *
 * IMPORTANT: Only high-level counts and categories are exposed.
 * Specific WCAG issues are NOT included (competitive advantage).
 */

export const AUDIT_DATA = {
  source: "Proper Access",
  standard: "WCAG 2.2 Level AA",
  method: "WCAG-EM",
  date: "2025-12",
  url: "https://audit.properaccess.nl/reports/202512_videospelers_v2/",
  players: {
    "Blue Billywig":       { findings: 0,  failedSC: 0,  status: "pass" },
    "Ivory Media Player":  { findings: 17, failedSC: 11, status: "fail" },
    YouTube:               { findings: 10, failedSC: 10, status: "fail" },
    "Ping Player":         { findings: 12, failedSC: 8,  status: "fail" },
    "Vixy Video":          { findings: 20, failedSC: 14, status: "fail" },
    Vimeo:                 { findings: 4,  failedSC: 4,  status: "fail" },
    Hihaho:                { findings: 12, failedSC: 14, status: "fail" },
    Rijksoverheidsplayer:  { findings: 0,  failedSC: 0,  status: "pass" },
    OpenGemeenten:         { findings: 0,  failedSC: 0,  status: "pass" },
  },
  categories: {
    "Toetsenbordbediening":       { playersAffected: 6, description: "Bediening via toetsenbord" },
    "Schermlezer-ondersteuning":  { playersAffected: 6, description: "ARIA-rollen, namen en statussen" },
    "Contrast & zichtbaarheid":   { playersAffected: 5, description: "Focusindicatoren, tekst- en iconencontrast" },
    "Zoom & responsiviteit":      { playersAffected: 3, description: "Bruikbaarheid bij 400% zoom" },
    "Formulieren & labels":       { playersAffected: 3, description: "Labels, foutmeldingen, autocomplete" },
    "Taalinstellingen":           { playersAffected: 3, description: "Ontbrekende taalattributen" },
  },
};

/** Map scanner player names to audit player names */
export const SCANNER_TO_AUDIT = {
  "Blue Billywig": "Blue Billywig",
  YouTube: "YouTube",
  Vimeo: "Vimeo",
  PingVP: "Ping Player",
  "Vixy Video": "Vixy Video",
  Hihaho: "Hihaho",
  "Ivory Media Player": "Ivory Media Player",
  OpenGemeenten: "OpenGemeenten",
  Rijksoverheidsplayer: "Rijksoverheidsplayer",
};
