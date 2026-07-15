# Emergency Towing — Mesa, AZ · SEO & Web Consolidation Package

Client: **Emergency Towing and Transport** / **Emergency Towing Heavy Rescue LLC**
Location: 725 E Southern Ave, Mesa, AZ 85204 · Serving Mesa & the East Valley since 2001
Prepared: July 2026

## What's in this package

| Doc | Purpose |
| --- | --- |
| [01-domain-site-merge-plan.md](./01-domain-site-merge-plan.md) | Full domain/site inventory, which domain to keep, and the 301 migration plan |
| [02-cloudflare-migration.md](./02-cloudflare-migration.md) | Runbook: move all domains to Cloudflare DNS (zero downtime), host the site on Cloudflare Pages, implement redirects with Redirect Rules |
| [03-seo-monitoring.md](./03-seo-monitoring.md) | Recommended monitoring stack, KPIs, and cadence |
| [04-google-business-profile.md](./04-google-business-profile.md) | GBP strategy (one profile vs. two), optimization checklist, citation/NAP cleanup |
| [05-google-ads.md](./05-google-ads.md) | Local Services Ads + Search campaign structure, conversion/call tracking, budgets & benchmarks |
| [06-redirect-map.csv](./06-redirect-map.csv) | URL-by-URL 301 redirect map, ready to implement as Cloudflare rules |

## The situation (as found, July 2026)

The business currently has **four domains**, three of them running live, near-duplicate
websites — which splits link equity, confuses Google's local algorithm, and creates a
duplicate-content problem:

| Domain | Status | Notes |
| --- | --- | --- |
| `emergencytowingaz.com` | Live, indexed | Most complete site: 6+ dedicated service pages (light-duty, heavy-duty, lockouts, tire changes, private property impounds, Landoll) |
| `emergencytowingheavyrescue.com` | Live, indexed | Same template/content as above; homepage title even says "Emergency Towing and Transport Services" |
| `emergencytowingandtransportaz.com` | Live, indexed | Older builder site (/, /about/, /services/, /contact/) |
| `emergencyheavyrescue.com` | Not indexed | No pages in Google — safe to use as a pure redirect domain |

Two business identities share the address:

- **Emergency Towing and Transport** — (480) 577-5334, family-owned since 2001, Yelp 5.0★ (~20 reviews), BBB-listed (as "Emergency Transport and Towing" — a name mismatch to fix)
- **Emergency Towing Heavy Rescue LLC** — (480) 288-6911, USDOT 4004745, MC 1506139

## Headline recommendations

1. **Consolidate to `emergencytowingaz.com`** as the single canonical website; 301-redirect
   the other three domains page-to-page (see doc 01 + the redirect CSV).
2. **Move all four domains to Cloudflare DNS first**, then implement the redirects as
   Cloudflare Redirect Rules — no old hosting changes needed (doc 02).
   Host the consolidated site's front end on **Cloudflare Pages** (free tier, global CDN,
   automatic HTTPS) — architecture and cutover steps are in doc 02.
3. **Keep one primary Google Business Profile** ("Emergency Towing and Transport") and only
   retain the Heavy Rescue profile if it keeps a genuinely distinct identity (own phone,
   own landing page, different primary category) — otherwise it risks filtering/suspension (doc 04).
4. **Monitoring:** Google Search Console (all 4 domains) + GA4 + Bing Webmaster (free core), plus
   a local rank-grid tracker (Local Falcon or LocalViking) — details and budget tiers in doc 03.
5. **Ads:** Google **Local Services Ads (Google Guaranteed)** first dollar spent — it's the
   highest-ROI channel for towing — then a call-focused Search campaign for heavy-duty/commercial
   work where LSA volume is thin (doc 05).

## Suggested sequence

1. Week 1 — Cloudflare DNS migration (doc 02), GSC verification of all 4 domains, GA4 install.
2. Week 2 — Pick/confirm primary domain, implement 301 redirect map, submit change-of-address in GSC.
3. Weeks 2–3 — GBP cleanup & optimization; citation/NAP corrections (doc 04).
4. Weeks 3–4 — LSA onboarding (background check/insurance docs take time — start early); Search campaign build.
5. Ongoing — monitoring cadence per doc 03.
