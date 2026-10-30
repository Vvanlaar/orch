#!/usr/bin/env node
import { chromium } from "playwright";
import chalk from "chalk";
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, unlinkSync, openSync, writeSync, closeSync, renameSync } from "fs";
import { basename, dirname, join } from "path";
import { fileURLToPath } from "url";
import os from "node:os";
import { acquire } from "./wake-lock.mjs";
import { coverageFlags } from "./coverage.mjs";
import { createSovereigntyCollector, startCapture, playVideos, pickSamples } from "./sovereignty/collect.mjs";
import { resolveHosts, loadAsnDb } from "./sovereignty/resolve.mjs";

// ── Video Player Detectors ──────────────────────────────────────────
// Each detector checks page HTML + network requests for a specific player.
// Returns { found: boolean, details: string[] }

// Facebook video markup, shared by the detector and its social confirmer:
// the plugin iframe (optionally versioned, slashes escaped or URL-encoded) and
// an fb-video div anywhere in the class list, any quoting.
const FB_VIDEO_PLUGIN = /facebook\.com(?:\\*\/|%2F)(?:v[\d.]+(?:\\*\/|%2F))?plugins(?:\\*\/|%2F)video\.php/i;
const FB_VIDEO_CLASS = /class\s*=\s*\\*["'][^"']*(?<![\w-])fb-video(?![\w-])/i;

export const DETECTORS = {
  // ── Enterprise / OVP ────────────────────────────────────────────
  "Blue Billywig": {
    patterns: [
      /bbvms\.com/i,
      // A subdomain (cdn., stats.). The company's own www. and support. are
      // websites: www. matched every page of bluebillywig.com (19 of 25 without
      // a player), also URL-encoded in its share links (%2Fwww.bluebillywig.com)
      /(?<=[\w-]\.)(?<!(?:www|support)\.)bluebillywig\.com/i,
      /\.bbvms\./i,
      /bb-player/i,
      /data-bb-/i,
    ],
    scripts: [/bbvms\.com/i, /(?<=[\w-]\.)(?<!(?:www|support)\.)bluebillywig\.com/i, /\/bluebillywig\//i],
  },
  Brightcove: {
    patterns: [
      /players\.brightcove\.net/i,
      /brightcove\.com/i,
      /bcove\.video/i,
      /brightcove-player/i,
      // Brightcove in-page embed: <video-js data-account data-player ...>.
      // Only the data-account + data-player pair is Brightcove-specific — it maps
      // to the mandatory players.brightcove.net/<account>/<player>_default script.
      // Neither attribute qualifies alone: data-video-id is generic (see the
      // TikTok detector below, which pairs it with a vendor token for the same
      // reason) and data-account is generic (analytics/CMS wrappers carry one).
      // Bare-attribute matches are especially costly here because Brightcove is
      // tier 1, so one false hit suppresses every real lower-tier player found.
      // [^>]* (not .*) keeps the pair inside one tag — the old `.*` variant
      // matched a data-account on one element and a data-player on the next.
      /<[^>]*\bdata-account=[^>]*\bdata-player=/i,
      /<[^>]*\bdata-player=[^>]*\bdata-account=/i,
    ],
    scripts: [/players\.brightcove\.net/i, /brightcove\.com/i],
  },
  "JW Player": {
    patterns: [
      /jwplatform\.com/i,
      /jwplayer\.com/i,
      /jwpcdn\.com/i,
      // bare jwplayer() (no argument) is control code, not a player — hilvarenbeek2030.nl
      // runs `if (jwplayer()) jwplayer().stop()` on 7 pages without one. A named call
      // can still be control code (jwplayer('p').stop()); accepted, none seen so far.
      /jwplayer\(\s*[^)\s]/i,
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
      // NB: case-sensitive, word-anchored, and followed by the API dot. A bare
      // /kWidget/i matched the substring anywhere — `zoekwidget1.php`, an
      // unrelated search widget — and flagged pages with no video at all.
      // Relies on the corpus never being lowercased: extractEncodedMarkup
      // lowercases only for needle tests, the markup it pushes keeps its case.
      /\bkWidget\s*\./,
      // The container class Kaltura's embed JS renders. The bare /kWidget/i
      // caught it; the anchored form above does not, and on a self-hosted
      // (custom-domain) Kaltura with external embed JS it can be the only one.
      /\bkWidgetIframeContainer\b/,
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
    patterns: [/flowplayer\.com/i, /flowplayer\.org/i, /flowplayer\(/i, /class=["'][^"']*\bflowplayer\b/i],
    // Not /flowplayer/: a self-hosted /flowplayer/flowplayer.min.js loads on
    // every page of the GemeenteOplossingen council template with no player
    // on it (gemeenteraad.haarlemmermeer.nl), and at tier 1 it hid the real
    // YouTube embed. A self-hosted player still shows in the markup above.
    scripts: [/flowplayer\.(?:com|org)\//i],
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
    // NB: no bare /hihaho\.com/ — a "made with hihaho.com" mention in body text
    // is not an embed, and Hihaho is tier 1, so it would hide the real player.
    patterns: [/player\.hihaho\.com/i, /hihaho\.com\/embed/i],
    scripts: [/hihaho\.com/i],
  },
  "Ivory Media Player": {
    patterns: [/ivoryvideo\.com/i, /ivory-player/i, /ivorymediaplayer/i],
    scripts: [/ivoryvideo\.com/i],
  },
  OpenGemeenten: {
    // Only the TYPO3 Mediaplayer content element counts: it loads
    // OpenGemeentenMediaPlayer-*.js on the pages that carry a player. The bare
    // brand is the CMS itself — nieuwegein.nl ships "TYPO3 website by
    // OpenGemeenten, www.opengemeenten.nl" and OpenGemeentenSite-*.js on every
    // page, which flagged 3.3k pages with no video (tier 1, so it also hid the
    // real YouTube embeds on them).
    // The separator is optional so a TYPO3 extension path
    // (opengemeenten_mediaplayer) counts as well as the asset name.
    patterns: [/OpenGemeenten[_-]?Media-?Player/i, /AccessibleMediaPlayer/i],
    scripts: [/OpenGemeenten[_-]?Media-?Player/i],
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
      // NB: no bare /vixy\.nl/ — the vendor's company site, never an embed; the
      // player always loads from vixyvideo.com.
    ],
    scripts: [/vixyvideo\.com/i],
  },
  // Company Webcast and iBabs both arrive through the iBabs meeting portal
  // (bestuurlijkeinformatie.nl and siblings), which marks an embed slot with
  // data-video-type and lets /scripts/agendavideo fill it in client-side. That
  // script recognises exactly four values: Cwc, iBabsStream, ConnectedViews and
  // IframeUrl. The last two only build an iframe from data-video-url, so they
  // are covered when that URL points at a vendor already in DETECTORS and are a
  // silent miss otherwise - not something these two detectors handle.
  //
  // Both vendors are anchored to a host *path*, never a bare domain: an iBabs
  // player pulls its poster from sdk.companywebcast.com/customers/<org>/poster/,
  // so a loose companywebcast host match would tag every iBabs stream as
  // Company Webcast as well. Both are tier 1, so filterToHighestTier would not
  // resolve that - the page would just report two players where one exists.
  "Company Webcast": {
    // The marker has to stand on its own: on a Cwc embed data-video-url is
    // empty and the SDK builds the iframe, so before render the marker is the
    // only in-page signal. \b after it rejects suffixed variants (CwcLive),
    // which the portal does not emit.
    // The SDK alone is not a player: steenwijkerland.nl/bis loads
    // /sdk/player/client.js on all 1153 pages, and 6 of them name a recording
    // as body text ("Geluidsverslag: http://player.companywebcast.com/…").
    // So the player host and the SDK's own embed iframe (/sdk/player/?id=…,
    // lansingerland.nl) count only as a src-like attribute value (src,
    // data-src, data-src-cmplz, data-lazy-src, data-video-url; slashes may be
    // JSON-escaped or URL-encoded), never as text or a share/copy attribute.
    patterns: [
      /data-video-type=["']?Cwc\b/i,
      /(?:\bsrc[\w-]*|data-video-url)\s*=\s*\\*["']?\s*(?:https?:|https?%3A)?(?:\\*\/|%2F){2}player\.companywebcast\.com/i,
      /(?:\bsrc[\w-]*|data-video-url)\s*=\s*\\*["']?\s*(?:https?:|https?%3A)?(?:\\*\/|%2F){2}sdk\.companywebcast\.com(?:\\*\/|%2F)sdk(?:\\*\/|%2F)player(?:\\*\/|%2F)?(?:\?|%3F|#|index)/i,
    ],
    // Queries are stripped before these run, so the ?id= embed iframe is
    // /sdk/player/ and client.js no longer matches.
    scripts: [/player\.companywebcast\.com/i, /sdk\.companywebcast\.com\/sdk\/player\/?$/i],
  },
  // Dutch hosting platform; its iframe player runs video.js inside, so without
  // this entry the only trace was a network-only Video.js hit (breda.nl/milieustation).
  StreamPartner: {
    patterns: [/streampartner\.nl\/player\.php/i],
    scripts: [/streampartner\.nl\/player\.php/i, /streampartner\.nl\/video_opensource\//i],
  },
  iBabs: {
    patterns: [
      /data-video-type=["']?iBabsStream\b/i,
      /player\.ibabs\.eu/i,
    ],
    // Only the player host and the embed marker count. bestuurlijkeinformatie.nl
    // is built by iBabs, so every page - video or not - carries
    // /Images/icons/ibabs/ favicons plus footer links to ibabs.com and
    // portal.ibabs.eu. A bare /ibabs/i token would flag all 3253 pages of the
    // site: the same whole-site false positive the Video.js vjs- anchor exists
    // to prevent, and iBabs is tier 1, so it would suppress every real player.
    //
    // babscast.com is iBabs' own delivery domain - vod. for recordings,
    // signalr. and babscast-gateway. for live - so it is matched as a whole
    // host to cover a live stream too. It is the backstop; player.ibabs.eu in
    // the embedding markup is the primary signal.
    scripts: [/player\.ibabs\.eu/i, /\bbabscast\.com/i],
  },

  // ── Major platforms ─────────────────────────────────────────────
  YouTube: {
    patterns: [
      // With the video id (videoseries fits the 11 chars too). Bare
      // 'youtube.com/embed/' is a string literal in Google Tag Manager's YouTube
      // trigger script, inlined on every page of stadsarchief.breda.nl (990
      // pages, no player).
      /youtube\.com\/embed\/+[\w-]{11}/i,
      /youtube-nocookie\.com\/embed\/+[\w-]{11}/i,
      // NB: no bare /youtu\.be\// — that's a share/watch link domain, never an
      // embed src. It fired on plain links (stripAnchorHrefs only strips <a href>,
      // not data-*/text/JSON), flagging pages that merely link to YouTube.
      // Thumbnail of one specific video, not bare /ytimg\.com/: WP Rocket inlines
      // the template 'i.ytimg.com/vi_webp/ID/hqdefault.webp' on every page.
      /ytimg\.com\/vi(?:_webp)?\/[\w-]{11}\//i,
      // NB: no /youtube\.com\/iframe_api/ in the markup — it is text in cookie
      // banners' vendor lists (werkenindeleidseregio.nl, every page) and in the
      // GTM snippet. A player that loads the API shows up as a network request.
      /yt-video/i,
      // NB: no /class="youtube/ — it matched footer icons such as
      // class="youtube-li" linking to the channel. Real embeds carry the
      // embed URL or a video-id attribute.
      /data-youtube-id/i,
      // Any data-youtube* attribute holding a video id: theaterspeelhuis.nl's
      // hero player is <div data-youtubevid="ss0uBuG6N7k"> with the API loaded
      // only after consent, so no embed URL and no request to go on.
      /data-youtube[\w-]*=["'][\w-]{11}["']/i,
      // Drupal's oEmbed iframe: src/data-src="/media/oembed?url=https://youtu.be/ID"
      // (nu.venlo.nl), no youtube.com/embed in the page until consent
      /media\/oembed\?url=https?(?::|%3A)(?:\/\/|%2F%2F)(?:www\.)?(?:youtu\.be|youtube\.com)(?:\/|%2F)/i,
      /data-youtube-video-id/i,
      // As an element's class/id, not bare /youtube-player/: WP Rocket's inline
      // CSS '.rll-youtube-player{…}' ships on every page of the site.
      /(?:class|id)=["'][^"']*\byoutube-player\b/i,
      // IFrame API player built in script (new YT.Player(el, {videoId: "…"})): until
      // a click or consent creates the iframe, the loader is its only request.
      // Scoped to the YT.Player call: other players' configs have a videoId too.
      /\bYT\.Player\s*\([\s\S]{0,300}?\bvideoId\s*:\s*["'][\w-]{11}["']/,
    ],
    // Not the IFrame API loader (iframe_api → www-widgetapi.js): almelobuurtsamen.nl
    // and actiefhoogeveen.nl load it on every page (1880 pages) with no player.
    // An actual embed requests /embed/, its thumbnails (ytimg) or the player itself.
    scripts: [/youtube(?:-nocookie)?\.com\/(?!iframe_api|player_api|s\/player\/[^/]+\/www-widgetapi)/i, /ytimg\.com/i],
  },
  Vimeo: {
    patterns: [
      // A path after the host: a bare player.vimeo.com is a cookie-banner domain
      // list (gouda.nl, 1550 pages), CSP or preconnect, never an embed. The slash
      // may be JSON-escaped (\/) or URL-encoded (%2F) in a consent placeholder.
      /player\.vimeo\.com(?:\\*\/|%2F)\w/i,
      /vimeo\.com\/video/i,
      // Event / showcase embeds are iframe srcs in their own right, and the
      // removed link pattern never covered them (no digits after the slash).
      /vimeo\.com\/(?:event|showcase)\/[^"'\s<>]*\/embed/i,
      // NB: no bare /vimeo\.com\/\d+/ — same trap as the youtu.be link shape
      // above: a share/watch URL, never an embed src. It fired on pages that
      // only linked to a Vimeo recording from body text or a JSON payload.
      // Path required for the same reason: CookieYes lists providers as
      // "player.vimeo.com|highcharts.com|vimeocdn.com" (defryskemarren.nl, 1235 pages).
      /vimeocdn\.com(?:\\*\/|%2F)\w/i,
      /data-vimeo-id/i,
      /data-vimeo-url/i,
      // A tag or an attribute token (class/className/id/data-module…, also
      // JSON-escaped or entity-encoded), not prose: werkenbijcapelleaandenijssel.nl's
      // cookie modal says "ingesloten Vimeo-players" on every page. The value
      // scan is capped at 200 chars so a run of ?id= in text cannot backtrack.
      /(?:<|\\u003c|&lt;|\b(?:class(?:Name)?|id|data-(?:module|component|js|type))\\*["']?\s*[=:]\s*(?:\\*["']|&quot;)?[^"'<>]{0,200}?)vimeo-player\b/i,
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
    // NB: no bare /tiktok\.com/ — analytics.tiktok.com/i18n/pixel/events.js is
    // the TikTok ad pixel, loaded site-wide once cookies are accepted. It flagged
    // 44k museum pages as TikTok and, at tier 2, hid their real tier-5 players.
    scripts: [/tiktok\.com\/embed/i, /tiktok\.com\/player\//i],
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
      FB_VIDEO_PLUGIN,
      FB_VIDEO_CLASS,
    ],
    // NB: no bare /facebook\.com\/watch/ — that is the share-link shape. A blog
    // link on trefhetinoss.nl kept it in data-href="…/watch/?v=…" (stripAnchorHrefs
    // drops only href). Embeds go through plugins/video.php or an fb-video div.
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
    // Embed paths only. spotify.com/show|episode are share links: they fired on
    // the social-links JSON amsterdammuseum.nl ships on every page
    // ("spotify":"https://open.spotify.com/show/…"). A bare /spotify\.com/
    // script pattern also matched the pixel.byspotify.com ad pixel.
    // Podcast-host embeds: Spotify for Podcasters, renamed Spotify for Creators
    // in 2025, and the anchor.fm URLs that predate both.
    patterns: [
      /open\.spotify\.com\/embed/i,
      /(?:podcasters|creators)\.spotify\.com\/pod\/(?:show|profile)\/[^"'\s<>]+\/embed/i,
      /anchor\.fm\/[^/"'\s<>]+\/embed/i,
    ],
    scripts: [
      /open\.spotify\.com\/embed/i,
      /(?:podcasters|creators)\.spotify\.com\/pod\/(?:show|profile)\/.+\/embed/i,
      /anchor\.fm\/[^/]+\/embed/i,
    ],
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
    // Both `vjs` spellings need a left boundary. Drupal serves aggregated JS as
    // `js_<hash>.js?...&include=<urlsafe-base64>`, and that blob collided with bare
    // /vjs/i — data.oss.nl flagged 29/29 dataset pages off the substring "vjS".
    // Since the bundle URL is byte-identical site-wide, one collision flags every
    // page, so a loose token here is a whole-site false positive.
    // The HTML class is anchored on [\s"'/.] specifically: none of whitespace,
    // quote, apostrophe, slash, or dot can appear in the urlsafe-base64 alphabet
    // (A-Za-z0-9-_), so a blob cannot match, while real markup always leads with
    // a quote, space, dot or slash.
    // `video.js` / `video-js` need a left boundary too: WordPress gives every
    // enqueued script the id "<handle>-js", so the jarallax plugin's
    // id="parallax-video-js" flagged all 336 pages of ettyhillesumcentrum.nl,
    // and a bare /video\.js/ matches any site script named *-video.js.
    // `videojs` must not be the library's own style switch: an inline
    // `window.VIDEOJS_NO_DYNAMIC_STYLE = true` sits on every page of a site that
    // loads video.js site-wide (haarlemmerliederaad.haarlemmermeer.nl flagged
    // 5,833 pages without a <video>), and it is markup, so NEEDS_MARKUP lets it by.
    patterns: [/(?<![\w-])video\.js\b/i, /videojs(?!_NO_DYNAMIC_STYLE)/i, /(?:^|[\s"'\/.])vjs-/i, /(?<![\w-])video-js\b/i],
    // `scripts` patterns see the request URL without its query string (see
    // detectPlayers), so a query blob can no longer reach them. Residual: `_` and
    // `-` are in the base64url alphabet, so a path segment like `…_vjs_…` can
    // still match — kept because real URLs use them (`player-vjs.js`,
    // `vendors_vjs.js`).
    scripts: [/videojs/i, /(?<![\w-])video\.js\b/i, /(?:^|[\/._-])vjs(?:[\/._-]|$)/i],
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
    // A camera viewfinder is a <video> too: zevenaardoet.nl ships an empty
    // <video id="QrScanVideoPreview"> for its QR scanner on every page (70 hits),
    // and Recruitee job pages (werkenbijgemeentekrimpenerwaard.nl) a hidden
    // <video class="ba-videorecorder-video"> for video applications.
    // Skipped only when its own id/class names a camera or recorder AND nothing
    // says it plays a file: no src/data-src, no controls, no <source> child. So
    // <video class="security-camera-promo" src="…"> still counts.
    patterns: [/<video(?!(?=[^>]*(?<![\w-])(?:id|class)\s*=\s*["']?[^"'>]*(?:qr[-_]?(?:scan|code|reader)|camera|webcam|recorder))(?![^>]*\s(?:data-)?src\s*=)(?![^>]*\scontrols\b)(?![^>]*>\s*<source\b))[\s>]/i, /<source[^>]+type="video/i],
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
    // A path segment, not the bare word: Mediasite URLs are
    // <host>/Mediasite/Play|Player|…, while "Mediasite" in body text (a
    // university's "terugkijken via Mediasite") is not a player. The HTML side
    // also takes JSON-escaped (\/) and URL-encoded (%2F) slashes, which is how a
    // consent placeholder or block attribute carries an embed not yet loaded.
    patterns: [/(?:\/|\\\/|%2f)mediasite(?:\/|\\\/|%2f)/i],
    scripts: [/\/mediasite\//i],
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
  "Company Webcast": 1, iBabs: 1, StreamPartner: 1,
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

/**
 * Drop generic engines (tier 5) when a vendor player is on the page: they are
 * usually its engine — Brightcove renders <video-js>, WordPress wraps YouTube
 * in MediaElement.js — not a second player. Vendors of other tiers all stay.
 */
export function dropEnginesUnderVendors(players) {
  if (!players.some((p) => (DETECTOR_TIER[p.player] ?? 5) < 5)) return players;
  return players.filter((p) => (DETECTOR_TIER[p.player] ?? 5) < 5);
}

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
    FB_VIDEO_CLASS.test(html) ||
    FB_VIDEO_PLUGIN.test(html) ||
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

// Crawler-trap bounds. A site that resolves relative links against *any* path
// regenerates every page one level deeper, forever: waardwijzer.krimpenerwaard.nl
// left 11,243 such URLs queued after a single scan (median depth 39, max 61,
// up to 1057 chars) while the real site is ~3 levels deep.
//
// All three thresholds were measured against the real URLs in this repo's scan
// history. The path bounds each reject exactly one of 573,359 — the same
// malformed link, two URLs concatenated — while together catching 99.2% of that
// trap. Deepest genuine page seen is 10 segments; the most any segment
// legitimately repeats is 3 (8 URLs), so 12 and 4 sit clear of real traffic.
//
// The query bound covers the other half of the trap: a paginator that appends
// ?from= on every link, growing the URL a parameter at a time. No real URL
// repeats a query key more than twice (multi-value facets like
// ?filter=a&filter=b are common and must survive), so rejecting at 3 caps that
// growth without touching a single genuine page.
const MAX_PATH_SEGMENTS = 12;
const MAX_SEGMENT_REPEATS = 4;
const MAX_QUERY_KEY_REPEATS = 3;

// Query parameters that pick a state of the page they sit on rather than
// another page. Each is matched against one raw query part (`key=value`, or a
// bare `key`) and is as narrow as the site that fooled us allows — a parameter
// that merely looks similar names a different page and has to survive.
//
// Drupal quicktabs: ?qt-<block>=<n> only says which tab of a tab block is
// open. www.jiphaarlemmermeer.nl/pesten-geweld/grooming-sexting came back four
// times (bare, ?qt-vragen_formulier=0, =1, =2) — one page, one YouTube embed.
// The value is always a tab index, so anything else under a qt- key is not
// quicktabs and stays. The price: a quicktabs block in ajax mode renders only
// the open tab, so a video in another tab is no longer reached through its
// ?qt- link.
const QUICKTABS_PARAM = /^qt-[^=]+=\d+$/;
// WordPress search with nothing typed: dementiehaarlemmermeer.nl links
// /dagbesteding-overzicht?s= next to /dagbesteding-overzicht, and on a page or
// post WordPress does not look at s at all (WP_Query reads it for archive
// queries only) and serves the page itself. Only the empty value goes — ?s=term
// is a real results page — and never on the root, where /?s= is the search
// template rather than the home page. Other archives (/category/x?s=, a
// language home /en?s=) get that template too and cannot be told from a page
// by their URL; they collapse, onto the archive that lists the same posts.
const EMPTY_SEARCH_PARAM = /^s=?$/;

function isSamePageParam(part, pathname) {
  return QUICKTABS_PARAM.test(part) || (pathname !== "/" && EMPTY_SEARCH_PARAM.test(part));
}

export function normalizeUrl(url, base) {
  try {
    const u = new URL(url, base);
    u.hash = "";
    // Remove trailing slash for consistency (except root)
    if (u.pathname !== "/" && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }
    // Drop query parameters that repeat verbatim. Some CMSes re-append their own
    // param to every internal link, so ?origin=gm&origin=gm and ?origin=gm are
    // one page fetched twice (2,329 such URLs in this repo's scan history).
    //
    // Of repeats, only byte-identical key=value pairs go. A repeated KEY is not
    // the same thing: ?filter=a&filter=b is a multi-value facet naming a
    // different result set than ?filter=b, and 4,429 real URLs here rely on
    // that — collapsing by key would quietly drop half of every faceted listing.
    // Runaway repetition is handled by MAX_QUERY_KEY_REPEATS instead, which
    // bounds it without reinterpreting anyone's parameters.
    //
    // Done on the raw query string rather than via URLSearchParams so that
    // untouched parameters keep their exact original encoding — re-serializing
    // would rewrite %20 as + on params that never repeated.
    //
    // Same-page parameters (isSamePageParam) go in the same pass, on the raw
    // string as well, so what remains keeps its encoding too.
    const rawQuery = u.search.slice(1);
    if (rawQuery) {
      const parts = rawQuery.split("&");
      const kept = [...new Set(parts.filter((part) => !isSamePageParam(part, u.pathname)))];
      if (kept.length !== parts.length) u.search = kept.join("&");
    } else {
      // /pad? is /pad with an empty query: the parser keeps the bare ? in href.
      // No site in the scan history links one yet; assigning "" drops it, and
      // does nothing to a URL that has no query.
      u.search = "";
    }
    return u.href;
  } catch {
    return null;
  }
}

/**
 * The --resume queue, re-filtered: it was written by whatever rules were in
 * force when the scan paused, so a run interrupted before the crawler-trap
 * bounds existed would otherwise resume straight back into the trap it was
 * stuck in (one real scan came back with 11,243 queued URLs, 99% trap output).
 * Normalized as well as filtered: the rules that collapse a re-appended ?from=
 * at enqueue time have to reach URLs queued before they existed, or the
 * paginator half of the trap survives the restore.
 */
export function restoreQueue(storedQueue, startUrl) {
  return [
    ...new Set(
      storedQueue.map((u) => normalizeUrl(u, startUrl)).filter((u) => u && !shouldSkipUrl(u, startUrl)),
    ),
  ];
}

/**
 * True when a URL's shape marks it as crawler-trap output rather than a real
 * page — excessive path depth, one path segment repeated over and over, or a
 * query key stacked up past anything a real multi-value parameter uses.
 */
export function isCrawlerTrap(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length > MAX_PATH_SEGMENTS) return true;
  const segmentCounts = new Map();
  for (const segment of segments) {
    const n = (segmentCounts.get(segment) || 0) + 1;
    if (n >= MAX_SEGMENT_REPEATS) return true;
    segmentCounts.set(segment, n);
  }

  const keyCounts = new Map();
  for (const key of parsed.searchParams.keys()) {
    const n = (keyCounts.get(key) || 0) + 1;
    if (n >= MAX_QUERY_KEY_REPEATS) return true;
    keyCounts.set(key, n);
  }

  return false;
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

// Translated copies. Dutch sites serve a (usually machine-) translated copy of
// every page under a language prefix, and the language switcher links it from
// every page, so each copy looks like a new page to the crawler. hilversum.nl
// spent 2,169 of a 3,000-page budget on /es/ /bg/ /ro/ /pt/; almelo.nl,
// visitvlissingen.nl (/de/ /en/ /fr/), sociaalteamhouten.nl (/en/ /uk/ /ar/
// /fr/ /tr/) and amstelveenvoorelkaar.nl (/ar/) do the same. The copies cost
// Dutch coverage and count a video twice.
//
// Only the FIRST path segment is checked, and only as a whole segment: /en/…,
// /pt-br/…, /zh_Hans/… are copies; /english-lessons, /debat, /esports, /de-wolf
// (harderwijk.nl) and /de-ing (ing.nl) are pages. Hosts (en.example.nl) and
// query strings (?lang=en) are left alone. /de/ and /en/ are also Dutch words
// (article, "and"), but as a whole first segment they are German and English
// copies on every site in the scan history (13k /de/ URLs on 27 sites, 72k /en/
// on 59) — some keep the Dutch slug (amstelveenvoorelkaar.nl/en/over-ons).
//
// Languages come from the 634k URLs in this repo's scan history plus the usual
// municipal translation-widget targets (refugee/migrant languages). Dutch (nl,
// nl-nl, nl-be) is never listed. Codes deliberately NOT listed because the
// segment is a Dutch path there:
//   is  (Icelandic) — /is/ is the product path of the "wijzer" social-domain
//       platform: waardwijzer.krimpenerwaard.nl, velsenwijzer.nl, cjgzeist.nl… (25k URLs)
//   my  (Burmese)   — /my/ account area on agnietenhof.nl, posthuistheater.nl
//   th  (Thai)      — utrecht.nl/th is a Dutch shortlink
//   id, eu, hr, ms  — too likely an identifier route, EU pages, HR, a medical term
// Listed but worth watching: so (Somali) is also "speciaal onderwijs" on school
// sites and it (Italian) an ICT section; neither shows up that way in the history.
// Frisian (fy, and friesmuseum.nl's own /frl/) and Papiamento (rijksmuseum.nl
// /pap/) are listed: those are copies of the Dutch page too.
const TRANSLATION_LANGS = new Set([
  "en", "de", "fr", "es", "pt", "it", "pl", "bg", "ro", "tr", "ar", "uk", "ru",
  "zh", "ja", "ko", "el", "hu", "sk", "cs", "sl", "lt", "lv", "et", "fi", "da",
  "sv", "no", "nb", "ca", "gl", "sq", "vi", "so", "ti", "am", "fa", "ps", "ku",
  "fy", "frl", "pap",
]);
// A base code, optionally with a region (en-gb, pt_BR, es-419) or script
// (zh-hans). Scripts are listed, not [a-z]{4}, so /de-wolf stays a page.
const LANG_SEGMENT = /^([a-z]{2,3})(?:[-_](?:[a-z]{2}|\d{3}|hans|hant|latn|cyrl))?$/;

// The base language of a path segment that is a language prefix — Dutch or a
// listed translation — else null. Case-insensitive: /en-GB/, /pt_BR/.
function segmentLang(segment) {
  const m = LANG_SEGMENT.exec(segment.toLowerCase());
  return m && (m[1] === "nl" || TRANSLATION_LANGS.has(m[1])) ? m[1] : null;
}

/**
 * The translation prefix a URL lives under ("es", "pt-br"), or null when its
 * first path segment is not a non-Dutch language code.
 */
export function translationPrefix(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const first = parsed.pathname.split("/")[1] || "";
  const lang = segmentLang(first);
  return lang && lang !== "nl" ? first.toLowerCase().replace("_", "-") : null;
}

/**
 * True when `url` is a translated copy the crawl should not visit. A scan
 * started under a language prefix asked for that language, so the start URL's
 * own prefix is kept; without a start URL every translation prefix is skipped.
 */
export function isTranslatedCopy(url, startUrl) {
  const prefix = translationPrefix(url);
  return prefix !== null && prefix !== (startUrl ? translationPrefix(startUrl) : null);
}

// Login pages: raad.rijssen-holten.nl links login?redirect=<doc> beside every
// document, half of a 1,925-page crawl. In 573,656 scanned URLs, 1,650 of the
// 1,664 login URLs with a player only repeated the page they redirect to; the
// other 14 were rijksmuseum.nl's site-wide template on the login form.
// Matched on the path only: ?next=/login on a content page is not a login page.
// Last segment only: pages below one (/inloggen/uitleg-digid-video) can be content.
const LOGIN_PATH = /\/(?:login|log-in|signin|sign-in|inloggen)(?:\.(?:php|aspx?|html?))?\/?$/i;

function isLoginPage(url) {
  try {
    return LOGIN_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

// Facet combinations. A listing whose filter links carry the whole selection as
// array parameters has one URL per subset of its checkboxes:
// www.ha-meer.nl/activiteiten?gemeente[0]=116&days[0]=1&days[1]=4&doelgroepen[0]=65&…
// had 600,754 of them queued after 7,464 scanned (0 with video) when the crawl
// died. ?tx_solr[filter][0]=…&tx_solr[filter][1]=… did the same to
// werkenvoortilburg.nl (36,877 pages scanned),
// leerplichtdoorstroompuntmiddenbrabant.nl (12,660) and sportintilburg.nl
// (8,943). The links are plain <a>, so isFilterControl never sees them.
//
// An array parameter is key[N]= or key[]=, brackets raw or %5B%5D. One is a
// single filter value and stays: those grow with the number of values, not
// with their combinations, and ha-meer pages its listing as
// ?gemeente[0]=116&pagina=2 — gemeente[0] rides on every link there, so the
// second array parameter is the first real filter. A named key is an address,
// not a filter: ?tx_news_pi1[action]=detail&tx_news_pi1[news]=42 is one TYPO3
// article. ?filter=a&filter=b stays MAX_QUERY_KEY_REPEATS' business.
// Of 769,775 scanned URLs the rule takes 60,958, on 35 sites; the only ones
// with a player are 787 on boijmans.nl, whose TikTok embed is on 19,885 of its
// 19,995 pages. Of ha-meer's 600,778 queued URLs it leaves 24.
const ARRAY_PARAM_KEY = /(?:\[|%5B)\d*(?:\]|%5D)$/i;
const MAX_ARRAY_PARAMS = 1;

function isFacetCombination(url) {
  const start = url.indexOf("?");
  if (start === -1) return false;
  let arrayParams = 0;
  for (const param of url.slice(start + 1).split("#")[0].split("&")) {
    const eq = param.indexOf("=");
    if (!ARRAY_PARAM_KEY.test(eq === -1 ? param : param.slice(0, eq))) continue;
    arrayParams++;
    if (arrayParams > MAX_ARRAY_PARAMS) return true;
  }
  return false;
}

// Endless calendars. gemeenteoplossingen council sites link the previous and
// the next year from /kalender/<year>, with no first or last one:
// gemeenteraad.haarlemmermeer.nl has been walked from /kalender/1799 to
// /kalender/4583, 9,472 of the 20,000 pages of its last crawl, and dronten,
// dordrecht, ridderkerk, den helder, weert and venlo the same way. 10,218 such
// pages in scan history, 0 with a player.
// Years a meeting can be in stay — the meetings on these sites run 2006..2027,
// and those calendar pages (726) are a way to reach them. Four digits exactly:
// with the walk cut at both ends a longer number is not a year but an id or a
// date. Only /kalender/: the number after /event/ is an id
// (posthuistheater.nl/order/add/event/6133).
const CALENDAR_YEAR = /\/kalender\/(\d{4})(?:\/|$)/i;
const CALENDAR_FIRST_YEAR = 1990;
const CALENDAR_YEARS_AHEAD = 2;

function isEndlessCalendarPage(url) {
  // Nearly no URL is a calendar page: look before parsing
  if (!CALENDAR_YEAR.test(url)) return false;
  let match;
  try {
    match = CALENDAR_YEAR.exec(new URL(url).pathname);
  } catch {
    return false;
  }
  if (!match) return false;
  const year = Number(match[1]);
  return year < CALENDAR_FIRST_YEAR || year > new Date().getFullYear() + CALENDAR_YEARS_AHEAD;
}

export function shouldSkipUrl(url, startUrl) {
  const skip = [
    /\.(pdf|zip|png|jpg|jpeg|gif|svg|webp|mp4|mp3|wav|doc|docx|xls|xlsx|ppt|pptx|css|js|xbri|xbrl|xml|csv)(\?|$)/i,
    /mailto:/i,
    /tel:/i,
    /javascript:/i,
    /#$/,
    // Draft/preview links (CMS preview tokens) — unpublished, auth-gated, redirect
    // to a login page. Not real public pages; they only pollute failure counts.
    /[?&]preview[-_]token=/i,
    // State-changing links: a GET here adds to a basket or ends a session.
    // agnietenhof.nl links /order/add/event/<id> on every show — 226 of 510 pages.
    /\/(?:order|cart|basket|winkelwagen|winkelmand(?:je)?)\/(?:add|remove|delete)(?:[/?#]|$)/i,
    /[?&]add[-_]to[-_]cart=/i,
    /\/(?:logout|log-out|signout|sign-out|uitloggen)(?:[/?#]|$)/i,
    /[?&]action=logout\b/i,
    // OpenGemeenten "translate this page" link on every page: one proxy URL per
    // page (?tx_opengemeententranslategoogle[url]=<base64>), and it answers with
    // an HTTP error. 4,157 in scan history, 0 with a player; nieuwegein.nl spent
    // 1,376 of a 2,823-page crawl on them, schouwen-duiveland.nl 776 of 1,565.
    /\/google-translate-informatie(?:[/?#]|$)/i,
    /[?&]tx_opengemeententranslategoogle/i,
    // iBabs document viewers, one per document of every meeting:
    // /Agenda/Document/<guid>?documentId=…, /Reports/Document/<guid>,
    // /Document/View/<guid>. haarlemmermeer.bestuurlijkeinformatie.nl spent
    // 19,027 of 20,000 pages on them and got to 514 meetings. 29,510 in scan
    // history on four iBabs sites, 0 with a player: there the video is on the
    // meeting itself (/Agenda/Index/<guid>, 144 of the 155 pages with one).
    // In the path only, not in a ?returnUrl= on some other page.
    /^[^?#]*\/Document\/(?:View\/)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}(?:[/?#]|$)/i,
  ];
  if (skip.some((r) => r.test(url))) return true;

  if (isLoginPage(url)) return true;

  if (isCrawlerTrap(url)) return true;

  if (isFacetCombination(url)) return true;

  if (isEndlessCalendarPage(url)) return true;

  if (isTranslatedCopy(url, startUrl)) return true;

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
export async function discoverSitemapUrls(startUrl, domain, { maxUrls = 5000, fetchTimeout = 30000 } = {}) {
  const origin = new URL(startUrl).origin;
  const targetProtocol = new URL(startUrl).protocol;
  const sitemapCandidates = new Set();

  // 1. Try robots.txt first
  const robots = await fetchText(`${origin}/robots.txt`, fetchTimeout);
  for (const m of (robots || "").matchAll(/^\s*Sitemap:\s*(\S+)/gim)) {
    sitemapCandidates.add(m[1].trim());
  }

  // 2. Fallback to common locations
  if (sitemapCandidates.size === 0) {
    sitemapCandidates.add(`${origin}/sitemap.xml`);
    sitemapCandidates.add(`${origin}/sitemap`);
  }

  const MAX_SITEMAP_DEPTH = 3;
  // Fetched one after another before the crawl starts
  const MAX_SITEMAP_FETCHES = 100;
  const visitedSitemaps = new Set();
  const urlsets = [];
  let urlsetTotal = 0;
  let fetches = 0;

  // Normalized while parsing: a raw loc is a slice of the sitemap document and
  // would keep all of it in memory. No one urlset can add more than maxUrls.
  function toUrls(locs) {
    const urls = [];
    for (const loc of locs) {
      if (urls.length >= maxUrls) break;
      // Normalize scheme to match the site's protocol (sitemaps often use http://)
      const normalized = normalizeUrl(loc.replace(/^https?:/, targetProtocol), startUrl);
      if (normalized && isSameDomain(normalized, domain) && !shouldSkipUrl(normalized, startUrl)) urls.push(normalized);
    }
    return urls;
  }

  // Level by level through the index tree, so an index of years → months
  // spends the fetch budget on months across all years, not on the first
  // year's. Per level: one sitemap of each kind first, then the rest spread,
  // until every kind is in and the urlsets hold enough to fill the cap.
  let level = [...sitemapCandidates];
  let unfetched = 0;
  for (let depth = 0; depth <= MAX_SITEMAP_DEPTH && level.length > 0; depth++) {
    const { ordered, kinds } = orderSitemaps(level);
    const next = [];
    for (let i = 0; i < ordered.length; i++) {
      if (i >= kinds && urlsetTotal >= maxUrls) break;
      if (fetches >= MAX_SITEMAP_FETCHES) {
        unfetched += ordered.length - i;
        break;
      }
      const url = ordered[i];
      if (visitedSitemaps.has(url)) continue;
      visitedSitemaps.add(url);
      fetches++;
      const xml = await fetchText(url, fetchTimeout);
      if (!xml) continue;
      const locs = parseLocs(xml);
      if (/<sitemapindex\b/i.test(xml)) {
        for (const loc of locs) {
          // Only follow sub-sitemaps on the same domain to avoid arbitrary outbound
          // fetches, and not a translation's (/es/sitemap.xml): every URL in it
          // would be dropped, so it only spends the fetch budget
          const sameProtocol = loc.replace(/^https?:/, targetProtocol);
          if (isSameDomain(sameProtocol, domain) && !isTranslatedCopy(sameProtocol, startUrl)) next.push(loc);
        }
      } else {
        const urls = toUrls(spreadPick(locs, locs.length));
        urlsets.push(urls);
        urlsetTotal += urls.length;
      }
    }
    if (fetches >= MAX_SITEMAP_FETCHES) {
      unfetched += next.length;
      break;
    }
    level = next;
  }
  if (unfetched > 0) {
    console.log(chalk.gray(`  Sitemap: fetch budget (${MAX_SITEMAP_FETCHES}) reached, ${unfetched} sitemap(s) not fetched`));
  }

  // Sitemaps are split by content type, so filling the cap front to back fills
  // it with whatever comes first — often one news archive. Round-robin over
  // the urlsets instead: each gets an even share, and what a small one can't
  // use goes to the others.
  const found = new Set();
  for (let i = 0, more = true; more && found.size < maxUrls; i++) {
    more = false;
    for (const urls of urlsets) {
      if (i >= urls.length || found.size >= maxUrls) continue;
      found.add(urls[i]);
      more = true;
    }
  }
  return [...found];
}

// <loc> text, unescaped. TYPO3 index entries carry ?page=1&amp;sitemap=…&amp;cHash=…
// and WordPress core uses &#038;; fetched still escaped, the query breaks and
// the child comes back empty. Some generators wrap the URL in CDATA.
function parseLocs(xml) {
  return [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[\s*)?([^<]+?)\s*(?:\]\]>\s*)?<\/loc>/gi)].map((m) =>
    decodeXmlEntities(m[1]),
  );
}

const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeXmlEntities(text) {
  return text.replace(/&(?:(amp|lt|gt|quot|apos)|#(\d+)|#[xX]([0-9a-fA-F]+));/g, (entity, name, dec, hex) => {
    if (name) return XML_ENTITIES[name];
    const code = dec ? Number(dec) : parseInt(hex, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

// An index often lists one archive in numbered parts (post-sitemap1..60) next
// to a handful of other kinds. A positional spread over 61 children can skip
// the lone page-sitemap, so order one of each kind first, then the rest
// spread. Kind = the URL minus digit runs and hash tokens (TYPO3's cHash).
export function orderSitemaps(urls) {
  const firstOfKind = new Map();
  for (const url of urls) {
    const kind = url.replace(/[0-9a-f]{8,}/gi, "").replace(/\d+/g, "");
    if (!firstOfKind.has(kind)) firstOfKind.set(kind, url);
  }
  const ordered = new Set(spreadPick([...firstOfKind.values()], firstOfKind.size));
  for (const url of spreadPick(urls, urls.length)) ordered.add(url);
  return { ordered: [...ordered], kinds: firstOfKind.size };
}

// Order a list so every prefix is spread across it: 0, ½, ¼, ¾, ⅛, … Cutting
// the result anywhere still samples the whole list rather than its head.
export function spreadPick(list, n) {
  const count = Math.min(n, list.length);
  const out = [];
  const taken = new Set();
  const take = (idx) => {
    if (!taken.has(idx)) {
      taken.add(idx);
      out.push(list[idx]);
    }
  };
  if (count > 0) take(0);
  // Once 2·step exceeds the list length every index has been hit, so this ends.
  for (let step = 1; out.length < count; step *= 2) {
    for (let k = 1; k < 2 * step && out.length < count; k += 2) take(Math.floor((k * list.length) / (2 * step)));
  }
  return out;
}

// Body as text, or null on any failure. The timeout covers the body too: a
// stalled sitemap body would otherwise hang discovery with no output.
async function fetchText(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Pages with these path segments are more likely to have video content.
// orderQueue moves such a URL up in its section (see there).
const VIDEO_LIKELY_PATHS = [
  /video/i, /media/i, /blog/i, /nieuws/i, /news/i, /podcast/i,
  /over-/i, /about/i, /campagne/i, /campaign/i, /verhaal/i, /story/i,
  /werkenbij/i, /careers/i, /evenement/i, /event/i, /webinar/i,
  /academy/i, /training/i, /demo/i, /tutorial/i, /case/i,
];

// Section = first path segment under which the page sits. A top-level page
// (/contact, /nieuws itself) has no section of its own and shares "". A
// language prefix (segmentLang) is not a section: /nl/wonen and /nl/nieuws are two.
export function urlSection(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { section: "", depth: 0, path: "" };
  }
  let segs = u.pathname.split("/").filter(Boolean);
  if (segs.length && segmentLang(segs[0])) segs = segs.slice(1);
  return { section: segs.length > 1 ? segs[0].toLowerCase() : "", depth: segs.length, path: u.pathname + u.search };
}

// FNV-1a: a stable pseudo-random rank, so the order within a section depends
// only on the URL — never on the queue order it arrived in. Reordering every
// batch must converge, not reshuffle.
function hashUrl(url) {
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) h = Math.imul(h ^ url.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

// The queue is re-ordered after every batch, so parse each URL once, not once
// per batch. Once full it stops growing instead of clearing: a crawl past the
// cap re-parses only its excess, where clearing would re-parse everything on
// every batch.
const urlMetaCache = new Map();
const URL_META_CACHE_MAX = 500_000;

function urlMeta(url) {
  let meta = urlMetaCache.get(url);
  if (!meta) {
    const { section, depth, path } = urlSection(url);
    // The path, not the host: on media.x.nl every URL would match, which
    // makes the weight meaningless
    meta = { section, depth, hash: hashUrl(url), weight: VIDEO_LIKELY_PATHS.some((p) => p.test(path)) ? 2 : 1 };
    if (urlMetaCache.size < URL_META_CACHE_MAX) urlMetaCache.set(url, meta);
  }
  return meta;
}

// Order the queue so a capped crawl samples every section of the site instead
// of spending its whole budget in one. A URL's rank is roughly how many pages
// its section will have had scanned when its turn comes; lowest rank goes
// first, so under-sampled sections catch up. A video-likely URL's rank is
// halved, which moves it up. Within a section: hub pages before deep ones,
// then a hash-spread sample rather than the first N of a 5,000-item archive.
export function orderQueue(urls, visited = []) {
  const scanned = new Map();
  for (const url of visited) {
    const { section } = urlMeta(url);
    scanned.set(section, (scanned.get(section) || 0) + 1);
  }
  const items = [];
  const buckets = new Map();
  for (const url of urls) {
    const { section, depth, hash, weight } = urlMeta(url);
    const item = { url, depth, hash, weight, rank: 0 };
    items.push(item);
    const bucket = buckets.get(section);
    if (bucket) bucket.push(item);
    else buckets.set(section, [item]);
  }
  for (const [section, bucket] of buckets) {
    bucket.sort((a, b) => a.depth - b.depth || a.hash - b.hash);
    const base = scanned.get(section) || 0;
    for (let i = 0; i < bucket.length; i++) bucket[i].rank = (base + i) / bucket[i].weight;
  }
  items.sort((a, b) => a.rank - b.rank || b.weight - a.weight || a.depth - b.depth || a.hash - b.hash);
  return items.map((item) => item.url);
}

// Reorder the crawl queue in place. Not `queue.splice(0, n, ...ordered)`: a
// spread passes every URL as a call argument and V8 overflows the stack near
// 125k — which killed three Tilburg crawls the moment their queue got there.
export function reprioritizeQueue(queue, visited = []) {
  const ordered = orderQueue(queue, visited);
  for (let i = 0; i < ordered.length; i++) queue[i] = ordered[i];
}

// Re-sort the queue, then put the rate-limited URLs in front. They are held
// out until after the sort, which would otherwise file them back under their
// section, where a capped crawl may never reach them.
export function rebalanceQueue(queue, visited, retryNext) {
  reprioritizeQueue(queue, visited);
  queue.unshift(...retryNext);
  retryNext.length = 0;
}

// Queue bound. A site that mints URLs faster than the crawl scans them grows
// the queue until something gives: www.ha-meer.nl reached 600,778 queued URLs
// of ~880 characters, a 537 MB checkpoint and a dead process. The largest
// queue a scan in history ended with is 56,679; the crawls that got past
// 100,000 queued were all filter mazes (ha-meer, and the three Tilburg sites
// at ~125,000).
const MAX_QUEUE = 100_000;

// Cut a freshly sorted queue back to `max`. The tail goes: the lowest-ranked
// URLs, which a capped crawl reaches last or never. A dropped URL also leaves
// queuedSet, so the next link to it queues and ranks it again, and the meta
// cache, which would otherwise keep its string alive. Returns how many went.
export function capQueue(queue, queuedSet, max = MAX_QUEUE) {
  const dropped = queue.length - max;
  if (dropped <= 0) return 0;
  for (let i = max; i < queue.length; i++) {
    queuedSet.delete(queue[i]);
    urlMetaCache.delete(queue[i]);
  }
  queue.length = max;
  return dropped;
}

export const CONSENT_SELECTORS = [
  "#onetrust-accept-btn-handler",
  "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
  // Cookiebot's newer dialog: stedelijk.nl, labelled "Allow all" in an English browser
  "#CybotCookiebotDialogBodyButtonAccept",
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

async function acceptCookies(page) {
  for (const sel of CONSENT_SELECTORS) {
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

// Request listener that records every URL except the page's own main-frame
// navigations (the crawled URL and its redirects). Those name the page, not
// anything it loads: ngf.nl has a page whose path contains youtube.com/watch,
// which the bare /youtube\.com/ script pattern read as a YouTube player. Iframe
// navigations stay — those are the embeds.
export function recordSubresource(page, networkRequests) {
  return (req) => {
    let ownNavigation = false;
    // frame() throws for a service-worker request; that one is never ours.
    try {
      ownNavigation = req.isNavigationRequest() && req.frame() === page.mainFrame();
    } catch {}
    if (!ownNavigation) networkRequests.push(req.url());
  };
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

// A block page says what it is in its text, not in the URLs it carries: the 403
// page of meer-vitaal.nl (LiteSpeed, no WAF) pulls jQuery from
// cdnjs.cloudflare.com and read as a Cloudflare block, which put the whole
// crawl in back-off for 145 filter URLs.
const ABSOLUTE_URL = /(?:https?:)?\/\/[^\s"'<>)]+/gi;

export function detectResponseRateLimit(response, html) {
  if (!response) return 'null response (blocked)';
  const status = response.status();
  if (status === 429) return `HTTP 429`;
  if ((status === 403 || status === 503) && html) {
    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1] : '';
    const head = html.replace(ABSOLUTE_URL, '').slice(0, 5000);
    for (const p of WAF_TITLE_PATTERNS) {
      if (p.test(title) || p.test(head)) {
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

// With the response for a block page: a 403 can also be the site refusing this
// one URL, which the crawl loop tells apart (see createRefusalTracker). A 403
// that names a Retry-After is a rate limit by its own account.
export function createRateLimitError(reason, response) {
  const err = new Error(`Rate limited: ${reason}`);
  err._rateLimit = reason;
  err._refusable = response?.status() === 403 && !response.headers()['retry-after'];
  return err;
}

// Navigate resiliently. Tracker-heavy sites (e.g. ing.nl) keep the network busy
// indefinitely and never reach "networkidle", so a strict networkidle goto times
// out and the page is lost. Load on "domcontentloaded" (reliable) and then give
// the network a bounded, best-effort chance to settle so network-based player
// detection still benefits. Returns the navigation response (for rate-limit and
// redirect checks); connection errors still throw from the inner goto.
//
// Anubis (techaro) answers with a proof-of-work page that solves itself in JS
// and then reloads into the real site. Council sites run it (11 of the 348
// gemeente URLs, e.g. gemeenteraad.haarlemmermeer.nl), and a scan that read the
// challenge page saw one page and no links. Wait for the reload, then keep the
// Anubis cookies: every page gets a fresh context, and carrying them over saves
// solving the challenge again on each one.
const ANUBIS_SCRIPT = 'script[src*="/.within.website/"]';
let anubisCookies = [];
// What accepting the cookie banner on the first page added (cookies, plus the
// site's own localStorage for CMPs that keep consent there); seeded into every
// per-page context so the whole crawl browses with consent.
let consentState = null;
// The first page's banner was clicked (sovereignty meta; whether consent took
// is consentState: what the click left behind)
let consentAccepted = false;
// Sovereignty collector (sovereignty/collect.mjs), set by --mode sovereignty
let sovereignty = null;

const cookieKey = (c) => `${c.name}|${c.domain}|${c.path}|${c.value}`;

/** The cookies and localStorage entries that are new or changed after consent, or null. */
export function pickConsent(cookiesBefore, cookiesAfter, storageBefore, storageAfter) {
  const seen = new Set(cookiesBefore.map(cookieKey));
  const cookies = cookiesAfter.filter((c) => !seen.has(cookieKey(c)));
  const storage = Object.fromEntries(Object.entries(storageAfter).filter(([k, v]) => storageBefore[k] !== v));
  return cookies.length || Object.keys(storage).length ? { cookies, storage } : null;
}

function readLocalStorage(page) {
  return page.evaluate(() => Object.fromEntries(Object.entries(localStorage))).catch(() => ({}));
}

async function passAnubis(page, timeout) {
  const onChallenge = () => page.$(ANUBIS_SCRIPT).then(Boolean, () => true);
  if (!(await onChallenge())) return;
  const deadline = Date.now() + Math.max(30_000, timeout * 2);
  while (Date.now() < deadline && (await onChallenge())) {
    await sleep(1000);
    await page.waitForLoadState("domcontentloaded").catch(() => {});
  }
  anubisCookies = (await page.context().cookies().catch(() => [])).filter((c) => /anubis/i.test(c.name));
}

async function gotoResilient(page, url, timeout) {
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  await passAnubis(page, timeout);
  await page
    .waitForLoadState("networkidle", { timeout: Math.min(8000, timeout) })
    .catch(() => {});
  return response;
}

// Fresh context per page = fresh connection. Edges like ing.nl reset a reused
// HTTP/2 connection after a couple of requests, which would fail every later
// page in a shared context; a per-page context keeps the crawl working even
// when the IP is being rate-limited (one page-load fits one connection).
//
// Closed when the page is done, or at the deadline: goto has its own timeout,
// but page.content() and evaluate() don't, and a page that pins its main
// thread blocks them forever (an archief.amsterdam beeldbank page stalled a
// crawl for 5 hours). Closing the context rejects every pending call on it.
async function withScanContext(browser, deadlineMs, scan, contextOptions) {
  const context = await createScanContext(browser, contextOptions);
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`page took over ${Math.round(deadlineMs / 1000)}s`)), deadlineMs);
  });
  try {
    return await Promise.race([scan(context), deadline]);
  } finally {
    clearTimeout(timer);
    // A wedged page can stall close() too
    let closeTimer;
    await Promise.race([
      context.close().catch(() => {}),
      new Promise((r) => { closeTimer = setTimeout(r, 10_000); }),
    ]);
    clearTimeout(closeTimer);
  }
}

function scanOnePage(browser, url, timeout) {
  return withScanContext(browser, timeout * 6, (context) => scanPageIn(context, url, timeout));
}

const pagePath = (url) => url.split(/[?#]/)[0];

// activate: click "load video" placeholders (off for the pre-consent sample:
// that click is a visitor's choice). play: a player name — start it and keep
// what it loads (sovereignty play sample).
async function scanPageIn(context, url, timeout, { activate = true, play = null } = {}) {
  const page = await context.newPage();
  const networkRequests = [];
  page.on("request", recordSubresource(page, networkRequests));
  const capture = sovereignty ? startCapture(page) : null;

  let response;
  try {
    response = await gotoResilient(page, url, timeout);
  } catch (err) {
    const rlReason = detectConnectionRateLimit(err);
    await page.close();
    if (rlReason) throw createRateLimitError(rlReason);
    // A URL that serves a file download (e.g. .xbri report packages, some
    // extensionless /binaries/ document paths) isn't a page — skip, don't fail.
    if (/Download is starting/i.test(err?.message || "")) {
      return { detected: [], links: [], skippedReason: "download" };
    }
    throw err;
  }

  // Check response for WAF/rate limit pages
  const earlyHtml = await page.content();
  const rlReason = detectResponseRateLimit(response, earlyHtml);
  if (rlReason) {
    await page.close();
    throw createRateLimitError(rlReason, response);
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

  // A click-to-load placeholder often starts the video itself (autoplay=1):
  // the play window opens before it
  if (play && capture) capture.mark();

  // Click curated activation placeholders so deferred players hydrate
  let hydrated = false;
  if (activate) {
    const activated = await activatePlayButtons(page);
    for (const src of [...activated.scripts, ...activated.iframes]) {
      networkRequests.push(src);
    }
    hydrated = activated.iframes.length > 0;
  }
  if (play && capture) {
    const before = pagePath(page.url());
    await playVideos(page, DETECTORS[play], { click: !hydrated });
    // A click that left the page: what loaded next is not this player's media
    if (pagePath(page.url()) !== before) throw new Error(`play sample left the page for ${page.url()}`);
  }

  // Re-grab HTML after dynamic content has loaded
  const html = await page.content();
  const encoded = await extractEncodedMarkup(page);
  const shadow = await extractShadowDomMarkup(page);
  const corpus = [html, encoded, shadow].filter(Boolean).join("\n");
  const detected = await detectWithConsent(page, corpus, networkRequests);
  const links = await collectLinks(page);

  return { detected, links, status: response.status(), ...(capture ? { sov: await capture.snapshot() } : {}) };
}

// Filter controls rendered as links: each one adds a facet to the current URL,
// so following them crawls every combination. visitrijssenholten.nl queued
// 11,153 URLs like /alle-routes/rondwandeling/50-100km/5-10km after 1,832 pages,
// every one an <a role="checkbox" aria-checked>. Navigation links don't carry a
// checked state in practice, so the role or aria-checked alone marks the control.
const FILTER_CONTROL_ROLES = new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"]);

export function isFilterControl({ role, ariaChecked }) {
  // role may list fallbacks ("checkbox button"); only the first token is checked
  const primaryRole = (role || "").trim().split(/\s+/)[0].toLowerCase();
  return FILTER_CONTROL_ROLES.has(primaryRole) || ariaChecked != null;
}

// Links to crawl next, minus filter controls.
async function collectLinks(page) {
  const anchors = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href]"), (a) => ({
      href: a.href,
      role: a.getAttribute("role"),
      ariaChecked: a.getAttribute("aria-checked"),
    }))
  );
  return anchors.filter((a) => !isFilterControl(a)).map((a) => a.href);
}

// First page: accept cookies before scanning (re-navigates if cookies accepted)
// Twice the deadline: consent can mean a second goto, and its clicks run on
// Playwright's own 30s default. A first page cut off queues no links, which
// ends a crawl without a sitemap at one page.
function scanFirstPage(browser, url, timeout) {
  return withScanContext(browser, timeout * 12, (context) => scanFirstPageIn(context, url, timeout));
}

async function scanFirstPageIn(context, url, timeout) {
  const page = await context.newPage();
  const networkRequests = [];
  page.on("request", recordSubresource(page, networkRequests));
  const capture = sovereignty ? startCapture(page) : null;

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
    throw createRateLimitError(rlReason, response);
  }

  // Skip pages that redirected to a different domain
  try {
    if (didRedirectOffDomain(page, url)) {
      const dest = page.url();
      await page.close();
      return { detected: [], links: [], skippedReason: `redirect to ${new URL(dest).hostname}` };
    }
  } catch {}

  // What the site stored before the banner click, so that only what consent
  // added is carried over — not session, load-balancer or bot-manager cookies,
  // which would make every page one visitor again (see withScanContext).
  const cookiesBefore = await page.context().cookies().catch(() => []);
  const storageBefore = await readLocalStorage(page);
  if (await acceptCookies(page)) {
    consentAccepted = true;
    // The crawl record of this page is the consented reload; the page without
    // consent comes from the pre sample
    capture?.reset();
    await gotoResilient(page, url, timeout);
    // Re-check redirect after post-consent navigation
    try {
      if (didRedirectOffDomain(page, url)) {
        const dest = page.url();
        await page.close();
        return { detected: [], links: [], skippedReason: `redirect to ${new URL(dest).hostname}` };
      }
    } catch {}
    // Every later page gets a fresh context (see withScanContext), so without
    // this the consent lived on the first page only: agnietenhof.nl sends its
    // trailer embeds only to a consenting browser, and 510 pages scanned 0 video.
    const picked = pickConsent(
      cookiesBefore,
      await page.context().cookies().catch(() => []),
      storageBefore,
      await readLocalStorage(page),
    );
    consentState = picked && { ...picked, origin: new URL(page.url()).origin };
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
  const links = await collectLinks(page);

  return {
    detected,
    links,
    status: response.status(),
    ...(capture ? { sov: await capture.snapshot() } : {}),
  };
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

  // loadavg() is always 0 on Windows, which read as an idle machine however
  // busy it was. There, measure busy time across all cores since the last
  // call instead (0..1, the same scale as loadavg / cores).
  let lastCpuTimes = null;
  function cpuLoad() {
    if (os.platform() !== "win32") return (os.loadavg?.()[0] ?? 0) / cpuCount;
    let idle = 0;
    let total = 0;
    for (const { times } of os.cpus()) {
      idle += times.idle;
      total += times.user + times.nice + times.sys + times.irq + times.idle;
    }
    const prev = lastCpuTimes;
    lastCpuTimes = { idle, total };
    if (!prev || total <= prev.total) return 0;
    return 1 - (idle - prev.idle) / (total - prev.total);
  }

  function cleanup() {
    if (!heartbeatPath) return;
    try { unlinkSync(heartbeatPath); } catch {}
  }

  // Called once per batch. Returns nothing; mutates throttle.baseConcurrency
  // (and throttle.concurrency where it doesn't conflict with rate-limit floor).
  function proposeNext(throttle, hostname) {
    writeHeartbeat(throttle, hostname);

    // CPU load factor: 1.0 ≈ saturated; <0.7 = comfortable headroom.
    const loadFactor = Math.min(2, Math.max(0, cpuLoad()));

    // Pages spend most of their time waiting on the network, not the CPU, so
    // the budget allows three pages per core and lets the measured load pull
    // it back. With one page per core, ten scans got two pages each on an
    // idle 12-core machine.
    const softCap = Math.max(2, cpuCount * 3);
    const loadBudget = softCap * Math.max(0.25, 1.2 - loadFactor);

    const { total, peers = [] } = readPeers();
    const sameHost = peers.filter(p => p.hostname === hostname).length;
    // If multiple scans hit the same host, halve each scan's share to spread
    // the rate-limit budget. Different hosts split CPU evenly.
    const hostPenalty = sameHost > 1 ? sameHost : 1;
    const share = Math.max(2, Math.floor(loadBudget / total / hostPenalty));
    // One site still gets at most one page per core: the extra budget is for
    // many scans side by side, not for hitting a single host harder
    const target = Math.min(share, Math.max(2, cpuCount));

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

  // A first beat at start: the per-batch one first lands after the start page,
  // the sitemap step and the first crawl batch, and until then the scan looks
  // dead to anything that reads heartbeats to decide whether it still runs.
  return { proposeNext, cleanup, beat: writeHeartbeat };
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

// ── Access refusal vs rate limit ──────────────────────────────────
// A 403 block page means one of two things. The host is throttling the crawl
// (mauritshuis.nl: Cloudflare on every URL after the first page), and backing
// off is the answer. Or the site refuses that one URL to anyone
// (beeldengeluid.nl: Drupal's "Access denied" on 21 profile pages, three
// back-offs each, in a crawl of 2044 pages), and backing off only stalls the
// crawl.
//
// The rest of the host tells them apart. A refused URL is tried once more,
// REFUSAL_RECHECK_MS later and without throttling, and when it is refused the
// same way while the host serves other pages both times, it is that URL. The
// wait is what makes the second answer mean something: a rate limit that
// blocks part of the requests would repeat itself a moment later too. A retry
// that gets through shows that kind of 403 passes
// (oss.bestuurlijkeinformatie.nl: three Cloudflare 403s, all fine on retry),
// so from then on it is a rate limit again.
const REFUSAL_RECHECK_MS = 30_000;

// www and the bare domain are one host here, as they are in isSameDomain.
const hostOf = (url) => new URL(url).hostname.replace(/^www\./, "");

export function createRefusalTracker(now = Date.now) {
  const firstRefusal = new Map(); // url → { signature of the block page it got, due time of its retry }
  const waiting = []; // [{ url, due }], oldest first: refused once, retry not sent yet
  const transient = new Set(); // signatures a retry got past
  const controls = new Map(); // host → the last page it served
  // cf-ray differs per response
  const signatureOf = (reason) => reason.replace(/\s*\(cf-ray: [^)]*\)/, "");

  return {
    /** A page this host served, to ask for again when a batch holds only refusals. */
    controlUrl: (host) => controls.get(host) ?? null,
    /** A page loaded. Returns the refusal it got past, if it had been refused before. */
    pageLoaded(url) {
      controls.set(hostOf(url), url);
      const first = firstRefusal.get(url);
      if (!first) return null;
      firstRefusal.delete(url);
      transient.add(first.signature);
      return first.signature;
    },
    /** "retry" (later, unthrottled), "refused" (give the URL up) or "rate-limit" (back off). */
    judge(url, reason, hostOk) {
      const signature = signatureOf(reason);
      if (transient.has(signature)) {
        firstRefusal.delete(url);
        return "rate-limit";
      }
      if (!hostOk) return "rate-limit";
      const first = firstRefusal.get(url);
      if (first?.signature === signature) {
        // Seen again before its wait was over (a URL list naming it twice):
        // still the first answer, the retry is on its way
        if (now() < first.due) return "retry";
        firstRefusal.delete(url);
        return "refused";
      }
      // One unthrottled retry per URL. A block page whose title changes per
      // response would otherwise send the URL round forever; the rate-limit
      // path counts its retries.
      if (first) return "rate-limit";
      const due = now() + REFUSAL_RECHECK_MS;
      firstRefusal.set(url, { signature, due });
      waiting.push({ url, due });
      return "retry";
    },
    /** Up to `limit` URLs whose retry is due, oldest first. They stop waiting. */
    takeDue(limit = Infinity) {
      const due = [];
      while (due.length < limit && waiting.length > 0 && waiting[0].due <= now()) due.push(waiting.shift().url);
      return due;
    },
    /** The URLs still sitting out their wait. */
    waiting: () => waiting.map((w) => w.url),
  };
}

// A scan result that shows the host serving pages: not a redirect off the
// domain or a download, and not an error page that slipped past the WAF check.
const servedPage = (scan) => !scan.skippedReason && scan.status < 400;

// Loads a page the host served earlier in this crawl, without scanning it.
function hostServes(browser, url, timeout) {
  return withScanContext(browser, timeout * 2, async (context) => {
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    return Boolean(response) && response.status() < 400;
  }).catch((err) => {
    // Counts as "host does not serve", which backs off: the safe reading
    console.log(chalk.gray(`  control page ${truncate(url, 50)} did not load: ${String(err?.message).slice(0, 60)}`));
    return false;
  });
}

// Reads a batch before its failures are judged: did the host serve a page while
// it refused the others? Only this batch counts. A page from a few seconds ago
// says nothing once a block has started: on a test site that blocked everything
// after three pages, 16 URLs were written off on evidence 15 seconds old.
// A batch of nothing but refusals (filter URLs come in runs) has no such page,
// so `probe` asks the host for one it served before. Also while backing off:
// skipping the question there would file every refusal in the run as a rate
// limit, which extends the back-off, which skips the question again.
export async function weighBatch(refusals, throttle, batch, batchResults, probe) {
  let rateLimited = false;
  const serving = new Set(); // hosts that served a page in this batch
  const refusing = new Set(); // hosts with a 403 to judge
  batch.forEach((url, i) => {
    const result = batchResults[i];
    if (result.status === "rejected") {
      if (result.reason?._refusable) refusing.add(hostOf(url));
    } else if (servedPage(result.value)) {
      serving.add(hostOf(url));
      const cleared = refusals.pageLoaded(url);
      if (cleared) {
        onRateLimit(throttle, url, `${cleared}, gone on retry`);
        rateLimited = true;
      }
    }
  });

  for (const host of refusing) {
    const control = refusals.controlUrl(host);
    if (!serving.has(host) && control && (await probe(control))) serving.add(host);
  }
  return { hostOk: (url) => serving.has(hostOf(url)), rateLimited };
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
// consent: carry the first page's consent. block: skip images/media/fonts —
// off for the sovereignty samples, where an aborted pixel or <video> source
// sets no cookie and follows no redirect.
async function createScanContext(browser, { consent = true, block = true } = {}) {
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
  });
  await context.addInitScript(SHADOW_INIT_SCRIPT);
  if (block) await applyResourceBlocking(context);
  if (consent && consentState) {
    // A cookie Playwright rejects (expired mid-crawl) must not fail the page
    if (consentState.cookies.length) await context.addCookies(consentState.cookies).catch(() => {});
    if (Object.keys(consentState.storage).length) {
      await context.addInitScript(({ origin, storage }) => {
        if (location.origin !== origin) return;
        for (const [k, v] of Object.entries(storage)) try { localStorage.setItem(k, v); } catch {}
      }, consentState);
    }
  }
  if (anubisCookies.length) await context.addCookies(anubisCookies);
  return context;
}

/**
 * The rows of the report a --resume continues, under the URLs today's
 * normalizeUrl gives them. A report written before a rule existed lists one
 * page once per spelling (www.jiphaarlemmermeer.nl: four rows for one page,
 * three of them ?qt- variants). `visited` collapses on restore, and without
 * this the rows would not: the resumed report would list more pages with video
 * than the crawl counts as pages. A player joins the merged row once.
 */
export function restoreRows(details, startUrl) {
  const rows = new Map();
  for (const d of details) {
    const url = normalizeUrl(d.url, startUrl) || d.url;
    let row = rows.get(url);
    if (!row) rows.set(url, (row = { url, players: [] }));
    for (const p of d.players) {
      if (!row.players.some((known) => known.player === p.name)) row.players.push({ player: p.name, evidence: p.evidence });
    }
  }
  return [...rows.values()];
}

// Periodically persist crawl state so a long crawl killed mid-run (session
// teardown, OOM, Ctrl-C) can be continued with --resume. The shape matches what
// the resume path reads (_state.visited/queue + details). Written to a stable
// INPROGRESS name; deleted on clean completion (the final timestamped report
// supersedes it).
function checkpointPath(domain) {
  return `videoscan-${domain}-INPROGRESS.json`;
}

// writeSync may write less than it was given; a checkpoint cut short that way
// would be renamed into place as if it were whole
function writeAll(fd, text) {
  const buffer = Buffer.from(text);
  for (let offset = 0; offset < buffer.length;) offset += writeSync(fd, buffer, offset);
}

// One JSON array, an item per line, CHECKPOINT_CHUNK items per write
const CHECKPOINT_CHUNK = 1000;
function writeJsonArray(fd, items, indent) {
  let lines = [];
  let written = false;
  const flush = () => {
    if (lines.length === 0) return;
    writeAll(fd, (written ? ",\n" : "\n") + lines.join(",\n"));
    written = true;
    lines = [];
  };
  writeAll(fd, "[");
  for (const item of items) {
    lines.push(`${indent}  ${JSON.stringify(item)}`);
    if (lines.length >= CHECKPOINT_CHUNK) flush();
  }
  flush();
  writeAll(fd, written ? `\n${indent}]` : "]");
}

// Windows refuses to rename onto a file another process has open, and the orch
// server reads the checkpoint (sync, scan list) for a moment at a time. Wait
// that moment out rather than report a checkpoint as lost.
const RENAME_ATTEMPTS = 10;
const RENAME_RETRY_MS = 200;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function replaceFile(from, to, rename = renameSync, wait = sleepSync) {
  for (let attempt = 1; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      if (attempt >= RENAME_ATTEMPTS || !["EPERM", "EBUSY", "EACCES"].includes(err.code)) throw err;
      wait(RENAME_RETRY_MS);
    }
  }
}

// Written in pieces, never as one JSON.stringify of the whole state: that is a
// single string, and a V8 string ends at 536,870,888 characters. ha-meer.nl's
// checkpoint got to 536,824,765 bytes; every write after it threw, and the
// crawl that died four hours later was resumed from that one.
// Throws when the write fails — see createCheckpointSaver. Goes to a .tmp
// first, so a process killed halfway leaves the previous checkpoint, not half
// of a new one.
// coverage: the crawl's coverage flags (coverage.mjs). Stored, so the run that
// resumes from here still knows links were dropped before it.
export function writeCheckpoint(domain, results, visited, queue, { file = checkpointPath(domain), coverage = {}, extra = {} } = {}) {
  const details = results
    .filter((r) => r.players.length > 0)
    .map((r) => ({ url: r.url, players: r.players.map((p) => ({ name: p.player, evidence: p.evidence })) }));
  const head = JSON.stringify(
    {
      domain,
      checkpoint: true,
      scanDate: new Date().toISOString(),
      pagesScanned: visited.size,
      ...coverageFlags(coverage),
      ...extra,
    },
    null,
    2,
  );
  const tmp = `${file}.tmp`;
  try {
    const fd = openSync(tmp, "w");
    try {
      writeAll(fd, `${head.slice(0, -2)},\n  "_state": {\n    "visited": `);
      writeJsonArray(fd, visited, "    ");
      writeAll(fd, `,\n    "queue": `);
      writeJsonArray(fd, queue, "    ");
      writeAll(fd, `\n  },\n  "details": `);
      writeJsonArray(fd, details, "  ");
      writeAll(fd, "\n}\n");
    } finally {
      closeSync(fd);
    }
    replaceFile(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* never created, or already renamed */ }
    throw err;
  }
}

// Progress line + checkpoint interval. VIDEOSCAN_PROGRESS_MS shortens it for
// coverage.test.mjs, which needs a checkpoint within seconds, not 30 (0 or
// unset means 30 s; use 1 for every batch).
const PROGRESS_MS = Number(process.env.VIDEOSCAN_PROGRESS_MS) || 30_000;

// The checkpoint stays best-effort — a crawl is not stopped over it — but not
// silent: ha-meer.nl's failed for four hours behind an empty catch. The first
// failure is said once, loudly, and so is the first write that works again;
// the ones in between would only bury it. Returns whether the checkpoint is
// saved, for the progress line: one line scrolls out of a task's output.
export function createCheckpointSaver(write = writeCheckpoint, log = console.log) {
  let failing = false;
  return (...state) => {
    try {
      write(...state);
      if (failing) log(chalk.green("  ✓ Checkpoint saved again"));
      failing = false;
    } catch (err) {
      if (!failing) {
        log(chalk.red.bold(`  ✗ CHECKPOINT NOT SAVED: ${err.message} — a crash from here on resumes from the last one that was; the next checkpoint tries again`));
      }
      failing = true;
    }
    return !failing;
  };
}

async function crawlSite(startUrl, { maxPages = 50, timeout = 15000, resumeFile = null, concurrency = DEFAULT_CONCURRENCY, delay = 200, sitemap = true, maxSitemapUrls = 5000, controlFile = null, maxQueue = MAX_QUEUE, mode = null, seeds = [] } = {}) {
  let browser = await launchScanBrowser();
  // Recycle the whole browser process every N pages. Over a long crawl the
  // single browser accumulates state (and Chrome's DNS resolver can degrade,
  // surfacing as ERR_NAME_NOT_RESOLVED) — a periodic relaunch bounds that.
  const RECYCLE_EVERY = 400;
  let pagesSinceRecycle = 0;

  const baseUrl = new URL(startUrl);
  const domain = baseUrl.hostname.replace(/^www\./, "");
  let prevSovereignty = null;
  let visited = new Set();
  let queue = [normalizeUrl(startUrl, startUrl)];
  let results = [];

  const throttle = createThrottleState(delay, concurrency);
  const autoTuner = createAutoTuner(controlFile);
  const refusals = createRefusalTracker();
  const retryCount = new Map();
  const MAX_RETRIES = 2;
  // The queue bound has dropped URLs, in this run or the one it resumes: the
  // queue is a sample of what the site links, and "queue empty" no longer
  // means "site covered"
  let queueFull = false;
  // Coverage flags of the file this run resumes (coverage.mjs). The links they
  // stand for are in no queue: a resume that runs dry would otherwise rewrite
  // the file as a crawl that covered the site.
  let carried = {};
  // What the report and the checkpoint say: carried over, plus this run's bound
  const coverage = () => ({ ...carried, ...(queueFull ? { queueCapped: true } : {}) });

  // Resume from previous scan state
  if (resumeFile) {
    const prev = JSON.parse(readFileSync(resumeFile, "utf-8"));
    carried = coverageFlags(prev);
    prevSovereignty = prev.sovereignty || null;
    queueFull = carried.queueCapped === true;

    // `visited` is normalized with the same function as the queue below. Both
    // sides of the "have I seen this?" test have to speak one spelling: a URL
    // stored as visited under ?from=162&from=162 would otherwise never match its
    // restored, collapsed form and would be crawled a second time, inflating
    // pagesScanned and making the coverage figure incomparable to the run before
    // the pause.
    const normalizeAll = (urls) => {
      const out = new Set();
      for (const u of urls) {
        const n = normalizeUrl(u, startUrl);
        if (n) out.add(n);
      }
      return out;
    };

    if (prev._state?.visited?.length) {
      visited = normalizeAll(prev._state.visited);
    } else {
      const allUrls = [];
      for (const d of prev.details || []) allUrls.push(d.url);
      for (const [, data] of Object.entries(prev.playerSummary || {})) {
        for (const p of data.pages || []) allUrls.push(p);
      }
      visited = normalizeAll(allUrls);
    }

    const storedQueue = prev._state?.queue || [];
    const restored = restoreQueue(storedQueue, startUrl);
    const dropped = storedQueue.length - restored.length;
    if (dropped > 0) {
      console.log(
        chalk.yellow(`  Dropped ${dropped} queued URL(s): the crawl now skips them, or duplicates`),
      );
    }
    // Say so out loud when the filter took everything, and resume nothing: the
    // start-URL fallback below is for a queue that was empty to begin with. The
    // resume endpoint seeds https://www.<domain>, which a non-www host never
    // visited, so falling back here would crawl one stray page.
    if (storedQueue.length > 0 && restored.length === 0) {
      console.log(chalk.yellow("  Every queued URL is one the crawl now skips — nothing left to resume"));
    }
    queue = restored.length || storedQueue.length ? restored : [normalizeUrl(startUrl, startUrl)];

    results = restoreRows(prev.details || [], startUrl);
    // A Set, not results.find per URL: that was O(visited x details), 15s on a
    // 35k-page resume. The rows are normalized like `visited` (restoreRows), or
    // a detail stored under ?x=1&x=1 gets a second, player-less row under its
    // collapsed form.
    const known = new Set(results.map((r) => r.url));
    for (const v of visited) {
      if (!known.has(v)) results.push({ url: v, players: [] });
    }

    // maxPages is additive when resuming: scan N more pages beyond what's already visited
    maxPages = visited.size + maxPages;

    console.log(chalk.yellow(`\nResuming scan of ${domain}`));
    console.log(chalk.yellow(`Previously scanned: ${visited.size} pages, Queue: ${queue.length} URLs`));
  } else {
    console.log(chalk.blue(`\nStarting scan of ${domain}`));
  }
  console.log(chalk.gray(`Max pages: ${maxPages}, Timeout per page: ${timeout}ms, Concurrency: ${concurrency}, Delay: ${delay}ms\n`));
  if (mode === "sovereignty") {
    sovereignty = createSovereigntyCollector({ domain, detectors: DETECTORS, prev: prevSovereignty });
    console.log(chalk.gray(`  Sovereignty mode: every player per page, requests/cookies/storage per consent phase${seeds.length ? `, ${seeds.length} seed page(s) first` : ""}`));
  }
  // After the resume parse: a corrupt resume file must not leave a heartbeat
  // behind that reads as a live scan.
  autoTuner.beat(throttle, domain);

  setupInterruptHandler();

  // Rate-limited URLs waiting for rebalanceQueue to put them in front
  const retryNext = [];

  // Accept cookies on first page before parallel scanning
  const firstUrl = queue.shift();
  if (firstUrl && !visited.has(firstUrl)) {
    visited.add(firstUrl);
    process.stdout.write(
      chalk.gray(`[${visited.size}/${maxPages}] `) + chalk.white(truncate(firstUrl, 80)) + " "
    );
    try {
      const first = await scanFirstPage(browser, firstUrl, timeout);
      const { detected, links, skippedReason } = first;
      if (servedPage(first)) refusals.pageLoaded(firstUrl);
      if (skippedReason) {
        console.log(chalk.yellow(`  ⤳ skipped (${skippedReason})`));
      } else if (detected.length > 0) {
        console.log(chalk.green(`  [${detected.map((d) => d.player).join(", ")}]`));
      } else {
        console.log(chalk.gray("  -"));
      }
      console.log(chalk.gray(consentState
        ? `  Cookie consent carried to every page (${consentState.cookies.length} cookie(s))`
        : "  No cookie consent captured — later pages are scanned without it"));
      results.push({ url: firstUrl, players: detected });
      if (sovereignty) {
        sovereignty.setConsent({ accepted: consentAccepted, given: Boolean(consentState), cookies: consentState?.cookies.length || 0 });
        sovereignty.recordPage({ url: firstUrl, phase: "crawl", players: detected, capture: first.sov });
      }

      // A Set: header and footer both link /contact, and the re-sort puts
      // identical URLs side by side, so both copies would land in one batch
      const newLinks = new Set();
      // A site that exists only under a language prefix (root redirects to
      // /en/, no Dutch version) gives no page to follow once translations are
      // skipped, so note the first copy to say so below. A link back to the
      // start URL doesn't count: it may be the one that redirected.
      let crawlable = false;
      let translatedCopy = null;
      for (const link of links) {
        const norm = normalizeUrl(link, firstUrl);
        if (!norm || norm === firstUrl || !isSameDomain(norm, domain)) continue;
        if (shouldSkipUrl(norm, startUrl)) {
          if (!translatedCopy && isTranslatedCopy(norm, startUrl)) translatedCopy = norm;
          continue;
        }
        crawlable = true;
        if (!visited.has(norm) && !queue.includes(norm)) newLinks.add(norm);
      }
      for (const link of newLinks) queue.push(link);
      if (!crawlable && translatedCopy) {
        const copy = new URL(translatedCopy);
        const segment = copy.pathname.split("/")[1];
        console.log(
          chalk.yellow(`  First page links only to translated copies (/${segment}/…), which are skipped; to scan that language, start at ${copy.origin}/${segment}/`),
        );
      }
    } catch (err) {
      if (err._rateLimit) {
        onRateLimit(throttle, firstUrl, err._rateLimit);
        visited.delete(firstUrl);
        retryNext.push(firstUrl);
        console.log(chalk.yellow(`  ⚠ First page rate-limited, will retry`));
      } else {
        console.log(chalk.red(`  ERROR: ${err.message.slice(0, 60)}`));
        results.push({ url: firstUrl, players: [], error: err.message });
      }
    }
  }

  // Parallel crawl loop
  const queuedSet = new Set([...queue, ...retryNext]);
  // Pages an earlier scan found video on: scanned before the queue, so a
  // capped quick scan covers them (sovereignty mode). Held out of the queue,
  // whose re-sort would file them back under their section.
  // At most 80% of the pages: the crawl still explores, and the pre sample
  // gets pages without video too.
  const seedQueue = [];
  const maxSeeds = Math.floor(maxPages * 0.8);
  for (const u of seeds) {
    if (seedQueue.length >= maxSeeds) break;
    const norm = normalizeUrl(u, startUrl);
    if (norm && !visited.has(norm) && isSameDomain(norm, domain) && !shouldSkipUrl(norm, startUrl) && !seedQueue.includes(norm)) seedQueue.push(norm);
  }
  for (const u of seedQueue) queuedSet.add(u);

  // Seed queue from sitemap (skip when resuming — already in state)
  if (sitemap && !resumeFile) {
    const sitemapUrls = await discoverSitemapUrls(startUrl, domain, { maxUrls: maxSitemapUrls }).catch((err) => {
      // Fetch failures already come back empty, so this is a bug: say so
      // rather than report it as "none found"
      console.log(chalk.yellow(`  Sitemap: discovery failed: ${err.message}`));
      return [];
    });
    let added = 0;
    for (const u of sitemapUrls) {
      if (!visited.has(u) && !queuedSet.has(u)) {
        queuedSet.add(u);
        queue.push(u);
        added++;
      }
    }
    if (added > 0) {
      console.log(chalk.gray(`  Sitemap: ${sitemapUrls.length} URLs found, ${added} new added to queue`));
    } else if (sitemapUrls.length === 0) {
      console.log(chalk.gray(`  Sitemap: none found (or unreachable)`));
    }
  }
  // Said once, when the bound first bites; no count, the first trim is not
  // the total
  const trimQueue = () => {
    if (capQueue(queue, queuedSet, maxQueue) > 0 && !queueFull) {
      queueFull = true;
      console.log(chalk.yellow.bold(`  ⚠ QUEUE FULL: more than ${maxQueue} URLs queued, the lowest-ranked are dropped from here on — check the queue for a filter or calendar maze`));
    }
  };
  const saveCheckpoint = createCheckpointSaver();
  let checkpointSaved = true;

  // Also re-sorts a resumed queue, stored in whatever order the last run left it
  rebalanceQueue(queue, visited, retryNext);
  trimQueue();

  let batchNum = 0;
  let lastProgressAt = Date.now();
  const scanStartTime = Date.now();
  // Baseline of pages already scanned at the moment this run begins.
  // Used to keep pages/min and ETA accurate after a resume — without this,
  // we'd divide *all* visited pages (including pre-resume ones) by *this run's* elapsed time.
  const resumeBaseline = visited.size;

  while ((queue.length > 0 || seedQueue.length > 0 || refusals.waiting().length > 0) && visited.size < maxPages && !interrupted) {
    // Inter-batch delay (skip first batch)
    if (batchNum > 0 && throttle.delay > 0) {
      await sleep(throttle.delay);
    }
    batchNum++;

    // Apply live control-file overrides (concurrency/delay) before sizing batch
    applyControlFile(throttle, controlFile);

    // Grab a batch of URLs to scan in parallel (use throttle.concurrency).
    // Refused URLs whose wait is over go first, and straight into the batch:
    // through the queue, the re-sort below would file the ones that don't fit
    // back under their section (see rebalanceQueue).
    const batch = refusals.takeDue(Math.min(throttle.concurrency, maxPages - visited.size));
    while (batch.length < throttle.concurrency && (seedQueue.length > 0 || queue.length > 0) && visited.size + batch.length < maxPages) {
      const url = seedQueue.length > 0 ? seedQueue.shift() : queue.shift();
      if (!url || visited.has(url)) continue;
      batch.push(url);
    }
    if (batch.length === 0) {
      if (refusals.waiting().length === 0) break;
      // Nothing left but refused URLs sitting out their wait
      autoTuner.beat(throttle, domain);
      await sleep(1000);
      continue;
    }

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
    const weighed = await weighBatch(refusals, throttle, batch, batchResults, (control) => hostServes(browser, control, timeout));
    let batchHadRateLimit = weighed.rateLimited;
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
        sovereignty?.recordPage({ url, phase: "crawl", players: detected, capture: result.value.sov });

        // Add discovered links to queue
        for (const link of links) {
          const norm = normalizeUrl(link, url);
          if (norm && !visited.has(norm) && !queuedSet.has(norm) && isSameDomain(norm, domain) && !shouldSkipUrl(norm, startUrl)) {
            queuedSet.add(norm);
            queue.push(norm);
          }
        }
      } else {
        const err = result.reason;
        const errMsg = err?.message || "Unknown error";

        const verdict = err?._refusable ? refusals.judge(url, err._rateLimit, weighed.hostOk(url)) : null;
        if (verdict === "refused") {
          console.log(chalk.red(`  ✗ ${truncate(url, 65)}  access refused, other pages load`));
          results.push({ url, players: [], error: `Access refused: ${err._rateLimit}` });
        } else if (verdict === "retry") {
          console.log(chalk.gray(`  ↻ ${truncate(url, 65)}  ${err._rateLimit}, one retry in ${REFUSAL_RECHECK_MS / 1000}s`));
          visited.delete(url);
        } else if (err?._rateLimit) {
          batchHadRateLimit = true;
          onRateLimit(throttle, url, err._rateLimit);
          visited.delete(url);
          const retries = retryCount.get(url) || 0;
          if (retries < MAX_RETRIES) {
            retryCount.set(url, retries + 1);
            retryNext.push(url);
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

    // Re-balance after each batch: new links join their section, and the
    // sections just scanned drop back behind the ones still under-sampled.
    // Before the checkpoint, so it stores the sorted queue and the retries.
    rebalanceQueue(queue, visited, retryNext);
    trimQueue();

    // Recovery check: if no rate limits this batch and cooldown expired
    if (!batchHadRateLimit && throttle.rateLimitHits > 0) {
      tryRecover(throttle);
    }
    autoTuner.proposeNext(throttle, domain);

    // Progress stats every 30s. The dashboard parses this line up to "min left"
    // and its auto-conc part (videoscan-progress.ts): anything new goes last.
    if (Date.now() - lastProgressAt > PROGRESS_MS) {
      const elapsed = (Date.now() - scanStartTime) / 60_000;
      const newlyScanned = visited.size - resumeBaseline;
      const ppm = elapsed > 0 ? (newlyScanned / elapsed).toFixed(1) : "0.0";
      const remaining = Math.min(queue.length, maxPages - visited.size);
      const etaMin = ppm > 0 ? (remaining / ppm).toFixed(1) : "?";
      console.log(chalk.cyan(`  ── ${ppm} pages/min | queue=${queue.length} | ~${etaMin}min left | delay=${throttle.delay}ms | auto-conc=${throttle.concurrency} (base=${throttle.baseConcurrency})${queueFull ? " | queue full" : ""}${checkpointSaved ? "" : " | checkpoint NOT saved"}`));
      lastProgressAt = Date.now();
      checkpointSaved = saveCheckpoint(domain, results, visited, [...refusals.waiting(), ...seedQueue, ...queue], {
        coverage: coverage(),
        // A resume from the checkpoint stays a sovereignty scan, with its crawl data
        ...(sovereignty ? { extra: { mode: "sovereignty", sovereignty: sovereignty.toJSON() } } : {}),
      });
    }

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

  // Stopped (page cap, pause) before their retry: back in the queue, so a
  // resume asks again instead of losing them. Unscanned seeds too.
  queue.unshift(...refusals.waiting(), ...seedQueue);
  if (queueFull) {
    console.log(chalk.yellow(`  Queue was full (bound ${maxQueue}): URLs were dropped unscanned, so this crawl did not cover the site`));
  }

  // A paused scan skips them: the resume redoes the samples (collect.mjs).
  // A failure here must not cost the crawl its report.
  if (sovereignty && !interrupted) {
    await runSovereigntySamples(browser, results, normalizeUrl(startUrl, startUrl), timeout).catch((err) => {
      console.log(chalk.red(`  Sovereignty samples failed: ${err.message}`));
    });
  }

  await browser.close();
  autoTuner.cleanup();
  const sovereigntyJson = sovereignty && (await finishSovereignty());
  try { unlinkSync(checkpointPath(domain)); } catch { /* no checkpoint to clean */ }
  // Left by an earlier run of this domain that was killed mid-write
  try { unlinkSync(`${checkpointPath(domain)}.tmp`); } catch { /* none */ }

  return {
    domain,
    results,
    pagesScanned: visited.size,
    _state: { visited: [...visited], queue },
    rateLimits: buildRateLimits(throttle),
    coverage: coverage(),
    ...(sovereigntyJson ? { sovereignty: sovereigntyJson } : {}),
  };
}

// ── Sovereignty passes ──────────────────────────────────────────────

// Some edges refuse the bundled Chromium outright (ing.be: every load
// ERR_HTTP2_PROTOCOL_ERROR, the scan browser loads the same page fine). The
// page load reports that as a connection "rate limit", so go by the message: an
// HTTP 429 or a page that left is not the browser's doing, and gets no second try.
export const isBrowserRefusal = (err) => /ERR_(HTTP2|QUIC|SSL|CONNECTION)/.test(err?.message || "");

// After the crawl: re-load a sample without consent (what leaks before the
// banner is answered), and start each player type on a few pages (the media
// path only shows on play). When no consent took, the crawl itself ran
// without it, so the pre pass would repeat it.
async function runSovereigntySamples(browser, results, startUrl, timeout) {
  const { pre, play } = pickSamples(results, startUrl);
  const preJobs = consentState ? pre.map((url) => ({ url, phase: "pre" })) : [];
  const playJobs = play.flatMap(({ player, urls }) => urls.map((url) => ({ url, phase: "play", player })));
  const jobs = [...preJobs, ...playJobs];
  if (!jobs.length) return;
  console.log(chalk.blue(`\n  Sovereignty samples: ${preJobs.length} page(s) without consent, ${playJobs.length} play sample(s)`));
  // Play runs in the bundled Chromium: in headless Chrome the YouTube embed
  // ignores the click and loads no video (checked 2026-10-16), so the media
  // path would stay unseen
  let playBrowser = browser;
  if (playJobs.length) {
    playBrowser = await chromium.launch({ headless: true }).catch((err) => {
      console.log(chalk.yellow(`  Bundled Chromium unavailable (${err.message.split("\n")[0]}): play samples run in the scan browser`));
      return browser;
    });
  }
  const failures = [];
  let next = 0;
  const loadSample = (job, sampleBrowser) => withScanContext(
    sampleBrowser,
    timeout * 6,
    (ctx) => scanPageIn(ctx, job.url, timeout, job.phase === "pre" ? { activate: false } : { play: job.player }),
    { consent: job.phase !== "pre", block: false },
  );
  async function worker() {
    while (next < jobs.length && !interrupted) {
      const job = jobs[next++];
      try {
        const r = await (job.phase === "play" ? loadSample(job, playBrowser) : loadSample(job, browser)).catch((err) => {
          if (job.phase !== "play" || playBrowser === browser || interrupted || !isBrowserRefusal(err)) throw err;
          console.log(chalk.gray(`  Play sample retried in the scan browser (${err.message.split("\n")[0]}): ${job.url}`));
          return loadSample(job, browser);
        });
        if (!r.sov) continue; // skipped (download, off-domain redirect)
        if (job.phase === "pre") {
          sovereignty.recordPage({ url: job.url, phase: "pre", players: r.detected, capture: r.sov });
        } else {
          // Only what the play start loaded; the page load itself is the crawl's
          sovereignty.recordPage({
            url: job.url,
            phase: "play",
            players: r.detected,
            capture: { ...r.sov, requests: r.sov.requests.filter((q) => q.play) },
          });
        }
      } catch (err) {
        failures.push({ url: job.url, phase: job.phase, error: String(err?.message || err).split("\n")[0].slice(0, 200) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker));
  if (playBrowser !== browser) await playBrowser.close().catch(() => {});
  sovereignty.setSampleFailures(failures);
  if (failures.length) {
    console.log(chalk.yellow(`  ${failures.length} sample page(s) failed to load`));
    for (const f of failures) console.log(chalk.gray(`    ${f.phase} ${f.url}: ${f.error}`));
  }
}

async function finishSovereignty() {
  const hosts = sovereignty.hosts();
  console.log(chalk.gray(`  Resolving ${hosts.length} host(s) to their operators...`));
  try {
    return sovereignty.toJSON(await resolveHosts(hosts, { asnDb: await loadAsnDb() }));
  } catch (err) {
    console.log(chalk.red(`  Host resolution failed (${err.message}): hosts saved unresolved`));
    return sovereignty.toJSON();
  }
}

// Strip <a href="..."> values so player-domain regexes don't match link
// targets. Anchors are navigation, not embeds.
// The second pass covers the JSON-escaped copy a Next.js payload carries
// (`\u003ca href=\"…\"`): capelleaandenijssel.nl linked to a cbr.bbvms.com
// video that way and was flagged as Blue Billywig.
// The scan between opener and href stops at the next \u003c/\u003e, so an
// unclosed opener can neither reach into the next tag nor go quadratic; href
// must follow whitespace (not data-href); \\\" covers HTML inside a JSON prop.
const ESCAPED_ANCHOR_HREF =
  /(\\u003ca(?:\s|\\[nrt])(?:(?!\\u003[ce]).)*?)(?<=\s|\\[nrt])href\s*=\s*(?:\\\\)*\\"[^"]*?(?:\\\\)*\\"/gi;
// A CMS link object in the payload is the same anchor before rendering:
// louwmanmuseum.nl's "video op YouTube bekijken" link is also
// `"externalLink":{"value":"https://www.youtube.com/embed/…"}`, and a page with
// no player graded the whole site E.
const JSON_LINK_OBJECT = /"externalLink\\*"\s*:\s*\{[^{}<]*\}/g;
function stripAnchorHrefs(html) {
  return html
    .replace(/(<a\b[^>]*?)\s+href\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "$1")
    .replace(ESCAPED_ANCHOR_HREF, "$1")
    .replace(JSON_LINK_OBJECT, "");
}

// Strip IE downlevel-hidden conditional comments (`<!--[if ...]> ... <![endif]-->`).
// Their content is only parsed by IE ≤9 and never renders in the scan's Chromium,
// but the DOM serializer keeps the whole block as inert comment text — so a
// `<video>`/`<source>` inside an IE fallback (e.g. asnbank.nl) would otherwise
// falsely trigger the "HTML5 native" detector.
//
// The negative lookahead skips downlevel-*revealed* comments, where the opener
// ends with `<!-->` (e.g. the html5-boilerplate `<!--[if gt IE 8]><!--> … <!--<![endif]-->`):
// there the inner content renders for non-IE, so it must be left in the corpus.
function stripDownlevelConditionals(html) {
  return html.replace(/<!--\[if\b[^\]]*\]>(?!\s*<!-->)[\s\S]*?<!\[endif\]-->/gi, "");
}

// Strip host lists that name player vendors without embedding anything. A
// <meta http-equiv="Content-Security-Policy"> allow-list is template-wide:
// werkenbijoss.nl lists "frame-src … https://*.bbvms.com https://player.vimeo.com"
// on every page, which flagged all 25 pages as Blue Billywig. Preconnect /
// dns-prefetch hints are the same shape — they warm a connection — and prefetch
// fetches for a later navigation, so none of them loads anything for this page.
// (rel=preload is left alone: that fetches a resource for this page.)
// rel is a token list, so the hint may sit anywhere in it (rel="preload preconnect").
const RESOURCE_HINT_LINK =
  /<link\b[^>]*\brel\s*=\s*(?:"[^"]*\b(?:preconnect|dns-prefetch|prefetch)\b[^"]*"|'[^']*\b(?:preconnect|dns-prefetch|prefetch)\b[^']*'|(?:preconnect|dns-prefetch|prefetch)\b)[^>]*>/gi;

function stripHostAllowLists(html) {
  return html
    .replace(/<meta\b[^>]*\bhttp-equiv\s*=\s*["']?content-security-policy\b[^>]*>/gi, "")
    .replace(RESOURCE_HINT_LINK, "");
}

// A stylesheet is not a player. Video.js injects <style class="vjs-styles-defaults">
// with `.video-js {…}` on load, and themes inline `.mejs-container{…}`: both sat on
// every page of gemeenteraad.denhelder.nl (221) and jeugdhulprijnmond.nl (153)
// without a single <video>. Same for <link rel="stylesheet" href="…/video-js.min.css">.
const STYLESHEET_LINK =
  /<link\b[^>]*\brel\s*=\s*(?:"[^"]*\bstylesheet\b[^"]*"|'[^']*\bstylesheet\b[^']*'|stylesheet\b)[^>]*>/gi;

// The body may not contain "<": a "<style>" inside a script string (or JSON's
// escaped "<\/style>") must not swallow everything up to the next real </style>,
// players included. CSS with a literal "<" just stays, as before.
function stripStylesheets(html) {
  return html.replace(/<style(?=[\s>])[^>]*>[^<]*<\/style>/gi, "").replace(STYLESHEET_LINK, "");
}

// Generic player libraries are often loaded site-wide (jeugdhulprijnmond.nl loads
// video.js on every page). Loading the library is not a player — neither the request
// nor its <script src>/<link> tag, both of which name it. These players need a match
// in the markup with those tags removed: the element a real player leaves in the
// rendered DOM (<video class="video-js">, .mejs-container). Trade-off: a player inside
// an iframe, whose only trace here is the iframe's script request, is not counted.
const NEEDS_MARKUP = new Set(["Video.js", "MediaElement.js"]);
const stripAssetTags = (html) =>
  html.replace(/<script\b[^>]*\bsrc\s*=[^>]*>/gi, "").replace(/<link\b[^>]*>/gi, "");

// `scripts` patterns see scheme + host + path only. Trackers carry the page URL,
// title and referrer in their query (GA's dl/dt, pixel ?url=), and bundlers put
// random base64 there: Google's pagead/1p-user-list?random=… and Drupal's
// ?include=<blob> each flagged hundreds of pages as Video.js. A player's own
// request rarely names its player in the query alone (combo loaders such as
// /min/?f=video.js do), and such players leave markup evidence as well.
function stripQuery(url) {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

// Network evidence = the request URL (truncated) plus the substring that
// actually fired. Long URLs get cut well before the matching region, so the
// URL alone can carry no trace of why the detector hit (the data.oss.nl
// Video.js false positive stored evidence with no "vjs" in it at all). When
// the match sits past the truncation point, also show a window around it.
const EVIDENCE_URL_LEN = 80;
const EVIDENCE_CONTEXT = 20;
// Patterns like /connect\.facebook\.net\/.+\/sdk\.js/ can match a long span.
const EVIDENCE_MATCH_LEN = 60;

function elide(str, from, to) {
  return `${from > 0 ? "…" : ""}${str.slice(from, to)}${to < str.length ? "…" : ""}`;
}

function networkEvidence(url, match) {
  const shown = elide(url, 0, EVIDENCE_URL_LEN);
  const end = match.index + match[0].length;
  // Only worth a context window when the match lies past the truncation point:
  // for a URL shown in full, the window would just repeat what's already there.
  const context =
    end > Math.min(url.length, EVIDENCE_URL_LEN)
      ? ` in "${elide(url, Math.max(0, match.index - EVIDENCE_CONTEXT), Math.min(url.length, end + EVIDENCE_CONTEXT))}"`
      : "";
  return `${shown} [matched: "${match[0].slice(0, EVIDENCE_MATCH_LEN)}"${context}]`;
}

export function detectPlayers(html, networkRequests) {
  const searchable = stripAnchorHrefs(stripStylesheets(stripHostAllowLists(stripDownlevelConditionals(html))));
  const requestPaths = networkRequests.map(stripQuery);
  const found = [];
  let markupOnly;

  for (const [player, config] of Object.entries(DETECTORS)) {
    const matches = [];

    // Check HTML content
    for (const pattern of config.patterns) {
      const match = searchable.match(pattern);
      if (match) matches.push(`HTML: ${match[0].slice(0, 80)}`);
    }

    // Check network requests
    for (const scriptPattern of config.scripts) {
      for (let i = 0; i < networkRequests.length; i++) {
        // No scripts pattern is /g today, but a stateful lastIndex would hand
        // networkEvidence a wrong match.index and it would slice the wrong region.
        scriptPattern.lastIndex = 0;
        // requestPaths[i] is a prefix of networkRequests[i], so match.index stays
        // valid against the full URL the evidence shows.
        const match = scriptPattern.exec(requestPaths[i]);
        if (!match) continue;
        matches.push(`Network: ${networkEvidence(networkRequests[i], match)}`);
        break;
      }
    }

    if (NEEDS_MARKUP.has(player)) {
      markupOnly ??= stripAssetTags(searchable);
      if (!config.patterns.some((p) => p.test(markupOnly))) continue;
    }
    if (matches.length > 0) {
      found.push({ player, evidence: matches });
    }
  }

  // Confirm/strip unconfirmed social embeds BEFORE tier-filtering: a tier-2
  // social that later fails confirmation would otherwise have already
  // annihilated the lower-tier real player, leaving an empty result.
  const confirmed = filterNonVideoSocials(found, searchable, requestPaths);
  // Sovereignty mode rates every player on the page: a YouTube embed next to
  // a Blue Billywig one still sends data to Google
  return sovereignty ? dropEnginesUnderVendors(confirmed) : filterToHighestTier(confirmed);
}

// ── Explicit URL scanning (no crawl) ────────────────────────────────

async function scanExplicitUrls(urls, { timeout = 15000, concurrency = DEFAULT_CONCURRENCY, delay = 200, controlFile = null } = {}) {
  const browser = await launchScanBrowser();

  const baseUrl = new URL(urls[0]);
  const domain = baseUrl.hostname.replace(/^www\./, "");
  const results = [];

  const throttle = createThrottleState(delay, concurrency);
  const autoTuner = createAutoTuner(controlFile);
  autoTuner.beat(throttle, domain);
  const refusals = createRefusalTracker();
  const retryCount = new Map();
  const MAX_RETRIES = 2;

  console.log(chalk.blue(`\nScanning ${urls.length} explicit URLs (domain: ${domain})`));
  console.log(chalk.gray(`Timeout per page: ${timeout}ms, auto-conc=${throttle.concurrency} (initial), Delay: ${delay}ms\n`));

  setupInterruptHandler();

  // First URL: accept cookies
  const firstUrl = urls[0];
  process.stdout.write(chalk.gray(`[1/${urls.length}] `) + chalk.white(truncate(firstUrl, 80)) + " ");
  try {
    const first = await scanFirstPage(browser, firstUrl, timeout);
    const { detected, skippedReason } = first;
    if (servedPage(first)) refusals.pageLoaded(firstUrl);
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

  while ((remaining.length > 0 || refusals.waiting().length > 0) && !interrupted) {
    if (batchNum > 0 && throttle.delay > 0) await sleep(throttle.delay);
    batchNum++;

    applyControlFile(throttle, controlFile);

    // Refused URLs whose wait is over go first (see createRefusalTracker)
    const batch = refusals.takeDue(throttle.concurrency);
    batch.push(...remaining.splice(0, throttle.concurrency - batch.length));
    if (batch.length === 0) {
      autoTuner.beat(throttle, domain);
      await sleep(1000);
      continue;
    }

    for (let i = 0; i < batch.length; i++) {
      const idx = results.length + i + 1;
      console.log(chalk.gray(`[${idx}/${urls.length}] `) + chalk.white(truncate(batch[i], 80)) + chalk.gray(" ..."));
    }

    const batchResults = await Promise.allSettled(
      batch.map((url) => scanOnePage(browser, url, timeout))
    );

    const weighed = await weighBatch(refusals, throttle, batch, batchResults, (control) => hostServes(browser, control, timeout));
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
        const verdict = err?._refusable ? refusals.judge(url, err._rateLimit, weighed.hostOk(url)) : null;
        if (verdict === "refused") {
          console.log(chalk.red(`  ✗ ${truncate(url, 65)}  access refused, other pages load`));
          results.push({ url, players: [], error: `Access refused: ${err._rateLimit}` });
        } else if (verdict === "retry") {
          console.log(chalk.gray(`  ↻ ${truncate(url, 65)}  ${err._rateLimit}, one retry in ${REFUSAL_RECHECK_MS / 1000}s`));
        } else if (err?._rateLimit) {
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

function generateReport({ domain, results, pagesScanned, _state, rateLimits, coverage, batchId, batchLabel, resumeFile, sovereignty: sovereigntyJson }) {
  const playerSummary = {};
  const pagesWithPlayers = [];
  const pagesWithoutPlayers = [];
  const errorSummary = {}; // normalized reason → count
  const failedUrls = []; // [{ url, error }] — so failures can be re-run precisely

  for (const { url, players, error } of results) {
    if (error) {
      // Collapse to the ERR_*/keyword signature so noisy URLs/suffixes group.
      const key = (error.match(/ERR_[A-Z0-9_]+|Timeout|Rate limited|Access refused|null response/i) || [error])[0];
      errorSummary[key] = (errorSummary[key] || 0) + 1;
      if (failedUrls.length < 1000) failedUrls.push({ url, error: error.slice(0, 200) });
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
  if (failureRate >= 0.5 && (errorSummary["Access refused"] || 0) > pagesFailed / 2) {
    console.log(chalk.bold.red(
      `\n  ⚠ ${Math.round(failureRate * 100)}% of pages failed — mostly URLs the site refused (403) twice, ${REFUSAL_RECHECK_MS / 1000}s apart, while other pages loaded.` +
      `\n    That points at those URLs rather than a rate limit: a re-run will likely get the same answer.`
    ));
  } else if (failureRate >= 0.5) {
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
    ...(pagesFailed > 0 ? { errorSummary, failedUrls } : {}),
    ...(batchId ? { batchId } : {}),
    ...(batchLabel ? { batchLabel } : {}),
    // Links dropped unscanned (coverage.mjs): an empty queue below is not full coverage
    ...coverageFlags(coverage),
    playerSummary: Object.fromEntries(
      Object.entries(playerSummary).map(([p, urls]) => [p, { count: urls.length, pages: urls }])
    ),
    details: pagesWithPlayers.map(({ url, players }) => ({
      url,
      players: players.map((p) => ({ name: p.player, evidence: p.evidence })),
    })),
    rateLimits,
    ...(sovereigntyJson ? { mode: "sovereignty", sovereignty: sovereigntyJson } : {}),
    _state,
  };
  writeFileSync(jsonFile, JSON.stringify(jsonReport, null, 2));
  console.log(chalk.green(`\n  Rapport opgeslagen: ${jsonFile}`));
  console.log(jsonMarkerLine(jsonFile));
  console.log("");
}

// Machine-readable: videoscan-runner (resolveScanJsonFile) parses this line to
// find the file this scan wrote. The newest file in the dir can belong to a
// concurrent scan. Plain text, no chalk.
export function jsonMarkerLine(jsonFile) {
  return `VIDEOSCAN_JSON: ${jsonFile}`;
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
  --max-pages <n>       Max pagina's te scannen (standaard: 50, sovereignty: 500)
  --mode sovereignty    Soevereiniteitsscan: alle players per pagina, requests/cookies/storage
                        voor en na consent, play-steekproef, hosts → operator/land (JSON: sovereignty)
  --seed-from <file|auto|none>  Sovereignty: video-pagina's uit een eerdere scan eerst (standaard: auto)
  --timeout <ms>        Timeout per pagina in ms (standaard: 15000)
  --delay <ms>          Vertraging tussen batches in ms (standaard: 200)
  --resume <json-file>  Hervat scan vanuit eerder resultaat
  --urls <urls|file>    Scan explicit URLs (comma-separated or JSON file path)
  --no-sitemap          Skip sitemap-based URL discovery
  --max-sitemap-urls <n> Max URLs uit sitemap toevoegen aan queue (standaard: 5000)
  --max-queue <n>       Max URLs in de queue; de laagst gerangschikte vallen af (standaard: ${MAX_QUEUE})
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

// Video pages of an earlier scan of the domain, to scan first. "auto": the
// newest finished scan file in the working dir; "none": no seeds.
export function loadSeeds(from, url, dir = ".") {
  if (from === "none") return [];
  let file = from;
  if (from === "auto") {
    const domain = new URL(url).hostname.replace(/^www\./, "");
    const prefix = `videoscan-${domain}-`;
    const candidates = readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".json") && !/INPROGRESS|-summary|-merged/.test(f))
      // The timestamp follows the domain: a dotted subdomain of it starts with
      // the same prefix but has no digit there
      .filter((f) => /^\d{4}-/.test(f.slice(prefix.length)))
      .sort();
    if (!candidates.length) return [];
    file = join(dir, candidates[candidates.length - 1]);
  }
  try {
    const prev = JSON.parse(readFileSync(file, "utf-8"));
    // Pages with network evidence first: a page budget can end long before the
    // stronger pages of an older scan's weak matches (louwmanmuseum.nl: 1604
    // string-only pages ahead of 13 with a network hit, none reached in 60)
    const hasNetwork = (d) => (d.players || []).some((p) => String(p.evidence).includes("Network:"));
    const details = prev.details || [];
    const urls = [...details.filter(hasNetwork), ...details.filter((d) => !hasNetwork(d))].map((d) => d.url);
    console.log(chalk.gray(`  Seeds: ${urls.length} video page(s) from ${basename(file)}`));
    return urls;
  } catch (err) {
    console.log(chalk.yellow(`  Seeds: ${file} unreadable (${err.message}), crawling without`));
    return [];
  }
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
  let mode = flagValue("--mode");
  if (args.includes("--mode") && mode !== "sovereignty") {
    console.error(chalk.red(`Onbekende --mode: ${mode} (alleen: sovereignty)`));
    process.exit(1);
  }

  // --urls mode: scan explicit URLs without crawling
  const urlsIdx = args.indexOf("--urls");
  if (urlsIdx !== -1 && args[urlsIdx + 1] && mode) {
    console.error(chalk.red("--mode sovereignty werkt alleen met een crawl, niet met --urls (gebruik --seed-from)"));
    process.exit(1);
  }
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
    if (!mode && prevData.mode === "sovereignty") mode = "sovereignty";
  } else {
    url = args[0];
    if (!url.startsWith("http")) {
      console.error(chalk.red("URL moet beginnen met http:// of https://"));
      process.exit(1);
    }
  }

  // A sovereignty scan is a quick scan: 500 pages give the player mix
  const maxPages = parseInt(args[args.indexOf("--max-pages") + 1]) || (mode ? 500 : 50);
  const sitemap = !args.includes("--no-sitemap");
  const maxSitemapUrls = parseInt(args[args.indexOf("--max-sitemap-urls") + 1]) || 5000;
  const maxQueueArg = parseInt(flagValue("--max-queue"));
  const maxQueue = maxQueueArg > 0 ? maxQueueArg : MAX_QUEUE;

  try {
    const seeds = mode && !resumeFile ? loadSeeds(flagValue("--seed-from") || "auto", url) : [];
    const scanResult = await crawlSite(url, { maxPages, timeout, resumeFile, concurrency, delay, sitemap, maxSitemapUrls, controlFile, maxQueue, mode, seeds });
    generateReport({ ...scanResult, batchId, batchLabel, resumeFile });
  } catch (err) {
    console.error(chalk.red(`Scan mislukt: ${err.message}`));
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
