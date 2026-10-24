# Player host research (2026-10-16)

[V] = unverified / vendor self-claim only. All vendor claims are self-reported unless stated.

## Part 1 - vendors

| Vendor | HQ | Owner / parent | Hosting / CDN (stated) | Certs | Sources |
|---|---|---|---|---|---|
| PingVP | Amersfoort NL | not stated [V] | Storage CloudNL (NL); CDN Gcore (Luxembourg) | Claims ISO 27001, NIS2, GDPR; WCAG 2.2 AA. No certificate seen [V]. No NEN 7510 | en.pingvp.com/security-compliance/, /transparency-page/ |
| Hihaho | Assen NL | not stated; ~20 staff, no acquirer found [V] | App on AWS EU (Ireland per privacy page). Uploaded video storage = JW Player (US co). CloudFront, Cloudflare, Google Fonts/Analytics requests listed | ISO 27001 since 2022-11 (DigiTrust; expired 2025-11-23; recert unconfirmed [V]); claims NEN 7510/7512 | hihaho.com/compliance-security-measures/, hihaho.com/blog/hihaho-receives-certification-for-information-security/, hihaho.com/?p=13389 |
| Ivory (Ivory Studio) | Amersfoort NL (site) / Nieuwegein (directory) | not stated; 3 staff, founded 2014; independent of Hihaho (competitor) | Not stated. 2020 Vixy partnership suggests NL hosting [V]. "Ivory Media Player" not found as product name | none stated | ivoryvideo.com, partner.hihaho.com/?p=14702 |
| OpenGemeenten | NL | not stated | CMS platform for 35 municipalities / 236 sites; no video player product found. Host unnamed | ISO 27001 (page link), WCAG 2.2 AA | opengemeenten.nl. Treat as "no own player" [V] |
| Rijksoverheid player | NL (Min. AZ / DPC) | Government. Platform Rijksoverheid Online hosting: Centric + Prolocation since 2014 (outdated [V]) | Not in public docs. Measured: rijksoverheid.nl on Akamai; CSP media-src = *.rovid.nl, *.rijksoverheidsvideo.nl (own domains, NS rijksoverheidnl.*). www.rovid.nl behind Cloudflare. mediatheek.rijksoverheid.nl = NXDOMAIN. Player builder unknown [V] | none found | binnenlandsbestuur.nl/digitaal/centric/hosting-platform-rijksoverheid-online; CSP header of www.rijksoverheid.nl |
| Vixy Video | Amsterdam NL (about page; Hilversum elsewhere) | NEP The Netherlands co-owner since 2016 (self-claim); NEP Group Inc is Pittsburgh US [V] | "Hosted in EU"; servers at NEP NL; CDN unnamed. Marketing site on Cloudflare | ISO 27001 (NEP NL met 2022-07-22), annual pentest | vixyvideo.com/about/, /features/video-hosting/ |
| Company Webcast | NL | Euronext 51% since 2017-02-14 (EUR 3.6m upfront); now Euronext Corporate Solutions (companywebcast.com 301-redirects there). Remaining 49% unconfirmed [V] | "Servers hosted in the EU". Measured player.companywebcast.com on AWS eu-west-1 (Ireland) | ISO 27001:2022 (corporatesolutions.euronext.com) | euronext.com/news/euronext-acquires-majority-stake-company-webcast; corporatesolutions.euronext.com |
| StreamPartner | NL (address not found) | not stated | "Hosted & developed on Dutch soil"; datacenter unnamed. Measured: Serverius (NL) | none stated | streampartner.nl |
| iBabs | NL | Euronext: 60% on 2017-07-10 (EUR 30.1m); remaining 40% in 2021 for EUR 55.6m [V, secondary source only] | Not stated publicly. Measured player.ibabs.eu = AWS eu-west-1 (Ireland) ELB, Kestrel (.NET). ibabs.eu redirects to ibabs.com (403 to fetch) | not found [V] | euronext.com/news/euronext-acquires-majority-stake-ibabs |
| Blue Billywig | Hilversum NL | Blue Billywig Group BV, "independently owned since 2006", no US parent (self-claim) | Scaleway EU DCs (Amsterdam/Paris/Warsaw per FAQ; intro says Amsterdam + Frankfurt: inconsistent). CDN: Bunny CDN (EU edges). Global delivery opt-in. Measured: cdn.bluebillywig.com = bunny; bbvms.com = AWS CloudFront | ISO 27001 (certificate on request); pentest summary under NDA. No NEN 7510/BIO | bluebillywig.com/european-sovereign-ovp/ |
| 23 Video / TwentyThree | Copenhagen DK | "Independent" per own page; CB Insights flags "Acquired 2019" with no buyer [V]. No Vimeo acquisition found | Not verified (security page 404) [V]. Measured: Fastly | not verified | cbinsights.com/company/twentythree |
| Spotify | Stockholm SE (Spotify AB; parent Spotify Technology S.A., Luxembourg [V]) | listed company | Core backend on Google Cloud since 2016; audio historically also AWS. Measured open.spotify.com: Fastly | n/a | datacenterdynamics.com/en/news/spotify-tunes-in-to-googles-cloud-platform/ |
| Flowplayer | Stockholm SE | Wowza (Colorado US), owned by Clearhaven Partners (US PE). Acquired 2022-09 | Wowza Video platform | n/a | flowplayer.com/blog/announcing-wowza-aquires-flowplayer; privateequitywire.co.uk (2022-09-07) |
| bunny.net | Ljubljana SI | Independent, founder Dejan Grofelnik Pelzel [V]; USD 6m round 2022 | Own CDN edges (~110-120 PoPs). Measured IPs in AS212238/AS60068 "Datacamp Limited" (UK; CDN77 parent) = leased capacity [V]. Public sub-processor list, DPA in panel | ISO 27001 not confirmed [V] | bunny.net/gdpr/; techcrunch.com/2022/10/04/slovenias-bunny-net-raises-a-6m-round-to-offer-a-developer-friendly-cdn |
| PeerTube | Framasoft, France (non-profit, <10 staff) | none; AGPLv3, self-hosted per instance | Depends on instance host | n/a | en.wikipedia.org/wiki/PeerTube; joinpeertube.org |

Asides: Vimeo reportedly acquired by Bending Spoons (IT) Nov 2025 [V, CB Insights]. OVHcloud acquired api.video (2025) [V].

## Part 2 - passive DNS/headers (this machine, resolver dns.google, NL vantage)

Caveat: anycast/CDN. IP + ASN show the edge that answered from an NL vantage, not origin or data location. ipinfo country is unreliable for anycast. One A lookup + one `curl -sI` per host. CNAME shown = first alias nslookup returned.

| host | CNAME -> | IP | ASN | ASN org | CDN hint |
|---|---|---|---|---|---|
| bbvms.com | - | 18.239.18.67 | AS16509 | Amazon.com | CloudFront (X-Cache hit); Server Apache; 302 |
| www.bbvms.com | d1i254ftm0zvcw.cloudfront.net | 18.239.18.67 | AS16509 | Amazon.com | CloudFront |
| demo.bbvms.com | d1i254ftm0zvcw.cloudfront.net | 18.239.18.67 | AS16509 | Amazon.com | CloudFront; exists (302) |
| cdn.bluebillywig.com | bb-cdn-prod.b-cdn.net | 79.127.134.227 | AS212238 | Datacamp Limited | Server BunnyCDN-FR1; 403 response also carried Via CloudFront [V] |
| www.youtube.com | - | 142.251.155.4 | AS15169 | Google LLC | Server ESF |
| www.youtube-nocookie.com | youtube-ui.l.google.com | 142.250.180.14 | AS15169 | Google LLC | ESF |
| i.ytimg.com | - | 172.217.17.214 | AS15169 | Google LLC | sffe |
| player.vimeo.com | player.vimeo.com.cdn.cloudflare.net | 162.159.128.61 | AS13335 | Cloudflare | cloudflare, CF-RAY -AMS; also Fastly varnish (x-served-by iad, rtm) |
| f.vimeocdn.com | vimeo.map.fastly.net | 151.101.64.217 | AS54113 | Fastly | Fastly (AMS edge) |
| players.brightcove.net | dualstack.brightcove.map.fastly.net | 151.101.2.27 | AS54113 | Fastly | Fastly (RTM edge) |
| cdnapisec.kaltura.com | cdn-kaltura-dscd.edgekey.net | 184.24.16.128 | AS16625 | Akamai Technologies | Akamai edgekey; Server Kaltura |
| cdn.jwplayer.com | - | 108.156.60.15 | AS16509 | Amazon.com | CloudFront |
| fast.wistia.com | dualstack.j.sni.global.fastly.net | 151.101.66.132 | AS54113 | Fastly | CloudFront + Fastly chained; istio-envoy |
| play.vidyard.com | p.shared.global.fastly.net | 151.101.193.181 | AS54113 | Fastly | Fastly (AMS) |
| geo.dailymotion.com | d1azaraa2duw8j.cloudfront.net | 18.239.18.71 | AS16509 | Amazon.com | CloudFront; envoy |
| www.tiktok.com | www.tiktok.com.edgesuite.net | 104.110.240.233 | AS20940 | Akamai International B.V. | Akamai |
| pingvp.com | - | 193.141.100.162 | AS1136 | KPN B.V. | no CDN header; Server "webserver" |
| player.hihaho.com | - | 18.239.36.6 | AS16509 | Amazon.com | CloudFront |
| platformrijksoverheidonline.nl | - | 2.16.6.201 | AS20940 | Akamai International B.V. | Akamai (same range as www.rijksoverheid.nl) |
| mediatheek.rijksoverheid.nl | - | NXDOMAIN | - | - | does not exist |
| www.rovid.nl (from CSP) | www.rovid.nl.cdn.cloudflare.net | 104.20.22.176 | AS13335 | Cloudflare | Cloudflare (AMS) |
| vixyvideo.com | - | 162.159.134.42 | AS13335 | Cloudflare | Cloudflare (marketing site only; player CDN untested) |
| player.companywebcast.com | legacyfrontendproduction-2082129223.eu-west-1.elb.amazonaws.com | 54.171.92.39 | AS16509 | Amazon.com | AWS ELB eu-west-1 (Ireland), no CDN |
| streampartner.nl | - | 46.249.52.154 | AS50673 | Serverius | Apache/2, NL host, no CDN |
| player.ibabs.eu | babscast-1398201752.eu-west-1.elb.amazonaws.com | 108.132.118.192 | AS16509 | Amazon.com | AWS ELB eu-west-1 (Ireland), Kestrel |
| open.spotify.com | atc.spotify.map.fastly.net | 151.101.131.42 | AS54113 | Fastly | Fastly (AMS) in front of Google edge |
| iframe.videodelivery.net | - | 104.16.202.35 | AS13335 | Cloudflare | cloudflare (Stream) |
| iframe.mediadelivery.net | router-geo.mediadelivery.net | 84.17.46.50 | AS60068 | Datacamp Limited | Kestrel; bunny Stream |
| stream.mux.com | geo-stream.mux.com | 151.101.2.132 | AS54113 | Fastly | Fastly (AMS) |
| www.twentythree.com | twentythree.com | 151.101.193.120 | AS54113 | Fastly | Fastly (RTM) |

Tooling note: no whois/dig on machine; used nslookup (8.8.8.8) + ipinfo.io for ASN.
