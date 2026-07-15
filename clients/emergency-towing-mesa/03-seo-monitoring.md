# 03 · SEO Monitoring — Recommendations

Towing SEO is **local-pack-first**: most revenue queries ("tow truck near me",
"towing mesa az") resolve in the Google Maps 3-pack and Local Services Ads, not blue links.
Monitoring must therefore cover *both* organic web rankings and **map-grid rankings**, plus
calls — the only conversion that matters.

## Recommended stack

### Tier 1 — Free, non-negotiable (set up during the migration)

| Tool | What it gives you | Notes |
| --- | --- | --- |
| **Google Search Console** | Queries, impressions, clicks, index coverage, change-of-address, Core Web Vitals | Verify all 4 domains as *domain properties* via Cloudflare DNS. This is also the migration health monitor |
| **GA4** | Traffic, engagement, conversion events (calls, form fills, direction clicks) | One property on the primary domain; mark `tel:` clicks as key events |
| **GBP Performance reports** | Calls, direction requests, website clicks, search terms, photo views — per profile | Check monthly; export before/after any profile change |
| **Bing Webmaster Tools** | Bing/DuckDuckGo coverage; imports from GSC in one click | 5 minutes of setup, occasional roadside-assistance traffic |
| **Cloudflare Analytics** | Uptime signal, traffic, bot share, cache hit rate | Comes free with the DNS move |

### Tier 2 — Paid, high ROI for a towing client (~$25–60/mo total)

| Tool | Why | Cost |
| --- | --- | --- |
| **Local Falcon** (or LocalViking/BrightLocal grid) | Map-grid rank tracking: shows where in the East Valley the GBP ranks in the 3-pack, on an actual geographic grid. This is the single best local-SEO KPI | from ~$25/mo |
| **BrightLocal** (alternative all-in-one) | Grid tracking + citation monitoring + review monitoring in one; good agency reporting | ~$39/mo |
| Uptime monitor (**UptimeRobot** free / Pulsetic) | A towing site that's down at 2am loses the night's calls; free tier is fine | $0 |

### Tier 3 — Optional / when budget allows

- **Semrush or Ahrefs** (~$120+/mo): backlink watch + competitor tracking (towmesa.com,
  valleyexpresstowing.com, quikpiktowing.com, eztowingaz.com are the visible competitors).
  Overkill for one client; sensible if the agency has multiple clients on one seat.
- **CallRail** (~$45/mo): call tracking & recording with dynamic number insertion (DNI).
  Worth it once Google Ads spend starts — attribution per channel. Use DNI correctly so the
  *displayed* NAP number stays consistent (see doc 05 for the safe setup).

## KPIs to report monthly

1. **Calls** — from GBP insights + `tel:` click events + (later) CallRail, segmented
   GBP vs organic vs LSA vs paid.
2. **Local-pack grid position** — Local Falcon average rank on a 5×5 grid (7-mile radius,
   center 725 E Southern Ave) for: `towing`, `tow truck near me`, `24 hour towing`,
   `heavy duty towing`, `semi truck towing`.
3. **Organic clicks/impressions** (GSC) on the primary domain — during the merge, also track
   the retired domains trending to zero.
4. **Reviews** — count + average rating vs. the Mesa competitor set; response rate.
5. **Index health** — indexed pages on primary; redirect coverage on retired domains.
6. **Core Web Vitals** — should be all-green once on Cloudflare Pages.

## Cadence

| When | What |
| --- | --- |
| Daily (weeks 0–6 post-merge) | GSC coverage/impressions glance on primary + retired domains; uptime alerts |
| Weekly | Grid-rank snapshot, review check + responses, GBP Q&A check |
| Monthly | Full KPI report (template above), citation spot-check, competitor review-count check |
| Quarterly | Content refresh (one new service/city page or recovery-job post with photos), backlink review, GBP photo batch upload |

## Alerting

- GSC email alerts ON (coverage/security/manual actions) for all properties.
- UptimeRobot → SMS/email on the primary domain and on one retired domain (redirect health).
- Google Alerts for both business names (catches new citations/mentions, good and bad).
