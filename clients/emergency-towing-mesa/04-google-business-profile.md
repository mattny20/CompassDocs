# 04 · Google Business Profile — Recommendations

## The structural decision: one profile or two?

Facts on the ground:

- **Emergency Towing and Transport** — (480) 577-5334 · 725 E Southern Ave, Mesa 85204 ·
  operating since 2001 · Yelp 5.0★ (~20 reviews) · BBB profile exists (as "Emergency
  Transport and Towing" — name inverted).
- **Emergency Towing Heavy Rescue LLC** — (480) 288-6911 · same address · USDOT 4004745 ·
  MC 1506139 · email 911emergencytowing@gmail.com.

Google's guidelines allow multiple profiles at one address only for **genuinely distinct
businesses**. Two towing profiles, same address, same category, websites that are clones of
each other = textbook filtering (one listing suppressed from the pack) or suspension risk —
and towing is one of Google's most fraud-policed categories (video verification is now
standard for tow operators).

### Recommendation

**Primary path: one flagship profile** — "Emergency Towing and Transport" — carrying all
review-building effort, posts, photos, and the primary phone (480) 577-5334, website
`https://emergencytowingaz.com`.

**For the Heavy Rescue profile (if it already exists and is verified):** keep it *only* if
it can be genuinely differentiated, otherwise mark it permanently closed / merge it:

- Primary category: **"Towing service"** stays on the flagship; give Heavy Rescue a
  different primary (e.g. "Crane service"/"Transportation service" fit poorly — realistically
  it will still be "Towing service", which is exactly why filtering is likely).
- Distinct phone: (480) 288-6911 ✓ (already true).
- Distinct website page: `https://emergencytowingaz.com/heavy-duty-towing/` (after the merge)
  — never the same homepage as the flagship.
- The two-profile setup is defensible because the LLC is a real separate legal entity
  with its own USDOT — but expect the pack to show only one of them for any given query.

**If the Heavy Rescue profile is NOT yet created/verified: don't create it.** Put that
energy into the flagship; a heavy-duty *service* on one strong profile outranks two weak
profiles that filter each other.

## Flagship profile optimization checklist

**Core data**
- [ ] Business name: exactly **Emergency Towing and Transport** — no keyword stuffing
      ("… | 24/7 Towing Mesa" will get it suspended in this category).
- [ ] Primary category: **Towing service**. Secondary: **Auto wrecker**,
      **Transportation service**, (add **Roadside assistance** if offered as its own category in the picker).
- [ ] Address: keep 725 E Southern Ave visible only if customers actually come there
      (impound pickups → yes, keep a storefront listing). If it's dispatch-only, it must be a
      **Service Area Business** (address hidden) per guidelines — decide once, don't flip-flop.
- [ ] Service area: Mesa, Gilbert, Chandler, Tempe, Apache Junction, Queen Creek,
      San Tan Valley (matches the site's `areaServed` schema — max 20 areas).
- [ ] Hours: **Open 24 hours**, all 7 days. Never use "hours may differ" hacks.
- [ ] Phone: (480) 577-5334 as primary. If CallRail is added later, tracking number goes in
      the *primary* slot and the real line moves to *additional* — that preserves NAP
      association (doc 05 covers this).
- [ ] Website: `https://emergencytowingaz.com` (update the day the merge goes live).

**Services & attributes**
- [ ] Add every service with descriptions: light-duty towing, medium-duty, heavy-duty/semi
      towing, motorcycle towing, flatbed transport, Landoll/equipment transport, winch-out,
      jump start, lockout, tire change, fuel delivery (if offered), private property
      impound, abandoned vehicle removal, accident recovery.
- [ ] Attributes: identifies as family-owned (true since 2001 — also a differentiator),
      on-site services.

**Content & engagement**
- [ ] Photos: 20+ real photos — trucks with branding, heavy recoveries in progress, the yard,
      team. Towing profiles with recovery photos massively outperform stock imagery. Add
      3–5 new ones monthly (feeds the "photo views" signal and deters spam edits).
- [ ] Business description (750 chars): family-owned since 2001, 24/7, 55-minute East Valley
      response, light-to-heavy fleet, USDOT-registered heavy rescue division.
- [ ] Google Posts: 2–4/month — recent recovery jobs (with photo), seasonal (monsoon
      season stranding, summer heat tire blowouts), service spotlights.
- [ ] Q&A: seed and answer the top 8 questions yourselves (pricing approach, response time,
      cash/card, impound release hours, insurance billing, motorcycle handling, service area,
      heavy/semi capability).

**Reviews**
- [ ] Reply to 100% of reviews (all-time backlog too), within 24–48h.
- [ ] Review acquisition: post-job SMS with the direct review short-link
      (`g.page/r/...` from the GBP dashboard). Drivers ask at drop-off — happy roadside
      customers convert at very high rates in the first hour.
- [ ] Never gate ("only ask happy customers via filter") — violates both Google and FTC rules.
- [ ] Target: parity with the top Mesa competitor's review count within 12 months; respond-
      rate 100%.

**Defense**
- [ ] Turn on GBP email notifications; check "Google updates" pending edits weekly —
      towing listings get frequent third-party/spam edit attempts.
- [ ] Keep verification documents handy (utility bill for the yard, USDOT registration,
      truck photos/video) — re-verification requests are common in this category.

## Citation / NAP cleanup (do after the domain merge)

Canonical NAP to enforce everywhere:
`Emergency Towing and Transport · 725 E Southern Ave, Mesa, AZ 85204 · (480) 577-5334 · https://emergencytowingaz.com`

| Listing | Problem found | Fix |
| --- | --- | --- |
| BBB ("Emergency Transport and Towing") | Business name inverted | Request name correction + add website + pursue accreditation (BBB badge already claimed on the old site) |
| YellowPages | "Emergency Towing Heavy Rescue" title on an emergency-towing-and-transport listing URL | Claim listing, settle on flagship name/phone, fix website link |
| Yelp (5.0★, ~20 reviews) | Verify website + phone after merge | Update website field to primary domain |
| Facebook (/emergencytowingandtransport) | Verify link targets | Point to primary domain; keep posting monthly |
| Wheree, local.yahoo, bubba.ai, SearchCarriers, otrucking (DOT scrapers) | Mixed data across entities | Fix the top ~10 by hand; DOT-scraper sites will keep the LLC's data — that's fine, they refer to the LLC (leave the 288-6911 number there, it's correct for the LLC) |
| Apple Business Connect + Bing Places | Likely unclaimed | Claim both (free, 10 min each, feeds Siri/Apple Maps and Bing/DDG) |

Rule: the **Heavy Rescue LLC's** own listings (FMCSA-derived, carrier directories) keep the
LLC name and (480) 288-6911 — don't overwrite a legitimate second entity's records with the
flagship NAP. Only the *website* field should converge on the primary domain (deep-linked to
`/heavy-duty-towing/`).
