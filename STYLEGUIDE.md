# CompassDocs UI Style Guide

The canonical patterns for every page and component in the app. When adding
or touching UI, match these exactly — consistency across pages is a feature.
If a new need doesn't fit a pattern here, extend this guide in the same PR.

## Page skeleton

Every top-level page:

```tsx
<PageContainer>                       {/* honors the Normal/Wide/Full account setting */}
  <PageHeader icon={<SomeIcon />} title="Page title" subtitle="One-sentence subtitle."
              back={{ href, label }} actions={<Button …/>} />
  …content…
</PageContainer>
```

`components/PageHeader` renders the h1 (`text-2xl font-bold` with the 24px
icon), the subtitle, an optional back link above and an actions slot to the
right. `SettingsPage` and `AccountPage` render it for you. Never hand-write
a page title; a guard test fails the build on an `<h1` outside the
documented exceptions.

**The heading ladder** — one size per level, so readers get a size-to-level
mapping as they move from Dashboard to Space to Document to Settings:

| Level | Element | Recipe | Where |
| --- | --- | --- | --- |
| Page title | `h1` via PageHeader | `text-2xl font-bold` + 24px icon | every top-level page, settings and account sections |
| Document title | `h1` | `text-3xl font-bold tracking-tight`, no icon | the document page, share page, public document — the document is the thing itself |
| Section heading | `h2` via `SectionHeading` | `text-lg font-semibold` | a group of cards within a page |
| Card title | `h3` via `CardTitle` | `text-base font-semibold text-slate-900` | one card |
| Sub-heading | `h4` via `SubHeading` | `text-sm font-semibold text-slate-800` | a block inside a card |
| Eyebrow | `Eyebrow` / `EYEBROW_TEXT` | `text-xs font-semibold uppercase tracking-wider text-slate-500` | a label over a list, table headers |
| Group label | `RAIL_GROUP_TEXT` | `text-2xs font-semibold uppercase tracking-wider text-slate-500` | rail groups, the Settings and Account eyebrows |

Documented exceptions: the dashboard greeting (an `h1` with no icon,
because it is a greeting), the editor's sticky bar (the document title is
the editable field), and the two mastheads — a space (its 48px icon tile)
and a person (their photo) — where the tile or photo stands in for the
24px lucide icon. Standalone surfaces outside the shell (setup, OAuth
consent, error pages, the public site) keep their own titles. Sign-in, its
admin preview and the forced password change (1.16.0) title themselves
with `AuthHeading`, the one h1 of `AuthShell` (§Sign-in surfaces), and
none of those pages writes an `<h1>` of its own.

- **Never hard-code a page width** (`max-w-*` on the page wrapper) — that
  breaks the user's width preference. Narrow *content columns* inside a page
  (e.g. a reading column) are fine when deliberate. The presets themselves
  are `56rem` / `72rem` / `112rem` (Full is bounded, so on an ultrawide it is a
  wide centred page rather than edge-to-edge) and grow with the interface
  scale.
- On the document page the right rail sits beside the article at Wide and
  Full and stacks under it at Normal (`components/DocLayout`): a 56rem column
  cannot share with an 18rem rail without squeezing prose to 45 characters.
  The table of contents goes where the rail goes (1.9.0): pass it to
  `DocLayout` as `toc`, which renders it first in the rail when the rail is
  beside the article ("On this page", capped at half the viewport) and as a
  collapsible card above the body when it is not. `DocToc` reads the placement
  from context; both mark the heading being read with `aria-current="location"`.
- **The sticky document bar has a phone budget** (1.10.0). `StickyDocBar`
  takes arbitrary children; on the document page they are the
  read-confirmation control (`AckStickyControl`, rendered **before the
  title** so it survives truncation), the `StatusBadge`, the truncated title
  and a copy of `DocActions` without the `ack` prop (the shield toggle
  keeps its state locally, so two copies would disagree after a click; A5
  moves it into a popover). Under `sm` the bar shows the **control and the
  title only**, plus, from 1.13.0, the `sm` `error` chip **Overdue** from
  the reader's deadline (the neutral and warn due chips are `hidden
  sm:contents`): the `DocActions` wrapper is `hidden sm:flex`, the control
  collapses to its icon plus "Pending" / "Confirmed" (`text-2xs`), and the
  bar itself never scrolls sideways (`e2e/acknowledgements.spec.ts` asserts
  it at 375px). Nine 36px icon buttons do not fit beside a title on a phone,
  and the bar is exactly where a reader halfway down a policy looks.
- The document editor follows the same rule (1.9.1): at Wide and Full its
  properties sit in a sticky 18rem column beside the editor card, placed by a
  CSS grid (`lg:grid-cols-[minmax(0,1fr)_18rem]`) so each field is rendered
  once, and above it otherwise. The column is a `div`, not an `aside` — the
  sidebar stays the one aside the specs locate. The formatting toolbar is two
  rows: the tools that apply anywhere, then a fixed-height row for the current
  block (heading, table, image, panel), so text never shifts as the caret moves.
- The one such column is the **document reading measure**: put `doc-read` on
  the element wrapping the rendered document body, and `globals.css` caps the
  direct children of `.doc-read .doc-prose` at `var(--doc-measure)`, which
  scales with the Normal/Wide/Full setting — see
  [Reading measure](#reading-measure-rendered-documents) for the values, which
  blocks opt out, and why the cap is on the children rather than the container. Only the
  document page, the share page and the public document page set `doc-read` —
  `.doc-prose` is shared with the tiptap editor and every other `MarkdownView`
  (editor preview, newsletter, training player, version history, review queue,
  AI answers), and those must stay uncapped, so the cap lives on the scoping
  class, never on `.doc-prose` itself. Everything outside the prose column —
  masthead, right rail, notice strip, sticky bar — keeps the full
  Normal/Wide/Full width.
- **Document title.** Every page exports `metadata` (or `generateMetadata`)
  with a page-specific title; the root layout's template appends the
  workspace name, so the tab reads "Users — Acme". Admin pages use
  `settingsMetadata(href)` from `lib/settings-sections` with the same href
  they hand `SettingsPage`; dynamic pages read the entity through
  `lib/page-data` (per-request `cache()`) so the title and the body share
  one query, with a plain fallback ("Document") when it is missing. Auth
  surfaces add `robots: { index: false, follow: false }`. Never set
  `document.title` from a client component. `e2e/smoke.spec.ts` asserts the
  pattern.
- **Every page title carries a lucide icon**, `h-6 w-6 text-compass-600`,
  before the text. Pick the icon once and keep it stable (it may also appear
  in navigation).
- Subtitles: `mt-1 text-sm text-slate-500` (plus `mb-6` when the next block
  needs the gap). Card/section sub-descriptions use the smaller tier:
  `mt-0.5 text-xs text-slate-500`.
- **Header actions wrap; callers never fork them** (1.18.0). PageHeader's
  title block and actions share a row while both fit at their natural
  width; otherwise the actions drop to a row of their own under the
  subtitle, where the slot (`min-w-0 max-w-full flex-wrap`) shrinks to the
  row and wraps its buttons rather than pushing the page sideways — three
  buttons fit a 375px phone. Pass the actions **once, at their full
  labels**: never a `hidden sm:flex` copy beside a phone-only row, never
  `max-sm:sr-only` to trim "Publish handbook" to "Publish". A status chip
  in the slot (the handbook editor's Published / Draft) wraps with the
  buttons; `print:hidden` goes on each control.
- **A page under a section layout that owns the h1** (the Compliance
  section's pages, 1.14.0) titles itself with a `SectionHeading` (h2, its
  lucide icon) and one `text-sm text-slate-500` sentence under it, never a
  second `PageHeader`: the layout's h1 is the page title, and a second one
  breaks the heading ladder. `TeamPolicies` ("Your team's policies") is
  the worked example.
- **A sub-page that must not inherit its section's header** lives in its
  own route group, as `(home)` does: the person record is
  `(record)/compliance/person/[id]` (1.14.0), so it renders its own
  `PageHeader` with a back link instead of the Compliance section's header
  and tab row.
- **A page that must not have the app shell at all** lives in a route
  group beside `(app)`, not under it: the printed handbook is
  `(print)/handbooks/[id]/print` (1.18.0, §Print), with no sidebar,
  palette or skip link. It repeats what `(app)/layout.tsx` does first
  (sign-in, the forced password change) before its own read check.
- **A chapter inside a page keeps the ladder** (1.18.0). In the handbook
  reader the h1 is the handbook's (PageHeader); the policy on screen is an
  `h2` at the document-title size (`text-3xl font-bold tracking-tight`),
  so a policy reads as the document it is while the page keeps one h1
  (§Handbooks).

### Standalone link pages (the one exception)

Pages reached by an unauthenticated tokenized link — the share page
(`/share/<token>`) and the image drop page (`/upload/<token>`) — sit outside
the app shell and **do** hard-code a column — `mx-auto max-w-standalone` (a
`clamp(56rem, 52vw, 76rem)` token, so it grows with the screen) for a document
column, `max-w-2xl` for a form — with a `<Brand>` header instead of the
sidebar. The public site (`/public`) uses the same column. That is not a violation of the
rule above: the rule protects a *preference*, and the person opening one of
these links may have no account at all, so there is nothing to honor. They also
skip the lucide page-title icon — the h1 is the thing itself (a document title,
"Add an image to X"), not a navigation label.

Keep this list closed. A page that a signed-in user reaches from the product is
a top-level page and uses `PageContainer`, however standalone it feels. The
one page that looks like an exception is not: the sign-in preview
(`/login/preview`, 1.16.0), which an admin opens from Settings → Workspace →
Sign-in page, is the sign-in page itself rendered with scripted answers, so
it wears `AuthShell` like `/login` (§Sign-in surfaces), not a page shell of
its own.

## Sections and cards

- Card: `<Card title description actions icon padding>` from
  `components/Card` (`rounded-xl border border-slate-200 bg-surface
  shadow-xs`; `p-5` for forms and settings, `p-4` for dense content,
  `padding="none"` when the children own it — a table — which gives the
  header an inner `border-b border-slate-100 px-4 py-3` row). The bare
  recipe is `CARD_CLASS` for the rare wrapper that cannot be a `Card`.
- **A card that holds a popup menu is `CARD_CLASS`, not `<Card
  padding="none">`** (1.18.0). `padding="none"` adds `overflow-hidden` (so
  a table's corners stay round), which also clips any `Popover` hanging
  from a row inside it. The handbook editor's Contents card is the worked
  example: a `<section className={CARD_CLASS} aria-labelledby>` whose rows
  each carry a "Where people find it" menu; it draws the header row
  (`border-b border-slate-100 px-4 py-3`) itself. A card that only clips
  its own decoration (the reader's policy page, with its accent wash) may
  add `overflow-hidden` because nothing floats out of it.
- Headings below the page title come from `components/Heading` and step
  down one size per tier: `SectionHeading` (h2, `text-lg font-semibold`, a
  group of cards — "Users (2)"), `CardTitle` (h3, `text-base font-semibold`,
  one card), `SubHeading` (h4, `text-sm font-semibold text-slate-800`, a
  block inside a card), `Eyebrow` (`text-xs font-semibold uppercase
  tracking-wider text-slate-500`, a label over a list or a table header).
  Rail group labels are the smaller tier (`RAIL_GROUP_TEXT`). Levels follow
  the document outline; sizes follow the tier — never make a card title
  `text-lg` or an eyebrow `text-sm`. Icons sit before the text at 20px
  (section), 16px (card, sub-heading) or 14px (eyebrow), in `text-compass-600`.
- **End-of-article action card** (1.10.0). When a document asks the reader
  for one thing once they have read it — a read confirmation today — the
  control lives in a card **after the article**, between `</article>` and
  the feedback row, never only in the strip above it (a reader who finishes
  a long policy should not have to scroll back up). The recipe is the
  `TrainingPlayer` gate panel: a `<section id tabIndex={-1}
  aria-labelledby>` with `scroll-mt-20` (5rem, the sticky-bar clearance
  `DocToc` gives headings), a 48px `bg-compass-50` circle holding the lucide
  icon, a `CardTitle` carrying the `aria-labelledby` id, **one statement
  sentence** (the confirmation statement, see §Vocabulary) and nothing
  else, an optional meta line (`text-xs text-slate-500`: "Version 12 ·
  published {date} by {author}"), and **one `lg` primary `Button`**
  (`busy`, wired through `useAction()`, full width under `sm`). A
  re-confirmation (1.11.0) adds, above the statement, **one reason line**
  (`text-sm font-medium text-slate-700`: the change note, the manager's
  reason or the annual cycle) and, only when the text changed, a native
  `<details>` disclosure (the `DocBlocksStatic` accordion recipe:
  `rounded-lg border border-slate-200 bg-surface text-left`, a `summary`
  in `text-sm font-semibold`) listing the versions since the confirmed one
  above `DocDiff` with a "+{added} / −{removed} lines" header and an
  "Open in version history" link; a re-ask that changed no text shows the
  reason line and no disclosure. The sticky control reads **Re-confirm
  needed** when an earlier confirmation lapsed. A policy that requires a
  typed signature (1.12.0) adds, between the statement and the button, the
  **Sign to confirm** block (the training player's recipe: a `max-w-md
  rounded-lg border bg-canvas p-4` panel, a `SubHeading` with `PenLine`,
  `<Field label="Type your full name to sign" help="Exactly as it appears
  on your account: {name}"><TextInput autoComplete="name"/>` and, for a
  local account, `<Field label="Re-enter your account password"><TextInput
  type="password" autoComplete="current-password"/>`). The button is
  `aria-disabled` (never `disabled`, so it stays focusable) with
  `aria-describedby` pointing at a visible `text-xs text-slate-500` line
  "Sign above to confirm" until the typed name matches under `nameKey`;
  the click is ignored until then. The statement itself renders through
  `MarkdownView` at the card's size. The done
  state is plain text inside the same card — the emerald `CircleCheckBig`
  and "You confirmed version 12 on {date}" (", signed as {name}" on a
  signed confirmation) — never a second card or an
  inline flash; the toast is the announcement, and focus moves to the
  section after success. The done state carries one `link`, **View your
  record** (1.14.0, `/compliance/person/me`), beside the confirmed line;
  My policies (1.12.0) links the other way, from its rows to this card,
  and to the same record as **Your record**. The strip at the top keeps **one
  sentence and one action**: a `secondary` `sm` `<Button
  href="#confirm-reading">` (a real anchor so it works without JS;
  `onClick` adds `scrollIntoView` unless reduced motion, then focuses the
  section). Change notes, reasons and diffs belong in the card, not the
  strip. A `hidden print:block text-xs` line after the article states the
  reader's standing, so a printed policy carries it. `AckCard`
  (`#confirm-reading`) is the first.
- **A triage queue** (1.14.0; the compliance Overview's Needs attention in
  `PortalOverview` is the worked example; the training Overview's is the
  older hand-rolled one): a `padding="none"` `Card` whose description is
  the count line ("showing 12 of 19 · 7 snoozed"), rows in a `divide-y`
  list: the person (a link to their record), the subject (a link), one
  `sm` chip for the reason (tone by severity: `error`, `warn`, `neutral`)
  and the actions as `secondary` `sm` Buttons with `data-tt`; policy-level
  rows lead; a `SectionEmpty` "Nothing needs attention."; after an action
  removes a row, focus moves to the neighbouring row, else the card.
- **An invitation strip** (1.14.0, the lead's banner on My policies): one
  sentence and one `link` in the bulk bar's tint (`rounded-lg border
  border-compass-200 bg-compass-50/70 px-3 py-2 text-sm text-slate-700`),
  `print:hidden`, above the page's content; never a `notice-*` class
  (those are state, not an invitation) and never a second card.
  `TeamLeadBanner` is the first.

## Dashboard tiles

The home dashboard (1.17.0, `app/(app)/(home)/page.tsx`) is a set of
sections, and **every section but the status strip is one
`DashboardTile`** from
`components/dashboard/DashboardTile`: `<DashboardTile id title actions
footer flush className>`.

- **The title is inside the tile.** The tile is the card (`rounded-xl
  border border-slate-200 bg-surface shadow-xs`); its first row holds the
  `h2` (`text-lg font-semibold`, the section tier, named by
  `aria-labelledby` so the tile is a findable region) and, on the right,
  `actions`: one small control or link ("New space", "Directory →", the
  Following | Everything `Segmented size="sm"`, a 28px
  `iconButtonClass("bordered")` with `data-tt` and `aria-label`) or a
  `text-sm text-slate-500` meta ("Most read in your spaces", "2 of 3
  due"). The row wraps: in a narrow tile the actions drop under the title
  instead of squeezing it. Never a heading above a bare card, which was the
  pre-1.17.0 dashboard. Meta a phone can do without is `hidden @md:inline`
  (the page's container, below).
- **`id` is the section key** from `lib/dashboard-sections`
  (`status`, `latest`, `popular`, `spaces`, `training`, `compliance`,
  `quick_links`, `my_team`, `people`); it becomes `data-dashboard-section`
  and the heading's id stem, and specs locate tiles by it.
- **Body**: inset (`px-2 pb-2`, rows with their own `px-2` padding) by
  default; `flush` for a table or a divided list that runs edge to edge
  (cells `px-4`, so they line up with the title). Labels inside a tile are
  `TileLabel` (the group-label tier with a 14px lucide icon: "Pinned by
  you"). **`footer`**: one or two links under a hairline ("Add a quick
  link" · "All links →", "Open the directory"); a footer with nothing to
  link is a `text-slate-500` sentence ("Updated in the spaces you follow")
  or absent. A tile whose last row has a hover band and no footer passes
  `className="overflow-hidden"` (only when nothing in it has a `data-tt`,
  which would clip).
- **A compact table in a tile** (Latest): `table-fixed`, a `bg-slate-50`
  header row in the eyebrow tier, fixed widths for the side columns
  (Space 12.5rem, Updated by 10rem, the time 5.5rem with an `sr-only`
  header), the primary column truncating. It **folds under a ~40rem
  tile** (`@container` around the table, `@min-[40rem]:` on the side
  columns): the type badge, the space and the person move to a line under
  the title. An initials avatar in a cell is a 22px `bg-compass-100
  text-compass-700` circle; times are `RelativeTime`.
- **Layout**: the greeting and Ask, the status strip, the pinned blocks
  (announcements, newsletters, Needs your attention, Pick up where you
  left off), then the tiles in two columns inside an `@container`: from
  `@4xl` (a 56rem content column, where the old grid split; Wide and Full
  at a desktop, never Normal) a `minmax(0,1fr)` left column and a 19rem
  right one, as a flex row (`@4xl:flex-row`, right column
  `@4xl:w-[19rem] @4xl:shrink-0`); below it one column, the right column's
  tiles after the left's. **24px between tiles** in both directions
  (`gap-6`), never a margin on a tile. Two tiles that pair up (My training
  and Team compliance) sit in an `auto-fit` grid
  (`minmax(min(100%,18rem),1fr)`), so one alone takes the row.
- **Hide when empty.** A tile that has nothing for this person (no
  training assigned, no reports, nothing read this week, no directory
  link) is not rendered at all: its component returns `null`, never an
  empty card. A column (and the pair row) is `empty:hidden`, so a column
  with no tiles takes no gap. A tile whose list is merely empty for now
  but that the person can fill (Quick links, Latest in Following) keeps
  the tile and shows a `SectionEmpty` with its action.
- **Data**: each tile is an async server component that fetches its own
  data (taking `user`, and the `scope` / drafts flag the page resolved,
  never a scope of its own), so the tiles render in parallel; work two
  places need (the pick-up cards and Latest's exclusions) is started once
  in the page and handed down as a promise. A tile's client parts live in
  a sibling `…Client.tsx`. Overlays a tile opens are `Modal`s (portalled):
  the tile columns are a container, and a container is a containing block
  for fixed descendants (§Overlays).
- **Edit dashboard** (`EditDashboardButton`): a `link`-weight text button
  with a 14px `Pencil`, on the date's line under the greeting, opening a
  `Modal` with one `Toggle` per section (label and a one-sentence help) in
  dashboard order, Cancel and Save. Save `PUT`s the whole hidden set to
  `/api/account/dashboard` (stored in `users.dashboard_hidden`) and
  refreshes; **a hidden section is neither rendered nor fetched**. The
  dialog offers only what the workspace has (no My training without the
  training feature, no Team compliance without read confirmations). The
  pinned blocks above the tiles are not sections and cannot be hidden: they
  are things waiting on the person.
- **The status strip** (`StatusStrip`, key `status`) is the one full-width
  row that is not a tile: a slim card (`px-4 py-2.5 text-sm`) with an
  `sr-only` h2 "System status", a summary with a dot ("All systems normal",
  "1 service degraded", red dot when any is down), every tracked service as
  an 8px dot and its name (problems first, the problem in its ink:
  `ink-warn`, `text-red-600`, sky for maintenance; operational ones carry
  an `sr-only` status), at most eight then "+N more", and "Status →" to
  `/status`. A phone shows the summary and the link only. Left out when no
  service is tracked. It replaces the pre-1.17.0 problems banner.

## Empty states

Two tiers, and both come from `components/form` — never hand-roll a "nothing
here" box. (Sixteen pages once shipped eleven different ones: dashed and solid
borders, four paddings, three greys, two of them with an emoji.)

- **Page-level** (the whole page, or its whole content region, has no content
  yet): `<EmptyState icon title body action?>`.

  ```tsx
  <EmptyState
    icon={<Trash2 />}
    title="Trash is empty"
    body="Deleted documents wait here before they're removed for good."
    action={{ href: "/search", label: "Search documents", icon: <Search /> }}
  />
  ```

  It renders the card the page skeleton implies — `rounded-xl border
  border-slate-200 bg-surface px-4 py-10 text-center shadow-xs` — with three
  tiers inside it that mirror the page header: a lucide icon (`h-8 w-8
  text-slate-400`, applied by the component), a headline (`text-base
  font-semibold text-slate-800`), and a sentence (`text-sm text-slate-500`,
  capped at `max-w-md`). **The border is solid** — a dashed border is a
  drop-zone idiom this app uses nowhere else, and it was the loudest source of
  drift.
  - Pass the icon as an **element**, `icon={<Inbox />}` — never an emoji, and
    never a size of your own. Emoji ignore the workspace accent, so a re-skinned
    workspace is left with yellow sparkles.
  - **Fill `action` whenever a real destination exists.** An empty state that
    names a place in prose ("…under Settings → Directory") and doesn't link it
    is a dead end; `action` takes `{ href }` (safe from server components) or
    `{ onClick }` for a handler already on the page. Rare extras — search tips,
    a second link — go in `children`, under the body.
  - Say what *will* appear here, not just that nothing is. Keep it to a
    headline plus one or two sentences.

- **Section-level** (a list inside a card is empty): `<SectionEmpty>` — plain
  `text-sm text-slate-500` in the flow of the card, **no box-in-box**. It takes
  the same optional `action` (rendered as an inline accent link) and a
  `className` for the padding when the surrounding list owns it
  (`<SectionEmpty className="px-4 py-6">`).

**`slate-400` never carries words.** It measures 2.56:1 on the canvas, below
the AA floor, so it is the **icon/decorative tone** only — icons, chevrons,
dividers, input placeholders. Any run of text, however small (help lines,
timestamps, captions, rail group labels, "Saved" states, empty lines, the
label before a chip row), is `text-slate-500` or darker. Don't darken the
token itself; that would collapse it into `slate-500` for icons too.
`test/style-drift.test.ts` fails on `text-slate-400` next to a text size.

## Buttons

Every text button comes from `components/Button`: `<Button variant size
busy icon href>` (a `<button>`, or a `<Link>` when `href` is set), or
`buttonClass(variant, size, extra)` where the element must stay bare (a
form `<button>` with a ref, a menu item). The review that produced it
measured 41 distinct primary recipes across 79 sites; a guard test now fails
the build on a primary recipe written outside the module.

- Variants: `primary` (`bg-compass-600 text-white font-semibold`),
  `secondary` (bordered, `font-medium`), `ghost` (text only, tinted hover),
  `danger` (red border and ink, `hover-danger`). Destructive hover is always
  `hover-danger` — never a bare `hover:bg-red-50`, which paints a pale slab
  in dark mode.
- Sizes have **fixed heights** so adjacent controls line up: `sm` (h-7,
  `text-xs`, row actions in tables), `md` (h-9, the default), `lg` (h-10,
  hero and sign-in actions).
- `busy` shows a spinner before the label, keeps the label and disables the
  control; `icon` takes a lucide element and sizes it.
- Radius scale: cards `rounded-xl`, controls `rounded-lg`, small controls
  `rounded-md`, chips `rounded-full`.
- **Icon-only controls** use `iconButtonClass("quiet" | "bordered", "sm" |
  "md")`: a square box of at least 28px (WCAG 2.5.8 and a 2560 panel), the
  icon centred, `data-tt` plus `aria-label` from the caller. Never a bare
  `p-0.5` / `p-1` around a 14px glyph. The `Toggle` is 44×24 with a visible
  off track.
- Prefer **icon buttons with tooltips** where the action is obvious from the
  icon (toolbars, table row actions, dense UI); keep icon + text where the
  action is rare or destructive.
- **An alternate-path action** on a sign-in surface (1.16.0: "Use a password
  instead", "Use single sign-on instead", "Use a recovery code", "Use your
  authenticator app", "Back") is `<button type="button" className="link
  text-sm font-medium">`, or `<a className="link …">` when it goes to
  another address. It is the one link-styled text button in the product,
  and it sits flush left in a column under the form (`mt-6 flex flex-col
  items-start gap-3`), never in a row beside the submit and never as a
  `ghost` button: it is a way round the form, not a second action of it.
- **On sign-in surfaces** the submit is a bare `<button type="submit"
  className={buttonClass("primary", "lg", "w-full")}>`, whose busy state is
  `aria-disabled` rather than `busy` (§Sign-in surfaces), and a single
  sign-on hand-off is an `<a href>` styled with `buttonClass`, never
  `<Button href>`: next/link can prefetch the GET that starts an identity
  provider's flow.

## Tooltips

- **Relative times** ("3d ago") are `<RelativeTime value>` from
  `components/RelativeTime`: a real `<time dateTime>` whose house tooltip
  is the workspace-formatted exact time, shown on hover and on keyboard
  focus. Never a native `title` holding the raw database string.

Use the custom tooltip, never the native `title` attribute on interactive
elements (browsers show `title` slowly, unstyled, and never on keyboard
focus):

```tsx
<button data-tt="Download CSV" aria-label="Download CSV" …>
  <Download className="h-4 w-4" />
</button>
```

- `data-tt="Label"` on the element itself; `data-tt-pos="bottom"` when the
  element sits near the top of the viewport or under a sticky bar (the
  sidebar header, the editor toolbar); `data-tt-pos="right"` in the collapsed
  sidebar rail, where the bubble is the only label and must escape the
  rail's scroll container (it is `position: fixed` there);
  `data-tt-align="start"` on an element flush with the left edge of the
  viewport (the sidebar brand) so a long label grows rightwards instead of
  running off-screen; `data-tt-wrap`
  on a label longer than a few words so it wraps instead of becoming a
  450px pill. One tooltip per control: never add a hand-rolled hover span
  beside `data-tt`. A control with `aria-expanded="true"` shows no tooltip
  (the open panel is the label), so a popup trigger keeps `data-tt` and
  sets `aria-expanded` rather than toggling the attribute.
- **A control flush with a card's right edge** (a Contents row's Remove
  `X`, 1.18.0) keeps its tooltip to one word ("Remove"): the bubble is
  centred on the control, so a long one hangs past the edge and, even
  hidden, widens a 375px page into a sideways scroll. The `aria-label`
  keeps the whole sentence ("Remove {title} from the handbook"). There is
  no end-aligned variant; `data-tt-align="start"` is for the left edge.
- **Icon-only on a phone only** (a row action whose words are
  `max-sm:sr-only`, the editor's "Rename section"): it carries `data-tt`
  with the same words and `sm:after:hidden!`, so the bubble labels the
  bare pencil under `sm` and never repeats the visible words beside it.
  (`!`: the `[data-tt]` rules are unlayered.)
- **Icon-only controls must also carry `aria-label`** (matching the tooltip
  text) — `data-tt` is presentation, not an accessible name. Elements with
  visible text must NOT get `aria-label` (it would override the text).
- The `<Tooltip>` wrapper (`components/Tooltip.tsx`) exists for disabled
  buttons and third-party children that can't carry the attribute.
- Tooltips clip inside `overflow-auto/hidden` containers — inside scrolling
  tables keep labels short or keep native `title`.
- Plain-text truncation previews (full title on a truncated cell) may keep
  native `title` — that's content, not a control label.

## Settings pages

- Every `/admin/*` page wraps its content in `<SettingsPage href="/admin/…">`
  — the header (icon + label + description) comes from
  `lib/settings-sections.ts`, the same source the nav uses. Never hand-write
  a settings page header. **The section is the page's `h1`** at the page-title
  size (`text-2xl font-bold`, 24px icon); the console layout above it renders
  only a small "Settings" eyebrow, never a second heading, so a page has one
  `h1` and the first control sits near the top. A routed page that lives
  under a section without the `SettingsPage` header (email templates) renders
  that `h1` itself.
- The settings rail is sticky and self-scrolling (`sm:sticky sm:top-6
  sm:max-h-[calc(100vh-3rem)] sm:self-start sm:overflow-y-auto` on its
  wrapper in `admin/layout.tsx`): it stays put while a long page scrolls and
  fits a 900px-tall laptop by scrolling inside its own box. Its rows are the
  shared rail recipe below, in the dense size.
- New sections register in `settings-sections.ts` (pick the group:
  Platform / Content / People & access / AI / Operations) — that's the only
  place a section's identity lives.
- Sub-section headings inside a settings page:
  `mb-3 text-lg font-semibold text-slate-900`.
- Save/action feedback is a toast — `toast("ok", "Thing saved.")` /
  `toast("error", msg)` from `components/Toasts` (a single ToastHost is
  mounted in the app layout). No transient inline "Saved" flashes. Inline
  red text stays only for field-level validation; persistent status banners
  (license expiry, TLS state, import results) stay inline — they're state,
  not feedback.
- **Form controls come from `components/form`** — see §Forms. `<Field label
  help error size>` wrapping `<TextInput/>`, `<Select/>`, or `<Textarea/>`;
  boolean settings use `<Toggle label help checked onChange/>`. Never
  hand-roll an input class (the guard fails the build).
- Settings pages honor the account width preference like every other page —
  `SettingsPage` adds **no** width cap of its own. A readable column here
  would silently override Normal/Wide/Full (this shipped once, in 0.85.0);
  the "never hard-code a page width" rule has no settings exception.
- Destructive page-level actions live in a **danger zone** —
  `<DangerZone><DangerAction label description>…</DangerAction></DangerZone>`
  (red-bordered card, one per page, at the bottom). Per-row destructive
  buttons in lists ask with `confirmDialog({ danger: true })` instead.
- **Sub-pages are declared once.** A section's routed pages live in its
  `pages` entry in `lib/settings-sections.ts` and its in-page cards in
  `topics` (an `#anchor` on the card: `id="trash" className="scroll-mt-6 …"`).
  The section's layout renders `<SubNav label items={settingsPages(href)}>`
  (`components/SubNav`) under `SettingsPage`; the rail search indexes
  sections, pages and topics as "Section › Topic" rows (`SETTINGS_INDEX`),
  gated by the section's reachability. A new card worth finding gets an
  id and a topic in the same PR; never a hand-rolled tab row.
- **A section with several jobs gets pages, not a longer page.** When one
  settings section holds distinct tasks (the directory: people, fields,
  offices, export, sync), each task is a route under the section
  (`/admin/directory/fields`) sharing a `layout.tsx` that renders the
  `SettingsPage` header and a **sub-navigation row** — underline tabs
  (`border-b-2`, active `border-compass-600 text-compass-700`, inactive
  `border-transparent text-slate-500`), each with its lucide icon, in a
  `<nav aria-label="…">` of `<Link aria-current="page">`s (they navigate, so
  they are links, not `role="tab"`). The rail entry stays lit for every page
  under the section. The signal that a page needs splitting: more than one
  primary Save button visible at once, or a card the reader has to scroll to
  find. See `components/directory-admin/DirectorySubnav.tsx`.
- **One primary action per card, at its bottom-left**, `mt-4 flex
  items-center gap-3`: the button, then the state (`Unsaved changes` in
  `text-xs text-amber-600`, or `Saved` in `text-xs text-slate-500`). A page
  whose cards are one document (office fields + office values) has one Save
  below the cards, not one per card.
- **A per-document settings tab** (1.12.0): the Read confirmation page's
  Settings tab is a routed page under the record's layout
  (`doc/[id]/acknowledgements/settings`, guarded like the record), its cards
  stacked and sharing one `{ s, set, errors }` model, with one `SaveRow`
  "Save settings" (`useUnsavedChanges`) as the page's only primary action.
  A card's own action (Retire policy…, Un-retire) is a `secondary` or
  `danger` button that opens `formDialog` / `confirmDialog`, or (1.13.0) a
  `secondary` button that tells with Undo ("Also move existing
  deadlines"), never a second Save. The cards are six (1.13.0):
  Confirmation statement, Who must confirm, Deadline, Reminders,
  Re-confirmation, Lifecycle. `PolicySettingsPanel` is the worked example.
- **A card whose values live behind a second route** (the Program settings
  page's Compliance report card, 1.14.0) still saves through the page's
  one Save: the Save sends the page's PUT, then the card's PUT only when
  that block changed, and a refusal of the second is toasted with the
  server's sentence and leaves the page dirty. `ProgramSettingsPanel` is
  the worked example.
- **An optional group of fields a form rarely needs** ("Policy defaults"
  on a space, 1.13.0) is a native `<details>` with a `summary` in `text-sm
  font-semibold` (the DocBlocksStatic accordion recipe), closed by
  default.
- **A settings list with one editable item at a time (export presets) is a
  two-pane layout** (1.11.2): a rail-row list on the left (chips for state),
  the selected item's editor on the right in grouped cards with one Save row
  for the page. The list is a `padding="none"` `Card` whose rows are
  `<button>`s in `railRowClass(active, { dense: true })` with
  `aria-current="true"` on the lit one (they change what the editor shows,
  not the page, so they are not links), each carrying `chipClass(tone,
  "sm")` chips for the states worth seeing before opening it (**Default**
  `info`, **ZIP** `neutral`, **Scheduled** `accent`), and one secondary
  **New …** button in a footer row. The schedule sentence is not a tooltip
  (the chip sits inside the row button, which cannot hold a focusable, and
  the card clips its overflow) but a `text-2xs text-slate-500` truncated
  line under the chips, so it reads on keyboard, touch and hover alike; the
  chips carry `sr-only` commas and expansions so the row's accessible name
  is a sentence ("Phone list, Default, ZIP, one file per value, Scheduled,
  Every Friday at 07:00 UTC"). The editor is a header row (the item's name
  as a plain `CardTitle`, an `h3` like the cards under it so the outline
  stays flat: the lit row and its chip already say which item is open; its
  actions: Make default, Duplicate, Download, Delete in `danger`) over
  stacked `Card`s, each a `CardTitle` plus a one-line description and an
  `id` with `scroll-mt-6` registered as a `topics` entry ("Export › Page"),
  and the `SaveRow` sits below both panes. Download is a link with
  `download` while the page is clean (the leave guard lets it through) and
  a disabled `Button` inside `Tooltip` ("Save first to download this
  preset") while anything on the page is unsaved, the item's own rows or a
  definitions card's; Delete is wrapped in `Tooltip` ("Keep at least one
  preset") only while it is disabled. The panes are
  `lg:grid-cols-[18rem_minmax(0,1fr)]` and stack under `lg`, list first;
  the editor wrapper is a `@container` and its cards' grids use `@sm:` /
  `@md:` / `@2xl:` variants, because the pane, 18rem narrower than the
  column, is the width they share (§Scaling). `PresetList` /
  `PresetEditor` (`components/directory-admin/export/`) are the worked
  example. A set inside a card that is only put in order, never added to
  or taken from (the Order and filter card's **Section order**, 1.13.0),
  is the same `OrderedKeyList` with `removable={false}` in a fieldset with
  a legend, one row per item with a `text-2xs text-slate-500` count as its
  `extra` (a second `text-2xs` line under the count for a fact about the
  row, such as "Head: Jane Smith"), a `LoadingRow` while its route answers,
  a `SectionEmpty` when it has no rows, and one secondary **Reset …**
  button under the help. A `Toggle` that only means something once the
  data allows it (the card's **Section heads first**, 1.13.0, shown only
  when the chosen Sections by field has a head) sits under the control it
  qualifies and is left out, not disabled, until then.
- **An ordered pick from a large pool** (a policy set's members, 1.14.0)
  is a single-mode `EntityPicker` that appends ("Add policies in order…")
  over the same `OrderedKeyList`, labels numbered from the current order
  ("1. Acceptable Use"), `minimum={0}`, `available` = the chosen items so
  no add menu renders, and the item's facts as the row's `text-2xs
  text-slate-500` `extra`. `PolicySets` is the worked example.
- **A short table of definitions edited in place** (export markers, 1.11.2)
  is a `padding="none"` `Card` holding a `Table` whose rows are dense
  controls (`TextInput` / `Select` with `dense` and an `aria-label` naming
  the row: "Symbol for Public notary"), an icon-only Remove
  (`iconButtonClass`, `data-tt` plus `aria-label`), and a footer row with
  the card's own non-sticky `SaveRow` and a secondary **Add …** button as
  its child. The shared help, or the first touched row's problem, is one
  line under the table with `hasError` on the offending control only (the
  OrderedKeyList rule). The card keeps its own Save because its rows are
  definitions the page's other Save refers to by id (a preset can only
  tick a saved marker), and the page's sticky row belongs to the presets:
  the card's `SaveRow` passes `shortcut={false}`, so Ctrl/⌘+S saves the
  presets alone (two rows answering one keystroke would fire two saves)
  and the row's keycap hides with it. Focus never falls to `<body>`: Add
  focuses the new row's first input, Remove the next row's Remove (the
  previous row's when the last went, the Add button when the table is
  empty), and a choice that reveals an input ("Other…") focuses it. The
  input whose value is the row's label is named by position ("Name of
  marker 2"), since a name that changed on every keystroke would chatter;
  the row's other controls take the typed label. Add is wrapped in
  `Tooltip` ("Up to 24 markers.") once the limit is reached.
  `MarkersCard` is the worked example.
- **An image upload on a settings page acts at once**, like the logo
  (1.16.0, the sign-in artwork): Upload and Replace store the file, toast
  and `router.refresh()`, and never dirty the page's `SaveRow`, so a typed
  but unsaved field survives them; Remove deletes files and cannot be
  undone, so it asks through `confirmDialog({ danger: true })`. The file
  input is `sr-only` with `tabIndex={-1}` behind a `secondary` button with
  `ImageUp`, and the accepted types, the size limit and the smallest
  useful size are one `text-xs text-slate-500` line under it.
- **A focal-point picker** (1.16.0, "Keep in view" on the sign-in artwork)
  is a `fieldset` with a legend holding the **uncropped** picture
  (`object-contain` in a box at the image's own aspect ratio) and, over
  it, a `role="radiogroup"` of nine cells in a 3×3 grid: each a `<button
  role="radio" aria-checked>` named for its place ("Top left", "Center"),
  one tab stop (roving `tabIndex`), Left and Right moving within a row, Up
  and Down between rows, Home and End to the corners, the choice following
  focus. The chosen cell's dot is `h-4 w-4` accent with a white border and
  `shadow-float`; the others are small white dots that brighten on hover
  and keyboard focus (literal white and black: they sit on the picture,
  which does not follow the theme). One help sentence under it is the
  group's description. `FocusPicker` in `SignInPageSettings` is the worked
  example.
- **A preview of a whole page is the real page in an iframe at a real
  device size** (1.16.0, the sign-in page's Preview card;
  `components/auth/PreviewFrame`), never a component scaled down in place:
  rem, `clamp()`, `cqi` and breakpoints then resolve exactly as on the
  device. The iframe is laid out at the preset's viewport in px (Laptop
  1440×900, Ultrawide 3440×1440, Phone 390×844; §Scaling allows it) and
  scaled with a `transform` to the card's width (a phone to at most 32rem
  tall, centred), measured by a `ResizeObserver`. The wrapper is a leaf,
  `inert`, `overflow-hidden rounded-lg ring-1 ring-slate-200`, so nothing
  inside it takes focus or a click; the iframe has a `title`,
  `tabIndex={-1}` and `loading="lazy"`; its address carries the form's
  unsaved values and follows them 400ms behind, dimmed with `busyClass`
  until it loads; only the chosen preset is mounted. Size and theme are
  two `sm` `Segmented` controls with `flex-wrap` (§Segmented controls),
  and **Open full-size preview** opens the same page in a new tab. The
  previewed page must send nothing anywhere (the sign-in preview runs on
  a demo transport), and the card says so. The card sits beside the
  fields it previews, sticky (`@3xl:sticky @3xl:top-6`), from a 48rem
  container, so the default Wide column (53rem) keeps it in view while a
  field is typed in; narrower, it stacks above them in a
  `grid-cols-[minmax(0,1fr)]` track, so no card's content can widen the
  column on a phone.

## Forms

One field recipe, one input recipe, one width scale. Everything lives in
`components/form`.

- **`<Field label help error size className>`** wraps one control. The
  label is the control's accessible name; the help or error line is its
  *description* — Field generates the ids and hands `aria-describedby` and
  `aria-invalid` to the control through context, so a call site writes
  nothing. An `error` replaces the help, turns the border red and is
  announced (`role="alert"`) the moment it appears. Validation is inline:
  bounded numbers use `rangeError(value, min, max)`; rule checks (a
  username pattern, a minimum length) run on the client with the same
  rules the API enforces, shown once a submit has been attempted
  (`tried`), and the first invalid control is focused. Never let the
  server clamp a value and then toast "saved".
- **`<FormError>`** is the banner for a failure that belongs to the whole
  form — a wrong password, a server refusal. It is an alert, renders
  nothing while empty (so it can sit in the markup unconditionally), and
  is the only inline error that is not a field's.
- **`<TextInput>`, `<Select>`, `<Textarea>`** are the controls (forwarding
  refs; every native attribute passes through — keep `autoComplete`,
  `inputMode`, `type`, `maxLength`, `spellCheck`). `dense` is the compact
  variant for table rows and toolbars (`px-2.5 py-1.5`). A search box with
  an icon inset or a control outside a Field (a filter in a toolbar) uses
  the same component with `aria-label` and padding extras, or
  `controlClass(hasError, extra, dense)` on a raw element when a component
  can't be used. Extras that set a width, padding, radius, text size or
  surface replace the recipe's own (`w-16`, `pl-8 pr-3`, `rounded-md`,
  `text-xs`, `bg-canvas`); `w-auto` keeps an inline select at its
  intrinsic width. Focus is the global outline (§Focus): the recipe paints
  `focus:border-compass-500` and nothing else — `focus:ring-*` and
  `focus:border-compass-400` are the retired recipe and fail the build.
- **Width scale.** A single-line control is as wide as what goes in it:
  `size="xs"` (10rem — a number, a short code), `sm` (16rem — a label, a
  username), `md` (28rem — a name, an email, a password), `lg` (36rem — a
  URL, a key), `full` (the default: grid cells, textareas, anything in a
  narrow card). The size is a cap on the Field, so a grid cell or a flex
  row still governs. `<Toggle>` takes the same scale and defaults to `lg`
  so the switch sits near its label; pass `size="full"` only inside a
  bounded card. Never wrap a Field in a `max-w-*` div — that is what the
  prop is for.
- **Passwords** have one minimum, `PASSWORD_MIN` in `lib/password-policy`
  (8). Every form shows `PASSWORD_HELP` under the field and validates with
  `passwordProblem()`; every route refuses with the same function. Never a
  literal number in a form or a route.
- **On sign-in surfaces** (1.16.0, §Sign-in surfaces) inputs are
  `TextInput className="h-10 text-base sm:text-sm"`: 2.5rem, the height of
  the `lg` button under them, and 16px text on a phone so iOS does not zoom
  in on focus. The forced password change uses the same recipe; Account →
  Security keeps the house one.
- **Show password** is a checkbox under the field ("Show password", or
  "Show passwords" for the three fields of the forced change), `text-sm
  text-slate-600`, never an eye icon inside the input (a `Field` holds one
  control). Before the request it is switched off with `flushSync`, so the
  field is `type="password"` again when the browser decides whether to
  offer to save it.
- **The Caps Lock hint** goes through the password `Field`'s `help` ("Caps
  Lock is on."), read with `getModifierState("CapsLock")` on key down and
  up, cleared on blur, and announced once per change; never a tooltip or a
  second line of its own.
- **`Field describedBy`** (1.16.0) adds ids to the control's
  `aria-describedby` and **merges** with the Field's own help or error,
  never replaces them: the sign-in page points the identifier at the
  single sign-on error banner, so the banner is read with the autofocused
  field while its own help and error still describe it.
- **Labels** are `text-xs font-medium text-slate-500`, above the control;
  an optional field says so in the label (`(optional)`) rather than with a
  placeholder. Placeholders are examples, never the label: a control with
  no visible label needs `aria-label`.
- **Dates.** An instant (a `timestamptz`: when something happened) prints
  through `useFormatDate().date` / `.dateTime` (`formatDate` /
  `formatDateTime` in a server component), in the workspace's or the
  person's time zone. A calendar day (a `date` column, a chosen date on a
  `type="date"` input: an effective date, a next re-confirmation date)
  prints through `formatDay` / `useFormatDate().day`, never through the
  instant formatter — projected into a zone west of UTC, "2026-01-01"
  reads as the day before the one the person chose. Chart buckets keep
  `.dayShort`.
- Checkbox *lists*, radio groups and composite pickers (EntityPicker,
  SpaceIconPicker) keep their own markup; their text inputs still use the
  recipe.
- **A stacked radio group in a card** (1.13.0) reuses the choice dialog's
  radio-card recipe (§Overlays): `role="radiogroup"` with `aria-label`, a
  label and one description sentence per card, the chosen card
  `border-compass-300 bg-compass-50/60`, with the card's own control (a
  number, a date) as a `Field` under the description while chosen, a
  sibling of the radio, never nested in its label. `RadioCards` in
  `PolicySettingsPanel` is the worked example.
- **A live count line under a picker** ("Applies to 412 people · 3 without
  access", 1.13.0) is `text-xs text-slate-500` with `aria-live="polite"`,
  debounced, never a spinner.
- A control inside a list row (OrderedKeyList `extra`) is a dense
  `TextInput`/`Select` with a visible caption and an `aria-label` that
  names the row ('Wrap Name after'); the shared help and the first error
  live on the list's own label, and only the offending row's control takes
  `hasError`.
- A composite picker that belongs to each row of a definitions table (the
  Fields page's per-option **Heads** EntityPicker, 1.13.0) is not put in
  the table, whose sideways scroll would clip its list, but in a fieldset
  with a legend right under it, one captioned picker per row in a
  two-column grid, each with an `aria-label` naming the row ("Heads of
  Engineering") and a sublabel per choice that says what tells them apart
  (the person's own value for the field); the shared help is one line
  under the grid and a refusal is a `FormError` under it, not a toast.
- **A captioned Select in a toolbar** (the Policies page's Sort, 1.14.0)
  is a `dense` `Select` with `className="w-auto"` whose visible caption is
  a span the control names through `aria-labelledby` (a wrapping `<label>`
  would fold the chosen option into the accessible name), so a spec finds
  `getByRole("combobox", { name: "Sort" })`.
- **The Save row.** A page or card with a Save button uses `<SaveRow dirty
  busy onSave label disabled allowPristine>` from `components/SaveRow`
  with `useUnsavedChanges(snapshot)` and `useLeaveGuard(dirty,
  hasUnsavedChanges)` from `lib/use-unsaved`: disabled while pristine,
  "Unsaved changes" + a Ctrl/⌘+S hint while dirty (the shortcut saves),
  "Saved" for a moment after, pinned to the bottom of the viewport only
  while dirty, and a leave prompt on any in-app link or reload. Call
  `markDirty()` from user-input handlers only — never from a mount or
  load effect — and `markClean()` once the server has accepted the save,
  before applying the state it returns. A row that is also a re-apply
  (Domain "Save & apply") passes `allowPristine`. Secondary controls
  (Test sign-in, Sync now) go in as children. Never a bare primary button
  that never changes state.

## Wayfinding: back links and breadcrumbs

- **Sub-pages get one back link**, `<BackLink href label>` from
  `components/BackLink`, above the page title: an arrow and the
  destination's own name ("Directory", the document's title), never "Back
  to X". Default `mb-4`; pass `className=""` inside a flex row. Hidden in
  print.
- **Nested places get one breadcrumb trail**, `<Breadcrumbs items trailing>`
  from `components/Breadcrumbs` (the document page, the public document
  page): a named landmark, separators hidden from readers, long titles
  truncated with a tooltip (`title`), an optional right-aligned control.
  Never hand-roll either.

## Segmented controls

The space layout switcher (Cards / Table / Tree / Board / Timeline / By tag)
is a `Segmented` (1.9.3) — a radiogroup, so specs find it with
`getByRole("radiogroup", { name: "Space layout" })` and its options with
`getByRole("radio")`. Never a hand-rolled `role="tablist"`.

- A choice of two to five options where exactly one is on (theme, page
  width, interface scale, the document width switch) is
  `<Segmented options value onChange label size>` from
  `components/Segmented`: a `radiogroup` with a roving tabindex, arrows
  move the choice, the current option is `bg-compass-50 text-compass-700`.
  `size="sm"` for toolbars. Options may carry an icon and a `hint`
  (tooltip). Never write a second recipe, filled or tinted.
- A group in a toolbar that must fit a phone passes `className="flex-wrap"`,
  so its options wrap inside the border instead of pushing the toolbar
  sideways (1.13.0: the roster's five-option Show control, which the
  portal's expand row shows in a box about 213px wide at 375px;
  `e2e/compliance-portal.spec.ts` asserts it). It changes nothing where the
  options fit on one line. Never shorten the labels or swap in a select to
  make room.

## Account pages

- Account settings sit inside the app shell under `(app)/account`, framed
  like the console: an "Account" eyebrow, the rail (`AccountNav`, rows from
  `components/RailLink`) and `<AccountPage href>` rendering the section's
  icon, label and description from `lib/account-sections.ts` as the page's
  `h1`. The forced password change (`/account/password`) stays outside the
  shell: it is the second half of signing in, so since 1.16.0 it wears the
  sign-in shell (`AuthShell` and `AuthHeading`, §Sign-in surfaces) with
  the account in an `IdentifierRow` ("Signed in as", with Sign out).
  Changing a password from Account → Security is unchanged.

## Sign-in surfaces

The sign-in page (`/login`), its admin preview (`/login/preview`) and the
forced password change (`/account/password`) share one shell (1.16.0).
`/setup` and `/oauth/authorize` keep theirs for now; moving them is
mechanical and comes later.

- **`AuthShell` is the only auth shell** (`components/auth/AuthShell`,
  server-safe, styled by the `.auth-*` block in `globals.css`). From 64rem
  it is a **cover** beside a plain, card-less **form column**; below 64rem
  the cover becomes a **band** above the column, in normal flow, so
  nothing ever overlays an input. The column is `--auth-col: clamp(26rem,
  34vw, 38rem)` wide (416px at 1024, 490 at 1440, capped at 38rem), the
  form in it 24rem, text flush left and top-anchored (`clamp(5rem, 22vh,
  13rem)` from the top), so the h1 never moves between steps; below 64rem
  the form is centred in the 16px gutter. The band is 6rem tall on a phone
  (the lockup only), 10rem from 40rem, and 4rem when the viewport is under
  34rem tall (a landscape phone, the Outlook dialog), which wins by source
  order; the 6rem and 4rem bands grow by 3.5rem when they carry the quick
  links strip (below), and the 10rem band holds it as it is.
  The cover is a sticky, full-height `aside`. The grid uses
  `minmax(0, 1fr)`, so nothing scrolls sideways at 3440.
- **DOM order is `<main>` first**, then the cover. The grid puts the cover
  on the side the admin chose (**Artwork side**: `data-side="start"`, art
  on the left, the default; `"end"`, art on the right), so Tab and a
  screen reader reach the heading and the field before the art whichever
  side it is on. `<main id="main" tabIndex={-1}>` holds the form.
- **`AuthHeading` is the one h1** (`components/auth/AuthHeading`; the
  style-drift h1 allow-list names it, not the pages): `text-3xl font-bold
  tracking-[-0.02em] text-balance text-slate-900`, an optional `mt-2
  text-sm text-slate-500` subtitle, `id="auth-title"` (the form's
  `aria-labelledby`) and `tabIndex={-1}`, so a step without a field can
  focus its heading (the house focus rule leaves `tabindex="-1"` out, so
  never add `outline-none` to it). The page `metadata` title stays "Sign
  in" (the template adds the workspace name) with `robots` noindex.
- **The Card/Stage rule.** Nothing operable or essential ever sits on the
  art. The cover holds the logo tile, the workspace name, the headline,
  tagline and caption, and decoration; every control, error, help line
  and link is in the column. **The one deliberate exception** is the
  sign-in quick links (1.17.0, below): convenience links, never part of
  signing in, after the form in DOM and tab order. The first and password
  steps, and the
  forced password change, also name the workspace in the form's subtitle
  ("to continue to Acme"); a step with a sentence of its own (the
  break-glass, the choice of providers, two-factor) does not. The column
  starts with the lockup (`BrandTile` and the name, `mb-8`) whenever the
  cover does not carry the name: on screen when an admin turns the text
  off over a photo, and always in print (`hidden print:flex`), which
  hides the cover. With text, the cover is `<aside aria-label="About
  {Company}">`; with the text off it is a `div` with `aria-hidden`, unless
  it carries quick links: a control is never inside `aria-hidden`, so the
  `div` drops it and only `.auth-art-bg` stays hidden.
- **Default art** (no upload) is drawn from the accent and makes no
  request. Back to front: `.auth-art-mesh` (compass 600 → 800 → 900 at
  200°, plus two glows at the top right from 64rem, which fade out before
  any text), `CompassBezel` (an inline SVG dial in white strokes, anchored
  top-right with `xMaxYMin slice` on every aspect ratio and masked away
  from the lockup's left 30% and the display's bottom 38%; in the band,
  from the left 55%) and `.auth-art-grain` (a data-URI `feTurbulence` tile
  at opacity .08, soft-light, which stops banding on a large panel). The
  600 to 900 steps do not flip with the theme; dark mode dims
  `.auth-art-bg` with `brightness(0.8)`. The dial is abstract, so it suits
  a white-labelled workspace.
- **A photo** is an `<img>` with a `srcset` of three WebP widths (960, 1600,
  2560) and `sizes` written as a media list (`ART_SIZES`; never a
  `clamp()` in `sizes`), `alt=""` and `object-fit: cover`, preloaded from
  the server component with `fetchPriority="high"`. Under it, the
  picture's mean colour (`--art-tone`) and a 20px blurred placeholder
  paint at once, and since band and cover heights never depend on the
  image nothing shifts and nothing fades. The **focus point** is one of
  nine positions (`FOCUS_POSITION`) that sets `object-position` and the
  placeholder's `background-position`. A missing file (a database-only
  restore) falls back to the default art. One image serves both themes;
  dark mode dims it as it dims the default art.
- **Text on art.** Ink on the cover is a literal pure white in both themes
  (the art is dark in both; §Color and theming), never translucent. Over
  a photo each text block (`.auth-art-top`, `.auth-art-foot`) draws its
  own scrim as a `::before` of `rgb(2 6 23 / var(--scrim))`, so the floor
  of **0.62** sits under every glyph whatever the crop, focus point or
  viewport; the foot's scrim deepens by 0.1 towards the bottom edge. From
  64rem the quick links bar, darker still over a photo, is the lockup's
  scrim, and the lockup draws none of its own. A
  scrim drawn by the text block is provable where an upload-time contrast
  solver is not (which pixels sit under the text changes with the screen).
  `prefers-contrast: more` raises the floor to 0.8 and drops the bezel and
  grain; `forced-colors: active` hides the art and its scrims and outlines
  the cover in `CanvasText`; print hides the cover and prints the form
  under the column's lockup.

  | Pair | Worst case | Ratio |
  | --- | --- | --- |
  | White text on a photo under the 0.62 scrim | a pure-white photo (rgb 98 101 111 under the text) | 5.84:1, AA for `text-xs` captions |
  | The same under `prefers-contrast: more` (0.8) | a pure-white photo | about 11:1 |
  | White on the default art | compass-600, the lightest step under text | 4.5:1 or more for any accent (`solidAccent`, `test/theme.test.ts`) |
  | Dark mode | `brightness(0.8)` dims the art only, never the scrims | only improves |
  | The form column | `slate-500` labels and help on `canvas`, `link` in accent ink | the house AA tokens |

- **Display type follows the cover, not the viewport.** `.auth-art` is a
  leaf `inline-size` container (`container: auth-art / inline-size`): a
  sibling of `<main>`, holding no overlay, so §Scaling's container rule
  allows it; band or cover is decided by viewport media queries in rem.
  The big line (the headline, else the workspace name) takes one of three
  tiers by length (`lenTier`: up to 18 characters `s`, up to 36 `m`,
  longer `l`), each a `clamp()` in `cqi` with a `ch` cap (13, 17, 22): the
  short tier is 45px at 1024, 67px at 1440 and 99px, its cap, at 2560. The
  tagline and caption scale the same way, the lockup name is capped at
  24ch, and the display hides the lockup's name when it is the name.
  Aileron 400, 600 and 700 only; no display font, no weight 800.
- **Sign-in quick links** (1.17.0, a bar across the top of the cover
  since 1.18.1; `components/auth/SignInLinksBar`, the `.auth-links`
  rules): the links an admin marks **Sign-in page** in Settings → Links,
  only links with no group restriction (the chip is disabled with a
  `data-tt` reason otherwise, the server refuses the flag, and
  restricting a link later clears it), at most 8, by position. The pages
  load them through `signInLinks()`, which returns none on an error, so
  the links can never stop anyone signing in; with none, nothing renders
  and the cover is exactly as it is without them. A `<nav
  aria-label="Quick links">` inside the cover, between the lockup and the
  words in the DOM, so after the form for Tab and a screen reader however
  high it sits on screen; no visible caption (the nav is already named).
  Each link is a button-shaped `<a>` to the link's own address
  (`TrackedLink`: the same-origin click beacon counts it, a signed-out
  click with no user; the admin preview passes `trackLinks={false}`),
  `target="_blank" rel="noopener noreferrer"` with an `sr-only` "(opens
  in a new tab)": a white icon tile (the favicon or custom icon from the
  public-safe icon route, else the letter in `compass-700`; 0.375rem
  radius, the button's height less 0.875rem, so it is inset evenly on
  three sides), the title (600, white, truncating at 12rem, 10rem below
  64rem, with a plain `title` once it is over 20 characters), then a
  0.875rem `ExternalLink` at 60% opacity; no dividers, a 0.5rem gap.
  Buttons are 0.625rem radius, `rgb(255 255 255 / .14)` on a `.22`
  hairline, raised to `.26` / `.42` on hover and focus; the focus ring on
  the art is a 2px **white** outline (the house accent ring does not show
  on the accent art).
  - **From 64rem, a frosted bar across the top of the cover**, edge to
    edge, `rgb(15 23 42 / .32)` with `backdrop-filter: blur(14px)
    saturate(1.2)` and a `rgb(255 255 255 / .16)` bottom hairline. The
    logo tile stays where it always is, at the cover's padding, and the
    bar is `2 × --art-pad` + the tile tall, so the tile sits on its
    middle. The buttons are **the tile's height**: both read
    `--art-tile` (`clamp(2.5rem, 2rem + 0.8cqi, 3.25rem)` on the cover,
    set on `.auth-art`), never a measured size; 14px text. The cover's
    content becomes a two-row grid (`auto minmax(0, 1fr)` columns): the
    lockup at its own width and the nav in the rest of the first row,
    right-aligned and inset by `--art-pad`, the words at the foot of the
    second. The glass is the content's `::before`, placed on the first
    row and pushed out by the padding, with `pointer-events: none`; the
    nav is `position: relative; z-index: 1`. Nothing is absolutely laid
    over the links, so nothing takes their clicks. A row that does not
    fit **scrolls sideways** (scroll-snap, no visible scrollbar) in the
    space right of the lockup, never over it: the scroller runs out to
    the cover's edge and fades over its first 1.5rem and last
    `--art-pad`, which at rest are the list's own padding, so a long row
    is cut at the edge of the art. It never wraps, so the bar never
    grows and the tile stays on its middle. The middle of the cover is
    clear; the words keep their place at the foot.
  - **Below 64rem, a strip along the top of the band**: 3.5rem tall,
    `rgb(15 23 42 / .38)` with `blur(12px)` and a bottom hairline, the
    same buttons at 2.25rem (13px text), one row that scrolls sideways
    (scroll-snap, no visible scrollbar), inset by the band's own padding
    and right-aligned when it fits. The lockup sits under it, centred in
    the band's own height: the 6rem (and 4rem) band grows by the strip,
    the 10rem band has room for both.
  - **Over a photo the glass is darker** (`rgb(2 6 23 / .7)`, buttons
    `/ .1`, `.2` on hover and focus), so the links stay readable on a
    bright picture. The glass is one variable (`--glass`,
    `--glass-filter` on `.auth-art[data-links]`) that the bar and the
    strip both read, so each fallback is one line:
    `prefers-reduced-transparency` and `prefers-contrast: more` swap it
    for solid slate (`rgb(15 23 42)`, buttons `rgb(51 65 85)`);
    `forced-colors` draws `Canvas` with a `CanvasText` border (the bar's
    lines up with the cover's outline) and `LinkText` buttons; print
    hides it with the cover. Nothing on it moves.

### Identifier-first steps

`SignInFlow` (`components/auth/SignInFlow`, client) is the form. Its mode
is decided on the server: with no usable single sign-on provider (the
community build, or nothing configured) it is **one combined form**, email
or username plus password, with today's DOM and **no lookup call, ever**;
`/login?local=1` gives the same form while SSO is on (the break-glass);
otherwise it asks for the email or username first and `POST
/api/auth/lookup` says where it goes (`lib/sign-in-routing`).

- **One form, fixed DOM positions.** The identifier input stays mounted
  for the whole flow and is the only `autocomplete="username"` element;
  once locked it is hidden and `IdentifierRow` shows the value in the same
  2.5rem box, and Continue becomes Sign in on the same button, so nothing
  jumps. The first step has **no password input** at all. At most one
  submit per step; a step without a field (a redirect, a choice) has none.
- **Uncontrolled inputs, read on submit.** The handler reads the values
  from the DOM, so whatever was typed or filled by a password manager
  before hydration is used; React state mirrors only what the UI needs
  (the locked value, Caps Lock, Show password).
- **No plain form post.** The submit is server-rendered `disabled` until
  hydration (implicit submission is a no-op while the default button is
  disabled, and Playwright's click waits for it to be enabled), and the
  form is `method="post"` as defence in depth, so credentials never reach a
  URL.
- **Busy is `aria-disabled` plus `aria-busy`**, never `disabled`, so focus
  never falls to `<body>`. A ref ignores repeats, the label never changes,
  and the `Spinner` appears only once busy has lasted 150ms, so a fast
  answer never flashes. On success it stays busy until the navigation
  commits.
- **A heading per step**, and focus on entering it:

  | Step | h1 | Focus |
  | --- | --- | --- |
  | First step | Sign in | the identifier (`autoFocus`, any value selected) |
  | Password (looked up, or chosen) | Enter your password / Sign in with a password | the password |
  | One provider | Redirecting to Microsoft (Google, single sign-on) | the status row (`role="status"`, `tabIndex={-1}`) |
  | One provider after an SSO error | Sign in with Microsoft (the provider's label) | the **Continue** anchor |
  | Two providers | Choose how to sign in | the h1 |
  | Two-factor | Two-factor authentication | the code |

  One polite `sr-only` live region (`role="status"`), mounted from the
  first render, announces "Checking how you sign in…", the step and Caps
  Lock; field errors and `FormError` are alerts. A form error moves focus
  to the field to fix, with a password or code cleared first. The
  `FormError` sits above the submit, so fields never jump.
- **`IdentifierRow`** (`components/auth/IdentifierRow`) is **not a
  `Field`**, because a `<label>` around Change would fire it on a click on
  the words: a label span, then a `role="group"` row named by it
  (`bg-slate-100`, the field's border and height, a `CircleUserRound`
  icon), the value with its part before the "@" truncating first (the
  domain decides the routing, so it stays in view; a native `title` on
  that plain text is allowed, §Tooltips) and an action. **Change** is
  `buttonClass("ghost", "sm")` with an `sr-only` " email or username"; it
  returns to the first step with the value kept and selected, and calls
  `window.stop()` if a hand-off is under way. The forced password change
  puts Sign out there.
- **SSO never sits beside a password field.** On every password step
  while a provider exists it is behind a closed native `<details>`
  **Other ways to sign in** (the `DocBlocksStatic` accordion recipe; the
  provider anchors inside), identical for an unknown account and a
  password account, so it reveals nothing. It opens by itself only after
  the lookup's 429. After a wrong password the only hint is a static
  `text-xs text-slate-500` line ("If your organization uses single
  sign-on, open Other ways to sign in below.") that never names an
  account.
- **The hand-off is a full navigation** to a same-origin `/api/ee/...`
  address the server built (the client checks the prefix and refuses
  anything else): an `<a href>` (`buttonClass("secondary", "lg",
  "w-full")` with a `ProviderMark`, or the primary Continue anchor) or
  `location.assign` after one paint. Never `<Button href>` (next/link
  prefetches) and never a form submit that ends in a redirect to the
  identity provider (CSP `form-action 'self'` covers the whole chain in
  Chromium). A plain click remembers the identifier and never calls
  `preventDefault`; a modified or middle click does nothing extra.
- **Never auto-continue after `?sso_error`.** The banner (`notice-error`,
  `role="alert"`, a `CircleAlert`, and in the identifier's
  `aria-describedby`) stays while the person is on the first step or the
  password step they chose from it, `history.replaceState` drops
  `sso_error` (keeping `next` and
  `local`) so a reload shows no stale banner, and a single provider waits
  behind **Continue**. Back from the identity provider (`pageshow` with
  `persisted`) resets to the first step with the value selected and
  nothing in flight. The steps push no history; Change is the in-page
  back.
- **The remembered identifier** (`lib/remembered-identifier`) lives in
  `localStorage` only, every access in try/catch, for 180 days, at most
  254 characters and no control characters. It is written after a
  successful sign-in and just before any SSO hand-off, prefilled only
  into an **empty** field, never moves focus and is never submitted, with
  "Not you? **Use another account**" under it to forget it. Never a
  cookie, and never a "Welcome back, {name}" (that would say the account
  exists).
- **Two-factor codes are never auto-submitted**: a mistyped code spends
  one of the five attempts. The authenticator field is `inputMode="numeric"
  autoComplete="one-time-code"`, centred `font-mono`; the recovery field is
  `inputMode="text"` with autocorrect and capitalisation off, because
  recovery codes have letters. The input is keyed by mode, so the right
  keyboard mounts. Back returns to the password step with the password
  kept.
- **Help under the form** is one `mt-10 text-xs text-slate-500` line: the
  admin's text, or their link (`link`, its words the help text or "Get
  help signing in"; an https link opens in a new tab with a 0.75rem
  `ExternalLink`, a mailto link does not), on every step; without one,
  password steps say "Forgot your password? Ask your administrator to
  reset it."
- **Two transports.** `SignInFlow` talks to the server through
  `SignInTransport`: `realTransport` (`lib/sign-in-transport`) for the page
  and `demoTransport` (`lib/sign-in-demo`) for the admin preview, which
  answers from a script and sends nothing. A new step must work under
  both; the demo is how community CI exercises the identifier-first steps.

## Rails and navigation rows

The sidebar, the settings rail and the account rail share one row recipe,
`components/RailLink`: `rounded-lg px-3 text-sm font-medium`, current page
`bg-compass-50 text-compass-700` with `aria-current="page"`, otherwise
`text-slate-600 hover:bg-slate-100 hover:text-slate-800`; the icon is
`h-4 w-4`, `text-compass-600` when current and `text-slate-400` otherwise; the
label truncates (`min-w-0 flex-1 truncate`). Two sizes: `py-2` in the sidebar
and `py-1.5` (`dense`) in the settings and account rails. Group labels
(`RailGroupLabel`, or `RAIL_GROUP_TEXT` on a heading) are
`text-2xs font-semibold uppercase tracking-wider text-slate-500`.

- Settings and account rails render `<RailLink href icon label active>`; the
  sidebar composes `railRowClass(active, { collapsed })` and
  `railIconClass(active)` because its rows also carry tooltips, badges and
  the collapsed layout. Never write a fourth recipe.
- Shell widths are tokens in `globals.css` (`--container-sidebar` 16rem,
  `--container-sidebar-rail` 4rem, `--container-rail` 13rem → `w-sidebar`,
  `w-sidebar-rail`, `w-rail`, or `var(--container-rail)` in a grid template),
  so the sidebar and the rails grow together with the interface scale. The
  collapsed rail's right-placed tooltip offset assumes the 4rem token.
- A destination behind the sidebar's More fold that carries a badge is
  rendered with the fold open and the toggle hidden, exactly as the current
  page is: the accent pill means work waiting for you, and it is never
  behind a fold (1.12.0; the Compliance entry's "policies to confirm" badge
  is the first).

## Color and theming

- **All accent color comes from the `compass-*` palette** — never hard-code
  the brand blue. The palette is CSS-variable driven so the admin-chosen
  accent re-skins everything at runtime.
- The `--compass-*` / `--slate-*` variables hold raw `R G B` triplets: in
  hand-written CSS always wrap them — `rgb(var(--compass-600))`. A bare
  `var(--compass-600)` is not a valid color and fails **silently** (this bug
  shipped once, on `accent-color`).
- Native controls (checkbox/radio/range/progress) inherit the accent via the
  global `accent-color` rule — don't restyle them per-component.
- Dark mode flips through the variables plus targeted `dark:` classes; there
  is no `compass-950` (classes referencing it are no-ops — don't add them).
- Semantic colors stay semantic in both themes: emerald = success/complete,
  red = error/overdue, amber = warning, slate = neutral/disabled.
- **Only `compass-*`, `slate-*`, `surface` and `canvas` flip with the theme.**
  amber/red/green/sky are plain Tailwind, so `bg-amber-50` with no `dark:`
  counterpart stays cream on a dark page.
- **Never put a `dark:` variant on a slate token.** The slate ramp *inverts*
  (`--slate-800` goes `30 41 59` → `221 227 236`), so `bg-slate-50
  dark:bg-slate-800/40` flips twice and paints a light slab, and
  `text-slate-900 dark:text-slate-100` paints near-black ink on a near-black
  page. A bare slate token is already correct in both themes — the fix for one
  of these is a **deletion**. Same for `bg-white`: use `bg-surface` (literal
  white is right only for brand tiles, QR codes, media stages, the toggle knob
  and email previews). `test/style-drift.test.ts` enforces all of this.
- Anything that must stay dark in both themes (code blocks, the code-block
  header bar, the modal scrim, the sign-in cover's white ink and its
  `rgb(2 6 23 / …)` text scrims) is **hard-coded literal**, never themed.
- **Accent AA.** `lib/theme.ts` derives the solid steps (600 and darker:
  buttons, links, focus rings) from `solidAccent(hex)`, which darkens a light
  accent until white text reaches 4.5:1; the tints (50–500) keep the chosen
  hue. Accent *text* in dark mode comes from the `--compass-ink` /
  `--compass-ink-strong` tokens (`text-compass-ink` is a utility), which the
  theme emits alongside the ramp — never hand-write a dark accent colour.
- **Semantic ink.** Free-standing red/amber/green *text* (not a chip, not a
  notice): `text-red-600` lifts to red-400 in dark mode automatically;
  amber and emerald use `ink-warn` / `ink-ok` (700 light, 300 dark). A
  destructive control's hover is `hover-danger`, never a bare
  `hover:bg-red-50`. A link inside a sentence is `link` (underlined); nav
  links and table-cell links keep their own styling.

## Focus

Keyboard focus is one global `:focus-visible` rule in `globals.css`: a 2px
`compass-600` outline, offset 2px (0 on form controls), `compass-300` in
dark mode. It is unlayered, so it beats `outline-hidden`; never write
`outline-hidden` / `outline-none` on a control to "clean up" a ring, and
never add a per-control `focus:ring-*`. Two documented exceptions, where the
surrounding panel is the frame: the command-palette input (`.cmd-input`) and
the editor body (`.tiptap`). Form controls also tint their border on focus
(`focus:border-compass-500`) so a mouse click reads as active.

## Motion

Default `transition` (150ms) for hover and colour; `duration-200` for layout
reveals (sidebar width, sticky bar); hand-written CSS uses 120ms. Spinners are
the only looping animation. Reduced motion is handled globally — one
`prefers-reduced-motion` rule collapses every transition and animation except
`.animate-spin` — and any JS-driven motion (`scrollIntoView({ behavior:
"smooth" })`) checks `matchMedia("(prefers-reduced-motion: reduce)")`.

A block that appears as a step changes (1.16.0, the sign-in steps: the
password field, the redirect status row, the provider list, the code field)
fades and rises in with Tailwind's `starting:` variant (`@starting-style`)
on the layout-reveal tier: `transition-[opacity,translate] duration-200
ease-out starting:-translate-y-1 starting:opacity-0`. No keyframes, no JS
animation; the global reduced-motion rule collapses it. Headings change
their words without motion, and nothing on the sign-in cover moves.

## Notices (persistent inline state banners)

- **A licence gate is `<LicenseGate feature entitlement canManage>`**
  (`components/LicenseGate`): one warning notice naming the feature and
  the entitlement, with an "Open License" button only when the viewer can
  open that page. Never a grey box with no way forward.
- **Prerequisite states** ("SMTP is not set up", "this role is built in")
  are `notice-warn` banners with the action that clears them — never a
  bare amber sentence (it reads as a validation error and fails AA in
  dark mode). A hint sentence that must be amber uses `ink-warn`.

Three classes in `globals.css`, each carrying both themes:
`notice-warn` (amber), `notice-error` (red), `notice-ok` (green). They supply
border-color, background and ink only — keep the element's own `border`,
rounding, padding, `text-sm` and margins:

```tsx
<div className="notice-warn rounded-lg border px-3 py-2 text-sm">…</div>
```

They are classes rather than a `<Notice>` component because the call sites
share nothing but color (`rounded-lg`/`rounded-xl`, `px-3 py-2`/`p-4`, `<p>`
vs `<div>`, with/without a leading icon, flex rows), and because server
components use them with no import. Don't add a per-instance `text-amber-*`
inside one — child ink overrides the class and re-breaks dark mode; let it
inherit. Toasts and per-field validation errors are unrelated (see Feedback).

## Status chips

`<Chip tone size>` / `chipClass(tone, size, extra)` from `components/Chip`:
`rounded-full px-2 py-0.5 text-xs font-medium` (`size="sm"` is
`text-2xs`) in one of a closed set of tones — `ok` (emerald, the single
success hue; green is retired), `warn` (amber), `error` (red), `neutral`
(slate), `accent` (compass), `info` (sky), `label` (violet, product tiers:
`<EnterpriseBadge />`). Every tone carries its dark-mode pair and a print
override, so never write a hue pair by hand. Status text is label-cased
(`labelCase("published")` → "Published"); `TypeBadge` and `StatusBadge`
wrap the chip for documents. Categories (audit log) are labels, not
states: they render `neutral`.

**Status is shown, not chosen** (1.9.0). An entity's state is a chip where
the person deciding what to do next can see it — the document editor shows
its saved status beside the title — and changing it is a named action
(Publish, Unpublish, Submit for review), never a `<select>` of states. The
destructive direction asks first (`confirmDialog`); the keyboard save keeps
the state as it is.

**Status chips are never links or pickers** (1.10.0). A chip shows where
something stands; it does not take the reader anywhere and it does not open
a menu. The document sticky bar is the worked example (B2): while a read
confirmation is pending the control is a `secondary` `sm` `<Button href>`
that jumps to the card at the end of the article, and once confirmed it
becomes `chipClass("ok", "sm")` with `CircleCheckBig` and "Confirmed
{date}" — a status, not a link (My policies, 1.12.0, links from its rows
to the card; the card's **View your record** link, 1.14.0, lives in the
card, never on the chip).
The read-confirmation chips are a closed set — **Confirmed** (`ok`),
**Pending** (`warn`), **Overdue** (`error`), **Exempt** (`neutral`) — and
nothing else for a confirmation's state (never "Acknowledged").
A reader's standing on a policy **inside a handbook** (1.18.0) adds three
words to that set, from the reader's side rather than the compliance
desk's: **To confirm** (`accent`), **Updated since you confirmed**
(`warn`: they confirmed an earlier version) and **For information**
(`neutral`: the policy does not ask them), beside **Confirmed** (`ok`,
with `Check`). One component renders all four, `StandingChip`
(`components/handbooks/confirm`, `sm`), on the confirm-the-handbook list
and the reader's policy masthead alike; never a second switch over the
same words. The contents rail does not repeat the chip: it shows a
confirmed policy as an emerald `Check` with "(confirmed)" for screen
readers, and nothing for the others.

**"Handbook only"** (1.18.0) is a `neutral` `sm` chip with the `BookOpen`
icon, `HandbookOnlyChip` (`components/handbooks`): a document readers
find only through its handbooks. Where it stands alone (a space's table
view, the reader's masthead) it carries `data-tt` "Readers find it only
in {handbooks}." with `tabIndex={0}` and `data-tt-wrap`; inside a row or
card that is one big link it takes `inLink` and is plain text, because a
focusable tooltip cannot sit inside a link.

**A choice is a pill menu button, not a chip** (1.18.0). When a row
carries a setting the editor changes in place (the handbook editor's
"Where people find it", `FindModeMenu`), the control is a `button` with
`aria-haspopup="menu"`, `aria-expanded`, a `data-tt` naming the setting
and an `aria-label` that says the row and the value ("Where people find
{title}: Handbook only"). It is pill-shaped (`h-7 rounded-full px-2.5
text-xs font-medium`, a `ChevronDown`) so it reads as the row's setting:
outlined (`border-slate-200 bg-surface`) for the default, filled
(`bg-slate-800 text-surface`, which inverts with the theme) for the
exceptional value. It opens a `Popover role="menu"` of the options, each
a `menuitemradio` (§Overlays and modals, picker menu) with a bold title
and **one sentence** saying what it does, the chosen one `aria-checked`
on `bg-compass-50` with a `Check`; the menu opens with focus on it. Under `sm` the panel hangs from the row (the wrapper is
`sm:relative`, the panel `max-sm:left-2 max-sm:right-2`) so it spans the
row instead of running off the screen. The chevron is what tells it from
a status chip; a status chip never has one.

- **The review queue's chip says what approving does** (1.11.0,
  `ReviewClient` is the worked example). Beside the kind chip ("Edit" /
  "Publish request") a request on a document that requires read
  confirmation carries exactly one of a closed set: **Resets 42
  confirmations** (`warn`), **Keeps 42 confirmations (editorial)** (`info`),
  **Decision needed. 42 confirmations** (`warn`), **Metadata only.
  Confirmations unaffected** (`info`) or **Confirmations unaffected**
  (`info`). The two that need a sentence of explanation ("Decision needed",
  "Confirmations unaffected") carry it as `data-tt` with `tabIndex={0}`
  (§Accessibility); the others carry none. The number is the live count of
  confirmations the approval touches, never the audience.
- **A paused policy is an "Unpublished" chip, never an alert** (1.11.0,
  `CompliancePanel`): `neutral` `sm` with the `CirclePause` icon and the
  `data-tt` "Read confirmation is paused while the document is unpublished.
  Confirmations are kept." (`tabIndex={0}`), on a row inside the collapsed
  **Paused (unpublished) · 3** `<details>` group at the foot of the Policy
  progress card. The row offers no action (every row action needs a
  published document) and the tiles above leave the group out. The group's
  count follows the summary with a middle dot, not a second bracket. A
  retired policy (1.12.0, `PortalPolicies`) is a neutral **Retired {date}**
  chip with `Archive` and the retirer as its tooltip, in the collapsed
  **Retired · 3** group below Paused; its row keeps the record link and the
  CSV and offers Un-retire only.
- **An email its owner typed is an "Unconfirmed" chip** (1.16.0,
  `UsersClient`): `warn` `sm` beside the email under the username, with a
  `data-tt` (`tabIndex={0}`, `data-tt-wrap`) saying what confirming does
  and the check it stands for. Confirming is the row's named action
  (**Email…**), never the chip, and its dialog says what confirming grants
  and to whom (single sign-on gives the account to whoever signs in with
  the address), so nobody confirms by habit.

**Attribute chips** (a directory field shown as chips, a tag list) are not
status: render them with `FieldChips`, which shows the option's **label**
(never a raw code — "Phoenix", not `PHX1`) in **neutral slate by default**.
The accent is opt-in per field (`highlight`) and a colour is opt-in per
option; a certification or a team must never read as an alert. The one
place the *field's name* belongs next to its chips is a card, where the
chips would otherwise be a bare word: render `label` in `text-xs
text-slate-500` before them ("Notary · Phoenix").

## Tables

- **Filtering a list already on the page is `<ListFilter value onChange
  label shown total noun>`** (`components/ListFilter`): a filter box with
  a live "3 of 89 users" count, Escape clears. The box keeps a floor of
  12rem under `sm` and 14rem from `sm`, so it fits a 375px phone's card
  (about 213px wide with the rail and the gutters) and never shrinks to
  nothing beside the count. Lookups that fetch keep "Search …"
  (EntityPicker, people search, settings search).
- **Paging is `<Pager page limit total onPage busy>`** (`components/Pager`):
  "Showing 1–50 of 4,333" with Previous / Next, rendered above and below a
  long table. A list that can grow without bound (the Trash, the audit
  log) is paged by the server — never load every row to draw a page.
- **Cross-references to settings are `<SettingsLink href>`**
  (`components/SettingsLink`): a link when the viewer can open the
  section, plain text otherwise. Never a hand-written "Settings → X".

- The header row is `TABLE_HEAD_ROW` from `components/Table` (the eyebrow
  tier at an AA grey, semibold, with a bottom hairline) on `<thead>` or the
  header `<tr>`; cells use `TH` / `TD`, body rows `TR`. Every table gets
  tabular numerals from `globals.css`, so dates, counts and versions line
  up without opting in. Wrap a table that can outgrow its card in
  `<TableWrap>` so it scrolls sideways instead of breaking the page.
- `<Table scroll minWidth>` wraps a wide table in a sideways scroll
  container (the width rides on `--table-min` and is dropped under
  `print:`, with the wrapper's scroll released, so a wide record prints
  whole instead of clipping at its card); `<Table sticky>` keeps the header
  on screen while the page scrolls (never both: a sticky header inside a
  scroll wrapper sticks to the wrapper, not the page). `<Th sort={{ key,
  by, dir, onSort }}>` is a
  real button with `aria-sort` and a lucide icon (never a typed arrow);
  `<Th fit>` / `<Td fit>` shrink a column to its content (dates, counts,
  actions) so the primary column takes the slack; `TR` carries the hover
  band. Row actions: rare destructive actions keep text buttons (Users,
  Trash); dense admin lists use icon buttons with a separator before
  Delete (People admin).
- **A measurement in a cell is ink, never a chip** (1.11.0, the Record
  tab's Read time in `doc/[id]/acknowledgements/page.tsx` is the worked
  example). A value that fails a threshold renders in `ink-warn` on a
  focusable span (`tabIndex={0}`) carrying its `data-tt`; a chip would make
  a number read as a status. Because the table scrolls sideways inside its
  card the bubble can clip (§Tooltips), so the rule is also spelled out in
  a footnote under the table (`text-xs text-slate-500`, the Record tab's
  `EVIDENCE_NOTE`), shown whenever a row carries such a value.
- **A bulk bar** (1.13.0, `AckRoster` is the worked example; `SpaceViews`'
  `BulkBar` is the older hand-rolled one). A table with a leading checkbox
  column (`<Th fit>` holding a header checkbox `aria-label="Select all
  people on this page"`, `<Td fit>` row checkboxes `aria-label="Select
  {name}"`, both inheriting the accent) shows, only while something is
  selected, one bar above the table: `rounded-lg border border-compass-200
  bg-compass-50/70 px-3 py-2`, "{n} selected" in `text-sm font-semibold
  text-compass-800`, a ghost `sm` **Clear selection**, a hairline, then the
  same actions the rows offer as `secondary` `sm` `Button`s with their
  lucide icons, disabled with `busy` while a request is in flight. One
  label per action on both surfaces (`AckRoster`: "Extend due date…",
  "Exempt…", "Remove exemption", "Snooze", "Unsnooze", "Ask to
  re-confirm…"); a row's icon button has the same words as its `data-tt`
  and `aria-label`, and a date the action sets (a snooze's end) goes in
  the toast and the row's own column, never in the label. The bar
  is `print:hidden`. A bulk action over more than the server's cap (200) is
  disabled inside `Tooltip("Up to 200 people at a time.")`. Selection is
  per page: the header checkbox selects the rows on the page, and a
  successful action clears it. The portal's Policies list and People
  table (1.14.0) select everything the filter and the sort show, across
  pages, labelled "Select all shown" and capped by the "Up to 200 ... at a
  time." tooltip; the roster keeps per-page selection.
- **A stacked progress bar** (1.14.0, `PortalPolicies` is the worked
  example): a `role="img"` `div` carrying the numbers as its `aria-label`
  ("312 confirmed, 88 pending, 12 overdue, 4 exempt"), `flex h-1.5
  overflow-hidden rounded-full bg-slate-100`, segments as spans with
  percentage widths of the total of every segment (the accent
  `bg-compass-600` for done, `bg-slate-200` for open, `bg-red-500` for
  late), and a category outside the denominator hatched with an inline
  `repeating-linear-gradient(45deg, rgb(var(--slate-300)) 0 0.25rem,
  transparent 0.25rem 0.5rem)` so it reads in dark mode and on paper; the
  legend under it in `text-2xs text-slate-500` repeats the numbers for
  anyone who cannot read the colours. Never a hue for the exempt segment.
- **A hash in a cell** (1.14.0, `Evidence` is the worked example) is a
  12-character `code` prefix with an icon-only `CopyButton` ("Copy
  SHA-256") beside it, never the whole hash and never a tooltip holding it
  (the table scrolls); a server-side check of it (**Verify**) is a
  `secondary` `sm` button that toasts; the download is an
  `iconButtonClass("quiet")` anchor named for the row ("Download snapshot
  2026-09").
- **A row that stands for a member with nothing in the list** (the team
  page's "No policies to confirm", 1.14.0) keeps its Person cell and puts
  a `SectionEmpty` in one `Td` spanning the rest, so the member is still
  counted and found.

## Loading

- **One spinner**: `<Spinner size label>` from `components/Spinner`
  (lucide `LoaderCircle`, sm / md / lg, exempt from reduced motion because
  a frozen spinner reads as a hang). Inside a control that already says
  "Saving…" it needs no label; standing alone it carries one. A rotating
  `RefreshCw` on a Refresh button is the one other spinning glyph.
- **One loading row**: `<LoadingRow>` for a list or table still loading
  (centred, `role="status"`). A region that is *refreshing* keeps its
  content, dims with `busyClass(busy)` and carries `aria-busy`.
- **Pending navigation**: sidebar and rail rows render `<LinkPending />`
  inside their `<Link>`; it shows a small spinner after 150 ms while the
  router fetches, so a click never looks ignored and a fast navigation
  never flashes.
- **A submit that must keep focus while busy** (the sign-in steps, 1.16.0)
  is `aria-disabled` and `aria-busy` rather than `disabled`, keeps its
  label, and shows its `Spinner` after the same 150ms (§Sign-in surfaces).
  The sign-in page has no `loading.tsx`: the login helper and every spec
  wait on its real h1.
- **Route skeletons** (`loading.tsx`) exist for the dashboard (its tile
  columns, drawn in `(home)/loading.tsx` from the `Skeleton` primitive,
  1.17.0), a space, the directory, a directory download link's landing
  page (`DownloadSkeleton`, 1.15.0) and analytics (`components/Skeleton`):
  the page's shape, inside a `PageContainer` so nothing shifts, one
  `role="status"` with the
  message, **no real heading** (every spec and the login helper wait on
  the real `h1`). Never under `/admin`, where a permission redirect would
  replace the skeleton a moment later — which is why the dashboard page
  lives in its own `(home)` route group.

## Feedback

- Two live regions are always mounted by `ToastHost` — `role="status"`
  (polite) for successes and `role="alert"` (assertive) for errors — so the
  first toast is an announcement, not a region that appears with its text
  already inside. Errors stay longer; timers pause on hover; each toast has
  an icon and a 28px dismiss target. No inline "✓ Saved" flashes: `toast()`.
- **Copying a value** is `<CopyButton text label iconOnly>` from
  `components/CopyButton`: Copy → Copied with a check and a polite
  announcement, back after two seconds. Never a hand-rolled copy handler.
  **A link to hand out** (1.15.0, the directory's download links) is the
  link as a read-only, select-on-focus `TextInput` in a `Field`, with
  **Copy link** and a bordered open-in-new-tab icon button *beside* the
  field, never inside it (a `Field` is a `<label>`, which holds one
  control): `components/ExportLinkFields`.
- **A page that does its job on arrival** (1.15.0, `/directory/download/
  <preset>`, the landing page a download link opens after sign-in) is an
  ordinary signed-in page: `PageContainer` and `PageHeader`, then one card
  that starts the work at once and is one `role="status"` region saying
  where it is (a `lg` spinner and "Preparing your PDF…", then a check and
  "Downloaded" with the file name, or a warning icon, the server's own
  `error` and **Try again**). **Back to home** is always there and becomes
  the primary once the work is done; a small direct link (`link`, "Nothing
  happening?" while it runs, "Not in your downloads?" after) is the
  fallback, and using it stops the page's own request and shows a neutral
  "in your browser" state, never a success the page cannot see. A retry
  moves focus to the status region (`tabIndex={-1}`) when the button that
  had it went with the work and focus fell to `<body>`. The history entry
  remembers that the job is done, so Back to the page shows the result
  instead of doing it again; a reload does it again. Whatever the page can tell
  before starting (no access, a link to something deleted) is an
  `EmptyState` with a way on, never a failed download. Its route has its
  own `loading.tsx` (`DownloadSkeleton`) so a parent's skeleton does not
  flash the wrong shape.
- Action results use **toasts** (bottom-right, auto-dismiss, ok/error
  styling) — not top-of-page notices that scroll out of view.
- **Reversible actions tell, they don't ask.** Moving to the Trash,
  discarding a branch, archiving: do it and toast with an Undo action
  (`toast("ok", "Moved to the Trash.", { action: { label: "Undo", onClick } })`)
  that reverses through the existing API. Only the genuinely irreversible
  gets a `confirmDialog`, and its body ends "This cannot be undone."
  Sending mail is that case (1.10.1): the compliance portal's **Remind**
  asks "Remind 88 people?" with **Send reminders**; switching a
  requirement on asks through the shared `requireAckDialog`
  (`components/RequireAckDialog`), a `confirmDialog` with a `secondary`
  "Require quietly" button, so the document shield and the portal cannot
  drift. **Stop requiring** is reversible, so it tells and offers Undo.
- A toast constant written "Sentence · Undo" (`SET_DEACTIVATED_TOAST`,
  1.14.0) is rendered as the sentence and the Undo action, never as one
  string: the middle dot marks where the action goes.
- **An attestation whose statement is printed beside the button is the
  question; it does not open a dialog** (1.10.0). "I confirm that I have
  read and understood this document." next to **I've read and understood
  this** is already the sentence a `confirmDialog` would repeat, so the
  button records at once, toasts ("Confirmation recorded.") and moves
  focus to the done state; a dialog here would ask the same thing twice.
  The rule covers any signed statement, the training gate included. A
  dialog *is* right for the other party's decision — an editor choosing
  whether readers must re-confirm (the choice dialog in §Overlays).
- **Row actions go through `useAction()`** (`lib/use-action`): `run(key,
  () => fetch(…), { fallback, ok })` ignores a second click while the
  first is in flight, toasts the server's `error` or the specific
  `fallback`, toasts `ok`, and keeps `isBusy(key)` true until the
  refreshed page has committed. Disable the row's controls with
  `isBusy(key)`; never a bare fetch with a `setBusy` pair.
- Errors render in red (`text-red-600`); never show a failure in the
  success style.
- **Never fail silently.** Every `fetch` that can fail needs an `else` —
  `toast("error", …)` with the server's own `error` field when it sends one,
  falling back to a specific sentence ("Couldn't restore that document."),
  never a bare "Action failed." No `alert()`, `confirm()` or `prompt()` in
  the app: a question is `confirmDialog()` / `promptDialog()` from
  `components/Dialog` (see Overlays and modals). The one exception is the
  leave guard in `lib/use-unsaved`, which is the browser's own on purpose.
- `toast()` only shows where a `<ToastHost />` is mounted. One is in
  `(app)/layout.tsx` and one in `account/(settings)/layout.tsx` — a new shell
  outside those groups must mount its own or its toasts go nowhere.

## Vocabulary

One word per thing, everywhere a person can read it (labels, buttons,
placeholders, toasts, empty states, dialog copy, audit rows). Code
identifiers (`docs`, `doc_count`) keep their names.

- **Documents**, never "docs" in copy: "Export all documents", "12
  documents", "stale documents". "Doc" is fine only inside a proper noun
  that already has it (a URL, a DMS record label).
- **Users / people / accounts.** *Users* is the settings section
  (`/admin/users`) and its rows: an account someone signs in with, holding
  a role. *People* are directory entries (`/directory`): a person who may
  or may not have an account. *Accounts* is the word for the sign-in
  itself ("Match accounts to people", "signed in to their account"). The
  section is named "Users", not "Users & roles" — roles have their own
  section.
- **Search vs Filter.** A control that *fetches* says "Search …" (people
  search, document search, settings search, every `EntityPicker`). A
  control that *narrows a list already on the page* says "Filter …" and is
  `<ListFilter label="Filter users" noun="users">` from
  `components/ListFilter`, which also renders the live "3 of 89 users"
  count so the heading and the rows agree. An empty filter result says "No
  users match your filter.", never "…your search."
- **Trash.** "Move to Trash" (reversible, toasts with Undo), "Restore",
  "Delete permanently" (irreversible, `confirmDialog`). Never "remove",
  "purge" or "archive" for the same thing. The destination is "the Trash".
- **Space, Category, Page.** A *space* groups documents; a *category* is a
  section within a space; a *page* is a nested document under another
  document. "Folder", "section" and "sub-doc" are not product words.
- **Read confirmation** (1.10.0). The feature is *read confirmation*, and
  the product once said it four ways (confirm, acknowledge, attest, sign
  off). One glossary, every surface:
  - The reader **confirms** and **re-confirms**; never "acknowledges",
    "attests" or "signs off" in copy. The button is "I've read and
    understood this"; the toast is "Confirmation recorded."
  - The sentence a reader agrees to is the **confirmation statement**
    (default: "I confirm that I have read and understood this document.").
  - A manager **asks to re-confirm**: the controls are "Ask everyone to
    re-confirm…" for the audience and "Ask to re-confirm…" for one person
    (D4). Never "Re-request", "Re-attest" or "Reset confirmations" as a
    label — the reset is what happens, not what the person asks for.
  - The evidence row is the **attestation record**; the page that lists
    them is "the record" ("View record", "View your record").
  - One person's everything is their **compliance record** (1.14.0): the
    page title, the Users page's button ("Compliance record"), the
    erasure ("Anonymise compliance record…"); the reader's own links are
    "View your record" and "Your record".
  - Status chips read **Confirmed**, **Pending**, **Overdue** or
    **Exempt**, and nothing else (§Status chips has the tones).
  - The erasure action is "Anonymise compliance record…" (C5). The cycle
    is **annual re-confirmation**.
  - The number is **version 12**, shown as **v12** in chips, meta lines
    and labels. Never "revision" in UI copy; the CSV column
    `revision_as_of` keeps its name because exports never rename a column.
  - A **policy** is a document that requires read confirmation, and the
    word is used only on the compliance pages (the portal, the record). On
    the document page it is always "this document".
  - A group of policies is a **set** — never "pack" or "bundle", except
    inside an example name an admin types.
  - **People** wherever a count is shown ("42 of 50 people", "3 people
    notified"); **readers** only in prose without a number ("readers are
    notified").
  - "Acknowledgement" survives only where a rename would break something:
    API paths (`/api/documents/[id]/ack`, `…/acknowledgements`), audit keys
    (`document.acknowledge`, `ack.requested`), permission keys
    (`document.ack_submit`) and the licence label ("Policy
    acknowledgements"). Nowhere a person reads.
- **The audit log never prints a raw key.** Action labels come from
  `lib/audit-labels` (`actionLabel("user.create")` → "Created user"); every
  `audit({ action })` the codebase emits has a verb-first label there, and
  `test/audit-labels.test.ts` fails when one is missing. The fallback
  humanises ("Directory · Person updated") so an unmapped key is a dull
  row, not a code identifier; detail keys and target types go through
  `humanise()` the same way.
- **One primary create action per list page.** A settings page that lists
  things has exactly one primary button, top-right of its intro row (the
  row with the count or description): "Add user", "New space", "New
  group". It reveals the inline create form *above* the list it adds to;
  while the form is open the button hides, and the form's Cancel closes
  it. Other actions on that row are secondary. Nothing primary sits below
  the list.

## Not-found and error routes

Four boundary files cover the whole product; extend them rather than adding
per-route variants:

- `(app)/not-found.tsx` — every `notFound()` inside the shell. Standard page
  skeleton, page-level empty-state card, and both escape hatches ("Back to
  dashboard", "Search documents"). `app/not-found.tsx` is the same copy in a
  centered card for addresses outside the shell.
- `(app)/error.tsx` and `app/global-error.tsx` — client components with an
  honest sentence, the `error.digest` as a support reference, and a `reset()`
  retry button. `global-error.tsx` replaces the root layout, so it renders
  its own `<html>`/`<body>`, imports `globals.css`, and re-runs the pre-paint
  theme stamp itself — otherwise it is the one unstyled white slab left.

## Icons

- **lucide-react only** — no emoji in UI or marketing-site icons, no other
  icon sets, and **no typed glyphs** as control text: "＋ New" is
  `<Plus /> New`, "Copied ✓" is `<Check /> Copied`, "✨ Write" is
  `<Sparkles /> Write`. Typed characters sit off the baseline, ignore the
  accent and vary by OS; a guard test keeps them out. The exceptions are
  emoji that are content (space icons people chose) and the keycap map.
- **The provider-mark exception** (1.16.0, `components/auth/ProviderMark`):
  on a single sign-on button, Microsoft's four squares and Google's
  four-colour G are inline SVGs in their own literal colours, because
  people look for those marks. They are the only non-lucide icons in the
  product, always `aria-hidden` (the button's words name the provider) and
  drawn only for the vendor actually configured. A generic OIDC provider
  takes lucide `KeyRound` and SAML takes `Building2`, both in
  `text-compass-600`. Never draw a vendor's mark for a provider that is
  not that vendor.
- Sizes: page title `h-6 w-6`, section heading `h-4 w-4`, inline/button
  `h-4 w-4`, chip/tiny `h-3 w-3` or `h-3.5 w-3.5`.
- **Vocabulary:** a control that opens an editor or a new screen says
  **New …** ("New document", "New role", "New newsletter"); a control that
  appends a row or item in place says **Add …** ("Add link", "Add file",
  "Add user"). Never "＋ Link".

## Overlays and modals

- Overlays mount as a **direct child of the app shell's root flex div**
  (`(app)/layout.tsx`), not inside the component that owns them. That div
  creates no stacking context, so a `fixed` child is not clamped — which is
  why the notifications dropdown clips today and the palette doesn't. No
  portals exist in this codebase; if a `transform` ever lands on the shell,
  add one rather than escalating z-index.
- **A modal is `<Modal open onClose label|labelledBy layout scrim
  closeOnBackdrop className>`** from `components/Modal`: a portal to
  `<body>`, a layer on the LIFO overlay stack (Escape reaches only the
  top-most one), `inert` + `aria-hidden` on the background, a scroll lock,
  a Tab trap, initial focus on `[data-autofocus]` (else the first focusable
  element), and focus handed back to whatever opened it. The dialogs, the
  lightbox (`layout="fill"`), the video theater, the insert-video dialog
  and the analytics drill-down are all this component. Never a hand-rolled
  `fixed inset-0` layer with its own Escape listener or `body.style.overflow`
  poke. `useModalOverlay` (`components/overlay`) is what Modal is built on;
  reach for it directly only for a drawer that is not a dialog.
- **Floating panels** (a menu, a column picker, a QR card, the bell) are
  `<Popover open onClose triggerRef role label align side width>` from
  `components/Popover`, with `MenuItem` / `MenuSeparator` for menus: one
  radius and padding, the float tier, outside-click, Escape through the
  overlay stack, focus back to the trigger. The trigger carries
  `aria-expanded` and `aria-haspopup`. Never hand-roll an `absolute …
  shadow-lg` panel (a guard test fails the build).
- **A picker menu** (one choice among a few, 1.18.0: `FindModeMenu`) is a
  `Popover role="menu"` whose rows are `role="menuitemradio"` with
  `aria-checked` on the chosen one, never `menuitem` plus an sr-only
  "(current)". The Popover opens on the checked row (a plain menu opens on
  its first item), and its arrows, Home and End walk `menuitem`,
  `menuitemradio` and `menuitemcheckbox` rows alike.
- **A popover holds a handful of controls, never a settings page**
  (1.10.0). The Read confirmation popover on the document shield
  (`AckSettings`, A5) holds **four controls** under its heading — the
  "Require readers to confirm" Toggle, the status line with its "View
  record" link, the "When the text changes" Select, and the "Ask everyone
  to re-confirm…" button — plus one link, **All settings**, to that page
  (1.13.0), and nothing else is ever added to it. Further
  per-policy settings (audience, deadline, reminders, the re-confirmation
  interval, the statement, signature) go to the document's Read
  confirmation **Settings** page (`/doc/[id]/acknowledgements/settings`,
  with the house `SubNav`: Record · History · Settings), reached from the
  record. A popover wanting a fifth control is the signal to make the
  page.
- **An action over one of several rows on a page without a table of its
  own** (the person record's Exempt from…, 1.14.0) is a `secondary` menu
  button opening a `Popover role="menu"` of the rows it applies to,
  disabled inside a `Tooltip` saying why when there is nothing to pick;
  the question that follows is the roster's dialog.
- **Questions are dialogs**: `confirmDialog({ title, body, confirmLabel,
  danger, typeToConfirm, secondary })` and `promptDialog({ title, label,
  type, initial, validate, min, max })` from `components/Dialog`, one
  `<DialogHost />` beside the ToastHost. Themed, focus-trapped, Escape
  through the overlay stack, focus back to the trigger; the button says
  what it does ("Delete user", never "OK"); a destructive dialog is
  `danger` (red button, warning icon, focus starts on Cancel); an
  irreversible one adds `typeToConfirm` (RESTORE, PUBLIC, the space's
  name). A prompt validates inline (`validate`, or `min`/`max` for a
  number) instead of letting the server refuse. Chained questions are one
  dialog. Never `window.confirm` / `window.prompt` (the leave guard
  excepted) and never a hand-rolled modal for a yes/no.
- **Choice dialog** (1.10.0). A question with two or three named outcomes
  that share one extra input is one bespoke dialog on `components/Modal`,
  never a `confirmDialog` chained into a `promptDialog`. The recipe: a
  title that is the question ("How should readers see this change?"), a
  one-sentence lede with the numbers that matter ("42 of 50 people have
  confirmed version 12 of …"), a `role="radiogroup"` of **stacked radio
  cards** — a label plus one description sentence each, arrows moving the
  choice — **one hint sentence** that pre-selects a card ("Looks
  editorial: 14 words in one paragraph changed.") and may carry a
  disclosure for the evidence ("Show changes"), **one inline field** (a
  `Textarea` in a `Field`, required for every choice, its help changing
  with the selection), and Cancel plus **one primary whose label follows
  the selection** ("Save. Keep confirmations" / "Save and ask 42 people to
  re-confirm"), so the button always says what will happen. The same
  dialog serves Submit, Approve, Restore and Merge (1.11.0) with the verb
  in the primary ("Restore. Keep confirmations", "Merge and ask 42 people
  to re-confirm") and the question in the title ("Restore version 9 of a
  confirmed document?"); no second recipe. Enter submits,
  Escape cancels. It exposes a promise (`reconfirmDialog(opts) → result |
  null`) that the caller awaits **before** setting any busy state, so
  Cancel leaves the form dirty and the Save button idle; being on the
  overlay stack, `overlayOpen()` keeps the keyboard shortcut from opening a
  second one. `ReconfirmModal` (A3) is the first.
- **Three elevation tiers**, as tokens: `shadow-card` (`shadow-xs`, a
  resting card), `shadow-float` (menus, popovers, dropdowns, toasts),
  `shadow-modal` (dialogs, the palette). Nothing else casts a shadow.
- **Escape belongs to the top-most layer only.** Anything that binds Escape
  globally must check `overlayOpen()` from `lib/overlay-stack` first.
- Every overlay carries `role="dialog"`, `aria-modal="true"`, and an
  accessible name. The scrim's color is hard-coded (never a themed
  variable — the slate ramp inverts and would paint a near-white wash in
  dark mode).

## Keyboard shortcuts

- **Single-key shortcuts can be turned off** (WCAG 2.1.4): the account
  preference `single_key_shortcuts` (Account → Preferences → Keyboard),
  mirrored in localStorage by `components/palette/single-key`. With it
  off the bare keys (/ @ > # ? c and the g-chords) do nothing and the
  shortcut sheet hides them; Ctrl/⌘+K always works. Any new bare-key
  shortcut must go through the palette's hotkey layer so the switch
  covers it.

- Bindings live in `lib/nav-items` (`g` chords) and `lib/palette-commands`;
  guards live in `lib/hotkeys`. Never add a bare `keydown` listener without
  `blockBareKey`/`blockModKey`.
- **Match on the character produced (`e.key`), never a key code**, so every
  keyboard layout reaches the shortcut. AltGr (Ctrl+Alt on Windows/Linux)
  is how `@ > # ?` are typed on many layouts — the guards treat it as
  typing, not as a modifier.
- Mod means ⌘ *or* Ctrl in handlers, always both. For labels use
  `modLabel()` — never hard-code a glyph, or Windows users read "⌘K".
- A shortcut must never fire while the user is typing or while an overlay
  is open. Gate every binding on capability too: a shortcut for something
  the user can't reach must not be bound at all.

## Reading measure (rendered documents)

Document-reading surfaces — the document page, the share page, the public
document page — set `.doc-read`. Inside it, **direct children of `.doc-prose`
are capped at `var(--doc-measure)`** — the measure for body text, deliberately
narrower than the page.

The measure **scales with the page-width setting**, via `data-page-width` on
`PageContainer`:

| setting | cap | ≈ characters |
| --- | --- | --- |
| Normal | `65ch` (the rail stacks below the article, so the full 56rem column is text) | ~82 |
| Wide | `75ch` | ~98 |
| Full | `90ch` | ~117 |

One number could not serve all three. Pinned at `60ch`, someone who chose Full
got text using 41% of the column with the rest empty — a control that visibly
did nothing to what they were reading. Choosing a wider page *is* a request for
density, so the measure widens with it, while staying bounded: uncapped, that
column is ~190 characters at 2000px.

The share page and the public document page render `components/StandaloneDoc`
(1.9.2) — one masthead, summary, reading card, attachments panel and print
output — and pass the title as `dropTitle` to `MarkdownView`, as the document
page does, so a body that opens with "# Title" is not shown twice
(`lib/drop-title`: the first block only, an H1 only, loosely matched). No
other `MarkdownView` host passes it.

**Heading offset** (1.18.0). A host whose own title already holds a place
in the outline passes `headingOffset` to `MarkdownView`, and the body's
headings are re-tagged that many levels down (capped at h6), so the page
keeps one h1 and an unbroken ladder. The handbook reader's policy page,
its introduction and the printed handbook pass `2`: the policy title (or
"Introduction") is the h2, so an authored `# Heading` is an h3 there. The
tag is the outline; the look stays the level the author wrote: each
shifted heading carries `data-md-level` and that level's `.doc-prose`
look as `!`-utilities (the prose rules are unlayered), so a reader sees
the same document as on its own page. Anything that reads a body's
headings (a contents rail) queries h1-h6 and takes the shallowest levels
present, never a fixed `h1, h2, h3`. The document page itself passes
nothing: its title is the page's h1.

Surfaces with no `data-page-width` ancestor — the share page, the public
document page — fall back to `60ch` / ~78 characters. They have no preference
to read, and legibility is the right default for an anonymous reader.

Note `1ch` is the advance of "0", but the average prose glyph is narrower, so a
`ch` value renders about 1.26x more characters than it names. Quote the
character count, not the `ch`, when reasoning about legibility.

The cap is on the children, not on `.doc-prose` itself. Capping the container
also caps everything in it, which is what made a ten-column table scroll
sideways inside a 60ch column while the rest of the page sat empty — and made
the Wide and Full page settings render the body identically.

Blocks that are **wide by nature** opt out with `doc-wide` on their outermost
element:

```tsx
<div className="doc-wide md-filter-table">…</div>
```

Carried today by every block that renders as a **panel or as media** rather
than as running text: the table wrapper (`FilterTable`), fenced code
(`CodeBlock`), rendered diagrams (`MermaidBlock`, `PlantUmlBlock`), callouts
(`Callout`), the accordion (`DocDetails`), tabs (`DocTabs`), the decision tree
(`DecisionTreeBlock`), video (`VideoPlayer`) and embeds (`SiteEmbed`). A
paragraph whose only child is an image gets the same treatment via `:has()` —
markdown has nowhere else to put a figure.

The test is **what the block is**, not what's inside it. A callout holds prose
but it is a bordered, tinted panel that interrupts the text; leaving it at the
measure while the table above it spans the column is the raggedness this rule
exists to prevent. Containers are the clearest case: a table inside a tab or an
accordion is capped by its ancestor, so a narrow container silently halves
every table in it.

Rules:

- Opt out at the **call site**, not by matching shape in CSS. A new block type
  has to ask for the width deliberately.
- `doc-wide` removes the measure, not the column: a wide block still can't
  exceed whatever Normal/Wide/Full resolved to. Keep the block's own
  `overflow-x-auto` for the case where even that isn't enough.
- Never put `doc-wide` on the document's **running text** — paragraphs, lists,
  headings, blockquotes. Those are what the measure is for, and a full-width
  paragraph is the bug this section prevents.
- **The editor shares the measure** (1.9.0). The document editor sets
  `doc-edit` on the rich-text card (`<RichTextEditor measure>`) and on the
  Preview tab, and `globals.css` caps the direct children of
  `.doc-edit .doc-prose` exactly as `.doc-read` does, so what you type wraps
  where the page will wrap it. Panels keep the column there too: tiptap's node
  views (`data-node-view-wrapper`), the table wrapper, `pre`, and anything
  carrying `doc-wide`. The newsletter and template editors host the same
  component without `measure` — email has a width of its own.
- A panel carrying long-form prose is a smell. Callouts are one to three
  sentences by convention; if one grows into an essay, the fix is to promote it
  out of the callout, not to re-narrow the panel.

## Handbooks

A handbook (1.18.0) is an ordered bundle of published policies and SOPs
(1.18.2; any other published document through "All types") from any
space, in numbered sections, read as one (`/handbooks/{id}`), printed as
one (§Print) and, with read confirmation licensed, confirmed as one
(`/handbooks/{id}/confirm`). Its components live under
`components/handbooks/` (`reader/`, `editor/`, `confirm/`, `print/`).

- **Naming what a handbook holds** (1.18.2). Every count, position and
  sentence about a handbook's items comes from `lib/handbook-shared`
  (`handbookItemsLabel`, `handbookPositionLabel`, `handbookKind`,
  `kindNoun`) and `lib/handbook-confirm-shared` (`handbookStatement`,
  `confirmButtonLabel`), so the list, reader, rail, confirm page, printed
  copy and editor agree. Never hand-write "policies" next to a count.
  - **Policies only** (or empty): the 1.18.0 words, unchanged — "8
    policies", "Policy 3 of 8", "Confirm 5 policies", "I have read and
    understood all 8 policies in {title}, and I agree to follow them."
  - **SOPs only**: the same words with **SOP / SOPs** (always upper case,
    the `TypeBadge` label) — "4 SOPs", "SOP 2 of 4", "Confirm 2 SOPs",
    "…all 4 SOPs in {title}…"; "an SOP" where an article is needed.
  - **A mix**: counts name each kind, policies first, then SOPs, then
    every other type as **other documents** — "3 policies and 2 SOPs",
    "3 policies, 2 SOPs and 1 other document", "1 SOP and 2 other
    documents" ("other", because the policies and SOPs are documents too)
    — and a position uses the neutral house noun, **Document k of N**
    (never "Item", which is not a product word; the `TypeBadge` beside it
    says which kind). The whole-handbook statement names the total and
    the mix: "I have read and understood all 5 documents in {title} (3
    policies and 2 SOPs), and I agree to follow them."; a total of two is
    **both** ("both documents in {title} (1 policy and 1 SOP)", "both
    SOPs in {title}"), except for policies only, which keep "all 2
    policies". Only other types: "4 documents".
  - **One document** speaks of itself by its own kind wherever it is read:
    "this policy", "this SOP", "this document" (the confirm bar, "On this
    SOP" in the rail), and so does a list row's screen-reader prefix on
    the confirm page ("SOP 3: " in a mix; the number is the handbook's).
    What leads to the **next** document names the handbook's kind, not the
    current one's, since the next may differ: "Next policy", "Next SOP",
    "Next document" (`nextItemLabel`).
  - **The printed acknowledgement** agrees to follow "the policies it
    contains" for policies only, however many (the 1.18.0 sentence);
    other contents are counted: "the SOP", "the SOPs", "the documents".
  - The statement is stored on attestation records, so a policy-only
    handbook's sentence must stay byte-identical; a change to any of these
    helpers is a change to evidence wording.

- **The reader's frame** (`HandbookReader`) is the page skeleton: a
  `Breadcrumbs` back to Handbooks, then `PageHeader` with `BookOpen`, the
  handbook's title and the subtitle "N policies in M sections · updated
  {date} · for the whole workspace" (or "owned by {space}"). The actions,
  in order: **Edit** (`secondary`
  `Pencil`, editors only), **Print or save as PDF** (`secondary`
  `Printer`, to `/handbooks/{id}/print?print=1`) and **Confirm handbook**
  (`primary` `ShieldCheck`, to `/handbooks/{id}/confirm`; published
  handbooks that ask for it, under the licence), each `print:hidden`. A
  draft shows one `notice-warn` line under the header ("This handbook is
  a draft…"). Under it, `lg:grid-cols-[16rem_minmax(0,1fr)]`: the
  contents rail and the pane. A handbook with an introduction opens on it
  (`HandbookIntro`: a `CARD_CLASS` section, an h2 "Introduction", the
  Markdown, and one `primary` "Start reading: {title}" or "Continue:
  {title}").
- **The contents rail** (`HandbookContents`) is a `<nav aria-label=
  "Handbook contents">` on `CARD_CLASS px-2 py-3`, **sticky beside the
  pane from `lg`** (`lg:sticky lg:top-6`, capped at the viewport and
  scrolling itself). On a phone it sits above the pane **collapsed behind
  one button**, "Contents · Policy k of N · x of y confirmed" (the noun
  per §Naming what a handbook holds)
  (`TableOfContents`, a turning `ChevronDown`, `aria-expanded` /
  `aria-controls`), so the policy is the first thing a small screen
  shows; following a link closes it. Inside, top to bottom: **Your
  progress** (a `RAIL_GROUP_TEXT` label, "x of y confirmed" and the
  percentage, a `role="progressbar"` `h-1.5` bar in `bg-compass-600`;
  only when the licence is on and some policy asks this reader), the
  Introduction link, then each section as a group label ("1 · Working
  here", a `RAIL_GROUP_TEXT` div, not a heading — the policy's h2 owns
  the outline) over an `<ol>` of numbered policy links (`tabular-nums`
  number, title, the emerald `Check` once confirmed). The policy on
  screen is `aria-current="page"` on `bg-compass-50 font-semibold
  text-compass-700`, and under it an "On this policy" list: "In short"
  when it has summary points, then the two shallowest heading levels of
  its body (whatever their tags once shifted, §Reading measure, heading
  offset), the one being read `aria-current="location"` with a 2px
  inset accent bar. Each policy is a link with its own address
  (`/handbooks/{id}/{docId}`), so it can be bookmarked and shared.
- **The policy masthead** (`PolicyPage`) sits on `CARD_CLASS` with an
  accent wash (`bg-linear-to-b from-compass-50 to-transparent`, dropped in
  print). One wrapping row of badges: `TypeBadge`, `HandbookOnlyChip`
  when that is where people find it (its tooltip naming this handbook), "Policy k of N" ("SOP k of N", "Document k of N" for a mix; `text-xs
  text-slate-500`, plain text), and the reader's `StandingChip` pushed
  right (`ml-auto`). Then the title (an h2 at the document-title size,
  §Page skeleton) and the **facts row** (`PolicyFacts`): a `<dl>` of
  Owner, Approved by, Version, Effective, Next review, Applies to, each a
  `text-3xs` uppercase `dt` over a `text-sm font-medium` `dd`, wrapping
  `gap-x-7 gap-y-3`; an empty fact is left out, never a dash.
- **In short** (`InShort`): up to five summary points in an accent panel
  (`rounded-lg border-compass-200 bg-compass-50`, an h3 "In short" in
  `text-sm font-bold text-compass-700`, a disc list), above the body. A
  point is one sentence; `**bold**` is the only markup it keeps, rendered
  as React text (`boldRuns`) so a point can never carry a link or HTML,
  on paper too: the printed sheet's "In short" uses the same
  `boldRuns`, never `MarkdownView`. Its id is the rail's "In short"
  anchor.
- **What changed** (`WhatChanged`), for a reader who confirmed an
  earlier version: one `notice-warn` box, "**What changed in version 3**
  (you confirmed version 2): {the version notes since, oldest first}." and
  a **Compare versions** link (underlined in the notice's own ink, not
  the accent, which loses contrast on amber in dark mode) only for a
  reader who may open the document's own page.
- **The body** is the document renderer in a `doc-read` article (the
  reading measure, §Reading measure) with `headingOffset={2}` (its h1 is
  an h3 under the policy's h2), then **the confirm bar**
  (`PolicyConfirmBar`): the end-of-article action (§Sections and cards)
  in a handbook's clothes — the same `AckProvider` state, the same POST
  and typed signature — on a `rounded-lg border bg-slate-50` strip. A
  **tick box** beside the policy's own confirmation statement (rendered
  through `MarkdownView`, with the version line under it) **gates the
  button**: **Confirm** (`primary`, `Check`) is `aria-disabled` with
  `aria-describedby` on a visible "Tick the statement to confirm" line
  (then "Sign above to confirm" on a signature policy) until ticked and
  signed. When a signature is asked, the **Sign to confirm** block sits
  between the statement and the button row, so the order on screen is the
  tab order: tick, sign, Confirm, Next. Done, the strip says "You
  confirmed version N on {date}" with the emerald `CircleCheckBig` and
  **View your record** (a `link`, inside the sentence); a policy that
  does not ask says "For information." in one sentence. The navigation
  sits in the same strip: "Next: {title} →" (`secondary`), or on the last
  policy **Confirm handbook** when the handbook asks for it, else the
  previous policy. Every navigation button is `max-w-full` with its label
  in a `min-w-0 truncate` span, in a `min-w-0 max-w-full` wrapper (never
  `shrink-0`), so a long title truncates instead of widening a phone.
  The **Related** documents under the strip are `link`s.
- **Confirm the whole handbook** (`HandbookConfirm`) lists every policy
  with its `StandingChip`, one statement checkbox ("I have read and
  understood all N policies in {title}, and I agree to follow them."),
  the **Sign to confirm** block only when an outstanding policy needs a
  typed signature, and one `primary` "Confirm K policies" ("Confirm the
  handbook" once every policy already counts).
- **The editor** (`HandbookEditor`) is the explicit-save pattern
  (`SaveRow`, Ctrl/⌘+S, the leave guard): Details and Contents beside a
  sticky **Add documents** panel (`lg:grid-cols-[minmax(0,1fr)_22rem]`;
  named for documents, not "policies and SOPs", because its All types
  filter offers every type and its search box already says "Search
  documents…", §Vocabulary), whose `Segmented` type filter reads
  **Policies | SOPs | All types** (Policies first, as the default), with
  an empty result per filter ("No published SOPs here. Try Policies or All
  types."), the
  status chip and the named actions (Preview, Publish handbook /
  Unpublish) in the header, each `print:hidden`, Delete in the
  `DangerZone`. Each Contents row (a locked placeholder aside, below)
  carries the pill **Where people find it** menu (§Status chips), which
  is why that card is `CARD_CLASS` (§Sections and cards). Move up / Move
  down keep focus on the pressed arrow, so the card says where the row
  went in an always-mounted `sr-only` `aria-live="polite"` line ("Moved
  {title} to 3 of 8, in {section}."; a remove says "Removed …"). A Save
  that fails validation focuses the first invalid control in the card's
  order: Title, Introduction, then the groups picker's search box. After
  a contents save the page takes the new sections' ids from the answer,
  so a Save after a later step's refusal does not send the contents
  again.
- **A locked placeholder** (a Contents row whose document is in a space
  the editor can't add from, `HandbookItem.restricted`): the server sends
  no title, space or version, so the row shows a `Lock` (`h-3.5 w-3.5`,
  `aria-hidden`, `items-start` + `mt-0.5` so it leads the first line when
  the title wraps on a phone) and "A document you can't open"
  (`HANDBOOK_RESTRICTED_ITEM`) in `text-sm font-medium text-slate-500`,
  over the `text-xs text-slate-500` line "From a space you can't add from.
  You can move or remove it." It keeps Move up / Move down / Remove (their
  `aria-label`s name it by number, "item 3 (a document you can't open)",
  since placeholders share a title) and has no **Where people find it**
  menu and nothing that opens it. While the handbook holds one, the routes
  refuse Publish and any change to who reads or owns it with 403
  (`HANDBOOK_FOREIGN_CONTENTS`); the editor shows that sentence as a
  `FormError` at the foot of the Details card (the fields it is about,
  scrolled into view with `scroll-mb-24` clear of the pinned Save row),
  from a Save and from Publish alike, never a toast, and keeps the edits.
- **Two editors at once** (optimistic concurrency, 1.18.0). The details
  PATCH and the contents PUT send `if_updated_at`, the handbook's
  `updated_at` as the page last saw it (loaded, or answered by its own
  previous write, publishing and unpublishing included); a find-mode
  change leaves it alone. When someone else saved in between, the route
  answers 409 with "This handbook was changed by someone else. Reload to
  see their changes." and writes nothing. The page keeps every edit and
  shows that sentence in a `FormError` (§Forms) with a `secondary` `sm`
  **Reload** (`RefreshCw`), on its own line inside the Save row (`order-first
  basis-full`), which is pinned while the page is dirty, so it is on
  screen wherever Save was pressed; no toast repeats it. Reload asks
  first (`confirmDialog`, `danger`, "Reload and discard your changes?")
  when there are unsaved edits.
- **Handbook-only documents in their space.** Readers no longer find
  them there; the people who look after the space still do, each marked
  with `HandbookOnlyChip`, and the space page opens with one
  `SpaceHandbookNotice`: a `role="note"` line on `rounded-lg border
  border-slate-200 bg-surface px-4 py-3 text-sm` with a `BookOpen`, "**3
  documents here are handbook only.** You see them because you edit this
  space; readers find them only in {handbook links}." Informational, so
  neither a `notice-*` state banner nor a card, and `print:hidden`.

## Scaling

The interface is sized in **rem, never px**, so one root rule can scale the
whole product with the monitor. Tailwind v4 already emits spacing, widths,
icons and the text scale in rem; the house rules keep hand-written sizes on
the same footing:

- Font sizes come from the scale: `text-xs` and up, plus the two small steps
  `text-2xs` (11px at a 16px root — chips, keycaps, captions) and `text-3xs`
  (10px — tiny tags). Never `text-[11px]`. An odd size that has no step is
  written in rem (`text-[0.8125rem]`), never px.
- Dimensions use the spacing scale (`w-4.5`, `max-w-55`, `min-w-[45rem]`),
  never `h-[420px]` / `min-w-[720px]`. Hand-written CSS in `globals.css`
  follows the same rule (tooltip padding, keycap radius, measures in `ch`).
- **Allowed in px**, because they are hairlines or belong to another medium:
  `1px`/`2px` borders, rings, `shadow-xs`, `outline-offset`, the scrim blur;
  `vw`/`vh` overlay bounds; geometry and `<text>` inside an `<svg>`; email
  HTML (`lib/newsletter`, `lib/digest`); react-pdf exports (points); the
  device-viewport sizes of a preview iframe (an inline style: the frame is
  laid out at a real device's size and scaled down with a transform,
  §Settings pages); and the
  sidebar's `matchMedia("(max-width: 767px)")`, which must equal Tailwind's
  `md` breakpoint — rem in a media query resolves against the browser default,
  so breakpoints never move when the root scales.
- `test/style-scale.test.ts` fails the build on a new px literal outside that
  allow-list.

**The root rule.** `globals.css` sets
`html { font-size: calc(clamp(1rem, 0.8571rem + 0.1786vw, 1.125rem) * var(--ui-scale)) }`:
16px up to a 1280px viewport, about 16.3px at 1440, 17.1px at 1920, 18px from
2400 (capped so a 4K monitor at 150%, which presents as 2560, does not
double-scale). Written in rem so browser zoom and the OS text-size setting
keep working. `@media print` resets it to `1rem`. `--ui-scale` is the
per-user Interface scale preference (`data-ui-scale` on `<html>`, stamped
before first paint like the theme). Tailwind breakpoints are rem media
queries that resolve against the browser default, so they never move;
`e2e/scale.spec.ts` asserts the numbers and that nothing scrolls sideways at
2560 and 3440.

**Grids.** A repeating card or tile grid uses `card-grid` (with
`[--card-min:Nrem]` for the minimum card width; 18rem by default) — sized by
the column it is in, so the count follows Normal/Wide/Full and the sidebar
state. Never `xl:grid-cols-4` / `2xl:grid-cols-5`: the viewport is the wrong
variable. CSS-column masonry uses `columns-2xs` the same way. `sm:` / `lg:`
prefixes stay for shell and layout splits only.

**Container queries.** `@container` with `@4xl:` variants is fine on a leaf
wrapper whose subtree holds no overlay (the dashboard's activity/spaces split).
`container-type: inline-size` applies layout containment, which makes the
element the containing block for `fixed` descendants and a stacking context —
the same hazard §Overlays names for `transform`. So never put a container on
`PageContainer`, `<main>`, the document page wrapper or any ancestor of
`Lightbox`, `VideoPlayer`, `DocLinkSuggest`, the editor, `VideoInsertDialog`
or the analytics drill-down. The sign-in cover (`.auth-art`, 1.16.0) is
such a leaf in hand-written CSS: an `inline-size` container beside
`<main>`, never around it, so its type can be sized in `cqi` against the
cover's own width (§Sign-in surfaces). A settings card wrapper may be one
too when its subtree's only overlay, a `confirmDialog`, portals to
`<body>`.

## Print

Pages people print for records (certificates, transcripts, status, the
compliance matrix) hide their controls with `print:hidden` (buttons, search
boxes, filters) and keep tables/breaks clean (`break-inside: avoid` for
cards and images — see the `@media print` block in globals.css). Printing
always renders the **light** theme: the `@media print` block re-declares the
light tokens and `color-scheme: light`, because a dark-mode page printed as-is
is white text on white paper.

**Exports are files, not print dialogs.** When something needs to leave the
app as a document — the directory, a report — render it on the server
(`@react-pdf/renderer` for PDF, plain text for CSV) from an admin-defined
preset, behind an **Export ▾** menu that lists the presets, "What I see"
(the current filter/columns/grouping), and "Print…" as the fallback. The
browser print path can't honour paper size, logos or footers reliably across
machines; a server-rendered file can. Route the values through the same
display helpers the screen uses so a code that shows as a label on screen is
a label on paper. The compliance portal's menu (Matrix CSV, Ledger CSV,
Audit package (ZIP), Print…; 1.14.0) and the record page's (Export CSV,
Ledger CSV (all confirmations), Print…) follow the same shape, "Print…"
last.

**A printed handbook is the one print-first page** (1.18.0,
`/handbooks/{id}/print`). It is a reading copy people put on paper or
save as PDF from the browser, not a record export, so it is browser print,
not a server-rendered file — the content is the documents' own rendered
Markdown (`MarkdownView`), which a server PDF would have to re-implement.
What makes that hold:

- **Outside the shell.** The page lives in the `(print)` route group
  (§Page skeleton), so the cover starts at the paper's corner. Its one
  control strip is `PrintToolbar` (back to the handbook, an A4 / Letter
  `Segmented`, "Print or save as PDF"), which carries the page's h1
  ("Print preview") and is never printed; on paper each sheet heads
  itself with an h2, and a policy's body (or the introduction page's
  text) sits under it with `headingOffset={2}`, so its own h1 is an h3.
- **Sheets are paper in both themes.** On screen the page is a preview:
  white sheets standing on the canvas, one per cover, contents, policy and
  signature page. A sheet's subtree re-declares the light tokens — both
  the raw `--slate-*` / `--surface` triplets and Tailwind's resolved
  `--color-*` (they are resolved where declared, on `:root`) — plus
  `color-scheme: light`, so the shared prose prints dark ink on white in
  dark mode too (`HandbookPrint.module.css`). Its white is literal, like an
  email preview's.
- **Page furniture is `@page` margin boxes**, which Chromium prints: the
  footer on every page ("Title · Company" | "Printed {date} by {name} ·
  uncontrolled when printed" | `"Page " counter(page)`) and, per policy, a
  running header ("1 · Working here" | "Policy 2 of 8"). The header rides
  on **CSS named pages**: each policy sheet sets `page: hb-p-{n}` with an
  `@page hb-p-{n}` rule of its own, which also forces the page break, so
  every policy starts on a new page and every page of a long one carries
  its header. The cover is `@page hb-cover` (no margin, no furniture).
  The rules carry the handbook's title and people's names, so they are
  built per request (`page-css.ts`) and every string goes through
  `cssString`, which escapes it for a CSS string and for the `<style>` it
  is inlined into. Never furniture as fixed-position elements in the flow.
- **No page numbers in the contents.** Chromium has no
  `target-counter()`, so the contents numbers the policies instead and the
  running header says "Policy k of N".
- **`?print=1` opens the dialog once** the fonts and images have settled,
  then drops the flag from the address; the reader's "Print or save as
  PDF" and the handbook list's print icon link there. Every print (the
  button, the flag, Ctrl+P) records `handbook.printed` from `beforeprint`.

**A record page carries a `hidden print:block` footer**, "Generated {date}
by {viewer} · CompassDocs {version}" (the person record, 1.14.0), so a
printed page names who produced it and from which build.

## Accessibility

- **Landmarks are named.** Every `<nav>` and `<aside>` carries a unique
  `aria-label` ("Main", "Spaces", "Sidebar", "Settings sections",
  "Breadcrumb"); breadcrumb separators are `aria-hidden`; a lone back link is
  a `<div>`, not a navigation landmark. `<main id="main">` is focusable
  (`tabIndex={-1}`) so the skip link really lands.
- **Badges have a noun.** A count badge carries a visually hidden noun
  ("3 pending reviews"); a collapsed rail folds it into the link's
  `aria-label`. Unread items say "Unread:" for readers, not just bold.

- Interactive icon-only elements: `aria-label` always.
- Keyboard: anything hoverable must be reachable and reveal its tooltip on
  `focus-visible` (the `data-tt` CSS handles this). A `data-tt` on a
  non-interactive element (a chip, an exact-time span) gets `tabIndex={0}`,
  and sits beside a `<button>`, never inside one — a focusable element
  inside a button is not valid HTML. Inside a sideways-scrolling table the
  bubble is clipped (§Tooltips), so an explanation there is a footnote
  under the table instead.
- Secondary text must clear WCAG AA on the canvas tint — that's why our
  `--slate-500` is darker than stock Tailwind; don't "fix" it back.
