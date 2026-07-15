# 01 · Domain & Site Merge Plan

## Current inventory

### Domains

| # | Domain | Live site? | Indexed? | Phone shown | Platform notes |
| - | --- | --- | --- | --- | --- |
| 1 | `emergencytowingaz.com` | Yes | Yes | (480) 577-5334 | Newest template; deepest service-page coverage |
| 2 | `emergencytowingheavyrescue.com` | Yes | Yes | (480) 577-5334 on site; (480) 288-6911 in directories | **Same template & largely same content as #1** — duplicate content |
| 3 | `emergencytowingandtransportaz.com` | Yes | Yes | (480) 577-5334 | Older site builder; only 4 pages (/, /about/, /services/, /contact/) |
| 4 | `emergencyheavyrescue.com` | No / parked | **No pages indexed** | — | Zero SEO risk; use as redirect-only domain |

### Known indexed URLs (from search-engine inventory, July 2026)

**emergencytowingaz.com**
- `/` (home — "Emergency Towing and Transport Services")
- `/services-light-duty-towing/`
- `/services-heavy-duty-towing/`
- `/services-lockouts/`
- `/services-tirechanges/`
- `/services-private-property-impounds/`
- `/services-landoll/`
- `/contacts/`

**emergencytowingheavyrescue.com**
- `/` (home)
- `/about/`
- `/services/`
- `/services-tirechanges/`
- `/emergency-roadside-assistance/`
- `/gallery/`
- `/blog/`
- `/contacts/`

**emergencytowingandtransportaz.com**
- `/` (home)
- `/about/`
- `/services/`
- `/contact/`

> Before cutover, pull the authoritative URL list per domain from: Google Search Console
> (Pages report) + each site's `sitemap.xml` + a Screaming Frog crawl. The list above is
> what's publicly indexed; there may be more.

## Why merge

- **Duplicate content:** #1 and #2 are near-clones. Google picks its own canonical and the
  other domain's pages get filtered — you're paying for two sites and ranking with (at most) one.
- **Split authority:** backlinks, citations, and directory profiles point at three different
  domains. One domain compounding beats three diluting.
- **Local-pack confusion:** GBP, Yelp, BBB, YellowPages currently link to a mix of domains
  and even mix the two business names (YellowPages lists "Emergency Towing Heavy Rescue" under
  an "emergency-towing-and-transport" listing; BBB has "Emergency Transport and Towing").
  Consistent NAP + one website is a direct local-ranking input.

## Recommendation: consolidate to `emergencytowingaz.com`

Rationale:

1. **Deepest content** — it already has the dedicated service pages (each one is a ranking
   asset for "light duty towing mesa", "heavy duty towing mesa", "landoll transport", etc.).
2. **Brand-neutral** — works for both identities. "Emergency Towing AZ" covers Towing &
   Transport *and* Heavy Rescue; the reverse isn't true.
3. **Short, memorable, keyword-relevant** — best for citations, trucks, and ads.

**Heavy Rescue keeps a home, not a domain:** build a dedicated hub on the primary site —
`/heavy-duty-towing/` (or `/heavy-rescue/`) — carrying the Emergency Towing Heavy Rescue LLC
identity, USDOT 4004745 / MC 1506139, the (480) 288-6911 line, and heavy-recovery content
(rotator/landoll work, commercial accounts). That page becomes the website link for the Heavy
Rescue GBP *if* two profiles are retained (see doc 04).

### Considered alternative (not recommended)

Keeping `emergencytowingheavyrescue.com` as a second, genuinely-different site for the LLC.
Only viable if the content is rewritten to be fully distinct and the business truly operates
as two brands with separate marketing. Today the two sites are clones, so this is extra cost
and ongoing duplicate-content risk for little gain. Revisit only if the Heavy Rescue brand
needs standalone B2B positioning later.

## Migration plan (SEO-safe)

### Phase 0 — Baseline (before touching anything)
- [ ] Verify **all four domains** in Google Search Console (domain-level DNS verification —
      easy once DNS is on Cloudflare, see doc 02).
- [ ] Export current data per domain: GSC queries/pages (16 months), any GA data, backlink
      export (GSC Links report; Ahrefs/Semrush if available).
- [ ] Crawl each live site (Screaming Frog free tier covers <500 URLs) → full URL list.
- [ ] Screenshot/archive current rankings for the ~15 money terms
      ("towing mesa az", "tow truck mesa", "24 hour towing mesa", "heavy duty towing mesa",
      "semi truck towing mesa", "private property impound mesa", "roadside assistance mesa", …).

### Phase 1 — Prepare the primary site
- [ ] Ensure every page that exists on the retired domains has a destination on
      `emergencytowingaz.com` (add `/about/`, `/gallery/`, `/blog/`,
      `/emergency-roadside-assistance/` if missing — see redirect map, doc 06).
- [ ] Add the Heavy Rescue hub page (LLC identity, USDOT/MC numbers, 480-288-6911).
- [ ] On-page pass: unique titles/metas per page targeting one service + geo; `LocalBusiness`
      / `TowingService`* schema (name, address, phone, geo, 24/7 opening hours, `areaServed`
      for Mesa, Gilbert, Chandler, Tempe, Apache Junction, Queen Creek, San Tan Valley);
      click-to-call buttons; embedded GBP map; review snippets.
      *Use `AutomotiveBusiness` → additionalType towing if the builder limits schema types.
- [ ] Self-referencing canonicals on every page; XML sitemap; clean 404 page.

### Phase 2 — Redirects (page-to-page 301s)
- [ ] Implement the map in **doc 06** as Cloudflare Redirect Rules on domains #2, #3, #4
      (mechanics in doc 02). Page-to-page, not blanket-to-homepage — Google treats mass
      home-redirects as soft-404s and you lose page-level equity.
- [ ] Catch-all rule per domain as the last rule: anything unmapped → closest hub page
      (e.g. unknown service URL → `/services/`), homepage as final fallback.
- [ ] Redirects must be **301** (permanent), single hop, and land on the final
      `https://emergencytowingaz.com/...` URL (no chains through www/http variants).

### Phase 3 — Tell Google
- [ ] GSC → **Change of Address** tool from each retired domain property → primary property
      (do this for #2 and #3; #4 isn't indexed, nothing to move).
- [ ] Resubmit the primary sitemap; request indexing of the new/changed hub pages.
- [ ] Update the website URL on **every** profile: GBP (both if two), Yelp, BBB, Facebook,
      YellowPages, Nextdoor, Angi, FMCSA-adjacent directories, etc. (checklist in doc 04).

### Phase 4 — Watch (doc 03 covers ongoing monitoring)
- Weeks 1–6: expect some rank wobble; watch GSC Coverage on the retired domains — indexed
  pages should fall as redirects are processed, and impressions should transfer to the
  primary. Keep redirects live **minimum 12 months**; recommendation: keep the domains and
  redirects forever (renewals are ~$10/yr — cheap insurance and keeps the domains out of
  competitors' hands).

## Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Temporary rank dip during consolidation | Do it in one clean cutover, page-to-page 301s, GSC change-of-address; towing queries are call-driven — keep GBP/LSA running so the phone doesn't go quiet |
| Losing the (480) 288-6911 line's citations | Keep the number live and displayed on the Heavy Rescue hub page; don't NAP-swap old citations to the other number — correct the *website* field only |
| Old hosting auto-renews/serves stale content | Once Cloudflare rules serve the redirects at the edge, old hosting can be cancelled; keep DNS + redirects at Cloudflare |
| Builder platform can't do 301s | Irrelevant — redirects happen at Cloudflare, before the request reaches any host |
