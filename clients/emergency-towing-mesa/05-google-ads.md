# 05 · Google Ads — Structure, Tracking & Data Plan

## Channel priority for towing (spend in this order)

1. **Google Local Services Ads (LSA / "Google Guaranteed")** — towing is an LSA category in
   Phoenix-metro. Pay-per-lead (not per click), shows *above* everything, badge builds trust,
   and disputes on junk leads are creditable. For emergency towing this is consistently the
   cheapest qualified call. Requirements: background checks, license + insurance docs,
   review minimums — onboarding takes 2–6 weeks, **start immediately**.
2. **Search campaigns (call-focused)** — fill the gaps LSA doesn't cover well:
   heavy-duty/semi/commercial queries, Landoll/equipment transport, private-property-impound
   (B2B, property managers), and overflow when LSA budget caps out.
3. **Performance Max / Display / YouTube** — skip. Emergency intent doesn't live there;
   budget leaks. Revisit PMax only ever for the B2B impound offering.

## LSA setup notes

- Enroll as **Emergency Towing and Transport**, linked to the flagship GBP (reviews carry over —
  the 5.0★ Yelp reputation suggests the GBP reviews are strong too; LSA rank is heavily
  review-driven).
- Service area = the 7 East Valley cities; hours 24/7; weekly budget start ~$300–500
  (≈ 8–15 leads — towing leads in Phoenix metro typically run **$25–80/lead**, higher for heavy-duty).
- Answer **every** call fast: LSA ranking punishes missed/unanswered calls hard. Dispatch
  must treat LSA calls as gold.
- Dispute non-lead calls (solicitors, wrong numbers, out-of-area) weekly — real money back.

## Search campaign structure

One account, one search campaign per intent tier (separate budgets — heavy-duty is worth
far more per call than light-duty):

### Campaign 1 — Emergency Towing (light/medium)
- Ad groups: `towing near me` · `tow truck` · `24 hour towing` · `flatbed towing` ·
  `motorcycle towing` · `roadside assistance` (winch-out/jump/lockout/tire terms)
- Geo: Mesa, Gilbert, Chandler, Tempe, Apache Junction, Queen Creek, San Tan Valley —
  **"Presence" targeting only** (people *in* the area — a breakdown is located where the
  caller is; exclude "interest" traffic).
- 24/7 schedule. Review hourly data after 30 days; nights often convert *better* (fewer
  competitors answering) — bid up, don't dark-out.
- Bidding: start Max Clicks with a CPC cap (~$15), switch to tCPA once ≥30 call conversions.
  Phoenix-metro towing CPCs run **$10–30+**; budget floor for signal: ~$1,500/mo. Below
  that, put the money in LSA instead.
- Ads: RSAs with the phone number in headlines, "55-Min East Valley Response", "Family-Owned
  Since 2001", "24/7 Live Dispatch". Assets: **call asset on every ad**, location asset
  (links GBP), sitelinks to service pages, structured snippets (services).
- Also run a **call-only-style mobile preference**: towing converts by phone; landing pages
  matter less than tap-to-call speed. Landing page per ad group = matching service page on
  `emergencytowingaz.com` (post-merge, Cloudflare Pages = instant loads = lower CPCs via
  better ad rank/quality score).

### Campaign 2 — Heavy Duty & Commercial
- Ad groups: `heavy duty towing` · `semi truck towing` · `big rig/18 wheeler tow` ·
  `rv towing` · `box truck towing` · `landoll / equipment transport` · `heavy recovery`
- Landing: the Heavy Rescue hub page (USDOT/MC displayed — commercial dispatchers check).
- Wider geo justified (heavy jobs travel): add Phoenix metro + the US-60 / Loop 202 corridors.
- These clicks are $20–50 but a single heavy recovery is a four-figure ticket — protect this
  budget from Campaign 1 by keeping them separate.

### Campaign 3 (optional, small) — Private Property Impound (B2B)
- Keywords: `private property towing`, `apartment towing contract`, `parking enforcement mesa`.
- Landing: impound service page with a form (this one is form-fill, not emergency call);
  weekday schedule is fine here.

### Negatives (shared list, seed)
`free`, `jobs`, `salary`, `training`, `license`, `how to`, `diy`, `tow strap`, `hitch`,
`trailer for sale`, `game`, `truck simulator`, cities outside service area, `cheap` (test —
often junk for towing), competitor brand names (skip bidding on them initially; two-way war
in a small market).

## Conversion & call tracking (the "Google Ads data" layer)

The conversion currency is **answered calls ≥60s** (in Google Ads: an Ads-reported phone-call
conversion with call length threshold 60s). LSA and GBP calls are separate silos —
consolidate reporting monthly (doc 03 KPI #1).

Setup:

1. **Google Ads call reporting ON** → Google forwarding numbers on call assets and
   call-only ads. Conversion action "Calls from ads", 60s threshold, count = one per call.
2. **Website tel: clicks**: GA4 event `phone_call_click` on every `tel:` link → import to
   Google Ads as secondary conversion (mobile users who land and tap).
3. **Google forwarding number on the website** for ad traffic: enable "Calls to a phone
   number on your website" conversion + the GTag snippet swaps the displayed number for ad
   clicks only — organic visitors still see (480) 577-5334, so NAP stays intact.
4. **CallRail (recommended at >$1.5k/mo spend):** DNI pool for the website (swaps per
   source: ads/organic/GBP), call recording for dispatch QA, and lead-quality scoring. Keep
   the *real* number in schema markup and as the GBP primary-number fallback rule (doc 04).
5. Import GA4 key events; set Google Ads to optimize **only** on the 60s-call conversions
   (everything else = secondary/observational) — otherwise tCPA chases cheap junk.
6. **Offline truth layer:** dispatch logs jobs with source ("how'd you find us" + tracking
   number match) in a simple sheet: date, source, service type, ticket $. After 60–90 days
   this gives real **revenue per channel** — the number that decides LSA vs Search budget
   split. (Optional upgrade: import as offline conversions with values via GCLID.)

## Measurement dashboard (monthly, one page)

| Metric | Source |
| --- | --- |
| Leads: LSA (charged leads) | LSA dashboard |
| Leads: Search calls ≥60s | Google Ads |
| Leads: GBP calls (organic) | GBP performance |
| Cost / lead by channel | above + spend |
| Revenue / channel (dispatch log) | offline sheet |
| Search impression share vs. towmesa.com et al. | Auction insights |
| Wasted-spend audit (search-terms report) | Google Ads — add negatives weekly for month 1, then monthly |

## Budget guidance (starting point, adjust on 90-day data)

| Channel | Monthly | Expected |
| --- | --- | --- |
| LSA | $1,200–2,000 | 20–40 charged leads |
| Search C1 (emergency) | $1,500 | 40–70 clicks/wk, 15–30 calls |
| Search C2 (heavy) | $750 | fewer, high-value calls |
| CallRail | $45 | attribution |
| **Total** | **~$3,500–4,300** | blended CPL target: <$45 light, <$120 heavy |

If total budget is under ~$1,500/mo: **LSA only + GBP optimization**, no Search campaigns.
