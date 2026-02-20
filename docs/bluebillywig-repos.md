# BlueBillywig GitHub Repos

Top 20 most recently updated (as of 2026-02-20). Used by `ado-investigate` skill for repo scoring.

---

## Core Platform

### `ovp6` · TypeScript
**Blue Billywig Online Video Platform 6** — the main OVP frontend/admin application. Central repo for UI work, player embed configuration, publication management, media library, analytics dashboards.
- Tickets mentioning: OVP, publication, playlist, upload, embed, metadata, UI, admin, player configuration

### `formatengine` · PHP
**BB Format Engine / SAPI** — the main backend PHP application powering the Blue Billywig platform. Exposes the `/sapi/` REST API used by the OVP and external integrations. Handles mediaclips, publications, playlists, transcoding jobs, user management. Uses MySQL, Redis, Solr, Memcached.
- Tickets mentioning: SAPI, API, backend, mediaclip, publication, transcoding, format, import, upload, PHP

### `bb-backend` · TypeScript (NestJS)
**BB Backend microservices monorepo** — NestJS microservices on AWS (Docker Compose, Terraform). Contains ad-stats, prebid-analytics, and other backend services. Separate from the PHP `formatengine`; handles newer cloud-native backend concerns.
- Tickets mentioning: microservice, NestJS, ad stats, analytics, AWS, backend service

### `ovp-stats-processing` · PHP
**Stats processing service** — processes video play statistics at `stats.bluebillywig.com`. Uses Redis and Solr. Separate from the main `formatengine`.
- Tickets mentioning: stats, analytics, play events, reporting, Redis, Solr

---

## Web Players & Embedding

### `standardplayer` · JavaScript
**Standard embedded video player** — the core BB video player that gets embedded on customer pages. Handles playback, ads, subtitles, quality selection. Synced from SVN.
- Tickets mentioning: player, playback, embed, autoplay, quality, subtitles, HLS, ad, VAST, captions

### `bbiframebridge` · JavaScript
**Blue Billywig Iframe Bridge** — communication layer between the embedded player iframe and the parent page. Enables cross-origin postMessage-based API calls to the player.
- Tickets mentioning: iframe, postMessage, bridge, cross-origin, player API, embed communication

### `channel` · TypeScript
**Gallery / CloudTV embeddable video subsite** — embeddable video channel/gallery pages (CloudTV). Renders a branded video listing + player experience that customers embed on their sites.
- Tickets mentioning: channel, gallery, CloudTV, video wall, playlist page, embed, subsite

---

## Native Mobile SDKs

### `bbnativeplayersdk-kotlin` · Kotlin
**BB Native Media SDK for Android** — ExoPlayer-based native Android video player SDK. Used by Android apps to play BB-hosted content.
- Tickets mentioning: Android, Kotlin, ExoPlayer, native player, mobile SDK

### `bbnativesharedmodule` · Kotlin
**Shared module for Android native SDK** — shared Kotlin code used across `bbnativeplayersdk-kotlin` and related Android SDK repos.
- Tickets mentioning: Android, Kotlin, shared module, native SDK

### `bbnativeplayersdk-demo` · Kotlin
**Demo app for Android Native Player SDK** — Kotlin demo/sample Android app showing how to integrate the BB native SDK.
- Tickets mentioning: Android demo, sample app, integration example

### `bbnativeplayerkit-swift` · Swift (listed as HTML)
**iOS Native Player Kit (Swift)** — AVPlayer-based native iOS video player kit in Swift. No public README.
- Tickets mentioning: iOS, Swift, AVPlayer, native player, iPhone, iPad

### `bbnativeplayerkit-cocoapod` · Objective-C
**Blue Billywig Native Media Kit - Cocoapod** — iOS native player as a CocoaPods distribution package.
- Tickets mentioning: iOS, Cocoapod, Objective-C, pod, native player distribution

### `bbnativeshared-cocoapod` · Objective-C
**Shared native code for Cocoapod** — Objective-C shared code distributed as a CocoaPod; used by iOS native player kits.
- Tickets mentioning: iOS, Cocoapod, Objective-C, shared native

### `react-native-bb-player` · TypeScript
**React Native BB player component** — cross-platform React Native video player component, powered by the iOS AVPlayer and Android ExoPlayer BB SDKs.
- Tickets mentioning: React Native, cross-platform, mobile, iOS, Android, RN player

---

## Advertising & Header Bidding

### `bluebillywig_pbjs` · JavaScript
**Blue Billywig Prebid.js variant** — tools to build and maintain BB's customized fork of Prebid.js for header bidding ad integration with the player.
- Tickets mentioning: Prebid, header bidding, ads, advertising, VAST, programmatic, HB

### `bunny-edge-scripts` · Shell/TypeScript
**Bunny CDN edge middleware scripts** — scripts deployed to Bunny.net CDN pull zones. Current script: `hls-playlist-filter` — filters HLS master playlists by resolution using query params (`?minres=`, `?maxres=`).
- Tickets mentioning: CDN, Bunny, HLS, playlist, resolution filter, edge, delivery

---

## Infrastructure & DevOps

### `gh-workflows` · GitHub Actions YAML
**Reusable GitHub Actions workflow templates** — standardized GH Actions workflows shared across BB repos via `workflow_call`.
- Tickets mentioning: CI/CD, GitHub Actions, workflows, pipeline, build, deploy, automation

### `s3-bucket-deletion` · JavaScript
**AWS S3 bucket deletion service** — small Node.js API/service for deleting S3 buckets (internal infrastructure tooling).
- Tickets mentioning: S3, AWS, bucket, storage cleanup, infrastructure

---

## Documentation & Demos

### `sso-docs`
**SSO integration documentation** — documentation on integrating Single Sign-On with the Blue Billywig OVP.
- Tickets mentioning: SSO, SAML, OAuth, authentication, identity, login integration

### `www.bluebillywig.tv` · HTML
**Demo/marketing pages** — demo pages at bluebillywig.tv for showcasing features and player examples.
- Tickets mentioning: demo, marketing, showcase, example page

---

## Scoring Guide for `ado-investigate`

| Ticket keywords | Primary repo(s) |
|-----------------|-----------------|
| SAPI, `/sapi/`, mediaclip, transcoding, publication API | `formatengine` |
| OVP UI, admin, dashboard, publication management | `ovp6` |
| Player, embed, autoplay, HLS, VAST, subtitles | `standardplayer` |
| Iframe, postMessage, player API from page | `bbiframebridge` |
| Android, ExoPlayer, Kotlin | `bbnativeplayersdk-kotlin`, `bbnativesharedmodule` |
| iOS, Swift, AVPlayer | `bbnativeplayerkit-swift`, `bbnativeplayerkit-cocoapod` |
| React Native | `react-native-bb-player` |
| Prebid, header bidding, ads | `bluebillywig_pbjs` |
| Stats, analytics, play events | `ovp-stats-processing` |
| CDN, HLS filter, Bunny | `bunny-edge-scripts` |
| Channel, gallery, CloudTV | `channel` |
| Microservice, NestJS, AWS backend | `bb-backend` |
| CI/CD, GitHub Actions | `gh-workflows` |
