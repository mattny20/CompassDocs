# 02 · Cloudflare Migration Runbook (DNS + Pages front end + Redirects)

Goal: all four domains on **Cloudflare DNS**, the consolidated website served from
**Cloudflare Pages**, and the three retired domains 301-redirecting via **Redirect Rules** —
all on the free plan.

## Target architecture

```
emergencytowingaz.com          → Cloudflare DNS → Cloudflare Pages (the one real site)
www.emergencytowingaz.com      → 301 → apex (Cloudflare redirect rule)
emergencytowingheavyrescue.com → Cloudflare DNS → Redirect Rules → 301 page-to-page → primary
emergencytowingandtransportaz.com → same
emergencyheavyrescue.com       → same (catch-all → /heavy-duty-towing/)
```

Why Cloudflare Pages for the front end:
- Free, unlimited-bandwidth static hosting on Cloudflare's CDN — towing sites are
  content sites; static = fastest possible Core Web Vitals (a ranking input, and page
  speed matters enormously for stranded-motorist conversions on mobile).
- Deploys from a GitHub repo (push → live), preview URLs per branch.
- Automatic HTTPS, HTTP/3, and no hosting bill.

Recommended stack for the rebuilt site: **Astro** (static output) + Tailwind. It's the
best fit for a ~15-page local-service site: zero JS by default, trivial to add one page
per service and per city. (Next.js static export also works; Astro is lighter.)

## Part A — Move DNS to Cloudflare (zero downtime)

Do this **per domain**, one at a time, starting with the least important
(`emergencyheavyrescue.com`) as the practice run.

1. **Inventory current DNS first** (critical — email breaks are the #1 migration mistake).
   From the current DNS host (registrar panel), export/copy every record: A/AAAA, CNAME,
   **MX**, **TXT (SPF/DKIM/DMARC, verification records)**, SRV. The businesses use Gmail
   addresses (911emergencytowing@gmail.com, emergencytowingandtransport@gmail.com) — if
   there's no custom-domain email, MX may be empty, but check for Google Workspace anyway.
2. Cloudflare dashboard → **Add a site** → enter the domain → Free plan.
   Cloudflare auto-scans records; **diff against your inventory** and add anything missed.
3. Keep the proxy (orange cloud) **ON** for A/CNAME web records; MX/TXT stay DNS-only (grey).
4. At the **registrar** (GoDaddy/Namecheap/wherever each domain lives), replace the
   nameservers with the two Cloudflare assigns. Don't transfer the registration yet —
   nameserver change only. (Registration transfer to Cloudflare Registrar later is optional
   and saves a few dollars/yr, but adds a 60-day transfer lock — do it after everything is stable.)
5. Wait for Cloudflare to show **Active** (minutes to a few hours). Site keeps serving from
   the existing host the whole time — the origin hasn't changed, only who answers DNS.
6. SSL/TLS setting: **Full (strict)** if the current host has valid HTTPS (all three live
   sites do); this prevents redirect loops and downgrade issues.
7. Repeat for the next domain.

**Rollback:** point nameservers back at the old provider. Keep the old DNS zone untouched
until fully cut over.

## Part B — Stand up the site on Cloudflare Pages

1. Create a GitHub repo for the site (suggest `mattny20/emergency-towing-az`), build the
   consolidated site there (content plan: doc 01 Phase 1; keep the URL slugs from
   `emergencytowingaz.com` — `/services-heavy-duty-towing/` etc. — so existing indexed URLs
   don't need internal redirects).
2. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** → select the
   repo. Framework preset: Astro (build `npm run build`, output `dist`).
3. Test on the `*.pages.dev` preview URL. Add a `robots.txt` with `Disallow: /` **only on
   preview** (Pages sets `X-Robots-Tag: noindex` on pages.dev automatically — good).
4. **Custom domain cutover:** Pages project → Custom domains → add `emergencytowingaz.com`
   (Cloudflare auto-creates the record since DNS is already there). Add `www` too, plus a
   redirect rule `www → apex`.
5. Verify: pages load, forms/phone links work, `https` everywhere, then cancel the old
   hosting for that domain.

Until the rebuild is ready, the existing `emergencytowingaz.com` host keeps serving through
Cloudflare — Parts A and C don't depend on Part B. Don't block the redirect consolidation
on the rebuild.

## Part C — Redirects for the retired domains (no origin needed)

For each of the three retired domains, requests must terminate at Cloudflare (they need to
resolve somewhere for rules to fire):

1. DNS: add a proxied dummy record if the old host is gone —
   `A @ 192.0.2.1` (TEST-NET, never routed) with proxy ON, plus `CNAME www @` proxied.
   While the old host still exists, just leave existing records proxied.
2. **Rules → Redirect Rules**:
   - Page-to-page mappings from **doc 06**. With ~15 mappings per domain, individual
     redirect rules are fine (free plan: 10 rules/zone — combine with a **Bulk Redirect
     List** if you exceed that: Account → Bulk Redirects → create list → one rule
     references the whole list; free plan allows 20 list entries+, more than enough here).
   - Final catch-all rule per zone:
     `(http.host contains "emergencytowingheavyrescue.com")` →
     `concat("https://emergencytowingaz.com/services/")` — or for
     `emergencyheavyrescue.com` → `https://emergencytowingaz.com/heavy-duty-towing/`.
   - Status: **301**, preserve nothing (query strings can be dropped for these sites).
3. Test each mapping with `curl -I` — expect exactly one `301` hop landing on the final URL.

## Part D — Post-migration checklist

- [ ] All four zones Active in Cloudflare; SSL Full (strict); Always Use HTTPS = On.
- [ ] GSC domain-property verification via Cloudflare DNS TXT for all four (takes 2 minutes
      now that DNS is in one place) — prerequisite for doc 01 Phase 3 and doc 03 monitoring.
- [ ] Email still flows (send/receive test on any custom-domain mailboxes).
- [ ] Old hosting cancelled only after 2 weeks of clean serving.
- [ ] Domain auto-renew ON for all four (redirect domains must never lapse).
- [ ] Optional hardening, all free: Bot Fight Mode ON, Browser Integrity Check ON,
      HSTS after 30 stable days.
