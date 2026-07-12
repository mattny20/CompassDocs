# CompassDocs marketing site

The public landing page for **compassdocs.io**. It's a single, self-contained
`index.html` — no build step, no dependencies, no framework. Everything (styles,
the compass-rose graphic, the theme toggle, the waitlist form) is inline.

## Preview locally

Just open the file:

```bash
open index.html          # macOS
```

Or serve it (so relative links behave like production):

```bash
npx serve .              # then visit the printed localhost URL
```

## Deploy to compassdocs.io

Because it's a static file, any static host works. Pick one:

| Host | How |
| --- | --- |
| **Cloudflare Pages** | Create a Pages project from this repo, set the **build output directory** to `site` (no build command). |
| **Netlify** | New site from repo → **Publish directory** = `site`, build command empty. |
| **Vercel** | Import repo → Framework preset **Other** → **Root Directory** = `site`. |
| **GitHub Pages** | Push `site/` to a `gh-pages` branch (or set Pages source to `/site` on `main`). |

Then point the domain: add `compassdocs.io` as a custom domain in the host's
dashboard and follow its DNS instructions (usually an `A`/`ALIAS` record for the
apex and a `CNAME` for `www`).

> **Tip:** host the marketing site on the apex (`compassdocs.io`) and the app
> on a subdomain (e.g. `app.compassdocs.io`). The "Get started" button links to
> the GitHub repo today; point it at your app once it's deployed.

## Wire up the Cloud waitlist

The waitlist form currently succeeds client-side only (it stores the email in
`localStorage`). To actually collect signups, open `index.html`, find the
comment `// TODO: POST` in the waitlist script, and POST the email to a provider
such as [Formspree](https://formspree.io), [Buttondown](https://buttondown.email),
or your own endpoint.

## Keeping it in sync

The page references the product's real features and quickstart. If those change
(new roles, different commands, a live app URL), update the matching section
here so the marketing copy stays accurate.
