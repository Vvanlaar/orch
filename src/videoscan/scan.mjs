#!/usr/bin/env node
import { chromium } from "playwright";
import chalk from "chalk";
import { readFileSync, writeFileSync, existsSync } from "fs";

// ── Video Player Detectors ──────────────────────────────────────────
// Each detector checks page HTML + network requests for a specific player.
// Returns { found: boolean, details: string[] }

const DETECTORS = {
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
      /youtu\.be\//i,
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
  "Video.js": 5, "HTML5 native": 5,
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
  const hasPlaceholders = await page.evaluate(() =>
    document.querySelectorAll(
      'script[type="text/plain"][data-cookieconsent], .cookieconsent-optout-marketing, .cookieconsent-optout'
    ).length > 0
  );
  if (!hasPlaceholders) return;

  await page.evaluate(() => {
    // Method 1: Cookiebot API
    if (typeof Cookiebot !== "undefined" && Cookiebot.renew) {
      try { Cookiebot.consent.marketing = true; Cookiebot.renew(); } catch {}
    }
    // Method 2: dispatch standard Cookiebot event
    try { window.dispatchEvent(new Event("CookiebotOnAccept")); } catch {}
    // Method 3: force-swap consent-gated scripts to execute
    for (const s of document.querySelectorAll('script[type="text/plain"][data-cookieconsent]')) {
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
    // Script tags that Cookiebot hides behind consent
    for (const s of document.querySelectorAll('script[type="text/plain"][data-cookieconsent]')) {
      if (s.textContent) parts.push(s.textContent);
    }
    // Deferred src attributes on iframes/scripts only (skip images/tracking pixels)
    for (const el of document.querySelectorAll(
      "iframe[data-cmp-src], iframe[data-cookieblock-src], iframe[data-src]," +
      "script[data-cmp-src], script[data-cookieblock-src], script[data-src]"
    )) {
      const src = el.getAttribute("data-cmp-src") || el.getAttribute("data-cookieblock-src") || el.getAttribute("data-src");
      if (src) parts.push(src);
    }
    return parts.length > 0 ? parts.join("\n") : "";
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

async function scanOnePage(context, url, timeout) {
  const page = await context.newPage();
  const networkRequests = [];

  page.on("request", (req) => {
    networkRequests.push(req.url());
  });

  let response;
  try {
    response = await page.goto(url, { waitUntil: "networkidle", timeout });
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

  // Re-grab HTML after dynamic content has loaded
  const html = await page.content();
  const detected = await detectWithConsent(page, html, networkRequests);

  // Extract links for further crawling
  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href]"), (a) => a.href)
  );

  await page.close();
  return { detected, links };
}

// First page: accept cookies before scanning (re-navigates if cookies accepted)
async function scanFirstPage(context, url, timeout) {
  const page = await context.newPage();
  const networkRequests = [];
  page.on("request", (req) => networkRequests.push(req.url()));

  let response;
  try {
    response = await page.goto(url, { waitUntil: "networkidle", timeout });
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
    await page.goto(url, { waitUntil: "networkidle", timeout });
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

  const html = await page.content();
  const detected = await detectWithConsent(page, html, networkRequests);
  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href]"), (a) => a.href)
  );

  await page.close();
  return { detected, links };
}

const DEFAULT_CONCURRENCY = 6;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function crawlSite(startUrl, { maxPages = 50, timeout = 15000, resumeFile = null, concurrency = DEFAULT_CONCURRENCY, delay = 200, sitemap = true, maxSitemapUrls = 5000 } = {}) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
  });

  const baseUrl = new URL(startUrl);
  const domain = baseUrl.hostname.replace(/^www\./, "");
  let visited = new Set();
  let queue = [normalizeUrl(startUrl, startUrl)];
  let results = [];

  const throttle = createThrottleState(delay, concurrency);
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
      const { detected, links, skippedReason } = await scanFirstPage(context, firstUrl, timeout);
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

  while (queue.length > 0 && visited.size < maxPages && !interrupted) {
    // Inter-batch delay (skip first batch)
    if (batchNum > 0 && throttle.delay > 0) {
      await sleep(throttle.delay);
    }
    batchNum++;

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
      batch.map((url) => scanOnePage(context, url, timeout))
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

    // Progress stats every 30s
    if (Date.now() - lastProgressAt > 30_000) {
      const elapsed = (Date.now() - scanStartTime) / 60_000;
      const ppm = (visited.size / elapsed).toFixed(1);
      const remaining = Math.min(queue.length, maxPages - visited.size);
      const etaMin = ppm > 0 ? (remaining / ppm).toFixed(1) : "?";
      console.log(chalk.cyan(`  ── ${ppm} pages/min | queue=${queue.length} | ~${etaMin}min left | delay=${throttle.delay}ms | concurrency=${throttle.concurrency}`));
      lastProgressAt = Date.now();
    }

    // Re-prioritize remaining queue after each batch (new video-likely URLs bubble up)
    queue.splice(0, queue.length, ...prioritizeUrls(queue));
  }

  await browser.close();

  return {
    domain,
    results,
    pagesScanned: visited.size,
    _state: { visited: [...visited], queue },
    rateLimits: buildRateLimits(throttle),
  };
}

function detectPlayers(html, networkRequests) {
  const found = [];

  for (const [player, config] of Object.entries(DETECTORS)) {
    const matches = [];

    // Check HTML content
    for (const pattern of config.patterns) {
      const match = html.match(pattern);
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

  return filterNonVideoSocials(filterToHighestTier(found), html, networkRequests);
}

// ── Explicit URL scanning (no crawl) ────────────────────────────────

async function scanExplicitUrls(urls, { timeout = 15000, concurrency = DEFAULT_CONCURRENCY, delay = 200 } = {}) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
  });

  const baseUrl = new URL(urls[0]);
  const domain = baseUrl.hostname.replace(/^www\./, "");
  const results = [];

  const throttle = createThrottleState(delay, concurrency);
  const retryCount = new Map();
  const MAX_RETRIES = 2;

  console.log(chalk.blue(`\nScanning ${urls.length} explicit URLs (domain: ${domain})`));
  console.log(chalk.gray(`Timeout per page: ${timeout}ms, Concurrency: ${concurrency}, Delay: ${delay}ms\n`));

  setupInterruptHandler();

  // First URL: accept cookies
  const firstUrl = urls[0];
  process.stdout.write(chalk.gray(`[1/${urls.length}] `) + chalk.white(truncate(firstUrl, 80)) + " ");
  try {
    const { detected, skippedReason } = await scanFirstPage(context, firstUrl, timeout);
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

    const batch = remaining.splice(0, throttle.concurrency);

    for (let i = 0; i < batch.length; i++) {
      const idx = results.length + i + 1;
      console.log(chalk.gray(`[${idx}/${urls.length}] `) + chalk.white(truncate(batch[i], 80)) + chalk.gray(" ..."));
    }

    const batchResults = await Promise.allSettled(
      batch.map((url) => scanOnePage(context, url, timeout))
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
  }

  await browser.close();

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

function generateReport({ domain, results, pagesScanned, _state, rateLimits }) {
  const playerSummary = {};
  const pagesWithPlayers = [];
  const pagesWithoutPlayers = [];

  for (const { url, players } of results) {
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

  // Save JSON report
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const jsonFile = `videoscan-${domain}-${ts}.json`;
  const jsonReport = {
    domain,
    scanDate: new Date().toISOString(),
    pagesScanned,
    pagesWithVideo: pagesWithPlayers.length,
    uniquePlayers: playerNames.length,
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
  --concurrency <n>     Pagina's tegelijk scannen (standaard: 6)
  --delay <ms>          Vertraging tussen batches in ms (standaard: 200)
  --resume <json-file>  Hervat scan vanuit eerder resultaat
  --urls <urls|file>    Scan explicit URLs (comma-separated or JSON file path)
  --no-sitemap          Skip sitemap-based URL discovery
  --max-sitemap-urls <n> Max URLs uit sitemap toevoegen aan queue (standaard: 5000)

${chalk.bold("Voorbeelden:")}
  node scan.mjs https://www.menzis.nl
  node scan.mjs https://www.menzis.nl --max-pages 100 --concurrency 10
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

  const timeout = parseInt(args[args.indexOf("--timeout") + 1]) || 15000;
  const concurrency = parseInt(args[args.indexOf("--concurrency") + 1]) || DEFAULT_CONCURRENCY;
  const delay = parseInt(args[args.indexOf("--delay") + 1]) || 200;

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
      const scanResult = await scanExplicitUrls(urls, { timeout, concurrency, delay });
      generateReport(scanResult);
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
    const scanResult = await crawlSite(url, { maxPages, timeout, resumeFile, concurrency, delay, sitemap, maxSitemapUrls });
    generateReport(scanResult);
  } catch (err) {
    console.error(chalk.red(`Scan mislukt: ${err.message}`));
    process.exit(1);
  }
}

main();
