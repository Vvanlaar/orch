#!/usr/bin/env node
import { chromium } from "playwright";
import chalk from "chalk";
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, unlinkSync } from "fs";
import { basename, dirname, join } from "path";
import { fileURLToPath } from "url";
import os from "node:os";
import { acquire } from "./wake-lock.mjs";

// ── Video Player Detectors ──────────────────────────────────────────
// Each detector checks page HTML + network requests for a specific player.
// Returns { found: boolean, details: string[] }

export const DETECTORS = {
  // ── Enterprise / OVP ────────────────────────────────────────────
  "Blue Billywig": {
    patterns: [
      /bbvms\.com/i,
      /bluebillywig\.com/i,
      /\.bbvms\./i,
      /bb-player/i,
      /data-bb-/i,
    ],
    scripts: [/bbvms\.com/i, /bluebillywig/i],
  },
  Brightcove: {
    patterns: [
      /players\.brightcove\.net/i,
      /brightcove\.com/i,
      /bcove\.video/i,
      /brightcove-player/i,
      /data-account.*data-player/i,
      /data-video-id/i,
    ],
    scripts: [/players\.brightcove\.net/i, /brightcove\.com/i],
  },
  "JW Player": {
    patterns: [
      /jwplatform\.com/i,
      /jwplayer\.com/i,
      /jwpcdn\.com/i,
      /jwplayer\(/i,
      /jw-video-player/i,
      /cdn\.jwplayer\.com\/libraries/i,
      /cdn\.jwplayer\.com\/v2\/playlists/i,
      /class="jwplayer/i,
    ],
    scripts: [/jwplatform\.com/i, /jwplayer\.com/i, /jwpcdn\.com/i, /cdn\.jwplayer\.com/i],
  },
  Kaltura: {
    patterns: [
      /kaltura\.com/i,
      /cdnapisec\.kaltura/i,
      /kWidget/i,
      /kaltura-player/i,
    ],
    scripts: [/kaltura\.com/i],
  },
  Wistia: {
    patterns: [
      /wistia\.com/i,
      /wistia\.net/i,
      /fast\.wistia\./i,
      /wistia-popover/i,
      /wistia_embed/i,
      /data-wistia-id/i,
      /fast\.wistia\.net\/assets\/external\/E-v1\.js/i,
    ],
    scripts: [/wistia\.com/i, /wistia\.net/i, /fast\.wistia\.net/i],
  },
  Vidyard: {
    patterns: [
      /play\.vidyard\.com/i,
      /share\.vidyard\.com/i,
      /vidyard-player/i,
      /vyContext/i,
    ],
    scripts: [/vidyard\.com/i],
  },
  Flowplayer: {
    patterns: [/flowplayer\.com/i, /flowplayer\.org/i, /flowplayer\(/i],
    scripts: [/flowplayer/i],
  },
  Panopto: {
    patterns: [
      /panopto\.com/i,
      /panopto\.eu/i,
      /\/Panopto\/Pages\/Embed\.aspx/i,
      /\/Panopto\/Pages\/Viewer\.aspx/i,
      /data-panopto-id/i,
    ],
    scripts: [/panopto/i],
  },
  PingVP: {
    patterns: [
      /pingvp\.com/i,
      /pingVpVideoContainer/i,
      /pingVpReset/i,
    ],
    scripts: [/pingvp\.com/i],
  },
  Hihaho: {
    patterns: [/player\.hihaho\.com/i, /hihaho\.com\/embed/i, /hihaho\.com/i],
    scripts: [/hihaho\.com/i],
  },
  "Ivory Media Player": {
    patterns: [/ivoryvideo\.com/i, /ivory-player/i, /ivorymediaplayer/i],
    scripts: [/ivoryvideo\.com/i],
  },
  OpenGemeenten: {
    patterns: [/opengemeenten\.nl/i, /AccessibleMediaPlayer/i, /opengemeenten/i],
    scripts: [/opengemeenten/i],
  },
  Rijksoverheidsplayer: {
    patterns: [
      /platformrijksoverheidonline\.nl/i,
      /mediatheek\.rijksoverheid/i,
      /rijksoverheid\.nl\/[^"]*video/i,
    ],
    scripts: [/platformrijksoverheidonline/i],
  },
  "Vixy Video": {
    patterns: [
      /platform\.vixyvideo\.com/i,
      /vixyvideo\.com/i,
      /vixy\.nl/i,
    ],
    scripts: [/vixyvideo\.com/i],
  },

  // ── Major platforms ─────────────────────────────────────────────
  YouTube: {
    patterns: [
      /youtube\.com\/embed/i,
      /youtube-nocookie\.com\/embed/i,
      // NB: no bare /youtu\.be\// — that's a share/watch link domain, never an
      // embed src. It fired on plain links (stripAnchorHrefs only strips <a href>,
      // not data-*/text/JSON), flagging pages that merely link to YouTube.
      /ytimg\.com/i,
      /youtube\.com\/iframe_api/i,
      /yt-video/i,
      /class="youtube/i,
      /data-youtube-id/i,
      /data-youtube-video-id/i,
      /youtube-player/i,
    ],
    scripts: [/youtube\.com/i, /ytimg\.com/i],
  },
  Vimeo: {
    patterns: [
      /player\.vimeo\.com/i,
      /vimeo\.com\/video/i,
      /vimeo\.com\/\d+/i,
      /vimeocdn\.com/i,
      /data-vimeo-id/i,
      /data-vimeo-url/i,
      /vimeo-player/i,
    ],
    scripts: [/player\.vimeo\.com/i, /vimeocdn\.com/i],
  },
  DailyMotion: {
    patterns: [
      /dailymotion\.com\/embed/i,
      /dailymotion\.com\/player/i,
      /dailymotion\.com\/video/i,
      /geo\.dailymotion\.com/i,
      /dailymotion-player/i,
    ],
    scripts: [/dailymotion\.com/i, /dmcdn\.net/i],
  },
  TikTok: {
    patterns: [
      /tiktok\.com\/embed/i,
      /tiktok\.com\/player\/v1/i,
      /tiktok-embed/i,
      /data-video-id.*tiktok/i,
    ],
    scripts: [/tiktok\.com\/embed\.js/i, /tiktok\.com/i],
  },
  Instagram: {
    patterns: [
      /instagram\.com\/embed/i,
      /cdninstagram\.com/i,
      /instgrm\.Embeds/i,
      /instagram-media/i,
      /data-instgrm-permalink/i,
      /data-instgrm-version/i,
    ],
    scripts: [/instagram\.com\/embed\.js/i, /instagram\.com\/embed/i, /cdninstagram\.com/i],
  },
  "Facebook Video": {
    patterns: [
      /facebook\.com\/plugins\/video\.php/i,
      /facebook\.com\/watch/i,
      /class="fb-video/i,
    ],
    scripts: [/connect\.facebook\.net\/.+\/sdk\.js/i],
  },
  "X (Twitter)": {
    patterns: [
      /platform\.twitter\.com\/widgets/i,
      /twitter-tweet/i,
      /twitter-timeline/i,
      /twitter-video/i,
    ],
    scripts: [/platform\.twitter\.com\/widgets\.js/i],
  },
  LinkedIn: {
    patterns: [
      /linkedin\.com\/embed\/feed\/update/i,
      /linkedin\.com\/posts\//i,
    ],
    scripts: [],
  },
  Twitch: {
    patterns: [
      /player\.twitch\.tv/i,
      /twitch\.tv\/embed/i,
      /data-twitch-channel/i,
      /twitch-embed/i,
    ],
    scripts: [/twitch\.tv/i],
  },
  "Spotify (podcast)": {
    patterns: [
      /open\.spotify\.com\/embed/i,
      /spotify\.com\/episode/i,
      /spotify\.com\/show/i,
    ],
    scripts: [/spotify\.com/i],
  },
  Loom: {
    patterns: [
      /loom\.com\/embed/i,
      /loom\.com\/share/i,
      /useloom\.com/i,
    ],
    scripts: [/loom\.com/i],
  },

  // ── CDN / Infrastructure players ────────────────────────────────
  "Cloudflare Stream": {
    patterns: [
      /iframe\.videodelivery\.net/i,
      /videodelivery\.net/i,
      /data-cf-stream/i,
    ],
    scripts: [/videodelivery\.net/i],
  },
  "bunny.net Stream": {
    patterns: [
      /iframe\.mediadelivery\.net\/embed/i,
      /player\.mediadelivery\.net/i,
    ],
    scripts: [/mediadelivery\.net/i],
  },
  Mux: {
    patterns: [
      /stream\.mux\.com/i,
      /<mux-player/i,
      /mux-player/i,
    ],
    scripts: [/stream\.mux\.com/i, /mux\.com/i],
  },

  // ── Other platforms ─────────────────────────────────────────────
  Streamable: {
    patterns: [
      /streamable\.com\/e\//i,
      /streamable\.com\/o\//i,
      /streamable-embed/i,
    ],
    scripts: [/streamable\.com/i],
  },
  Rumble: {
    patterns: [
      /rumble\.com\/embed/i,
      /rumble\.com\/v[\w-]+/i,
    ],
    scripts: [/rumble\.com/i],
  },
  PeerTube: {
    patterns: [
      /\/videos\/embed\/[0-9a-f]{8}-/i,
      /\/videos\/watch\/[0-9a-f]{8}-/i,
    ],
    scripts: [/@peertube\/embed-api/i],
  },
  Odysee: {
    patterns: [
      /odysee\.com\/\$\/embed/i,
      /odysee\.com\/@/i,
    ],
    scripts: [/odysee\.com/i, /odycdn\.com/i],
  },
  Reddit: {
    patterns: [
      /embed\.reddit\.com/i,
      /redditmedia\.com/i,
      /reddit-embed/i,
    ],
    scripts: [/embed\.reddit\.com\/widgets\.js/i],
  },
  Bilibili: {
    patterns: [
      /player\.bilibili\.com\/player\.html/i,
      /bilibili\.com\/video\/BV/i,
    ],
    scripts: [/bilibili\.com/i],
  },
  "VK Video": {
    patterns: [
      /vk\.com\/video_ext\.php/i,
      /vk\.com\/video/i,
    ],
    scripts: [/vk\.com/i],
  },
  SproutVideo: {
    patterns: [/sproutvideo\.com/i, /videos\.sproutvideo/i],
    scripts: [/sproutvideo\.com/i],
  },
  "Video.js": {
    patterns: [/video\.js/i, /videojs/i, /vjs-/i, /video-js/i],
    scripts: [/videojs/i, /video\.js/i, /vjs/i],
  },
  "MediaElement.js": {
    patterns: [
      /mejs[_-]?_?container/i,
      /class="[^"]*\bmejs\b/i,
      /mediaelementplayer/i,
      /mediaelement-and-player/i,
      // IProX deferred-markup signature (verbatim MediaElementPlayer feature list)
      /data-playerfeatures="playpause,current,progress,duration/i,
      /<video[^>]+class="[^"]*\bmedia-element\b/i,
    ],
    scripts: [/mediaelement(?:-and-player)?(?:\.min)?\.js/i, /mediaelementplayer/i],
  },
  Plyr: {
    patterns: [
      /class="[^"]*\bplyr\b/i,
      /<div[^>]+data-plyr-provider/i,
      /plyr--(?:video|audio|html5|youtube|vimeo)/i,
    ],
    scripts: [/(?:^|\/)plyr(?:\.polyfilled)?(?:\.min)?\.js/i],
  },
  Clappr: {
    patterns: [
      /class="[^"]*\bclappr\b/i,
      /data-clappr/i,
      /new Clappr\.Player/i,
    ],
    scripts: [/(?:^|\/)clappr(?:\.min)?\.js/i],
  },
  "Shaka Player": {
    patterns: [
      /class="[^"]*shaka-/i,
      /data-shaka-player/i,
      /shaka\.Player/i,
    ],
    scripts: [/(?:^|\/)shaka-player(?:\.compiled)?(?:\.min)?\.js/i],
  },
  "HTML5 native": {
    patterns: [/<video[\s>]/i, /<source[^>]+type="video/i],
    scripts: [],
  },
  Cincopa: {
    patterns: [/cincopa\.com/i],
    scripts: [/cincopa\.com/i],
  },
  "23 Video": {
    patterns: [/23video\.com/i],
    scripts: [/23video\.com/i],
  },
  Mediasite: {
    patterns: [/mediasite/i],
    scripts: [/mediasite/i],
  },
  ThePlatform: {
    patterns: [/theplatform\.com/i, /media\.theplatform/i],
    scripts: [/theplatform\.com/i],
  },
};

// ── Tier priority (1 = highest) ─────────────────────────────────────
const DETECTOR_TIER = {
  // Tier 1: Enterprise / OVP
  "Blue Billywig": 1, Brightcove: 1, "JW Player": 1, Kaltura: 1,
  Wistia: 1, Vidyard: 1, Flowplayer: 1, Panopto: 1, PingVP: 1,
  Hihaho: 1, "Ivory Media Player": 1, OpenGemeenten: 1, Rijksoverheidsplayer: 1, "Vixy Video": 1,
  // Tier 2: Major platforms
  YouTube: 2, Vimeo: 2, DailyMotion: 2, TikTok: 2, Instagram: 2,
  "Facebook Video": 2, "X (Twitter)": 2, LinkedIn: 2, Twitch: 2,
  "Spotify (podcast)": 2, Loom: 2,
  // Tier 3: CDN / Infrastructure
  "Cloudflare Stream": 3, "bunny.net Stream": 3, Mux: 3,
  // Tier 4: Other platforms
  Streamable: 4, Rumble: 4, PeerTube: 4, Odysee: 4, Reddit: 4,
  Bilibili: 4, "VK Video": 4, SproutVideo: 4, Cincopa: 4,
  "23 Video": 4, Mediasite: 4, ThePlatform: 4,
  // Tier 5: Generic
  "Video.js": 5, "MediaElement.js": 5, Plyr: 5, Clappr: 5, "Shaka Player": 5,
  "HTML5 native": 5,
};

/** Keep only the highest-priority tier of players found on a page. */
function filterToHighestTier(players) {
  if (players.length <= 1) return players;
  const minTier = Math.min(...players.map((p) => DETECTOR_TIER[p.player] ?? 5));
  return players.filter((p) => (DETECTOR_TIER[p.player] ?? 5) === minTier);
}

// Social embeds where the regex matches both video and non-video posts.
// Each confirmer returns true only if positive video evidence is present.
const SOCIAL_VIDEO_CONFIRMERS = {
  Instagram: (html, net) =>
    /data-instgrm-permalink="[^"]*\/(reel|tv)\//i.test(html) ||
    net.some((r) => /cdninstagram\.com\/.+\.mp4/i.test(r)),
  "X (Twitter)": (html, net) =>
    /class="[^"]*twitter-video/i.test(html) ||
    net.some(
      (r) =>
        /video\.twimg\.com/i.test(r) ||
        /pbs\.twimg\.com\/(ext_tw_video_thumb|amplify_video_thumb)/i.test(r)
    ),
  "Facebook Video": (html, net) =>
    /class="[^"]*fb-video/i.test(html) ||
    /facebook\.com\/(plugins\/video\.php|watch)/i.test(html) ||
    net.some((r) => /video\.xx\.fbcdn\.net/i.test(r) || /fbcdn\.net\/.+\.mp4/i.test(r)),
  LinkedIn: (html, net) =>
    net.some((r) => /dms\.licdn\.com\/playlist/i.test(r) || /dms\.licdn\.com\/.+\.mp4/i.test(r)) ||
    /<video[^>]+(?:src|data-src)="[^"]*dms\.licdn\.com/i.test(html),
};

function filterNonVideoSocials(detected, html, networkRequests) {
  return detected.filter(({ player }) => {
    const confirm = SOCIAL_VIDEO_CONFIRMERS[player];
    return !confirm || confirm(html, networkRequests);
  });
}

// ── Crawler ─────────────────────────────────────────────────────────

function normalizeUrl(url, base) {
  try {
    const u = new URL(url, base);
    u.hash = "";
    // Remove trailing slash for consistency (except root)
    if (u.pathname !== "/" && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.href;
  } catch {
    return null;
  }
}

function isSameDomain(url, domain) {
  try {
    const u = new URL(url);
    return (
      u.hostname === domain || u.hostname === `www.${domain}` || `www.${u.hostname}` === domain
    );
  } catch {
    return false;
  }
}

function shouldSkipUrl(url) {
  const skip = [
    /\.(pdf|zip|png|jpg|jpeg|gif|svg|webp|mp4|mp3|wav|doc|docx|xls|xlsx|ppt|pptx|css|js)(\?|$)/i,
    /mailto:/i,
    /tel:/i,
    /javascript:/i,
    /#$/,
  ];
  if (skip.some((r) => r.test(url))) return true;

  // Pagination: skip ?page=N unless it's a listing/archive path where
  // pagination is the only way to reach older items.
  if (/\?.*\bpage=\d+/i.test(url)) {
    const isListing = /\/(nieuws|news|blog|archief|archive|pers|press|media|publicaties|publications)(\/|\?|$)/i.test(url);
    if (!isListing) return true;
  }
  return false;
}

// Discover URLs via robots.txt → sitemap (handles sitemapindex recursion).
// Returns same-domain, non-skip URLs only. Best-effort: any error → empty.
async function discoverSitemapUrls(startUrl, domain, { maxUrls = 5000, fetchTimeout = 30000 } = {}) {
  const origin = new URL(startUrl).origin;
  const targetProtocol = new URL(startUrl).protocol;
  const sitemapCandidates = new Set();

  // 1. Try robots.txt first
  try {
    const robotsRes = await fetchWithTimeout(`${origin}/robots.txt`, fetchTimeout);
    if (robotsRes?.ok) {
      const text = await robotsRes.text();
      for (const m of text.matchAll(/^\s*Sitemap:\s*(\S+)/gim)) {
        sitemapCandidates.add(m[1].trim());
      }
    }
  } catch {}

  // 2. Fallback to common locations
  if (sitemapCandidates.size === 0) {
    sitemapCandidates.add(`${origin}/sitemap.xml`);
    sitemapCandidates.add(`${origin}/sitemap`);
  }

  const visitedSitemaps = new Set();
  const found = new Set();
  const MAX_SITEMAP_DEPTH = 3;

  async function processSitemap(url, depth = 0) {
    if (depth > MAX_SITEMAP_DEPTH || visitedSitemaps.has(url) || found.size >= maxUrls) return;
    visitedSitemaps.add(url);
    let xml;
    try {
      const res = await fetchWithTimeout(url, fetchTimeout);
      if (!res?.ok) return;
      xml = await res.text();
    } catch { return; }

    const isIndex = /<sitemapindex\b/i.test(xml);
    const locs = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1]);
    if (isIndex) {
      for (const loc of locs) {
        if (found.size >= maxUrls) break;
        // Only follow sub-sitemaps on the same domain to avoid arbitrary outbound fetches
        if (!isSameDomain(loc.replace(/^https?:/, targetProtocol), domain)) continue;
        await processSitemap(loc, depth + 1);
      }
    } else {
      for (const loc of locs) {
        if (found.size >= maxUrls) break;
        // Normalize scheme to match the site's protocol (sitemaps often use http://)
        const schemeMatched = loc.replace(/^https?:/, targetProtocol);
        const normalized = normalizeUrl(schemeMatched, startUrl);
        if (normalized && isSameDomain(normalized, domain) && !shouldSkipUrl(normalized)) {
          found.add(normalized);
        }
      }
    }
  }

  for (const sm of sitemapCandidates) {
    if (found.size >= maxUrls) break;
    await processSitemap(sm);
  }
  return [...found];
}

async function fetchWithTimeout(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ctrl.signal, redirect: "follow" });
  } finally {
    clearTimeout(timer);
  }
}

// Pages with these path segments are more likely to have video content.
// We prioritize them in the crawl queue so they get scanned first.
const VIDEO_LIKELY_PATHS = [
  /video/i, /media/i, /blog/i, /nieuws/i, /news/i, /podcast/i,
  /over-/i, /about/i, /campagne/i, /campaign/i, /verhaal/i, /story/i,
  /werkenbij/i, /careers/i, /evenement/i, /event/i, /webinar/i,
  /academy/i, /training/i, /demo/i, /tutorial/i, /case/i,
];

function prioritizeUrls(urls) {
  const high = [];
  const normal = [];
  for (const url of urls) {
    if (VIDEO_LIKELY_PATHS.some((p) => p.test(url))) {
      high.push(url);
    } else {
      normal.push(url);
    }
  }
  return [...high, ...normal];
}

async function acceptCookies(page) {
  const selectors = [
    "#onetrust-accept-btn-handler",
    "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
    'button:has-text("Accepteren")',
    'button:has-text("Alle cookies accepteren")',
    'button:has-text("Alle cookies")',
    'button:has-text("Akkoord")',
    'button:has-text("Accept all")',
    'button:has-text("Accept")',
    ".cc-accept",
    "#accept-cookies",
    '[data-action="accept"]',
  ];
  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) {
        await btn.click();
        await page.waitForTimeout(1500);
        return true;
      }
    } catch {}
  }
  return false;
}

// After accepting the cookie banner, Cookiebot's inline consent placeholders
// (e.g. <script type="text/plain" data-cookieconsent="marketing">) may still
// block video embeds. This function triggers the swap so iframes load.
async function activateCookiebotConsent(page) {
  const PLACEHOLDER = 'script[type="text/plain"][data-cookieconsent], .cookieconsent-optout-marketing, .cookieconsent-optout';
  const hasPlaceholders = await page.evaluate((sel) => {
    const els = window.__bbDeepElements?.() || document.querySelectorAll("*");
    for (const el of els) if (el.matches(sel)) return true;
    return false;
  }, PLACEHOLDER);
  if (!hasPlaceholders) return;

  await page.evaluate(() => {
    // Method 1: Cookiebot API
    if (typeof Cookiebot !== "undefined" && Cookiebot.renew) {
      try { Cookiebot.consent.marketing = true; Cookiebot.renew(); } catch {}
    }
    // Method 2: dispatch standard Cookiebot event
    try { window.dispatchEvent(new Event("CookiebotOnAccept")); } catch {}
    // Method 3: force-swap consent-gated scripts to execute (shadow-aware)
    const els = window.__bbDeepElements?.() || document.querySelectorAll("*");
    for (const s of els) {
      if (!s.matches('script[type="text/plain"][data-cookieconsent]')) continue;
      try {
        const ns = document.createElement("script");
        ns.textContent = s.textContent;
        if (s.src) ns.src = s.src;
        s.parentNode.replaceChild(ns, s);
      } catch {}
    }
  });
  await page.waitForTimeout(2000);
}

// Extract video URLs from consent-gated tags even when consent activation
// didn't fire. Returns concatenated HTML-like string for detectPlayers().
async function extractConsentGatedContent(page) {
  return page.evaluate(() => {
    const parts = [];
    const DEFERRED =
      "iframe[data-cmp-src], iframe[data-cookieblock-src], iframe[data-src]," +
      "script[data-cmp-src], script[data-cookieblock-src], script[data-src]";
    // __bbDeepElements pierces shadow roots; native querySelectorAll wouldn't.
    const els = window.__bbDeepElements?.() || document.querySelectorAll("*");
    for (const el of els) {
      // Script tags that Cookiebot hides behind consent
      if (el.matches('script[type="text/plain"][data-cookieconsent]')) {
        if (el.textContent) parts.push(el.textContent);
      }
      // Deferred src attributes on iframes/scripts only (skip tracking pixels)
      if (el.matches(DEFERRED)) {
        const src = el.getAttribute("data-cmp-src") || el.getAttribute("data-cookieblock-src") || el.getAttribute("data-src");
        if (src) parts.push(src);
      }
    }
    return parts.length > 0 ? parts.join("\n") : "";
  });
}

// Pull HTML-entity-encoded markup out of data-* attributes (e.g. IProX
// `data-media-markup`, Drupal `data-media-embed-template`, WP lazy plugins)
// and decode it so detectPlayers() can match the real <video>/<iframe>/<source>
// regexes. Returns concatenated decoded blob or "".
async function extractEncodedMarkup(page) {
  return page.evaluate(() => {
    const NEEDLES = ["&lt;video", "&lt;iframe", "&lt;source", "&lt;audio", "&lt;script"];
    const parts = [];
    const els = window.__bbDeepElements?.() || document.querySelectorAll("*");
    for (const el of els) {
      for (const attr of el.attributes) {
        if (!attr.name.startsWith("data-")) continue;
        const v = attr.value;
        if (!v || v.length < 12) continue;
        const lower = v.toLowerCase();
        if (!NEEDLES.some((n) => lower.includes(n))) continue;
        try {
          const decoded = new DOMParser()
            .parseFromString(v, "text/html")
            .documentElement.textContent;
          if (decoded) parts.push(decoded);
        } catch {}
      }
    }
    return parts.join("\n");
  });
}

// Runs before any page script. Two jobs:
//  1. Record closed shadow roots on the host (a reference, not forcing
//     mode:"open" — forcing open can break sites that rely on encapsulation)
//     so the detection helpers can reach them.
//  2. Expose window.__bbDeepElements(root): every element in the tree, piercing
//     open shadow roots and the closed roots recorded above. The in-page
//     extractors route through this so player detection crosses shadow
//     boundaries everywhere, not just in the static markup walk. Native
//     querySelectorAll() never crosses a shadow boundary, which is why each
//     extractor needs it. Bounded by depth/count to stay cheap on huge DOMs.
export const SHADOW_INIT_SCRIPT = `(() => {
  const orig = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const root = orig.call(this, init);
    if (init && init.mode === "closed") {
      try { this.__closedShadowRoot = root; } catch {}
    }
    return root;
  };
  window.__bbDeepElements = function (root) {
    const out = [];
    const MAX = 20000, MAX_DEPTH = 20;
    (function walk(node, depth) {
      if (depth > MAX_DEPTH || out.length >= MAX) return;
      let els;
      try { els = node.querySelectorAll("*"); } catch { return; }
      for (const el of els) {
        if (out.length >= MAX) return;
        out.push(el);
        const inner = el.shadowRoot || el.__closedShadowRoot;
        if (inner) walk(inner, depth + 1);
      }
    })(root || document, 0);
    return out;
  };
})();`;

// Walk the full element tree, descending into open shadow roots (and closed
// roots recorded by the attachShadow init script), and emit compact HTML for
// any media-relevant element found *inside* a shadow root. page.content() only
// serializes the light DOM, so video/players living in custom-element shadow
// trees (e.g. ing.nl) are otherwise invisible to detectPlayers(). Returns an
// HTML-like blob to append to the corpus, or "". Same contract as
// extractEncodedMarkup().
export async function extractShadowDomMarkup(page) {
  return page.evaluate(() => {
    const parts = [];
    const seenHosts = new Set();
    const MAX = 400;        // cap a single element's serialized markup
    const MAX_PARTS = 200;  // cap total emitted snippets (bounds corpus growth)
    const MAX_DEPTH = 20;   // guard against pathological shadow nesting

    function emit(el, hostTag) {
      const tag = el.tagName;
      if (tag !== "IFRAME" && tag !== "VIDEO" && tag !== "AUDIO" && tag !== "SOURCE") return;
      // Emit the host marker only once we've actually found media under it —
      // otherwise component-heavy pages fill the MAX_PARTS budget with host
      // comments for media-less shadow roots and drop real evidence deeper in.
      if (hostTag && !seenHosts.has(hostTag)) {
        seenHosts.add(hostTag);
        parts.push(`<!-- shadow host: ${hostTag} -->`);
      }
      // outerHTML keeps src + data-* lazy-load attrs that detectPlayers keys on;
      // iframe outerHTML never includes the embedded document, so it stays small.
      parts.push(el.outerHTML.slice(0, MAX));
    }

    function walk(root, hostTag, depth) {
      if (depth > MAX_DEPTH || parts.length >= MAX_PARTS) return;
      let els;
      try {
        els = root.querySelectorAll("*");
      } catch {
        return;
      }
      for (const el of els) {
        if (parts.length >= MAX_PARTS) return;
        if (hostTag) emit(el, hostTag);
        const inner = el.shadowRoot || el.__closedShadowRoot;
        if (inner) walk(inner, el.tagName.toLowerCase(), depth + 1);
      }
    }

    // Start from document; hostTag is null at the light-DOM level so we only
    // emit markup discovered beneath a shadow boundary.
    walk(document, null, 0);
    return parts.join("\n");
  });
}

// Check whether navigation landed on a different domain (e.g. login redirect).
function didRedirectOffDomain(page, originalUrl) {
  const finalHost = new URL(page.url()).hostname.replace(/^www\./, "");
  const origHost = new URL(originalUrl).hostname.replace(/^www\./, "");
  return finalHost !== origHost;
}

// Gather consent-gated HTML and run detection.
async function detectWithConsent(page, html, networkRequests) {
  const consentGatedHtml = await extractConsentGatedContent(page);
  return detectPlayers(
    consentGatedHtml ? html + "\n" + consentGatedHtml : html,
    networkRequests
  );
}

async function scrollPage(page) {
  await page.evaluate(async () => {
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    const height = document.body.scrollHeight;
    for (let y = 0; y < height; y += 400) {
      window.scrollTo(0, y);
      await delay(100);
    }
    window.scrollTo(0, 0);
  });
}

// Click curated "activate video" placeholders so deferred players hydrate.
// Capped per-page to bound latency. Returns scripts/iframes captured during
// the post-click MutationObserver window so the caller can fold them into
// networkRequests.
export const ACTIVATE_SELECTORS = [
  "button.activate-media",                                          // IProX
  "lite-youtube",                                                   // web component
  "lite-vimeo",
  "[data-consent-element]",
  ".youtube-placeholder, .video-placeholder, .lazyframe",
  '[aria-label*="play" i][role="button"]',
  'button[aria-label*="play" i]',
  'button[aria-label*="start video" i]',
  'button[aria-label*="video afspelen" i]',
  ".media-content[data-media-location] .activate-control button",
];

async function activatePlayButtons(page, { max = 3, settleMs = 1000 } = {}) {
  const captured = { scripts: [], iframes: [] };
  // Playwright's selector engine already pierces open shadow DOM, so $$ finds
  // activation placeholders nested inside web components without a deep query.
  // (Closed shadow roots aren't reachable for clicking — a rare edge case.)
  const targets = await page.$$(ACTIVATE_SELECTORS.join(", "));
  if (targets.length === 0) return captured;

  const seen = new Set();
  let clicked = 0;
  for (const el of targets) {
    if (clicked >= max) break;
    try {
      const key = await el.evaluate((n) => n.outerHTML.slice(0, 120));
      if (seen.has(key)) continue;
      seen.add(key);
      if (!(await el.isVisible())) continue;
      await el.click({ timeout: 500 }).catch(() => {});
      clicked++;
      await page.waitForTimeout(settleMs);
      const drained = await waitForDynamicMedia(page, 500);
      captured.scripts.push(...drained.scripts);
      captured.iframes.push(...drained.iframes);
    } catch {}
  }
  return captured;
}

// Wait for dynamically loaded media elements using MutationObserver.
// Returns list of new script srcs and iframe srcs added during observation.
async function waitForDynamicMedia(page, timeoutMs = 5000) {
  return page.evaluate((timeout) => {
    return new Promise((resolve) => {
      const found = { scripts: [], iframes: [], hasVideo: false, hasAudio: false };
      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue;
            const tag = node.tagName;
            if (tag === "SCRIPT" && node.src) found.scripts.push(node.src);
            if (tag === "IFRAME" && node.src) found.iframes.push(node.src);
            if (tag === "VIDEO") found.hasVideo = true;
            if (tag === "AUDIO") found.hasAudio = true;
            // Also check children of added nodes (e.g. a div containing an iframe)
            for (const child of node.querySelectorAll?.("script[src], iframe[src], video, audio") || []) {
              if (child.tagName === "SCRIPT" && child.src) found.scripts.push(child.src);
              if (child.tagName === "IFRAME" && child.src) found.iframes.push(child.src);
              if (child.tagName === "VIDEO") found.hasVideo = true;
              if (child.tagName === "AUDIO") found.hasAudio = true;
            }
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        resolve(found);
      }, timeout);
    });
  }, timeoutMs);
}

// ── Rate Limit Detection ──────────────────────────────────────────

const WAF_TITLE_PATTERNS = [
  /just a moment/i, /attention required/i, /cloudflare/i,
  /access denied/i, /security check/i, /please wait/i,
  /checking your browser/i, /ddos protection/i,
];

const CONNECTION_ERROR_PATTERNS = [
  'ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_RESET', 'ERR_CONNECTION_CLOSED',
  'ECONNRESET', 'ECONNREFUSED',
  // Protocol-level resets are how some edges (e.g. ing.nl) reject once an IP
  // exceeds a request-rate threshold. Treat them as rate-limit signals so the
  // auto-tuner backs off + retries instead of permanently failing the page.
  'ERR_HTTP2_PROTOCOL_ERROR', 'ERR_SPDY_PROTOCOL_ERROR', 'ERR_QUIC_PROTOCOL_ERROR',
  'ERR_HTTP2_SERVER_REFUSED_STREAM', 'ERR_CONNECTION_TIMED_OUT',
  // Transient DNS/network blips (Chrome's resolver can wobble under sustained
  // load on a long crawl). They're not really rate-limiting, but routing them
  // through the same back-off + retry path means a page isn't permanently
  // dropped on a momentary miss — the retry (with a fresh per-page context) and
  // the periodic browser recycle usually clear it.
  'ERR_NAME_NOT_RESOLVED', 'ERR_NAME_RESOLUTION_FAILED', 'ERR_NETWORK_CHANGED',
  'ERR_INTERNET_DISCONNECTED',
];

function detectConnectionRateLimit(err) {
  const msg = err?.message;
  if (!msg) return null;
  const match = CONNECTION_ERROR_PATTERNS.find(p => msg.includes(p));
  return match ? `connection: ${match}` : null;
}

function detectResponseRateLimit(response, html) {
  if (!response) return 'null response (blocked)';
  const status = response.status();
  if (status === 429) return `HTTP 429`;
  if ((status === 403 || status === 503) && html) {
    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1] : '';
    for (const p of WAF_TITLE_PATTERNS) {
      if (p.test(title) || p.test(html.slice(0, 5000))) {
        return `HTTP ${status} WAF (${title.slice(0, 40)})`;
      }
    }
    // cf-ray header on 403 suggests Cloudflare block
    const headers = response.headers();
    if (status === 403 && headers['cf-ray']) {
      return `HTTP 403 Cloudflare (cf-ray: ${headers['cf-ray']})`;
    }
  }
  return null;
}

function createRateLimitError(reason) {
  const err = new Error(`Rate limited: ${reason}`);
  err._rateLimit = reason;
  return err;
}

// Navigate resiliently. Tracker-heavy sites (e.g. ing.nl) keep the network busy
// indefinitely and never reach "networkidle", so a strict networkidle goto times
// out and the page is lost. Load on "domcontentloaded" (reliable) and then give
// the network a bounded, best-effort chance to settle so network-based player
// detection still benefits. Returns the navigation response (for rate-limit and
// redirect checks); connection errors still throw from the inner goto.
async function gotoResilient(page, url, timeout) {
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  await page
    .waitForLoadState("networkidle", { timeout: Math.min(8000, timeout) })
    .catch(() => {});
  return response;
}

async function scanOnePage(browser, url, timeout) {
  // Fresh context per page = fresh connection. Edges like ing.nl reset a reused
  // HTTP/2 connection after a couple of requests, which would fail every later
  // page in a shared context; a per-page context keeps the crawl working even
  // when the IP is being rate-limited (one page-load fits one connection).
  const context = await createScanContext(browser);
  try {
  const page = await context.newPage();
  const networkRequests = [];

  page.on("request", (req) => {
    networkRequests.push(req.url());
  });

  let response;
  try {
    response = await gotoResilient(page, url, timeout);
  } catch (err) {
    const rlReason = detectConnectionRateLimit(err);
    await page.close();
    if (rlReason) throw createRateLimitError(rlReason);
    throw err;
  }

  // Check response for WAF/rate limit pages
  const earlyHtml = await page.content();
  const rlReason = detectResponseRateLimit(response, earlyHtml);
  if (rlReason) {
    await page.close();
    throw createRateLimitError(rlReason);
  }

  // Skip pages that redirected to a different domain
  try {
    if (didRedirectOffDomain(page, url)) {
      const dest = page.url();
      await page.close();
      return { detected: [], links: [], skippedReason: `redirect to ${new URL(dest).hostname}` };
    }
  } catch {}

  // Scroll to trigger lazy-loaded video embeds
  await scrollPage(page);

  // Wait for dynamically injected media elements (scripts, iframes, video/audio)
  const dynamicMedia = await waitForDynamicMedia(page, 5000);

  for (const src of [...dynamicMedia.scripts, ...dynamicMedia.iframes]) {
    networkRequests.push(src);
  }

  // Click curated activation placeholders so deferred players hydrate
  const activated = await activatePlayButtons(page);
  for (const src of [...activated.scripts, ...activated.iframes]) {
    networkRequests.push(src);
  }

  // Re-grab HTML after dynamic content has loaded
  const html = await page.content();
  const encoded = await extractEncodedMarkup(page);
  const shadow = await extractShadowDomMarkup(page);
  const corpus = [html, encoded, shadow].filter(Boolean).join("\n");
  const detected = await detectWithConsent(page, corpus, networkRequests);

  // Extract links for further crawling
  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href]"), (a) => a.href)
  );

  return { detected, links };
  } finally {
    await context.close().catch(() => {});
  }
}

// First page: accept cookies before scanning (re-navigates if cookies accepted)
async function scanFirstPage(browser, url, timeout) {
  const context = await createScanContext(browser);
  try {
  const page = await context.newPage();
  const networkRequests = [];
  page.on("request", (req) => networkRequests.push(req.url()));

  let response;
  try {
    response = await gotoResilient(page, url, timeout);
  } catch (err) {
    const rlReason = detectConnectionRateLimit(err);
    await page.close();
    if (rlReason) throw createRateLimitError(rlReason);
    throw err;
  }

  const earlyHtml = await page.content();
  const rlReason = detectResponseRateLimit(response, earlyHtml);
  if (rlReason) {
    await page.close();
    throw createRateLimitError(rlReason);
  }

  // Skip pages that redirected to a different domain
  try {
    if (didRedirectOffDomain(page, url)) {
      const dest = page.url();
      await page.close();
      return { detected: [], links: [], skippedReason: `redirect to ${new URL(dest).hostname}` };
    }
  } catch {}

  if (await acceptCookies(page)) {
    await gotoResilient(page, url, timeout);
    // Re-check redirect after post-consent navigation
    try {
      if (didRedirectOffDomain(page, url)) {
        const dest = page.url();
        await page.close();
        return { detected: [], links: [], skippedReason: `redirect to ${new URL(dest).hostname}` };
      }
    } catch {}
    await activateCookiebotConsent(page);
  }

  await scrollPage(page);
  const dynamicMedia = await waitForDynamicMedia(page, 5000);
  for (const src of [...dynamicMedia.scripts, ...dynamicMedia.iframes]) {
    networkRequests.push(src);
  }

  const activated = await activatePlayButtons(page);
  for (const src of [...activated.scripts, ...activated.iframes]) {
    networkRequests.push(src);
  }

  const html = await page.content();
  const encoded = await extractEncodedMarkup(page);
  const shadow = await extractShadowDomMarkup(page);
  const corpus = [html, encoded, shadow].filter(Boolean).join("\n");
  const detected = await detectWithConsent(page, corpus, networkRequests);
  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href]"), (a) => a.href)
  );

  return { detected, links };
  } finally {
    await context.close().catch(() => {});
  }
}

// Initial guess before AutoTuner takes over (it'll converge within ~2 batches).
function pickInitialConcurrency() {
  const cpu = Math.max(1, os.cpus()?.length || 2);
  return Math.min(8, Math.max(2, cpu));
}
const DEFAULT_CONCURRENCY = pickInitialConcurrency();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── AutoTuner ─────────────────────────────────────────────────────
// Sizes per-scan concurrency based on (a) CPU load, (b) number of co-active
// sibling scans (read from a heartbeat directory), (c) how many siblings share
// our hostname. The rate-limiter (onRateLimit) still owns the floor when 429s
// happen — AutoTuner only proposes targets and nudges one step per batch.
//
// No IPC: each scan writes _heartbeat-{taskId}.json to the videoscan dir every
// batch and reads sibling files. Stale > 30s = ignored. controlFile path is
// the only hint we have for our own taskId + dir; without it (e.g. raw CLI
// invocation) the tuner still works but with peer count = 1 always.
function createAutoTuner(controlFile) {
  const cpuCount = Math.max(1, os.cpus()?.length || 2);
  let heartbeatPath = null;
  let selfId = null;
  let heartbeatDir = null;
  if (controlFile) {
    const m = basename(controlFile).match(/_control-(.+)\.json$/);
    if (m) {
      selfId = m[1];
      heartbeatDir = dirname(controlFile);
      heartbeatPath = join(heartbeatDir, `_heartbeat-${selfId}.json`);
    }
  }

  function writeHeartbeat(throttle, hostname) {
    if (!heartbeatPath) return;
    try {
      writeFileSync(heartbeatPath, JSON.stringify({
        taskId: selfId, hostname, concurrency: throttle.concurrency, ts: Date.now(),
      }));
    } catch { /* best-effort */ }
  }

  function readPeers() {
    if (!heartbeatDir) return { total: 1, sameHost: 1 };
    let files;
    try { files = readdirSync(heartbeatDir); } catch { return { total: 1, sameHost: 1 }; }
    const cutoff = Date.now() - 30_000;
    const peers = [];
    for (const f of files) {
      if (!f.startsWith('_heartbeat-') || !f.endsWith('.json')) continue;
      try {
        const data = JSON.parse(readFileSync(join(heartbeatDir, f), 'utf-8'));
        if (typeof data.ts === 'number' && data.ts >= cutoff) peers.push(data);
      } catch { /* skip unreadable/stale */ }
    }
    return { total: Math.max(1, peers.length), peers };
  }

  function cleanup() {
    if (!heartbeatPath) return;
    try { unlinkSync(heartbeatPath); } catch {}
  }

  // Called once per batch. Returns nothing; mutates throttle.baseConcurrency
  // (and throttle.concurrency where it doesn't conflict with rate-limit floor).
  function proposeNext(throttle, hostname) {
    writeHeartbeat(throttle, hostname);

    // CPU load factor. loadavg() returns 0 on Windows — fall back to 0 (no
    // penalty). 1.0 ≈ saturated; <0.7 = comfortable headroom.
    const load = os.loadavg?.()[0] ?? 0;
    const loadFactor = Math.min(2, Math.max(0, load / cpuCount));

    const softCap = Math.max(2, cpuCount);
    const loadBudget = softCap * Math.max(0.25, 1.2 - loadFactor);

    const { total, peers = [] } = readPeers();
    const sameHost = peers.filter(p => p.hostname === hostname).length;
    // If multiple scans hit the same host, halve each scan's share to spread
    // the rate-limit budget. Different hosts split CPU evenly.
    const hostPenalty = sameHost > 1 ? sameHost : 1;
    const share = Math.max(2, Math.floor(loadBudget / total / hostPenalty));
    const target = Math.min(share, softCap);

    // Don't grow base during rate-limit cooldown — tryRecover() owns climb-back.
    if (Date.now() < throttle.cooldownUntil) return;

    // Step baseConcurrency one tick toward target (±1) to dampen load noise.
    if (throttle.baseConcurrency < target) throttle.baseConcurrency++;
    else if (throttle.baseConcurrency > target) throttle.baseConcurrency--;

    // Cap live concurrency if AutoTuner just lowered the ceiling.
    if (throttle.concurrency > throttle.baseConcurrency) {
      throttle.concurrency = throttle.baseConcurrency;
    }
    throttle.minConcurrency = Math.min(throttle.minConcurrency, throttle.concurrency);
  }

  return { proposeNext, cleanup };
}

function createThrottleState(delay, concurrency) {
  return {
    delay,
    concurrency,
    baseDelay: delay,
    baseConcurrency: concurrency,
    rateLimitHits: 0,
    cooldownUntil: 0,
    events: [],
    peakDelay: delay,
    minConcurrency: concurrency,
  };
}

function buildRateLimits(throttle) {
  if (throttle.events.length === 0) return undefined;
  return {
    totalHits: throttle.rateLimitHits,
    peakDelay: throttle.peakDelay,
    minConcurrency: throttle.minConcurrency,
    events: throttle.events.map(e => ({ time: new Date(e.time).toISOString(), url: e.url, reason: e.reason })),
  };
}

function onRateLimit(throttle, url, reason) {
  throttle.rateLimitHits++;
  throttle.cooldownUntil = Date.now() + 60_000;
  throttle.delay = throttle.delay === 0 ? 1000 : Math.min(throttle.delay * 2, 30_000);
  throttle.concurrency = Math.max(1, Math.floor(throttle.concurrency / 2));
  throttle.peakDelay = Math.max(throttle.peakDelay, throttle.delay);
  throttle.minConcurrency = Math.min(throttle.minConcurrency, throttle.concurrency);
  throttle.events.push({ time: Date.now(), url, reason });
  console.log(chalk.yellow(`  ⚠ Rate limit: ${reason} — delay=${throttle.delay}ms, concurrency=${throttle.concurrency}`));
}

function tryRecover(throttle) {
  if (Date.now() < throttle.cooldownUntil) return;
  // Reduce delay by 25%
  throttle.delay = Math.max(throttle.baseDelay, Math.floor(throttle.delay * 0.75));
  // Increase concurrency by 1 (cap at base)
  throttle.concurrency = Math.min(throttle.baseConcurrency, throttle.concurrency + 1);
}

// Live control file: { paused?: boolean }.
// Concurrency / delay used to be settable here; the AutoTuner owns those now.
// Legacy fields are silently ignored so old control files don't crash anything.
function applyControlFile(throttle, controlFile) {
  if (!controlFile) return;
  let mtimeMs;
  try {
    mtimeMs = statSync(controlFile).mtimeMs;
  } catch {
    return;
  }
  if (throttle._lastControlMtime === mtimeMs) return;
  throttle._lastControlMtime = mtimeMs;
  let ctrl;
  try {
    const raw = readFileSync(controlFile, 'utf-8');
    if (!raw.trim()) return;
    ctrl = JSON.parse(raw);
  } catch (err) {
    console.log(chalk.yellow(`  ⚠ Control file parse error: ${err.message}`));
    return;
  }
  if (ctrl.paused === true && !interrupted) {
    interrupted = true;
    console.log(chalk.yellow('\n⏸  Pause requested via control file — finishing current batch and saving state…'));
  }
}

// SIGINT/SIGTERM graceful shutdown
let interrupted = false;
function setupInterruptHandler() {
  let signalCount = 0;
  const handler = (sig) => {
    signalCount++;
    if (signalCount >= 2) {
      console.log(chalk.red('\nForce exit'));
      process.exit(1);
    }
    console.log(chalk.yellow(`\n${sig} received — finishing current batch (press again to force)...`));
    interrupted = true;
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

// Launch the scan browser. Real Chrome passes bot-fingerprint checks that block
// Playwright's bundled Chromium outright (e.g. ing.nl returns
// ERR_HTTP2_PROTOCOL_ERROR / connection timeouts to bundled Chromium but 200 to
// installed Chrome). Prefer installed Chrome; fall back to bundled Chromium when
// it isn't present. Override with VIDEOSCAN_BROWSER_CHANNEL=chromium to force
// the bundle, or =msedge etc.
async function launchScanBrowser() {
  // Opt-in HTTP/1.1. Resource blocking (applyResourceBlocking) keeps the
  // per-page request burst small enough that HTTP/2 connections don't get
  // GOAWAY/reset-poisoned, so HTTP/2 is the default. But some edges stall H2
  // under sustained load; VIDEOSCAN_DISABLE_HTTP2=1 forces the self-healing
  // HTTP/1.1 connection pool for those.
  const args = process.env.VIDEOSCAN_DISABLE_HTTP2 ? ["--disable-http2"] : [];
  // Empty/unset env both mean "use Chrome"; set =chromium to force the bundle.
  const channel = process.env.VIDEOSCAN_BROWSER_CHANNEL || "chrome";
  if (channel !== "chromium") {
    try {
      return await chromium.launch({ headless: true, channel, args });
    } catch {
      // Channel not installed — fall through to the bundled Chromium.
    }
  }
  return await chromium.launch({ headless: true, args });
}

// Heavy pages fire dozens of subresource requests; at scan concurrency this can
// flood a server's per-IP HTTP/2 stream limit and trigger protocol-reset blocks
// (ing.nl does this). Abort the heavy, detection-irrelevant resource types — we
// only need the document + scripts/XHR. The "request" event still fires before
// the abort, so network-URL evidence (ytimg, jwplayer, .m3u8, …) is still
// captured; this only skips downloading bytes we never inspect, and also speeds
// scans up. NOTE: stylesheets are deliberately NOT blocked — acceptCookies() and
// activatePlayButtons() gate clicks on isVisible(), and external CSS often sizes
// those consent/play controls; dropping it can make them compute to zero-size
// and silently skip the click (missed consent-gated video). Images dominate the
// request count anyway, so the flood mitigation barely needs stylesheets.
const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font"]);
async function applyResourceBlocking(context) {
  await context.route("**/*", (route) => {
    try {
      if (BLOCKED_RESOURCE_TYPES.has(route.request().resourceType())) return route.abort();
      return route.continue();
    } catch {
      try { return route.continue(); } catch { /* route already handled */ }
    }
  });
}

// Build a scan context with our shadow init script + resource blocking wired
// in. One per page (a fresh connection) — see scanOnePage for why.
async function createScanContext(browser) {
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
  });
  await context.addInitScript(SHADOW_INIT_SCRIPT);
  await applyResourceBlocking(context);
  return context;
}

// Periodically persist crawl state so a long crawl killed mid-run (session
// teardown, OOM, Ctrl-C) can be continued with --resume. The shape matches what
// the resume path reads (_state.visited/queue + details). Written to a stable
// INPROGRESS name; deleted on clean completion (the final timestamped report
// supersedes it).
function checkpointPath(domain) {
  return `videoscan-${domain}-INPROGRESS.json`;
}
function writeCheckpoint(domain, results, visited, queue) {
  try {
    const details = results
      .filter((r) => r.players.length > 0)
      .map((r) => ({ url: r.url, players: r.players.map((p) => ({ name: p.player, evidence: p.evidence })) }));
    writeFileSync(
      checkpointPath(domain),
      JSON.stringify({ domain, checkpoint: true, scanDate: new Date().toISOString(), pagesScanned: visited.size, _state: { visited: [...visited], queue }, details }, null, 2)
    );
  } catch { /* checkpoint is best-effort */ }
}

async function crawlSite(startUrl, { maxPages = 50, timeout = 15000, resumeFile = null, concurrency = DEFAULT_CONCURRENCY, delay = 200, sitemap = true, maxSitemapUrls = 5000, controlFile = null } = {}) {
  let browser = await launchScanBrowser();
  // Recycle the whole browser process every N pages. Over a long crawl the
  // single browser accumulates state (and Chrome's DNS resolver can degrade,
  // surfacing as ERR_NAME_NOT_RESOLVED) — a periodic relaunch bounds that.
  const RECYCLE_EVERY = 400;
  let pagesSinceRecycle = 0;

  const baseUrl = new URL(startUrl);
  const domain = baseUrl.hostname.replace(/^www\./, "");
  let visited = new Set();
  let queue = [normalizeUrl(startUrl, startUrl)];
  let results = [];

  const throttle = createThrottleState(delay, concurrency);
  const autoTuner = createAutoTuner(controlFile);
  const retryCount = new Map();
  const MAX_RETRIES = 2;

  // Resume from previous scan state
  if (resumeFile) {
    const prev = JSON.parse(readFileSync(resumeFile, "utf-8"));

    if (prev._state?.visited?.length) {
      visited = new Set(prev._state.visited);
    } else {
      const allUrls = new Set();
      for (const d of prev.details || []) allUrls.add(d.url);
      for (const [, data] of Object.entries(prev.playerSummary || {})) {
        for (const p of data.pages || []) allUrls.add(p);
      }
      visited = allUrls;
    }

    queue = prev._state?.queue?.length ? prev._state.queue : [normalizeUrl(startUrl, startUrl)];

    results = (prev.details || []).map((d) => ({
      url: d.url,
      players: d.players.map((p) => ({ player: p.name, evidence: p.evidence })),
    }));
    for (const v of visited) {
      if (!results.find((r) => r.url === v)) {
        results.push({ url: v, players: [] });
      }
    }

    // maxPages is additive when resuming: scan N more pages beyond what's already visited
    maxPages = visited.size + maxPages;

    console.log(chalk.yellow(`\nResuming scan of ${domain}`));
    console.log(chalk.yellow(`Previously scanned: ${visited.size} pages, Queue: ${queue.length} URLs`));
  } else {
    console.log(chalk.blue(`\nStarting scan of ${domain}`));
  }
  console.log(chalk.gray(`Max pages: ${maxPages}, Timeout per page: ${timeout}ms, Concurrency: ${concurrency}, Delay: ${delay}ms\n`));

  setupInterruptHandler();

  // Accept cookies on first page before parallel scanning
  const firstUrl = queue.shift();
  if (firstUrl && !visited.has(firstUrl)) {
    visited.add(firstUrl);
    process.stdout.write(
      chalk.gray(`[${visited.size}/${maxPages}] `) + chalk.white(truncate(firstUrl, 80)) + " "
    );
    try {
      const { detected, links, skippedReason } = await scanFirstPage(browser, firstUrl, timeout);
      if (skippedReason) {
        console.log(chalk.yellow(`  ⤳ skipped (${skippedReason})`));
      } else if (detected.length > 0) {
        console.log(chalk.green(`  [${detected.map((d) => d.player).join(", ")}]`));
      } else {
        console.log(chalk.gray("  -"));
      }
      results.push({ url: firstUrl, players: detected });

      const newLinks = [];
      for (const link of links) {
        const norm = normalizeUrl(link, firstUrl);
        if (norm && !visited.has(norm) && !queue.includes(norm) && isSameDomain(norm, domain) && !shouldSkipUrl(norm)) {
          newLinks.push(norm);
        }
      }
      queue.push(...prioritizeUrls(newLinks));
    } catch (err) {
      if (err._rateLimit) {
        onRateLimit(throttle, firstUrl, err._rateLimit);
        visited.delete(firstUrl);
        queue.unshift(firstUrl);
        console.log(chalk.yellow(`  ⚠ First page rate-limited, will retry`));
      } else {
        console.log(chalk.red(`  ERROR: ${err.message.slice(0, 60)}`));
        results.push({ url: firstUrl, players: [], error: err.message });
      }
    }
  }

  // Parallel crawl loop
  const queuedSet = new Set(queue);

  // Seed queue from sitemap (skip when resuming — already in state)
  if (sitemap && !resumeFile) {
    const sitemapUrls = await discoverSitemapUrls(startUrl, domain, { maxUrls: maxSitemapUrls }).catch(() => []);
    let added = 0;
    for (const u of sitemapUrls) {
      if (!visited.has(u) && !queuedSet.has(u)) {
        queuedSet.add(u);
        queue.push(u);
        added++;
      }
    }
    if (added > 0) {
      queue.splice(0, queue.length, ...prioritizeUrls(queue));
      console.log(chalk.gray(`  Sitemap: ${sitemapUrls.length} URLs found, ${added} new added to queue`));
    } else if (sitemapUrls.length === 0) {
      console.log(chalk.gray(`  Sitemap: none found (or unreachable)`));
    }
  }

  let batchNum = 0;
  let lastProgressAt = Date.now();
  const scanStartTime = Date.now();
  // Baseline of pages already scanned at the moment this run begins.
  // Used to keep pages/min and ETA accurate after a resume — without this,
  // we'd divide *all* visited pages (including pre-resume ones) by *this run's* elapsed time.
  const resumeBaseline = visited.size;

  while (queue.length > 0 && visited.size < maxPages && !interrupted) {
    // Inter-batch delay (skip first batch)
    if (batchNum > 0 && throttle.delay > 0) {
      await sleep(throttle.delay);
    }
    batchNum++;

    // Apply live control-file overrides (concurrency/delay) before sizing batch
    applyControlFile(throttle, controlFile);

    // Grab a batch of URLs to scan in parallel (use throttle.concurrency)
    const batch = [];
    while (batch.length < throttle.concurrency && queue.length > 0 && visited.size + batch.length < maxPages) {
      const url = queue.shift();
      if (!url || visited.has(url)) continue;
      batch.push(url);
    }
    if (batch.length === 0) break;

    // Mark all batch URLs as visited before launching (prevents duplicates)
    for (const url of batch) visited.add(url);

    // Print batch start
    const batchStart = visited.size - batch.length + 1;
    const queued = queue.length;
    for (let i = 0; i < batch.length; i++) {
      console.log(chalk.gray(`[${batchStart + i}/${maxPages}] `) + chalk.dim(`(queue: ${queued}) `) + chalk.white(truncate(batch[i], 80)) + chalk.gray(" ..."));
    }

    // Scan all pages in batch concurrently
    const batchResults = await Promise.allSettled(
      batch.map((url) => scanOnePage(browser, url, timeout))
    );

    // Process results and collect new links
    let batchHadRateLimit = false;
    for (let i = 0; i < batch.length; i++) {
      const url = batch[i];
      const result = batchResults[i];

      if (result.status === "fulfilled") {
        const { detected, links, skippedReason } = result.value;
        if (skippedReason) {
          console.log(chalk.yellow(`  ⤳ ${truncate(url, 65)}  skipped (${skippedReason})`));
        } else if (detected.length > 0) {
          console.log(chalk.green(`  ✓ ${truncate(url, 65)}  [${detected.map((d) => d.player).join(", ")}]`));
        }
        results.push({ url, players: detected });

        // Add discovered links to queue
        for (const link of links) {
          const norm = normalizeUrl(link, url);
          if (norm && !visited.has(norm) && !queuedSet.has(norm) && isSameDomain(norm, domain) && !shouldSkipUrl(norm)) {
            queuedSet.add(norm);
            queue.push(norm);
          }
        }
      } else {
        const err = result.reason;
        const errMsg = err?.message || "Unknown error";

        if (err?._rateLimit) {
          batchHadRateLimit = true;
          onRateLimit(throttle, url, err._rateLimit);
          visited.delete(url);
          const retries = retryCount.get(url) || 0;
          if (retries < MAX_RETRIES) {
            retryCount.set(url, retries + 1);
            queue.unshift(url); // push to front for retry
            queuedSet.add(url);
          } else {
            console.log(chalk.red(`  ✗ ${truncate(url, 65)}  permanently failed (${MAX_RETRIES} retries)`));
            results.push({ url, players: [], error: `Rate limited: ${err._rateLimit} (max retries)` });
          }
        } else {
          console.log(chalk.red(`  ✗ ${truncate(url, 65)}  ${errMsg.slice(0, 50)}`));
          results.push({ url, players: [], error: errMsg });
        }
      }
    }

    // Recovery check: if no rate limits this batch and cooldown expired
    if (!batchHadRateLimit && throttle.rateLimitHits > 0) {
      tryRecover(throttle);
    }
    autoTuner.proposeNext(throttle, domain);

    // Progress stats every 30s
    if (Date.now() - lastProgressAt > 30_000) {
      const elapsed = (Date.now() - scanStartTime) / 60_000;
      const newlyScanned = visited.size - resumeBaseline;
      const ppm = elapsed > 0 ? (newlyScanned / elapsed).toFixed(1) : "0.0";
      const remaining = Math.min(queue.length, maxPages - visited.size);
      const etaMin = ppm > 0 ? (remaining / ppm).toFixed(1) : "?";
      console.log(chalk.cyan(`  ── ${ppm} pages/min | queue=${queue.length} | ~${etaMin}min left | delay=${throttle.delay}ms | auto-conc=${throttle.concurrency} (base=${throttle.baseConcurrency})`));
      lastProgressAt = Date.now();
      writeCheckpoint(domain, results, visited, queue);
    }

    // Re-prioritize remaining queue after each batch (new video-likely URLs bubble up)
    queue.splice(0, queue.length, ...prioritizeUrls(queue));

    // Recycle the browser between batches once we've scanned enough pages — a
    // fresh process resets accumulated state / a degraded DNS resolver. Safe
    // here: the batch's pages are all done, none are in flight.
    pagesSinceRecycle += batch.length;
    if (pagesSinceRecycle >= RECYCLE_EVERY && queue.length > 0 && visited.size < maxPages && !interrupted) {
      console.log(chalk.gray(`  ↻ recycling browser after ${pagesSinceRecycle} pages`));
      try { await browser.close(); } catch { /* already gone */ }
      browser = await launchScanBrowser();
      pagesSinceRecycle = 0;
    }
  }

  await browser.close();
  autoTuner.cleanup();
  try { unlinkSync(checkpointPath(domain)); } catch { /* no checkpoint to clean */ }

  return {
    domain,
    results,
    pagesScanned: visited.size,
    _state: { visited: [...visited], queue },
    rateLimits: buildRateLimits(throttle),
  };
}

// Strip <a href="..."> values so player-domain regexes don't match link
// targets. Anchors are navigation, not embeds.
function stripAnchorHrefs(html) {
  return html.replace(
    /(<a\b[^>]*?)\s+href\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
    "$1"
  );
}

export function detectPlayers(html, networkRequests) {
  const searchable = stripAnchorHrefs(html);
  const found = [];

  for (const [player, config] of Object.entries(DETECTORS)) {
    const matches = [];

    // Check HTML content
    for (const pattern of config.patterns) {
      const match = searchable.match(pattern);
      if (match) matches.push(`HTML: ${match[0].slice(0, 80)}`);
    }

    // Check network requests
    for (const scriptPattern of config.scripts) {
      const match = networkRequests.find((r) => scriptPattern.test(r));
      if (match) matches.push(`Network: ${match.slice(0, 80)}`);
    }

    if (matches.length > 0) {
      found.push({ player, evidence: matches });
    }
  }

  return filterNonVideoSocials(filterToHighestTier(found), searchable, networkRequests);
}

// ── Explicit URL scanning (no crawl) ────────────────────────────────

async function scanExplicitUrls(urls, { timeout = 15000, concurrency = DEFAULT_CONCURRENCY, delay = 200, controlFile = null } = {}) {
  const browser = await launchScanBrowser();

  const baseUrl = new URL(urls[0]);
  const domain = baseUrl.hostname.replace(/^www\./, "");
  const results = [];

  const throttle = createThrottleState(delay, concurrency);
  const autoTuner = createAutoTuner(controlFile);
  const retryCount = new Map();
  const MAX_RETRIES = 2;

  console.log(chalk.blue(`\nScanning ${urls.length} explicit URLs (domain: ${domain})`));
  console.log(chalk.gray(`Timeout per page: ${timeout}ms, auto-conc=${throttle.concurrency} (initial), Delay: ${delay}ms\n`));

  setupInterruptHandler();

  // First URL: accept cookies
  const firstUrl = urls[0];
  process.stdout.write(chalk.gray(`[1/${urls.length}] `) + chalk.white(truncate(firstUrl, 80)) + " ");
  try {
    const { detected, skippedReason } = await scanFirstPage(browser, firstUrl, timeout);
    if (skippedReason) {
      console.log(chalk.yellow(`  ⤳ skipped (${skippedReason})`));
    } else if (detected.length > 0) {
      console.log(chalk.green(`  [${detected.map((d) => d.player).join(", ")}]`));
    } else {
      console.log(chalk.gray("  -"));
    }
    results.push({ url: firstUrl, players: detected });
  } catch (err) {
    if (err._rateLimit) {
      onRateLimit(throttle, firstUrl, err._rateLimit);
      console.log(chalk.yellow(`  ⚠ Rate-limited`));
      results.push({ url: firstUrl, players: [], error: `Rate limited: ${err._rateLimit}` });
    } else {
      console.log(chalk.red(`  ERROR: ${err.message.slice(0, 60)}`));
      results.push({ url: firstUrl, players: [], error: err.message });
    }
  }

  // Remaining URLs in batches
  const remaining = urls.slice(1);
  let batchNum = 0;

  while (remaining.length > 0 && !interrupted) {
    if (batchNum > 0 && throttle.delay > 0) await sleep(throttle.delay);
    batchNum++;

    applyControlFile(throttle, controlFile);

    const batch = remaining.splice(0, throttle.concurrency);

    for (let i = 0; i < batch.length; i++) {
      const idx = results.length + i + 1;
      console.log(chalk.gray(`[${idx}/${urls.length}] `) + chalk.white(truncate(batch[i], 80)) + chalk.gray(" ..."));
    }

    const batchResults = await Promise.allSettled(
      batch.map((url) => scanOnePage(browser, url, timeout))
    );

    for (let i = 0; i < batch.length; i++) {
      const url = batch[i];
      const result = batchResults[i];

      if (result.status === "fulfilled") {
        const { detected, skippedReason } = result.value;
        if (skippedReason) {
          console.log(chalk.yellow(`  ⤳ ${truncate(url, 65)}  skipped (${skippedReason})`));
        } else if (detected.length > 0) {
          console.log(chalk.green(`  ✓ ${truncate(url, 65)}  [${detected.map((d) => d.player).join(", ")}]`));
        }
        results.push({ url, players: detected });
      } else {
        const err = result.reason;
        if (err?._rateLimit) {
          onRateLimit(throttle, url, err._rateLimit);
          const retries = retryCount.get(url) || 0;
          if (retries < MAX_RETRIES) {
            retryCount.set(url, retries + 1);
            remaining.unshift(url);
          } else {
            results.push({ url, players: [], error: `Rate limited: ${err._rateLimit} (max retries)` });
          }
        } else {
          console.log(chalk.red(`  ✗ ${truncate(url, 65)}  ${(err?.message || "Unknown").slice(0, 50)}`));
          results.push({ url, players: [], error: err?.message || "Unknown error" });
        }
      }
    }

    if (throttle.rateLimitHits > 0) tryRecover(throttle);
    autoTuner.proposeNext(throttle, domain);
  }

  await browser.close();
  autoTuner.cleanup();

  const visited = results.map(r => r.url);
  return {
    domain,
    results,
    pagesScanned: results.length,
    _state: { visited, queue: [] },
    rateLimits: buildRateLimits(throttle),
  };
}

// ── Report ──────────────────────────────────────────────────────────

function generateReport({ domain, results, pagesScanned, _state, rateLimits, batchId, batchLabel, resumeFile }) {
  const playerSummary = {};
  const pagesWithPlayers = [];
  const pagesWithoutPlayers = [];
  const errorSummary = {}; // normalized reason → count

  for (const { url, players, error } of results) {
    if (error) {
      // Collapse to the ERR_*/keyword signature so noisy URLs/suffixes group.
      const key = (error.match(/ERR_[A-Z0-9_]+|Timeout|Rate limited|null response/i) || [error])[0];
      errorSummary[key] = (errorSummary[key] || 0) + 1;
    }
    if (players.length > 0) {
      pagesWithPlayers.push({ url, players });
      for (const { player } of players) {
        if (!playerSummary[player]) playerSummary[player] = [];
        playerSummary[player].push(url);
      }
    } else {
      pagesWithoutPlayers.push(url);
    }
  }

  const pagesFailed = Object.values(errorSummary).reduce((a, b) => a + b, 0);
  const failureRate = results.length > 0 ? pagesFailed / results.length : 0;
  const playerNames = Object.keys(playerSummary);
  const isBBCustomer = playerSummary["Blue Billywig"]?.length > 0;

  console.log("\n" + chalk.bold.blue("═".repeat(70)));
  console.log(chalk.bold.blue(`  VIDEOSCAN RAPPORT - ${domain}`));
  console.log(chalk.bold.blue("═".repeat(70)));

  console.log(chalk.bold(`\n  Pagina's gescand:     ${pagesScanned}`));
  console.log(chalk.bold(`  Pagina's met video:   ${pagesWithPlayers.length}`));
  console.log(
    chalk.bold(`  Unieke videoplayers:  ${playerNames.length}`)
  );
  if (pagesFailed > 0) {
    const pct = Math.round(failureRate * 100);
    const color = failureRate >= 0.5 ? chalk.bold.red : chalk.yellow;
    console.log(color(`  Pagina's mislukt:     ${pagesFailed} (${pct}% load errors)`));
    for (const [reason, n] of Object.entries(errorSummary).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
      console.log(chalk.gray(`    • ${reason}: ${n}`));
    }
  }
  // A scan that failed to load most pages must not read as a clean result.
  if (failureRate >= 0.5) {
    console.log(chalk.bold.red(
      `\n  ⚠ ${Math.round(failureRate * 100)}% of pages failed to load — results are NOT representative.` +
      `\n    Likely bot-blocking/rate-limiting. The auto-tuner backs off on protocol resets;` +
      `\n    re-run (optionally --resume) so backed-off pages get retried.`
    ));
  }

  if (playerNames.length > 0) {
    console.log(chalk.bold.yellow("\n  ── Gevonden Players ──────────────────────────"));
    for (const [player, urls] of Object.entries(playerSummary).sort(
      (a, b) => b[1].length - a[1].length
    )) {
      const isBB = player === "Blue Billywig";
      const color = isBB ? chalk.green : chalk.white;
      console.log(color(`\n  ${isBB ? "★" : "•"} ${player} (${urls.length} pagina's)`));
      for (const url of urls.slice(0, 5)) {
        console.log(chalk.gray(`    → ${truncate(url, 65)}`));
      }
      if (urls.length > 5) {
        console.log(chalk.gray(`    ... en ${urls.length - 5} meer`));
      }
    }
  }

  if (pagesWithPlayers.length > 0) {
    console.log(chalk.bold.yellow("\n  ── Detail per Pagina ─────────────────────────"));
    for (const { url, players } of pagesWithPlayers) {
      console.log(chalk.white(`\n  ${truncate(url, 65)}`));
      for (const { player, evidence } of players) {
        const isBB = player === "Blue Billywig";
        console.log((isBB ? chalk.green : chalk.gray)(`    ${isBB ? "★" : "•"} ${player}`));
      }
    }
  }

  if (rateLimits) {
    console.log(chalk.bold.yellow("\n  ── Rate Limiting ─────────────────────────────"));
    console.log(chalk.white(`  Total rate limit hits: ${rateLimits.totalHits}`));
    console.log(chalk.white(`  Peak delay: ${rateLimits.peakDelay}ms`));
    console.log(chalk.white(`  Min concurrency: ${rateLimits.minConcurrency}`));
    for (const e of rateLimits.events.slice(0, 10)) {
      const t = typeof e.time === 'string' ? e.time : new Date(e.time).toISOString();
      console.log(chalk.gray(`    ${t.slice(11, 19)} ${e.reason} — ${truncate(e.url, 50)}`));
    }
    if (rateLimits.events.length > 10) {
      console.log(chalk.gray(`    ... and ${rateLimits.events.length - 10} more`));
    }
  }

  console.log(chalk.bold.blue("\n" + "═".repeat(70)));

  // Save JSON report. On --resume, overwrite the source file so a scan-chain
  // stays in one entry; otherwise mint a timestamped name for a fresh scan.
  let jsonFile;
  if (resumeFile) {
    jsonFile = basename(resumeFile);
  } else {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    jsonFile = `videoscan-${domain}-${ts}.json`;
  }
  const jsonReport = {
    domain,
    scanDate: new Date().toISOString(),
    pagesScanned,
    pagesWithVideo: pagesWithPlayers.length,
    uniquePlayers: playerNames.length,
    pagesFailed,
    failureRate: Math.round(failureRate * 1000) / 1000,
    ...(pagesFailed > 0 ? { errorSummary } : {}),
    ...(batchId ? { batchId } : {}),
    ...(batchLabel ? { batchLabel } : {}),
    playerSummary: Object.fromEntries(
      Object.entries(playerSummary).map(([p, urls]) => [p, { count: urls.length, pages: urls }])
    ),
    details: pagesWithPlayers.map(({ url, players }) => ({
      url,
      players: players.map((p) => ({ name: p.player, evidence: p.evidence })),
    })),
    rateLimits,
    _state,
  };
  writeFileSync(jsonFile, JSON.stringify(jsonReport, null, 2));
  console.log(chalk.green(`\n  Rapport opgeslagen: ${jsonFile}`));
  console.log("");
}

// ── Main ────────────────────────────────────────────────────────────

function truncate(str, len) {
  return str.length > len ? str.slice(0, len - 3) + "..." : str;
}

function printUsage() {
  console.log(`
${chalk.bold("BB Videoscan")} - Scan websites voor videoplayer gebruik

${chalk.bold("Gebruik:")}
  node scan.mjs <url> [opties]
  node scan.mjs --urls <url1,url2,...|file.json> [opties]

${chalk.bold("Opties:")}
  --max-pages <n>       Max pagina's te scannen (standaard: 50)
  --timeout <ms>        Timeout per pagina in ms (standaard: 15000)
  --delay <ms>          Vertraging tussen batches in ms (standaard: 200)
  --resume <json-file>  Hervat scan vanuit eerder resultaat
  --urls <urls|file>    Scan explicit URLs (comma-separated or JSON file path)
  --no-sitemap          Skip sitemap-based URL discovery
  --max-sitemap-urls <n> Max URLs uit sitemap toevoegen aan queue (standaard: 5000)
  --control-file <path> JSON file polled per batch for live { paused } overrides
  --batch-id <id>       Stamp scan output with a batch identifier (for grouping in dashboard)
  --batch-label <text>  Stamp scan output with a human-readable batch label

Concurrency is auto-tuned per batch based on CPU load and the number of
co-active sibling scans; there is no manual --concurrency knob.

${chalk.bold("Voorbeelden:")}
  node scan.mjs https://www.menzis.nl
  node scan.mjs https://www.menzis.nl --max-pages 100
  node scan.mjs https://www.menzis.nl --resume videoscan-menzis.nl-2026-03-06.json --max-pages 400
  node scan.mjs --urls https://example.com/page1,https://example.com/page2
  node scan.mjs --urls urls.json
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const release = await acquire();
  process.on('exit', release);
  process.on('uncaughtException', err => { release(); console.error(err); process.exit(1); });
  process.on('unhandledRejection', err => { release(); console.error(err); process.exit(1); });

  const timeout = parseInt(args[args.indexOf("--timeout") + 1]) || 15000;
  const concurrency = DEFAULT_CONCURRENCY; // auto-tuned at runtime by createAutoTuner
  const delay = parseInt(args[args.indexOf("--delay") + 1]) || 200;
  const controlFileIdx = args.indexOf("--control-file");
  const controlFile = controlFileIdx !== -1 ? args[controlFileIdx + 1] : null;
  const flagValue = (name) => {
    const i = args.indexOf(name);
    if (i === -1) return null;
    const v = args[i + 1];
    return v && !v.startsWith("--") ? v : null;
  };
  let batchId = flagValue("--batch-id");
  let batchLabel = flagValue("--batch-label");

  // --urls mode: scan explicit URLs without crawling
  const urlsIdx = args.indexOf("--urls");
  if (urlsIdx !== -1 && args[urlsIdx + 1]) {
    const urlsArg = args[urlsIdx + 1];
    let urls;
    if (urlsArg.endsWith('.json') && existsSync(urlsArg)) {
      urls = JSON.parse(readFileSync(urlsArg, 'utf-8'));
    } else {
      urls = urlsArg.split(',').map(u => u.trim()).filter(Boolean);
    }
    if (!Array.isArray(urls) || urls.length === 0) {
      console.error(chalk.red('No valid URLs provided'));
      process.exit(1);
    }
    try {
      const scanResult = await scanExplicitUrls(urls, { timeout, concurrency, delay, controlFile });
      generateReport({ ...scanResult, batchId, batchLabel });
    } catch (err) {
      console.error(chalk.red(`Scan mislukt: ${err.message}`));
      process.exit(1);
    }
    return;
  }

  const resumeIdx = args.indexOf("--resume");
  let resumeFile = null;
  let url;

  if (resumeIdx !== -1 && args[resumeIdx + 1]) {
    resumeFile = args[resumeIdx + 1];
    if (!existsSync(resumeFile)) {
      console.error(chalk.red(`Resume bestand niet gevonden: ${resumeFile}`));
      process.exit(1);
    }
    // Get URL from resume file or from args
    const prevData = JSON.parse(readFileSync(resumeFile, "utf-8"));
    url = args.find((a) => a.startsWith("http")) || `https://www.${prevData.domain}`;
    // Inherit batch metadata from the resume file when CLI flags weren't supplied,
    // so resumed scans don't drift out of their batch on next list/sync.
    if (!batchId && typeof prevData.batchId === "string") batchId = prevData.batchId;
    if (!batchLabel && typeof prevData.batchLabel === "string") batchLabel = prevData.batchLabel;
  } else {
    url = args[0];
    if (!url.startsWith("http")) {
      console.error(chalk.red("URL moet beginnen met http:// of https://"));
      process.exit(1);
    }
  }

  const maxPages = parseInt(args[args.indexOf("--max-pages") + 1]) || 50;
  const sitemap = !args.includes("--no-sitemap");
  const maxSitemapUrls = parseInt(args[args.indexOf("--max-sitemap-urls") + 1]) || 5000;

  try {
    const scanResult = await crawlSite(url, { maxPages, timeout, resumeFile, concurrency, delay, sitemap, maxSitemapUrls, controlFile });
    generateReport({ ...scanResult, batchId, batchLabel, resumeFile });
  } catch (err) {
    console.error(chalk.red(`Scan mislukt: ${err.message}`));
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
