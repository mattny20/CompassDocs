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
  My policies (1.12.0) links the other way, from its rows to this card
  (a policy asked through a handbook, 1.18.3, to the reader's
  `PolicyConfirmBar` instead, §Handbooks), and to the same record as
  **Your record**. The strip at the top keeps **one
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
- **Placement is automatic** (1.20.2, `components/TooltipPlacer`, mounted
  once in the root layout). The bubble opens above its control, centred.
  Just before it shows, the placer measures the room inside the viewport
  and inside every ancestor that clips (a scrolling pane, an
  `overflow-hidden` card): with no room above and more below it opens
  **below** (`data-tt-auto="bottom"`), and one that would cross a side
  edge **slides back inside** (`--tt-shift` on the control). So the
  buttons at the top of a pane (the ticket pane's Status, Follow, Solve
  and More), a list header and a top bar need no attribute.
  `data-tt-pos` is the explicit override and always wins: write it only
  for a reason the placer cannot see (a sticky bar that covers the space
  above without clipping it), never by habit. The CSS transforms carry
  `var(--tt-shift, 0px)`: a new `[data-tt]` variant must keep it.
  `e2e/helpdesk-tooltips.spec.ts` hovers the top controls of the ticket
  pane, the queue, the desk's top bar, settings headers and the main
  app's page headers and fails on a bubble outside what can be seen.
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
- Inside `overflow-auto/hidden` containers the placer keeps the bubble
  within the container's box (below the control when there is no room
  above, slid inside its side edges). A container smaller than the bubble
  in both directions still clips it: inside dense scrolling tables keep
  labels short or keep native `title`.
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
- **A settings list whose items each have a page: list, then detail**
  (1.20.2, Desk settings → Teams). When every item of a settings page
  carries several cards of its own (a team: its fields, people, hours and
  targets, delete), the page is a **list** and each item a **routed page
  under it** (`/desk/settings/teams/[id]`), never every item expanded on
  one page. The list is a `padding="none"` `Card` holding a `ul
  role="list"` with `divide-y divide-slate-100`; each row is one real
  `<Link>` (`flex items-center gap-3 px-4 py-3 hover:bg-slate-50
  outline-offset-[-2px]`, so Enter, middle-click and the focus ring are
  the browser's): an icon tile (`h-9 w-9 rounded-lg bg-compass-50
  text-compass-700`), the name in `text-sm font-semibold`, `chipClass(…,
  "sm")` chips for what is worth knowing before opening it (**No members**
  `warn`, a mapped help address `neutral`, with an `sr-only` prefix so the
  row's name reads as a sentence), one truncated `text-xs text-slate-500`
  facts line ("5 people · Leads: Ana, Sam"), a right-aligned count ("12
  open") and a `ChevronRight` in `text-slate-400`. No row actions: what
  changes an item lives on its page. A `ListFilter` sits in a
  `border-b px-4 py-3` strip above the rows once the list passes eight,
  and a filter that matches nothing is a `SectionEmpty` with "Clear the
  filter". The one primary **Add …** is in the `PageHeader` `actions`; it
  asks for the least it needs in a `formDialog` (a name, an icon),
  creates, and opens the new item's page. No items: `EmptyState` with the
  same Add as its `action`. The detail page is `PageHeader back={{ href,
  label: "Teams" }}` (the list's name, §Wayfinding) with the item's own
  icon and name as the `h1`, its cards stacked in `flex flex-col gap-4`
  each with an `id` and `scroll-mt-6`, one `SaveRow` for the item's own
  fields with `useUnsavedChanges` and `useLeaveGuard`, controls that
  always saved at once (membership, a calendar choice) left saving at
  once under a card that says so, and Delete in a `DangerZone` at the
  bottom, which returns to the list. An item that is gone is an
  `EmptyState` linking back, under the same header. The rail entry stays
  lit on the detail page (`DeskSettingsNav` matches the prefix), both
  routes sit behind the list's own capability, and an old in-page anchor
  (`#team-12`) is forwarded to the item's page by the list.
  `TeamsSettings` and `TeamDetail` are the worked example.
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
- **The Save row brings its own gap** (1.20.2). `SaveRow` carries `mt-4`,
  the gap between a page's cards, in both its resting and its
  pinned-while-dirty state, so it never sits flush against the last card
  or option. Never add a margin at the call site (`className="mt-4"` on a
  `SaveRow` is the retired recipe). In a block stack (`space-y-*`) the
  margins collapse into the stack's own gap; a row its container already
  spaces passes **`flush`**: a card footer's padded strip (`MarkersCard`,
  `TeamSlaTargets`), a `flex`/`grid` parent with `gap-*`
  (`CalendarsPanel`), an inline form row (`BackupsClient`). A page that
  wants a wider gap passes `flush className="mt-6"`. The pinned row is
  `sticky bottom-3` and in flow: at the end of the scroll it rests in its
  own place under the last card, never over it, so the page container
  keeps its bottom padding (`PageContainer`'s `py-8`; at least `pb-3`
  anywhere else).

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

- **The Duo step** (`/login/duo`, 1.20.5) is a sign-in surface too: the
  same `AuthShell` and `AuthHeading` ("Confirm it's you", with one sentence
  saying why), an `IdentifierRow` with **Sign out** so nobody is stuck on
  it, and one primary button, "Continue with Duo"
  (`components/auth/DuoStep`). A failure is a `notice-error` line above
  the button and the button reads "Try again"; Duo being down is a state
  of its own with its own heading, "Duo can't be reached". The step never
  starts by itself: a prompt on someone's phone always follows a click.
  Inside the desk the same step is offered by `DuoDeskPrompt`, a
  `notice-warn` bar fixed at the top with one button that opens the step in
  a **second tab**, so the screen the agent is working on is never
  navigated away.
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
- **A rail row's badge** (1.19.2) goes in `RailLink`'s `badge` slot, never
  in the label: it sits at the row's end and the label wraps beside it
  (no truncation while a badge shows). The desk settings rail's **New**
  chip is `chipClass("label", "sm")` ("New", violet, the product-label
  tone) on the pages of the release's list (`lib/helpdesk/whats-new-shared`
  `DESK_NEW_PAGES`); it goes, per person, the first time they open the
  page. The release strip ("New in 1.19.3: Assets. The New badge goes
  once you've opened the page.") is the info tint (`border-compass-200
  bg-compass-50`, `Sparkles` in `text-compass-600`, `role="note"`) under
  the Teams page's header, with a quiet `X` icon button (`aria-label`
  "Dismiss what's new in 1.19.3", `data-tt` "Dismiss"); dismissed, it stays
  gone for that person. A release replaces the list and the version;
  nothing else changes.
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

## Usage meter

A count against an allowance the workspace pays for (the helpdesk's
agents on the licence): `<UsageMeter value max label>` from
`components/UsageMeter`. Not for work in flight (that is a
`role="progressbar"`, §Loading) and not for a dashboard percentage
(a tile's gauge, §Dashboard tiles).

- **Where.** One card directly under the page header of the page where
  the counted things are managed (Settings → Agents), before the list,
  and only for the people who can change the allowance's use (there,
  whoever gives roles). Settings → License repeats the count as a
  Details row ("5 / 6 · 3 included, 3 bought"), without a bar.
- **Structure.** `rounded-xl border border-slate-200 bg-surface px-4 py-3
  shadow-xs`, a flex row that wraps: the thing's 16px icon in
  `text-slate-500`; the count in `font-semibold` ("5 of 6 agents") then
  the source in muted text ("on your licence · 3 included, 3 bought",
  dropping a part that would read "0 bought"); the `h-1.5 max-w-md` bar
  under them; the way to raise the allowance as a link at the end ("Buy
  more agents", a 12px `ExternalLink`, a new tab with
  `rel="noopener noreferrer"` and an sr-only "(opens in a new tab)").
  No allowance (unlimited): no card and no bar, one muted line ("28
  agents · unlimited on your licence").
- **Over the allowance.** The bar fills to the end in `bg-amber-500`
  (within it, `bg-compass-600`), and a `notice-warn` sits above the card
  with a 16px `TriangleAlert`: a bold sentence with both numbers, that
  nobody loses anything, and the two ways out, counted for adding
  someone new (one more than the desk is over by: "To add someone new,
  buy 2 more agents or take 2 people off the desk"). A Details row puts
  the count in `ink-warn` with "· over by N". The meter only reports: a create action that would
  go past the allowance says so in its own dialog (a `notice-warn` with
  the same link, and a disabled submit), never by hiding the action.
- **Not enforced** (a licence in grace): the number is still the key's,
  there is no warning and no amber, and the muted text adds "· not
  enforced while the licence is in grace" (and "· over by N once
  renewed" when over). A Details row keeps "· over by N" muted and adds
  "· not enforced in grace".
- **Accessibility.** `role="meter"`, an `aria-label` naming what is
  counted ("Helpdesk agents in use"), `aria-valuemin` 0, `aria-valuemax`
  the allowance, `aria-valuenow` the count capped at the maximum (ARIA
  allows no value past it) and `aria-valuetext` with the real count ("7
  of 6, over by 1"). The visible sentence says the same, so color is
  never the only signal.

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

**"Through a handbook"** (1.18.3) is an `accent` `sm` chip with a
`ring-1 ring-inset ring-compass-200` outline (`dark:ring-compass-500/40`,
because compass-200 does not invert) and the `BookOpen` icon,
`ThroughHandbookTag` (`components/handbooks`): the person is asked to
confirm the policy through a published handbook because they can't open
its space, so their reminders link to the handbook reader. It sits after
the person's name on every roster of a policy's people (the Record tab's
`AckRoster`, which the portal's policy expand row mounts; the team page;
the person rows of the portal's Needs attention queue, where the row's
`gap` spaces it, so it takes `className=""` instead of its default
`ml-2`) and after the policy's title on a person's record. It carries `data-tt`
"Asked through {handbook}: they can't open this policy's space, so
reminders link to the handbook." with `tabIndex={0}` and `data-tt-wrap`,
and an `sr-only` ": {handbook}" so a screen reader hears where; `inLink`
drops both inside a row that is one big link. On the person's own record
(`self`) the tooltip says "you can't open". The handbook is named only to
a viewer in its audience or managing it: for anyone else the row carries
`asked_through_handbook` with a null title, the chip takes `asked` and
its tooltip reads "Asked through a handbook you can't open: they can't
open this policy's space, so reminders link to the handbook.", and the
CSVs' `asked_through` cell reads "a handbook". It is a status, never a
link, and prints as the chip print override's outlined text. One
component, never a hand-written pill.

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
  band. Row actions: rare destructive actions keep text buttons (Trash);
  dense admin lists use icon buttons with a separator before Delete
  (People admin). When a row's actions would push the table past its
  column, keep the frequent ones inline (at most three) and fold the rest
  into one quiet `MoreHorizontal` button (`iconButtonClass("quiet",
  "sm")`, `aria-label` "More actions for {name}", `data-tt` "More", one
  word as §Tooltips asks of a control at a card's right edge) opening a `Popover role="menu"` of `MenuItem`s, each with its
  `data-tt` where it needs explaining, Delete… last after a separator
  (Users, 1.19.1: Email…, Reset password and Disable inline; Reset 2FA,
  Compliance record, Anonymise, Download personal data and Delete… in the
  menu).
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
- **A policy asked through a handbook, from the reader's side** (1.18.3).
  Someone who can't open a policy's space but reads it in a published
  handbook is asked to confirm it there (`via_handbook` on the My policies
  and dashboard rows), and every place that lists their policies says so
  instead of pointing at a space they can't open. On **My policies** the
  row is otherwise identical (the same status chip, the same groups):
  the emoji slot holds a `BookOpen` in `text-compass-600`, centred in a
  `w-7` slot so the titles line up; the subtitle reads "In **{handbook}**
  · Updated {RelativeTime}" with the handbook's title `font-semibold
  text-slate-700`; the title links to `handbookConfirmHref` —
  `/handbooks/{id}/{docId}#confirm-reading`, the reader's confirm bar —
  never to `/doc`; the filter matches the handbook's title too. On the
  **dashboard**'s Needs your attention the count includes them, the
  detail line names one as "{title} (in {handbook}, due {date})" with no
  space icon, and when it is the only pending policy the row opens the
  same reader link. The compliance desk sees the other side as the
  **Through a handbook** chip (§Status chips).
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

## Helpdesk: Get help

The requester's side of the helpdesk (1.19.0, Enterprise `helpdesk`):
`/help` and its sub-pages inside the app shell, the dashboard's two
helpdesk rows, the sidebar entries and the four CompassDocs triggers.
Components live in `components/helpdesk/help`; the agents' side is
§Helpdesk: the desk.

- **Gate and guard.** Every `/help` page calls `helpPageGuard()`
  (`help/access.ts`): licensed without `helpdesk.request` is the shell's
  not-found page; unlicensed renders the page's own `PageHeader` and then
  `HelpGate`, the one `LicenseGate` ("The helpdesk", `helpdesk`, Open
  License only for someone who can open it). Never a page without its
  title while the gate shows.
- **Sub-pages carry a breadcrumb trail**, not a back link: Get help ›
  My requests › #1052 (`Breadcrumbs className="mb-2"` above the
  `PageHeader`). The request page's status chip sits in the header's
  actions slot.
- **Request-type cards** (`HelpHome`) are one link each in a `card-grid`
  (`[--card-min:18rem]`): a 40px `bg-compass-50 text-compass-700` tile
  holding the type's lucide icon, the title, one description sentence and
  the expected time with a 12px `Clock`. A type stores an icon *name*;
  `requestTypeIcon()` maps it to lucide (kebab, camel and Pascal case
  alike) and falls back to `LifeBuoy`. Never an emoji.
- **The guide search** (`KbSearch`) is a `TextInput` (h-11, 16px on a
  phone) whose suggestions hang in a `Popover` (`role="dialog"`, "Suggested
  guides"): the eyebrow "These might solve it", up to five documents with
  `BookOpen` and "{space} · {n} min read", then a hairline and "Still
  stuck?" with a `sm` primary **Send a request** to `/help/new?subject=`.
  Arrows walk the box and the links; Escape is the Popover's. An empty
  result is a `SectionEmpty`, never a dead panel: the way on stays.
- **Requester status chips** come from `requesterStatus()` and nothing
  else: a running workflow is **In progress** (`accent`), Open and New
  `accent`, **Waiting on you** `warn`, On hold `neutral`, Solved and Closed
  `ok`. The desk's "Waiting on requester" and "In workflow" never reach a
  requester.
- **A request form** renders the type's field definitions: a choice is
  radio cards (§Forms, the stacked radio group: two to a row from `sm`,
  the chosen card `border-compass-300 bg-compass-50/60`), one-line fields
  pair up two to a row, long text and checkboxes take the row, a person is
  the `EntityPicker`. Optional fields say "(optional)" in the label; a
  prefilled answer says "From your directory entry" as its help. A type
  whose questions hold no long answer also asks for a subject and a
  description (`asksSubject`). Inline validation on Send, first invalid
  control focused, a refusal is a `FormError` above Cancel and **Send
  request**.
- **What happens next** is a 19rem card beside the form (under it below
  `lg`): an eyebrow, then numbered steps, each a 30px `bg-compass-50`
  circle with the step's lucide icon (`Stamp` approval, `ListChecks`
  task, `Hourglass` wait, `CircleCheckBig` finish, `MessageSquare` reply),
  a bold title with the approver already named ("Sara Haddad approves")
  and one `text-xs text-slate-500` line ("Your manager, from the
  directory"). Resolved on the server (`form-data.ts`); a notify step is
  never shown.
- **The progress tracker** (`ProgressTracker`) is one card, a row of
  stages from `sm` (a stack with a line down on a phone): 32px dots,
  emerald with `Check` when done on an emerald line, the stage under way
  `bg-compass-600` with its icon and a `ring-4 ring-compass-500/20`, the
  rest `bg-slate-100 text-slate-400`, a declined stage red with `X`. Each
  stage says its state for screen readers (", done"). Sent is always the
  first stage; a request with no workflow shows Sent, "{team} is on it"
  (or **Waiting on you**) and Solved.
- **The conversation** shows public messages as cards (someone else's
  with a `border-l-3 border-l-compass-500` edge, the requester's own as
  "You") and system events as one `text-xs text-slate-500` line with
  `Stamp` or `Info`. Bodies are plain text (`whitespace-pre-line`), as
  comments are. The reply box is a borderless `Textarea` in a card with
  the paperclip (`AttachButton`, a bordered `md` icon button) and **Send**
  under a hairline. Attachments upload as they are picked and show as
  neutral chips with a remove `X`; a refusal (413 too big, 415 a type the
  store refuses) is a red `text-xs` line under them, never only a toast.
- **A closed team says so, calmly.** When the team that will answer is
  out of office hours or on a holiday (`teamOpenState`, lib/helpdesk/
  calendars), the request form and an open request's page show the
  calendar's own sentence above the content ("The IT team is closed for
  Christmas Day. We'll reply from Mon 09:00."): `TeamClosedNotice`, a
  `notice-warn` line with a 16px `Clock`, `role="status"`. Nothing while
  the team is open, nothing on a solved request, never a blocker: the
  request can still be sent.
- **The satisfaction question** appears once the request is solved, as
  the first card of the conversation column: "How did we do?", five stars
  as a radio group (each with "n of 5, {word}" for screen readers), an
  optional comment and **Send rating**; the done state is one line in
  the same card.
- **Approvals** (`ApprovalsClient`): one card open at a time (who and what
  in the header with a `warn` **Needs your decision** chip, the answers in
  a three-column `dl`, long ones across the row), then one note box and
  **Ask a question** (secondary), **Decline** (danger, `X`) and
  **Approve** (primary, `Check`). Declining and asking require the note;
  the error is inline under the box and focus goes to it. The others wait
  as one-line cards with **Open**. A decision removes the card and moves
  focus to the next.
- **Sidebar.** **Get help** (`LifeBuoy`) follows Handbooks for anyone
  with `helpdesk.request` when licensed; its badge counts approvals
  waiting for the person plus their requests waiting on them ("waiting on
  you"). **Desk** (`Headset`) follows it for agents, helpdesk admins and
  report readers: a plain anchor with `target="_blank"`, a 14px
  `ExternalLink` after the label and "(opens in a new tab)" for screen
  readers, because the desk is a workspace that stays open in its own
  tab. The palette marks it "opens in a new tab" and opens it there.
- **Dashboard.** Needs your attention gains "N requests need your
  approval" (`Stamp`, to `/help/approvals`) and "N of your requests are
  waiting on you" (`MessageCircleQuestion`, to `/help/requests`), from
  `lib/helpdesk/attention`, counted in the card's total.
- **The triggers** render only when the helpdesk is licensed and the
  person holds `helpdesk.request` (`helpTrigger()`, server-side), and
  open one dialog recipe, `HelpRequestDialog` (a `Modal`, `max-w-lg`: a
  title that says what is sent, one lede naming what it is about, the
  type's own questions prefilled from what the trigger knows, a subject
  and description when the type asks none, Cancel and one primary). Their
  places: **Report a problem with this page**, a `ghost` `sm` button with
  `Flag` under Suggest an edit in the document rail; **Ask about this
  policy**, a `secondary` `sm` button with `MessageCircleQuestion` after
  "Not sure what this means for you?" under the policy's related line;
  **This link is broken**, a quiet `Unlink` icon button (`data-tt`
  "Broken?") beside a curated quick link and a Links card, never inside
  the link, shown on hover and focus and always on a touch screen;
  **Request access**, on the shell's not-found page for a `/spaces/{slug}`
  address only. Every trigger is `print:hidden`.
- **Request access never confirms a space.** The offer reads the same
  for a private space and an address with nothing behind it ("If this is
  a space you need for your work, you can ask for access."), and the
  request carries only the slug from the address, never an id, so neither
  the page nor its payload says whether a space exists.

## Helpdesk: desk notifications and the desk app

The desk's Settings → Notifications page (1.19.0,
`components/helpdesk/desk/notifications/`) and the Install Desk prompt
(`components/helpdesk/desk/pwa/`).

- **Push on this device is a panel inside the Push notifications card**
  (`rounded-lg border border-slate-200 bg-canvas p-4`, a `SubHeading`
  naming the device), with one state at a time: the primary **Turn on
  notifications on this device** (the browser's permission prompt needs
  the click), an `ok` chip **On** with a secondary **Turn off on this
  device**, an `error` chip **Blocked** over numbered steps to allow
  notifications for the browser in hand (Chrome/Edge/Brave, Firefox,
  Safari, iOS Settings, Android) and one `text-xs` line about the system's
  own switch, or a `notice-warn` sentence when the page cannot get there
  (iOS before Add to Home Screen, with **Show me how**; plain HTTP). A
  refusal from the browser is a `notice-error` paragraph under the button
  (Brave's sentence names brave://settings/privacy). The panel is
  `aria-live="polite"`. Never a toast for a state the agent must act on.
- **Devices are a bordered `divide-y` list**, not a table: a 32px icon
  tile (Monitor / Smartphone), the label with `sm` chips (**This device**
  `accent`, **Not delivering** `warn`), a meta line (`deviceLabel` · added
  · last used as `RelativeTime`) and the push service's refusal in
  `ink-warn`. Actions: secondary `sm` **Send test**, icon-only Rename
  (`promptDialog`) and Remove (`confirmDialog({ danger: true })`), each
  with `data-tt` and `aria-label` naming the device. The text column is
  `min-w-[12rem] flex-1`, so on a phone the actions wrap under it,
  indented to the text (`ml-11 sm:ml-0`).
- **The events × channels matrix** is the Account → Notifications grid:
  native checkboxes named "{event} by {channel}", a row header with the
  event and its hint. A cell the workspace policy locks keeps its value,
  disabled, inside a focusable `role="note"` wrapper with `data-tt="Set by
  your workspace"`, plus one `text-xs` line under the table. A column that
  cannot act yet (Push before any device) stays editable and says so in one
  sentence above the table that the checkboxes reference with
  `aria-describedby`. Every switch saves at once (optimistic, rolled back
  with the server's sentence); there is no Save row on this page.
- **Weekday picks** (quiet hours) are a `fieldset` with a visible legend
  holding seven bordered labels around native checkboxes, Monday first,
  the chosen ones `border-compass-300 bg-compass-50 text-compass-700`; the
  visible text is the short day with the full name `sr-only`.
- **Pause** is the page header's one action: a secondary menu button
  (**Pause notifications** → For 1 hour / Until tomorrow at 08:00 / Until I
  resume, with a one-line `text-xs` lead in the menu) that becomes
  **Resume notifications** while paused, over a `notice-warn` banner that
  states the pause and carries no button of its own.
- **Install Desk** is a `MenuItem` in the desk's user menu (DeskShell
  `installSlot`, hidden once installed) and a card on the Notifications
  page. Chromium's own install dialog when the browser offered one
  (`beforeinstallprompt`, kept by `PwaHead`); otherwise one `Modal` with a
  40px `bg-compass-50` icon circle, a one-sentence lead and numbered steps
  for the browser in hand, closed by **Done**. The dialog is mounted once
  by `PwaHead`, never inside the menu, so a closing popover cannot take it
  down.

## Email templates in parts

Every email CompassDocs sends (1.19.0) is composed from four parts, each
from its own library: a **header**, a **body** (one per email, carrying
the subject), a **signature** and a **footer**. Settings → Notifications →
Email templates is the worked example (`components/email-templates/`);
the desk's Settings → Email templates renders the same screens filtered to
the helpdesk emails. By default every email is branded: the **Standard
header** and **Standard footer** frame the body, with no signature.

- **Five routed tabs, one row.** Under the Notifications header and its
  tab row, `TemplatesSubNav` (a `SubNav` with `items`, `aria-label="Email
  template libraries"`) switches between **Templates**, **Headers**,
  **Bodies**, **Signatures** and **Footers** (`PanelTop`, `FileText`,
  `Signature`, `PanelBottom`; Templates is `LayoutTemplate`). They are
  pages, so links with `aria-current`, never a tablist. The composer is a
  sub-page (`…/event/[key]`) with a `BackLink` to the Templates tab and the
  event as a `SectionHeading` (the section layout owns the `h1`).
- **The Templates tab** groups the emails by area (Documents, Read
  confirmation, Training, Helpdesk, …) in `padding="none"` Cards, one
  `ListFilter` above them. Each row is one link: the email's name, its
  description (`sm:truncate`) and the four parts it uses as `sm` chips
  separated by a `slate-400` middle dot ("Standard header · Policy
  reminder · No signature · Standard footer"), `accent` for a part that is not the
  shipped default, `neutral` otherwise, each with an `sr-only` "Header: "
  prefix. **Customized** (`warn`, `sm`) marks an email that differs from
  what ships (a slot off its default, or its built-in body edited); a
  helpdesk email with team versions adds **N team versions** (`info`). The
  chips are plain text inside the row link (a chip is never a link).
- **The composer** is two columns from a 48rem container
  (`@3xl:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]`, stacked above it):
  the pickers, then a sticky preview card. A helpdesk email has a **Who
  it's for** card first: a `Select` "Template for" (All teams, then each
  team, "(own version)" on the teams that have one) whose help says which
  template the chosen team sends. The **Parts** card holds four `Field`s,
  each a `Select` whose first option **inherits**: "Use workspace default"
  (on a team, "Same as All teams"). The option stays short so it never
  truncates; the field's help names the part and its source: "Workspace
  default: Standard header", "Inherited from All teams: Team signature",
  "Inherited from All teams: Standard footer (workspace default)", or
  "Chosen for this email" / "Chosen for {team}". Beside it two
  bordered icon links, **Edit** (`Pencil`, "View" with `Eye` for someone
  who cannot edit parts) and **New** (`Plus`), into the library with
  `?part=` / `?new=1` and `?from=` (the library then shows a `BackLink` to
  the composer). The row wraps under 12rem, so the buttons drop under the
  select on a phone. One `SaveRow` ("Save template", "Save {team}
  version", Ctrl/⌘+S) with **Send me a test** as its child; under it a `ghost` `sm`
  **Reset to defaults** ("Match all teams" on a team), which only changes
  the pickers (still to be saved), and, on a team with a variant, a
  `danger` `sm` **Remove team version** behind `confirmDialog`. Switching
  the team with unsaved changes asks with the leave prompt; the address
  carries `?scope=`.
- **The email preview** (`EmailPreview`) is the preview route's own render
  in an iframe: `sandbox="allow-same-origin"` (no scripts; same origin only
  so the page can read the body's height and grow the frame to the mail),
  `inert`, `tabIndex={-1}`, a `title` naming the email, `ring-1
  ring-slate-200` on a `bg-canvas` well. The subject line sits above it
  ("Subject: …", `aria-live="polite"`); a `sm` `Segmented` "Preview width"
  switches **Desktop** (the pane's own width; mail clients are fluid) and
  **Phone** (375px, scaled down by a transform when the pane is narrower).
  The mail itself stays white in dark mode, as a mail client shows it. A
  team's version previews with the team's name in `{{team_name}}`. It
  follows the form 300 to 400ms behind and dims with `busyClass` while a
  newer render is on its way; a refusal is an inline `notice-error` line.
- **A library tab** is the two-pane layout of §Settings pages (the export
  presets): rail-row buttons in a `padding="none"` Card (`aria-current`
  on the lit one), chips **Default** (`info`), **Built-in** (`neutral`),
  **Edited** (`warn`: a built-in changed from the original) and a
  `text-2xs` "Used by N templates" line (the kind's default reads
  "Default for N emails", since every email that names no part of its kind
  uses it); bodies are grouped under their
  area with `RAIL_GROUP_TEXT` labels, a custom body's line naming its
  email. One secondary **New {kind}** in the footer row. The editor: the
  part's name as a `CardTitle` with its chips, "Used by N templates" as a
  `link` button opening a `Popover` (role dialog) of composer links (team
  variants carry the team as a `neutral` chip), then the actions **under
  the name**, never flush right: **Set as default** (`primary` `sm`,
  `Star`: the one prominent action, headers, signatures and footers;
  disabled while the part has unsaved changes), **Reset to original**
  (`RotateCcw`, an edited built-in, `confirmDialog`) and **Delete**
  (`danger`, `confirmDialog`). When Delete cannot run (a built-in, the
  default, a part in use) it stays visible but disabled, with the reason
  as `text-xs text-slate-500` text beside it (`aria-describedby`), never
  only in a tooltip, so it reads on a phone too ("Used by 2 templates.
  Choose another header for them first.").
- **One content editor for every kind.** Markdown in a monospace
  `Textarea` under an **Insert tag** select that puts `{{tag}}` at the
  caret (`MarkdownWithTags`; 12 rows for a body, 4 for the others). A
  textarea keeps the stored markdown byte for byte, which the doc editor
  did not, and a body adds a Subject field. Under it, "Tags you can use" lists the
  kind's tags (a body adds its email's) as focusable `code` chips with the
  meaning in `data-tt`. Validation follows §Forms (`tried`, first invalid
  control focused, the route's limits checked first); a refusal is a
  `FormError` under the card. One `SaveRow` ("Save header", "Create
  header" with Cancel). Beside or under the editor (2 columns from a 56rem
  container) a sticky preview card shows the unsaved part inside an email
  (a body in its own; the others in the email chosen in **Preview in**).
- **Read-only.** Someone who may look but not change (a template reader;
  a helpdesk admin on the libraries, which every email shares) sees the
  same screens with disabled pickers, `readOnly` fields, the content as a
  `pre` block and one `text-sm text-slate-500` sentence in place of the
  Save row; Edit becomes View and New is not offered.
- **The frame (the mail itself).** `frameEmailHtml` lays out a framed mail
  as nested `role="presentation"` tables, inline styles only (no `class`,
  no `<style>`, no CSS variables: the accent is resolved to `#rrggbb` by
  `accentHex`), a centred column `width="600"` with `max-width:600px`. No
  background or text colour is painted, so a client's dark mode recolours
  it like plain mail; the only fixed colours are the accent rule under the
  header, a `#e2e8f0` hairline over the footer and the footer's `#64748b`.
  The logo carries the workspace name as `alt`. With no header, signature
  or footer the body goes out alone, exactly as before 1.19.0. The text
  part joins the parts with blank lines; a frame's text has no markdown,
  image or HTML syntax and no logo. The footer's "Manage your
  notifications" link goes to Account → Notifications at the email's
  section (`#notify-helpdesk`, …) and is left out for an outside recipient
  (no account), for an email whose body has its own manage link and for an
  email-type notification channel (`manageLink: false`).

## Helpdesk: the desk

The agents' side of the helpdesk (1.19.0, Enterprise `helpdesk`): `/desk`,
a full-screen workspace in its own `(desk)` route group, meant to stay
open in its own tab beside CompassDocs. Components live in
`components/helpdesk/desk`; the requester's side is §Helpdesk: Get help.

- **Its own shell, no sidebar.** `(desk)/layout.tsx` repeats what
  `(app)/layout.tsx` does first (sign-in, the forced password change, the
  interface scale, the date settings, one `ToastHost`, one `DialogHost`)
  and renders `DeskShell`: a `h-13` top bar (the Desk mark: a 32px
  `bg-compass-600` tile with `LifeBuoy`; the global search; **CompassDocs**
  with `ExternalLink`, opening in a new tab; the bell; the availability
  menu) over a `w-sidebar-rail` icon rail (Tickets, Approvals, Workflows,
  Reports, Settings: 42px squares, `data-tt-pos="right"`, an `aria-label`
  carrying the badge's count and noun, `aria-current="page"`). Under `md`
  the rail folds into a **Desk menu** button at the top bar's left (a
  `Popover role="menu"` of the same destinations). The page area is `flex
  min-h-0 flex-1` and every screen owns its own scrolling column, so the
  bar and rail never scroll away. `id="main"` sits on the page area for
  the skip link.
- **Gate and guard.** Unlicensed is `DeskLicenceGate` (a bare top bar, the
  page's `PageHeader` and the house `LicenseGate`); signed in without a
  desk permission (`helpdesk.agent`, `agent_all`, `admin`, `reports`) is
  `DeskForbidden`, an `EmptyState` with **Go to Get help**. A page a desk
  role does not reach renders `DeskPageForbidden` in place, never a 404.
- **Controls follow the desk role.** Agent J's roles decide what shows
  (`hdCapsFor` in the layout, `useCan()` in client code): the owner menu
  offers anyone, the team or only you (`tickets.assign_any` /
  `assign_team` / `assign_self`); priority, team, status, delete, internal
  notes, the Workflows rail item and each settings page appear only with
  their capability. A control the role lacks is **left out**, not
  disabled, except a property row, which stays as plain text without its
  chevron.
- **The split view** (`QueueLayout`): views and teams (`w-rail`, house rail
  rows with a `tabular-nums` count, the Overdue count in `text-red-600`
  when above zero), the ticket list (`lg:w-[23rem]`) and the ticket pane.
  Under `xl` the views fold into the list title's menu; under `lg` the list
  and the pane stack, and the pane opens with a back link named for the
  list. The view travels in the address (`?view=overdue`, `?team=3`,
  `?sort=priority`) and survives opening a ticket
  (`/desk/tickets/1047?view=overdue`). Report links that carry filters
  (`team`, `assignee`, `priority`, `request_type`, `channel`, `status`,
  `tag`, `created_from`/`to`, `solved_from`/`to`, `breached`,
  `requester`, or `from=reports`) show a **Filtered from Reports · Clear**
  strip (the invitation strip's tint) over the list.
- **A queue row** is one link: the 8px priority dot (`PRIORITY_DOT`, with
  an `sr-only` "High priority"), the number, one `sm` status chip on the
  right; the subject (`font-semibold`, truncating); the requester and the
  due. The open ticket is `bg-compass-50` with a 3px accent band
  (`before:w-0.75`) and `aria-current="page"`. The due is **ink, never a
  chip**: `slaInk()` (breached `text-red-600 font-semibold`, close
  `ink-warn`, on track `ink-ok`, paused `text-slate-500`), compacted
  ("Reply overdue 25m" reads "Overdue 25m") with the full label
  `sr-only`; a calendar note ("Paused for Christmas Day…") replaces it.
- **Status chips** are a closed set: New `info`, Open `accent`, Waiting on
  requester `warn` ("Waiting" in the list's narrow column), On hold
  `neutral`, Solved `ok`, Closed `neutral`, and the derived **In
  workflow** `accent` while a request's run is going. On the ticket the
  status is changed through a **status pill menu** (a `PickMenu`
  trigger tinted with the status tone, with a `ChevronDown`, §Status
  chips "A choice is a pill menu button"), never a `<select>`; Solve is
  the named action beside it.
- **Keyboard.** `j` / `k` move real focus through the list, `Enter` opens
  the focused row, `r` reply, `n` internal note, `e` solve, `a` assign to
  me, `/` the search. Every key goes through `useDeskKeys`
  (`blockBareKey` plus the account's single-key preference); the empty
  pane lists them only while single-key shortcuts are on.
- **The conversation**: a requester's or agent's message is a card (an
  agent's public reply carries a `border-l-2 border-l-compass-500` edge);
  an **internal note** is the amber card (`border-amber-200 bg-amber-50`,
  `dark:border-amber-500/30 dark:bg-amber-500/10`, ink `amber-950` /
  `dark:amber-100`) with a `warn` `sm` chip "Internal note" and `Lock`;
  a system event is one `text-xs text-slate-500` line with `RotateCw`. A
  newbie's held reply carries J's `ReviewStateChip`. Bodies are
  `MarkdownView` at `text-sm`, `headingOffset={2}`. Attachments link to
  `/api/helpdesk/attachments/[id]`, images with a thumbnail.
- **The composer**: a `Segmented size="sm"` (Reply to {first name} |
  Internal note), never hand-rolled tabs; the box turns amber in note
  mode. Macro (`Zap`) and Article (`BookOpen`) are `secondary` `sm`
  buttons opening `Popover` comboboxes; `/` in an empty box opens the
  macros and `[[` the articles. Attach is a bordered icon button; an
  upload refusal (413, 415) is an inline `text-xs text-red-600` line under
  the files, not a toast. **Send** is a split button: the primary and a
  chevron opening "Send and set Waiting on requester / On hold / Solved".
  A newbie's button reads **Send for review**. Drafts are kept per ticket
  in `localStorage` (a per-viewer convenience).
- **The side column**: the requester card, the properties card (rows of
  label and a picker-menu value button), Due (eyebrow, first reply and
  resolve as ink, a `role="img"` bar of the resolution time used), the
  workflow's progress and task tickets on a request, the request's
  answers, and **From your docs** (`Sparkles` eyebrow; Insert writes a
  Markdown link into the reply).
- **The workflow builder** (`/desk/workflows/[slug]`): the workflows rail,
  a centred `max-w-[40rem]` column of step cards from the violet **Starts
  when** card to the emerald Finish, and a `xl:w-80` settings panel for the
  selected step (it stacks under the steps below `xl`). A step card is a
  `rounded-xl` card whose title is a `button` stretched over it
  (`after:absolute after:inset-0`, `aria-pressed`); the selected card is
  `border-compass-500 ring-2 ring-compass-500/20`. A parallel group is a
  dashed box headed **At the same time** (`Split`) holding task cards in an
  auto-fit grid. Between steps a dashed 28px `+` opens the step menu.
  **Moving is a menu**, not drag and drop: each card's `GripVertical`
  button opens Move up, Move down (left and right inside a group), Remove.
  Save draft appears only while dirty (`useUnsavedChanges`, the leave
  guard); **Publish changes** asks first and says that running requests
  keep their version.
- **Settings** (`/desk/settings/*`): a desk settings rail (house rail rows,
  dense; a sideways-scrolling row under `lg`) beside the page, which is a
  `PageContainer` with its own `PageHeader`. Pages follow §Settings pages:
  one primary create action top-right ("New team", "New macro", "New
  rule", "New request type"), lists in `padding="none"` cards with icon
  row actions, editors in a `Modal` or the two-pane recipe (Request
  types), one `SaveRow` per page.
- **Page titles inside panes.** The queue and the ticket pane carry an
  `sr-only` `PageHeader` (the visible headings are the list's `h2` and the
  ticket subject's `h2 text-xl`), so the page still has its one h1 and
  every desk page title goes through `PageHeader`.
- **Desk roles** (agent J, `components/helpdesk/desk/roles`). A person's
  desk role (Newbie, Agent, Team lead, Manager, Admin) is one
  `RoleChip`: the role's lucide icon (`Sprout`, `Headset`, `Flag`,
  `BriefcaseBusiness`, `ShieldCheck`) in its tone (Newbie `info`, Agent
  `neutral`, the rest `accent`); a role that comes from the workspace role
  shows `Lock` and "(from workspace role)" with a focusable `data-tt`
  saying where to change it. The top bar's user menu shows it beside the
  name (`sm`). A newbie's held reply carries `ReviewStateChip`: **Waiting
  for review** (`warn`, `Hourglass`) or **Returned** (`neutral`, `Undo2`)
  with the reviewer's note under it; approved and unreviewed replies show
  nothing. Reviewers reach the held replies from the queue's **Reviews**
  row (with its count) at `/desk/reviews`.
- **The capability matrix** (Settings → Roles, `RolesMatrix`): the five
  roles are columns, the capabilities grouped rows of checkboxes under
  their section's eyebrow row (Tickets, Replies, Macros, Reports, People
  and teams, Configuration), in a `Table scroll` with an `sr-only`
  caption. The Admin column is locked on. A cell the rules forbid (Managers
  only, a capability the editor does not hold, a role at or above the
  editor's) is a disabled checkbox inside a focusable wrapper (`tabIndex=
  {0}`, `role="note"`) that carries the reason as `data-tt` with
  `data-tt-wrap`, because a disabled control takes neither hover nor
  focus. Reply to the requester and Reply after review are one choice per
  role: ticking one clears the other. One `SaveRow` and **Reset to
  defaults**; the server checks the same rules.
- **An `sr-only` label inside a table header cell needs the cell to be
  `relative`.** `sr-only` is `position: absolute`; without a positioned
  `th` its containing block is outside the table's scroll box, so the
  label escapes it and widens a phone page into a sideways scroll (J's
  lesson from the matrix at 390px).

## Helpdesk: CCs and followers

People copied on a request and agents following a ticket (1.19.1, mock-up
#3). Shared pieces live in `components/helpdesk/ccs/AddPeople.tsx`; the desk
rows in `desk/ticket/TicketPeople.tsx`; Get help's card in
`help/RequestPeopleCard.tsx`.

- **A CC is a neutral chip** (`chipClass("neutral")`): the name, an outside
  address marked with `Mail` (plus an `sr-only` "outside the workspace"),
  and, for whoever may remove it, a 20px round quiet `X` button with
  `aria-label` "Remove {name} from CC" and `data-tt="Remove"`. Agents see
  every address as the chip's `data-tt`; requesters and CCs see outside
  addresses only.
- **The desk rows** sit under the ticket subject: `Users` "CC" eyebrow-ink
  label (`text-xs text-slate-500`), the chips, then **+ Add** (an inline
  `text-compass-700` chip-height button, `print:hidden`); beside it `Eye`
  "Following" with neutral chips, the viewer first as **You**. Each row is a
  `role="group"` named CC / Following. No rows render until the people load.
- **Follow / Unfollow** is a `secondary` button in the ticket header beside
  Solve (`Eye` / `EyeOff`), with a `data-tt` saying what following does.
  The label changes; it carries no `aria-pressed`.
- **Add people** is one panel: an `EntityPicker` over the directory's
  active accounts (disabled, "Loading people…", until they arrive) and,
  only while outside senders are on, an email box with its own visible
  label and an inline `text-xs text-red-600` error; otherwise one muted
  line says outside addresses need outside senders. The desk's **+ Add**
  opens it in a `Popover` (`role="dialog"`, "Add people") hung from
  whichever edge keeps it on screen. In Get help and the new-request form
  the trigger is a bordered `sm` button "+ Add people" (`aria-expanded`,
  `aria-controls`) and the panel opens **inline** beneath it, full width
  (`basis-full`), closing on Escape, so a phone never floats a panel
  beside a narrow column.
- **Get help's "People on this request"** is a side-column card under
  "Who's helping you": `Users` eyebrow, the requester as an `accent` chip
  ("You · requester"), the CCs, one muted sentence on what CCs see, then
  **Add people** (requester) or **Leave** (a CC, `ghost` `sm` with
  `LogOut`, confirmed in a dialog).
- **The composer's public tab** reads "Reply to Daniel + 2 CC"
  (`replyLabel()` in `lib/helpdesk/ccs-shared`).
- **Desk notification settings** gain a **Following** card (`Eye`) with one
  `Toggle`, "Follow tickets I reply to"; the matrix row is "Tickets I
  follow".

## Helpdesk: presence and collision warnings

Who else has a ticket open, and the warning before a reply that crossed
someone else's (1.19.1, mock-ups #3 and #5). Components live in
`components/helpdesk/desk/presence`; the rules in `lib/helpdesk/presence`.

- **The presence line** (`TicketPresence`) sits under the ticket subject,
  before the VIP and CC rows: up to three overlapping 28px initials avatars
  (`bg-compass-100 text-compass-700`, `-space-x-1.5`) with the **emerald
  presence ring** (`ring-2 ring-emerald-500 ring-offset-2
  ring-offset-surface`), then "**Sam Lee** is viewing" in `text-xs
  text-slate-600` with the name `font-semibold`. Several people read "Sam
  and Ana" or "Sam and 2 others ... are viewing"; anyone replying makes it
  "is replying" plus three 6px `bg-compass-500` **typing dots**
  (`motion-safe:animate-bounce`, staggered, `aria-hidden`). The avatars'
  `data-tt` lists everyone and their state. The line is a polite
  `role="status"` that renders nothing while nobody else is there, so the
  header does not jump. Presence is never shown to requesters.
- **Heartbeat, not a socket.** The desk POSTs every 10 s while the tab is
  visible (paused while hidden); a row unseen for 30 s counts as gone.
  Typing in the composer flips the state to replying at once and back
  after 20 s without a keystroke.
- **The collision dialog** (`CollisionDialog`) is a `Modal` (`max-w-lg`):
  the title is what happened, with `CircleAlert` in `text-amber-600`
  ("Sam Lee replied while you were typing", "... added a note ..."); the
  message(s) that landed as `rounded-lg` boxes (`bg-slate-50`, or the
  internal-note amber with its `warn` chip), initials, name and relative
  time, the body clamped to six lines; one sentence on why it matters
  ("Your reply hasn't been sent. Read Sam's first so Daniel doesn't get two
  different answers."); then **Keep editing** (secondary, focused first),
  **Discard mine** (secondary) and **Send anyway** (primary; "Add anyway"
  for a note). Keep editing marks those messages seen, so Send does not
  warn about them twice. The conversation reloads behind the dialog.

## Helpdesk: saved views

Personal and team queue views (1.19.1, mock-up #1). Components live in
`components/helpdesk/desk/views`; the rules in `lib/helpdesk/saved-views`.

- **In the views column**, after the built-ins and Reviews and before
  Teams: a **My views** eyebrow with a quiet `Plus` icon button ("Save this
  list as a view"), then one **"{Team} views"** eyebrow per team that has
  any. Each row is a house rail link with `Bookmark` and its count
  (`tabular-nums`), `aria-current="page"` when open. Empty My views is a
  `SectionEmpty` with a "Save this list" action.
- **Row actions** on a view you may change: a quiet `MoreHorizontal` button
  over the count, shown on hover and on keyboard focus (`opacity-0
  group-hover:opacity-100 focus-within:opacity-100`; the count hides while
  it shows), opening a `Popover role="menu"`: Rename..., Edit filters...,
  Use the current list (when it differs), a separator, and Delete...
  (danger, confirmed). Folded into the list title's menu under `xl`, rows
  are plain menu items without actions.
- **The list header** gains a quiet `Filter` icon button before Sort
  (`iconButtonClass("quiet", "sm")`, `data-tt` "Filter", or "Edit view" on
  a saved view you may change; the 23rem header has no room for a label). It opens the **filter dialog**, a `Modal`
  with a two-column grid of labelled `Select`s and `TextInput`s (Start
  from, Contains, Status with "Not solved", Priority, Team, Owner, Tag,
  Created), report-only filters listed as "Also filtered by: ... Remove",
  and a live summary line. The primary says what happens: **Show list**,
  or **Save to view** beside a secondary Show list when editing a view.
- **A filtered list** shows the drill-down strip with "Filtered: {summary}"
  (Reports' keeps "Filtered from Reports") and a **Save view** link button
  (`BookmarkPlus`) before Clear.
- **Save this view** is a `Modal`: `Bookmark` title, one muted sentence
  ("Saved views sit under Views with their own count. Filters: Contains
  "VPN" · Created in the last 7 days · Not solved."), the Name field, and
  **Who sees it** as stacked `RadioCards` (Only me, "Under My views."; each
  team you lead, "Everyone in the team sees it under the team's views. Team
  leads can change or remove it."). With more than two teams to share with
  (a manager) the second card is **A team**, with a Team `Select` under its
  description while chosen. Without a team to share with, one line says
  only you see it. Cancel and **Save view**.

## Workflow conditions and hand-offs

Multi-team workflows (1.19.0, Enterprise `helpdesk`): a step that runs
only sometimes, a task routed to a team by an answer, what a team does
when it can't do its task, and what it hands on. Components live in
`components/helpdesk/desk/workflow-multi`; the builder panel
(`workflows/StepSettings`) and the ticket pane mount them.

- **Builder panel sections.** Under a step's own settings, each extra is
  a section under a hairline (`border-t border-slate-100 pt-4`) with a
  `SUB_HEADING_TEXT` heading and a 14px `slate-400` lucide glyph:
  **Only if…** (`Filter`, on every step, a parallel group included),
  and for a task **Route to team by answer** (`Signpost`), **If the team
  can't do it** (`CircleSlash`) and **Hand-off fields** (`ClipboardList`).
  Repeated rows (rules, route rows, fields) are `rounded-lg border
  border-slate-200 p-2.5` boxes with dense controls stacked to fit the
  320px panel. Their controls are named for screen readers ("Rule 2:
  what to check"), and remove, move up and move down are quiet `sm` icon
  buttons with one-word tooltips.
- **Every rule set says itself in plain words.** Under the rules, a
  `rounded-lg bg-slate-50 px-3 py-2 text-sm` line says it the way a
  person would: "Only if Office is London and Needs a laptop is Yes."
  ("or" for Any of these; "is London or Paris" for is one of). A route
  says "By Office: London → Facilities UK, Paris → Facilities FR;
  anything else → Facilities." These sentences come from
  `workflow-multi/conditions` and nowhere else. The step card's chip
  tooltip uses the same sentence.
- **What a rule can check** is one `Select` with `optgroup`s: The request
  form, The requester's directory entry, Earlier steps' hand-off fields
  (only tasks that finish before this step; a task in the same parallel
  group is not earlier). Operators follow the field: a yes/no is
  **is Yes / is No**; a choice is **is / is not / is one of** with the
  field's own options (checkboxes for is one of); text adds
  **contains**. Every field type also has **is empty / is filled in**.
  Two or more rules show the `Segmented` `sm` **All of these / Any of
  these**. A rule that cannot be checked yet says why in `ink-warn`
  `text-xs` under it.
- **Can't-do choice** is `RadioCards`, two cards: "Stop and hand back to
  {coordinating team}" (the request type's team, by name) and "Carry on",
  each with one sentence saying what happens next.
- **Hand-off fields** show each field's message placeholder in
  `font-mono text-2xs`: `{{outputs.<step>.<key>}}`. A key follows its
  label only while the field is new in this sitting. Once saved, a later
  message may quote the key, so it stays put.
- **Step card chips** (`StepBadges`) sit under the card's sub-line, `sm`,
  each `tabIndex={0}` with the full sentence as `data-tt` (`data-tt-wrap`)
  and in an `sr-only` span, raised above the card's stretched select
  button (`relative z-10`): **Only if** (`accent`, `Filter`), **By
  {field}** (`info`, `Signpost`), **{n} hand-off fields** and **Carries
  on** (`neutral`). They are status, never links.
- **Step state words** are a closed set (`STEP_STATE_LABEL`): Not
  started (`neutral`), In progress (`accent`), Done (`ok`), Couldn't be
  done (`error`), Declined (`error`), Skipped (`neutral`), Cancelled
  (`neutral`). A run is In progress, Waiting, **Stopped** (`warn`,
  blocked), Finished, Cancelled or Declined.
- **A task ticket's outcome bar** (`TaskOutcomeBar`) is a card above the
  conversation: a 32px `bg-compass-50` `Workflow` tile, "Workflow task:
  {title}", one line saying what finishing asks for, then **Can't be
  done** (secondary, `CircleSlash`) and **Mark done** (primary,
  `CircleCheck`). Once the task is finished it becomes one `notice-ok`
  line (Done) or one `notice-warn` line (can't be done, with the reason
  and what happened next).
- **Mark done** is a `Modal` (`max-w-lg`): the title "Mark "{task}"
  done", one lede naming who reads the hand-off, the task's fields
  (optional ones say "(optional)", as on request forms), an optional
  "Note for the next teams", Cancel and **Mark done**. It validates
  inline and focuses the first field that needs fixing. When a plain
  Solve is refused with 409 `missing`, the ticket pane opens this same
  dialog with those fields marked (`openTaskOutcome(number)`), never only
  a toast.
- **Can't be done** is a `Modal` whose lede box (`bg-slate-50`, `Undo2`
  or `Workflow`) says what happens next in one sentence: "The workflow
  stops and {team} takes it back. They can retry this step, skip it or
  cancel the workflow." or "The workflow carries on with its next step."
  The reason is required. The primary says what it does: **Hand back to
  {team}** / **Mark can't be done**.
- **A stopped workflow** (`BlockedRunBanner`) is a `notice-warn` region
  on the request ticket with `OctagonPause`: "Workflow stopped: {team}
  can't do "{step}"", the reason, who and when, then `sm` **Retry step**
  (`RotateCcw`), **Skip and carry on** (`SkipForward`, a `promptDialog`
  with an optional note) and **Cancel workflow** (`danger`, `Ban`, a
  danger `confirmDialog` whose body ends "This cannot be undone.").
  Results toast. Only someone who can work the request sees the
  actions.
- **Part of request** (`PartOfRequestCard`, a task's side panel) shows
  "#1047 · {subject}", then type and requester, then a compact list of
  each team's step (20px state dot, title, team, state chip). The
  viewer's own task is tinted `bg-compass-50/60` with "· this task".
  Below that is one `link`: **Open request (read-only)** with `Eye`, or
  **Open request** with `ArrowUpRight` when they may work it.
- **The read-only request view** (`/desk/requests/[number]?from=`) is a
  desk page with a back link to the task, the `PageHeader` (`Workflow`
  icon, the subject, "#1047 · type · opened … by …", the status chip),
  then one neutral banner. A read-only state is not a warning, so it is
  `rounded-lg border border-slate-200 bg-slate-50` with `Eye`, never a
  `notice-*`: "**Read-only** · You're seeing this because Facilities has
  a task on it." The main column holds the workflow timeline (28px dots
  on a `slate-200` line, groups as a grid of bordered cards) and the
  public conversation with no composer. The side column holds requester,
  request details, hand-offs and tasks. A sibling task is a link only
  when the viewer may open it. The page never renders an internal note,
  even if one were sent.
- **Hand-offs** (`HandoffsPanel`, `HandoffList`) list each finished
  task's fields as a two-column `dl` on `bg-slate-50`, then its note in
  quotes. When there are none, `SectionEmpty` says "What each team hands
  on appears here as they finish their tasks."

## Integrations and automated tickets

Helpdesk 1.19.0 (Enterprise). Monitoring tools, bots and automated mail
open tickets through **Desk → Settings → Integrations**
(`components/helpdesk/desk/intake`, lucide `Plug`; capability
`channels.manage`, which `settings.manage` covers).

- **The key is shown once.** Creating a webhook integration, and **Make a
  new key**, end on `KeyOnce`: a `notice-ok` banner ("Copy the key now. It
  won't be shown again."), the endpoint and the key each in a mono `code`
  box with its own `CopyButton` (the key's is `primary`), a curl example in
  a bordered `pre` with **Copy command**, and the tool's setup steps
  (`setup-notes.ts`; snippets say `<your key>`, never the key). Making a
  new key asks first with `confirmDialog({ danger: true })`: the old key
  stops at once. After that the page shows only the key's prefix
  (`cdhk_Ab12Cd…`). Never put a key in a URL the app builds, a toast, a log
  line or an audit row.
- **The wizard is three steps on one page**, "Step N of 3 · …" as a muted
  `text-xs` line above one card: choose the tool (radio cards, the
  RequestForm choice recipe, a lucide icon per kind in a 32px slate tile,
  focus shown on the card), then the settings (`IntegrationForm`, shared
  with the integration's page), then the key. Back is a `ghost` button
  beside the primary.
- **The list** is one table card: the kind's icon tile, name and kind;
  team (or "Unrouted"); last used (`RelativeTime`, "Never"); distinct
  alerts in 24 hours (a count, ink); **On** (`ok`) / **Off** (`neutral`).
  The row's name is the link to its page. Empty: `EmptyState` with `Plug`
  and a **New integration** action.
- **Deliveries** are a table of the newest 50 with a bordered icon
  **Refresh** (`data-tt`, `aria-label`): when, the status code (mono; red
  ink from 400), the outcome chip, the ticket link, the reason. Outcome
  tones are a closed set: **Created** `info`, **Updated** `neutral`,
  **Reopened** `warn`, **Resolved** `ok`, **Ignored** `neutral`,
  **Rejected** `error`.
- **Turn off and Delete** live in the page's one `DangerZone`; both ask
  first. Turning off is reversible (the button becomes **Turn on**).
- **An automated ticket carries `AutomatedChip`**: "Automated · Grafana",
  `info`, with lucide `Activity`, `sm` in queue rows (`inLink`, plain text
  inside the row link) and `md` under the ticket's subject (with a `data-tt`
  saying it was opened by the integration and has nobody to reply to).
  Never a second chip for the same fact; the requester line shows the
  service identity ("Monitoring (Grafana)") as written.
- **`AlertDetails`** sits in the ticket's side panel under the contact
  card, in the side panel's card recipe: the eyebrow "Alert" with
  **Firing** (`error`) or **Resolved** (`ok`) at the right, the
  integration's name and kind (a settings cog link for those who may
  configure it), a two-column `dl` (Fired, First seen, Last seen, Resolved,
  Severity, Source), the tool's links (http(s) only, `ExternalLink` icon,
  new tab, `rel="noopener noreferrer nofollow"`, "(opens in a new tab)" for
  screen readers), the fields folded in a `details` (mono `dl`), and the
  dedup key as a muted line. Severity is the tool's own word, ink, never a
  chip.
- **Alert text is never trusted as markup.** HTML is walked into text,
  raw tags in markdown are escaped, links and images keep only http(s)
  targets (an image becomes a link, so nothing loads from the tool when an
  agent opens the ticket). Repeats and resolutions are internal notes by
  the service identity ("Fired again (×3)", "Alert resolved."), so the
  conversation stays readable and no requester is ever written to.

## Helpdesk: contact cards

Contact cards (1.19.0) show who is on a ticket, from the CompassDocs
directory: the requester's card for agents, the agent's card for the
requester. One component renders every card, `ContactCard`
(`components/helpdesk/contacts`), from an `HdContactCard` the server has
already narrowed. Never a second hand-built person block in the desk or
Get help.

- **The directory decides what can be seen; the card never re-decides.**
  The server passes the person through `viewerScope`/`personForViewer`
  before any slot reads it, so an admins-only mobile or field is blank
  for non-admin viewers whatever Desk settings → Contact cards ticks.
  The audience's parts (`agent_sees` / `requester_sees`) only narrow it
  further. A component that wants another field adds a slot or an extra
  in settings, never a read of its own.
- **Variants.** `panel` (the side panel, "Who's helping you"): photo or
  initials (`h-14`, `bg-compass-100` initials), name (a link to the
  directory profile when the viewer may read it), `VipChip`, title ·
  department, pronouns; then the meta lines (lucide `MapPin` office with
  "local time 14:05", the zone and offset as its `data-tt`; `UserRound`
  Reports to; `Users` team · desk role; the desk availability dot and
  Teams `PresenceBadge`); then the contact rows; then the chat buttons;
  then extras (`dl`); then earlier tickets; then a bordered footer with
  **Open profile** (`secondary sm`) and the directory's `ProfileActions`
  (vCard and QR) plus **Schedule a meeting** for Microsoft-synced people.
  `popover` drops extras, the history list and `ProfileActions`.
  `compact` is one row (32px photo, name, relation · title, and, unless
  `actions={false}`, quiet icon buttons to call, email and chat).
- **Contact rows** sit in one bordered list (`rounded-lg border
  divide-y`), 44px tall: icon (`Phone` desk, `Smartphone` cell, `Mail`),
  the value as the link (`tel:` built by `telHref`, `mailto:` by
  `mailtoHref`, never a raw value in an `href`) with its label under it in
  `text-xs`, and an icon-only `CopyButton` (`ghost`, label "Copy desk
  phone") whose `onCopied` toasts "Desk phone copied." Values wrap
  (`break-words`, an email with a `<wbr>` before the @), never truncate: a phone number cut
  to "+1 602 555 01…" is useless. Agents get a quiet **Reply in ticket**
  (`Reply`) icon beside the email that focuses the composer.
- **Chat buttons** are `secondary sm` buttons with a lucide icon and the
  service named in words: `MessageSquare` Teams, `Video` Webex, `Hash`
  Slack. No brand logos. A web link opens in a new tab (`noopener
  noreferrer`); an app link (`msteams:`, `slack:`, `webexteams:`) opens in
  place; where a service has both, a quiet `Laptop` icon button beside it
  ("Open in the Slack app") opens the app.
- **VIP** is `VipChip`: `warn` with `Crown`, the reason ("VIP list:
  Board member") as its `data-tt`; `inLink` inside a queue row (plain text,
  no tab stop). Agents only: a requester-audience card never carries it.
- **The stack** (`TicketContacts`): the requester's card in the side
  panel's card recipe with the eyebrow "Requester" (`Contact` icon), then
  "Also on this ticket (n)" with compact rows that expand in place into
  the person's `panel` card (a quiet chevron opens it, a `ghost sm` "Show
  less" under the card closes it, both `aria-expanded`; the compact row
  gives way to the card, never both, so the card keeps the full width).
  On the desk's ticket the requester is the strip under the header
  (§Requester strip, 1.20.3): the side panel passes `requester={false}`
  and keeps only "Also on this ticket".
- **Hover cards** (`ContactHoverCard`) open after 350ms on hover or focus
  of a name (dotted underline), in the house `Popover` (`w-80`), and stay
  open while the pointer is on the name or the card. In a queue row (one
  big link) pass `inLink`: hover only, no tab stop.
- **"Who's helping you"** (`AssignedAgentCard`, Get help's request page,
  above "Your answers"): eyebrow with `Headset`, the agent's `panel` card,
  or "Your request is with the IT team. You'll see who's on it here once
  someone picks it up." Phones are off for requesters by default.
- **Print** hides copy buttons, chat buttons and the footer; the values
  stay.
- **Settings** (Desk settings → Contact cards) is a conventional settings
  page: a `Select` per slot (options marked "(admins only)" when the
  directory restricts them), Chat, Extra fields (up to six), VIPs (a
  directory rule plus the helpdesk list with notes), office time zones (a
  `TextInput` with a zone datalist) and a "Who sees what" table of
  checkboxes, one column per audience; one `SaveRow`.

## Requester strip

The requester strip (1.20.3, `desk/ticket/RequesterStrip.tsx`) is who
asked, across the open ticket: under the header (subject, CC/Following
row), above the conversation and the side column, full pane width. It
took the place of the side panel's Requester card and is the second
layout of an `HdContactCard`, after `ContactCard`: the same server-narrowed
card, so the strip never reads a field of its own. One per ticket; a
ticket with no requester has none (no empty strip), and everyone else on
it stays in the side panel's "Also on this ticket".

- **The shell** is the card recipe (`CARD_CLASS`, `mt-3`), no
  `overflow-hidden` (the More menu and tooltips hang out of it; the band
  rounds its own bottom corners with `last:rounded-b-xl`). Rows are
  separated by `border-t border-slate-100`. The layout follows the pane,
  not the window: stacked by default, the wide form from `@2xl` (the
  article is the `@container`), like the ticket's own grid.
- **Row 1** (`px-3 py-2.5`, `gap-3`): the photo or initials at 44px
  (`CardAvatar size="strip"`) with the presence dot on it (`PresenceDot`
  from Teams, else the desk availability dot; the wrapper carries the
  words as `data-tt` and `sr-only`); the name (`text-[0.9375rem]
  font-bold`, a link to the directory profile when the viewer may read
  it) with `VipChip` only when the card says VIP; line 2 the job title
  (`text-[0.8125rem] text-slate-700`, or "Not in the directory"); line 3
  department · office · "14:05 local time" (`text-xs text-slate-500`,
  each only when known, the zone as the time's `data-tt`).
- **The contact group** is one joined control, never loose buttons:
  `role="group"` "Contact {name}", `rounded-lg border` with hairlines
  between the segments, each segment `h-8 px-3 text-xs font-semibold`
  with a 14px `text-compass-600` lucide icon and a word. The order is
  fixed so chat is always at hand: `Mail` **Email** (`mailto:`), `Phone`
  **Call**, then chat as the card orders it (`MessageSquare` Teams,
  `Video` Webex, `Hash` Slack). There is one Call however many numbers
  the card has: with one it is a `tel:` link; with several it is a menu
  button (a small `ChevronDown`, `aria-haspopup="menu"`) whose `Popover`
  lists each number as a `menuitem` link, its label at the left and the
  number at the right (`Smartphone` for a cell). Segments are links,
  not buttons, except the two that open a menu; the person follows as
  `sr-only`. At most four segments: with more than four, three stay and
  the rest go under a last **More** segment (`MoreHorizontal`, the same
  menu of `menuitem` links). Under `@2xl` the group takes its own
  full-width line as a one-row grid of equal columns (`grid-flow-col
  auto-cols-fr`), and is a flex row from `@2xl`; a menu segment is a
  `relative` holder around its button, so its menu hangs under it.
- **The details button** is a 32px bordered icon button at the right
  (`ChevronDown` / `ChevronUp`), `aria-expanded`, `aria-controls`,
  `data-tt` and `aria-label` "Show requester details" / "Hide requester
  details". Its bubble, and those of the tiles' right-hand icon actions,
  end at the control's right edge (`after:left-auto! after:right-0!
  after:[transform:none]!`) rather than centring on it: the strip
  reaches the pane's edge, and a centred bubble, even hidden, widens the
  pane into a sideways scroll (§Tooltips). The photo's presence bubble
  is `data-tt-align="start"` for the same reason at the left. Open or closed is remembered per agent in the browser
  (`localStorage`, in try/catch); closed until they say otherwise.
- **Row 2, the facts band** (`bg-canvas`, `text-[0.8125rem]`): a `ul` of
  facts, hairline `border-l border-slate-200` between them from `@2xl`,
  one per line under it. Icons are 16px `text-slate-400`; the value is
  `font-semibold text-slate-800`, its qualifier `text-slate-500`. Up to
  two devices (computers first, then phones, then the rest), each the
  asset glyph, the name (a link to the asset's page) and, only when the
  source reports compliance, a 6px status dot (`emerald` compliant,
  `amber` not) with the words; "+N more" opens the details. Then `Ticket`
  "N open · M earlier" (their other tickets in two parts, still open
  and solved or closed; a link to them in the queue; "First ticket from
  Daniel" when there are none) and `UserRound` Manager. A
  fact with no data is left out; with no facts there is no band. Status
  is always a dot plus words, never colour alone, never a coloured pill.
- **The open view** is four tiles in a `grid` (`gap-2.5 p-3`, two
  columns from `@2xl`, one under it): `rounded-lg border
  border-slate-100 px-3 py-2.5`, each an `h3` `Eyebrow` with a quiet
  slate icon (`Contact` Contact, `MonitorSmartphone` Devices, `Briefcase`
  Work, `Ticket` History). Rows are a `dl`: `grid-cols-[5.25rem_1fr]`,
  28px tall, the label `text-xs text-slate-500`, the value `text-slate-800`
  with its quiet icon actions at the right. Contact values are links
  (`mailto:`, `tel:`, the chat link) that wrap, never truncate, each with
  an icon-only `CopyButton` (toast "Email copied."); the email also has
  **Reply in ticket**; a chat row opens the service (`ExternalLink`) or
  its app (`Laptop`); the tile's footer keeps the card's **Open
  profile**, **Schedule a meeting** and `ProfileActions`. Devices lists
  every device: name (to the asset page), the compliance dot and words,
  then `model · OS · seen 2h ago` or `model · TAG · Snipe-IT`, and an
  `ExternalLink` to the source. History has the open tickets as links,
  "N earlier tickets · last one 6d ago" with **Show** / **Hide**
  (`aria-expanded`) over the five latest and "All N tickets", and
  "4.8 of 5 · 12 ratings" when they have rated. A tile with nothing to
  show is left out (Devices only while an asset source is connected).
- **Only what exists.** The strip shows what the contact card, the asset
  cache and the tickets already hold. No field is invented for it: there
  are no working hours, language or requester notes until a feature
  stores them.
- **Print** shows the closed strip's first row with the email and phones
  as text in place of the buttons (`hidden print:block`); the group, the
  details button, the band and the tiles are `print:hidden`.

## Business calendars

Helpdesk 1.19.0 (agent L): `/desk/settings/calendars`, the office hours and
holidays each team's reply targets count in. Components live in
`components/helpdesk/desk/calendars`; the arithmetic is
`lib/helpdesk/sla` (`businessSegments`) and the words around it
`lib/helpdesk/calendars-shared`.

- **Three pages under one header** (§Settings pages: a section with several
  jobs gets pages): **Office hours**, **Holidays**, **Test a due time**, a
  `SubNav` row under the `PageHeader` (`CalendarClock`). Gated by the desk
  capability `sla.manage`; a role without it gets `DeskPageForbidden`.
- **Office hours and Holidays are the two-pane recipe** (export presets):
  rail-row buttons on the left (`aria-current="true"`, a **Default** `info`
  chip, the open-hours summary "Mon–Fri 09:00–17:30 · Europe/London" and
  the teams on it as `text-2xs` lines with `sr-only` commas), the editor on
  the right. Both grids carry `grid-cols-[minmax(0,1fr)]` so a table's
  minimum width can never widen the page on a phone.
- **The weekly grid** is one row per day, Monday first: a dense `Select`
  (Closed / Open / Open 24 hours), then `type="time"` interval pairs with
  an icon-only Remove (`data-tt="Remove"`, the full sentence in
  `aria-label`) and an **Add hours** link. On a phone the pair stays on one
  line (`min-w-0 flex-1`, `sm:w-32`); a shift past midnight says "Closes
  06:00 the next day" under it. An end of 00:00 is midnight (stored
  24:00). **Copy Monday to weekdays** is a `secondary` `sm` button.
- **Edits that re-time tickets say so** in the toast ("3 open tickets
  re-timed."). Holidays, team calendars and team targets act at once
  (toast, no `SaveRow`); the calendar editor has one `SaveRow`.
- **A team's calendar and targets** are `<TeamCalendarSelect teamId />`
  (the hint under it wraps, never truncates: a truncated line widens a
  host's implicit grid column) and `<TeamSlaTargets teamId framed />`
  (`framed={false}` inside a host's own card or `<details>`: no second
  card, Reset moves into its footer; its `SaveRow` is `sticky={false}
  shortcut={false}` so it never answers the host page's Ctrl/⌘+S).
- **A scrolling table's `sr-only` header text** sits in a `relative` `Th`:
  absolutely positioned, it otherwise escapes the scroller and widens a
  390px page.
- **Words**: "office hours", "holidays", "closed for Christmas Day",
  "resumes Mon 09:00", "We'll reply from Mon 09:00". Times are 24-hour
  wall-clock times in the calendar's zone; the zone is named next to them.

## Business-time counting, shortcuts and retention

Helpdesk 1.19.1 (agent V5): workflow time that can count business days,
Desk settings → Shortcuts, and Desk settings → Retention and privacy.

- **"Count" is a `RadioCards` choice** under the delay or offset it
  governs (`workflows/CountSetting.tsx`): **Calendar days / Business days**
  for an offset from a form date, **Calendar hours / Business hours** for a
  delay. The business card's description names the calendar ("Uses the
  office hours and holidays of IT Service Desk."); its extra holds the
  **Whose calendar** select, whose first option is the default in words
  ("The task's team", "The request type's team"). Calendar is the default
  and stores nothing, so an older step is unchanged.
- **The worked example** is an invitation-strip tint under the choice
  (`rounded-lg border border-compass-200 bg-compass-50/70 px-3 py-2
  text-sm text-slate-700`, a `CalendarDays` icon in `text-compass-600`),
  computed from the real calendar by the server, one sentence: "Start date
  Mon Jan 4 → moves on Tue Dec 29 (Dec 31 and Jan 1 are holidays)." Never
  a `notice-*` class: it is an explanation, not a state.
- **Delay words say how they count**: `countedHoursLabel` reads "1
  business day" only for business time (8 business hours) and "8 hours" for
  calendar time; offsets read "2 business days before the start date". A
  step that counts business time carries a neutral **Business days** /
  **Business hours** chip in `StepBadges`, its tooltip naming the calendar.
  The test run adds one `text-xs` line with `CalendarDays` naming the
  calendar and the holidays skipped.
- **A settings list that must stack on a phone** (Shortcuts) is a grid
  list, not a `<table>`: a header row `hidden sm:grid` in `TABLE_HEAD_ROW`
  (`aria-hidden`), then `<ul aria-label>` rows that are one column under
  `sm` (name in `font-semibold`, the "where" line in `text-slate-500`, the
  control full width) and the header's columns from `sm` up. Each control's
  `aria-label` repeats its row ("Report a broken link opens").
- **A choice that can switch a feature off** offers "Hidden" as the last
  option of the same select, and "Automatic: …" first, naming what the
  automatic rule picks today, so the reader never guesses.
- **A destructive automatic rule is off until switched on** (1.19.1 owner
  decision: nothing destructive happens on upgrade). Each retention rule
  is a full-width `Toggle` whose help starts "Off until you turn it on";
  its sentence inputs appear under it only while it is on, and a rule that
  is off neither blocks Save with its field errors nor counts in the
  preview ("Both rules are off, so nothing is closed, anonymised or
  deleted.").
- **Retention's sentence inputs**: a number `TextInput` (`w-20`) inside the
  sentence it completes ("After [7] days without a reply."), labelled by
  its first words (`<label>After</label>`, `<label>Keep closed tickets
  for</label>`); units and outcomes are `Segmented`
  (months | years, Anonymise | Delete). An irreversible choice asks with
  `confirmDialog({ danger: true })` when it is saved, naming tonight's
  count: choosing Delete, or switching anonymising on while tickets are
  due. The dry run is one live sentence ("Tonight: 41 tickets close, 312
  are anonymised (closed before Nov 2023). Nothing is deleted.") with **See
  the list** opening a `Modal` of tickets (number, subject, team, date, a
  `sm` chip: Closes `neutral`, Anonymised `warn`, Deleted `error`).
- **Legal hold** is a side-panel card (`ticket/LegalHoldCard.tsx`) with a
  `Lock` eyebrow: a `Toggle` for settings.manage, a sentence for other
  agents while it is on, nothing otherwise.

## Desk reports and charts

`/desk/reports` and `/desk/reports/explore` (1.19.0,
`components/helpdesk/desk/reports/*`, data from
`/api/helpdesk/analytics/*`). Good defaults first, customisation second:
the built-in Overview opens on the last 30 days against the 30 before with
nothing to set up; everything else (filters, other dashboards, Edit,
Explore, schedules) is one step further.

- **Page**: the desk page skeleton (`PageContainer`, `PageHeader` with
  `BarChart3`, "Reports"; Explore has `Compass` and a back link). Header
  actions, once, at full labels: Explore, Export ▾, Schedule, and Edit
  (or **Duplicate to edit** on a built-in: built-ins are read-only
  templates). Under the header, one row: the dashboard switcher (a
  `secondary` button opening a `Popover role="menu"` of
  `menuitemradio` rows grouped Built in / Yours / Shared, then "New
  dashboard"), a `sm` chip for where it is shared, and then the filter bar
  on its own row.
- **Filter bar** (one row above the widgets, never inside them): the date
  range (presets as `menuitemradio`, custom dates in the helpdesk's zone,
  named), the comparison (Previous period / Same period last year / Don't
  compare), a pill chip per filter in use plus Team, and "Add filter" for
  the rest. A chip is a `Popover role="menu"` of `menuitemcheckbox`
  rows; an active chip is `border-compass-200 bg-compass-50
  text-compass-ink-strong` (the ink token, so it reads in dark mode). "Include
  alerts and API tickets" appears only when the desk has automated tickets
  (they are left out by default, and never count in satisfaction). Under
  `sm` the whole bar folds into one **Filters (n)** button that opens the
  same controls in a `Modal` sheet with a full-width "Show results". The
  view lives in the address (`lib/helpdesk/analytics/url-state`), so a
  copied link opens the same dashboard, dates and filters.
- **The grid**: a leaf `@container` (no overlay inside it is `fixed`; the
  widget menus are `Popover`s, the dialogs portal), two columns on a phone
  so numbers pair up, four from `@5xl`; a widget spans 1–4 columns
  (`SPAN` in `Widget.tsx`), `gap-3`, `gap-4` from `@2xl`. Never
  viewport breakpoints for the widget grid.
- **A widget is a card** (`CARD_CLASS`, `p-3 sm:p-4`, never
  `overflow-hidden`: its ⋯ menu hangs out of it), an `h3` in the
  sub-heading tier that wraps to two lines (never truncates on a phone),
  an optional `text-xs` line ("Own filters: 1", "Top values only"), and
  one ⋯ `iconButtonClass` menu: Show as table / chart, Download CSV (only
  with Export tickets), Open in Explore. A **Time logged** widget (1.19.1)
  also carries a `Button variant="ghost" size="sm"` **Export** with the
  lucide `Download` icon, a `data-tt` naming what is downloaded and which
  filters apply, and an `aria-label` naming the widget: the raw time
  entries for the widget's dates (one row per entry), only with Export
  tickets, hidden in edit mode and in print. States in order: a skeleton the
  chart's shape (`Skeleton`, `aria-busy` on the card); the server's
  sentence in `text-red-600` with "Try again"; `SectionEmpty` — "Nothing
  matches these filters in this period." with **Clear filters** when the
  filters exclude everything, "No tickets in this period yet. Numbers
  appear here as the desk works." when there is simply nothing; then the
  chart. Live widgets (open now, unassigned now, breaching now) say "Right
  now · refreshes every minute" and refetch every 60 s while the tab is
  visible.
- **Edit mode**: an invitation strip (`border-compass-200
  bg-compass-50/70`) "Editing {name}" with Add widget, Settings, Cancel
  (asks before discarding) and Save. Each card gets a toolbar row above
  its title: a grip (the card itself drags), then 28px icon buttons with
  `data-tt` and full-sentence `aria-label`s — Move earlier, Move later
  (the keyboard path for reordering; focus follows the card), Narrower,
  Wider, Configure, Remove (`hover-danger`). **Add widget** opens the
  gallery (`Modal`, `card-grid`): one ready-made card per widget type,
  drawn live with the dashboard's filters, each with an Add button.
  **Configure** opens a right-hand panel (`Modal layout="fill"`,
  `max-w-xl`, `border-l`): a live preview on the canvas tint first, then
  Title, Shown as, Measure (grouped `optgroup`s, its description as the
  help), Split by / Then by (only the splits that measure allows; a
  caveat such as VIP's "today's list" as help), the widget's own filter
  chips, Width (a `Segmented` ¼ ½ ¾ Full) and a target with an optional
  "close to target" band (hours for time measures). A choice that cannot
  work says why in a `notice-warn` instead of the preview, and Apply waits.
  Dashboard settings (`Modal`): name, description, who can open it (a
  `Segmented`: Only me / A team / Everyone who reads reports, with "Each
  person still sees only the tickets they may report on."), the default
  toggle (reports.all only), and Delete dashboard (`danger`, confirmed).
- **Exports** follow §Print: Export ▾ lists "Dashboard as CSV",
  "Dashboard as PDF" (server-rendered with `@react-pdf/renderer`, light,
  headline tiles then one table per split with an inline bar) and
  "Print…" last; without Export tickets the menu says so in one line
  instead of the two downloads. A printed dashboard hides the controls,
  prints its name and dates, and lets the grid fall to one column with
  `break-inside-avoid` cards.
- **Schedules** (`Modal`, "Email this dashboard"): the existing schedules
  as a divided list (one line of when, one `text-xs` line of to whom,
  what and the next send; a `Toggle` and a Remove icon button), then the
  form: Send to (people and "Everyone in {team}"; without the right to
  send to others, only "you"), How often (`Segmented`), On / At (named
  zone), What it sends, and one sentence spelling out the cadence, the
  period covered and the first send before **Add schedule**.

### Charts

Hand-rolled SVG and HTML (`charts.tsx`); no chart library. The method is
the dataviz one:

- **Form follows the job**: a number (`kpi`) for one total, with its
  change and a sparkline; a meter (`gauge`) for a percentage against a
  target; lines or areas over time; ranked horizontal bars for teams,
  agents and categories; stacked bars only for counts; a donut only for
  parts of a whole of at most five parts (more falls back to bars); a
  heatmap for day of the week × hour; a table for anything with two
  splits or many rows. `widgetProblem` enforces it. One axis, always:
  two measures are two widgets.
- **Colour**: slot 1 is the workspace accent (`--compass-500`), slots 2–8
  the validated categorical order in `charts.module.css` (dark steps are
  selected for the dark surface, not flipped; print re-declares light).
  A series keeps its slot when filters change the others: priorities,
  channels, statuses and origin have fixed slots; other keys hash to a
  slot. "Other" and the comparison series are slate. Sequential (the
  heatmap) is one hue: `rgb(var(--compass-600) / α)` in six steps, with a
  Fewer → More key. Status colours (on target / close / off target) are
  emerald / amber / red ink and always carry an icon and words ("Off
  target (at most 4h)").
- **Marks**: 2px lines with round joins, a 10% area wash for a single
  series, 8px end dots with a 2px surface ring (`.gapStroke`), bars at
  most 0.75rem with a 4px rounded data end and square baseline, a 2px
  surface gap between stacked segments and donut arcs; solid hairline
  gridlines in `--grid`, axis ticks in `--tick`, four equal steps to a
  clean top (whole numbers for counts, 15m/30m/1h… for times, 0–100 for
  percentages). Tick and x labels thin out by width and the latest label
  always shows. A target is a dashed hairline labelled "Target 4h".
- **Text never wears the series colour**: values and labels are slate
  ink; identity comes from a swatch, a line key or the legend. Two or more
  series always have a legend (a dashed key for the comparison); one
  series has none (the title names it).
- **Interaction and keyboard**: every plot has a layer of real buttons
  over its marks (the x bands of a time chart, each bar, each heatmap
  cell, each donut legend row) with a roving tabindex — Tab lands once,
  arrows walk the points (and rows in the heatmap), Home/End jump — each
  carrying its `data-tt` tooltip and a matching `aria-label` ("Mon 3 Nov
  2026: 14 · Previous period: 11. Open these tickets"). Focus or hover
  draws the crosshair or dims the other marks. Clicking opens the matching
  tickets in the queue (`drillHref` in `lib/helpdesk/analytics/shared`:
  `/desk?from=reports&team=…&created_from=…`), so a chart is always a way
  into the work.
- **Text alternatives**: each chart renders an `sr-only` table with its
  caption, and the widget menu's Show as table gives everyone the same
  numbers (sortable `Th`, "Based on" for percentages and medians). Small
  samples say so ("Based on 3").
- **Words**: measure names are the registry's (`HD_MEASURES`: "First
  reply time (median)", "Resolution SLA met", "One-touch resolution");
  times are business time unless the measure says calendar time;
  comparisons read "vs previous period" / "vs same period last year";
  deltas are "+12%" for counts, "+2.6 pts" for percentages, "+16m" for
  times, and "Same as previous period" when nothing moved.

## Assignment settings

How tickets find an owner (1.19.0, agent N): Settings → Assignment in the
desk (`/desk/settings/assignment`, lucide `Shuffle`), components in
`components/helpdesk/desk/assignment`. One `PageHeader` and a `SubNav`
(**Teams**, **Rules**, **On call**; each tab only for the capability its
page needs: `agents.manage_team` for Teams and On call, `automations.manage`
for Rules).

- **One team at a time.** Teams and On call open with a labelled `Select`
  team switcher (`TeamPicker`); the choice lives in `?team=` so a link or a
  reload lands on the same team.
- **Mode cards are a radio group**, not a select: three cards in a
  `sm:grid-cols-3` grid (`role="radiogroup"`, each card a `role="radio"`
  button with arrow-key movement), a 36px icon tile (`Hand`, `Repeat`,
  `Scale`; `bg-compass-600` when chosen), the mode's name as a card title and
  one plain sentence of what happens. The chosen card is
  `border-compass-500 ring-2 ring-compass-500/20`, the workflow builder's
  selected-card recipe.
- **Settings the mode needs follow it.** "Who takes tickets" and "Extras"
  appear only for Round robin and Load balanced; switches are `Toggle`,
  numbers are `TextInput`s where empty means "no limit" / "never" (the
  placeholder says so). One `SaveRow` for the team's settings.
- **People save per row, not with the page.** The weight is a stepper (two
  bordered icon buttons with `aria-label`s and `data-tt`, the number
  `tabular-nums`), pausing is a `secondary` `sm` button that reads
  **Pause** / **Resume** with `aria-pressed`; each change toasts. A row
  shows the presence dot on the initials, the desk role as a neutral `sm`
  chip, a `warn` **Paused** chip, and why the next ticket would pass them
  over as `ink-warn` text ("Skipped: away"), never a red error.
- **"Who's next"** is an eyebrow band at the top of the People card
  (`bg-slate-50`, `aria-live="polite"`): the person and why ("Next in turn",
  "Fewest open tickets (3)"), or, in `ink-warn`, why nobody can take a
  ticket right now.
- **Rules** follow the Automations list (numbered rows, on/off, icon
  actions) and add a `GripVertical` drag handle (pointer only; the Move up /
  Move down buttons are the keyboard way and stay). Chips: **Off**
  `neutral`, **Carries on** `info` (a rule that does not stop the run). Each
  row's second line is the rule in one sentence, the same sentence the
  editor shows under its fields.
- **The rule editor** is a `Modal` with the workflow builder's "Only if…"
  pattern (a `Segmented` All / Any once there are two conditions; each
  condition a bordered box with what to check, how to compare and a value
  control that fits the field: checkboxes for choices, a text box for
  words, nothing for yes/no) and a **Then** fieldset (assign to, minimum
  role, move to team, priority, tags, the Stop toggle).
- **Test a ticket** is a card under the list: a `Segmented` (a made-up
  ticket / a ticket number), the sample's fields, a `secondary` **Test**
  button, then one result sentence and **Rule by rule** lines (a `Check` in
  `ink-ok` or a slate `X`, plus an `sr-only` "matched" / "no match").
- **On call**: an "On call now" band (a 36px accent tile with `PhoneCall`,
  the person, until when, a `warn` **Cover** chip for a stand-in), the rota
  card (ordered people with Move up / Move down / Remove, turn length,
  handover time, first handover, timezone; one `SaveRow`), the next four
  weeks as a 7-column strip of day cells (`grid-cols-7`, each a tinted cell
  with a chip per person; a person keeps one chip tone across the strip;
  cover chips are outlined dashed; at phone width the cell shows the day
  number and initials, and every cell carries the full sentence as its
  `aria-label`), and the Cover card (upcoming cover rows and an inline add
  form).
- **On a ticket**, "Assignment history" is a closed native `<details>` in
  the side column (the disclosure recipe: `summary` in `text-sm
  font-semibold` with `History`), loaded on first open; each line says who
  and how, with the method as an `sm` chip (`accent`, or `neutral` for **By
  hand**), the rule's name and a `RelativeTime`. A ticket waiting for
  someone to become available shows an amber `Hourglass` line first.
- **Pause auto-assign** lives in the top bar's availability menu as a
  `menuitemcheckbox` under the three availability rows, with a hint line
  like theirs; it only appears for someone in at least one team.
- **The rule editor's "Assign to" is `RadioCards`** (1.19.2): one card per
  way to assign, its name and one sentence (`HD_ASSIGN_ACTION_HINT`); the
  chosen card's own controls (the person, or the skills panel) sit under
  its sentence. "The team's turn" is the team's own mode.

## Helpdesk: skills and languages

Desk settings → **Skills and languages** (1.19.2, `/desk/settings/skills`,
lucide `Languages`, in the People group after Agents), components in
`components/helpdesk/desk/skills`.

- **Two tag kinds, two chip tones**: a skill is a `neutral` `Chip`, a
  language an `accent` one (`SkillChip`, `language` prop), everywhere they
  show (the lists, the agents table, the rule editor). Never the `Tag`
  component (that is directory attributes) and never a third tone.
- **The page**: two cards side by side from `lg` (Skills, Languages), each
  row a chip, "N agents" in `tabular-nums` slate-500 and, for
  `teams.manage`, quiet icon buttons (Rename, Delete / Remove; `data-tt` and
  `aria-label`); the card's `secondary` `sm` **Add skill** / **Add
  language** in its header. Under the languages, one sentence on where a
  ticket's language comes from. Then the agents `Table` (`scroll`, Agent ·
  Teams · Skills · Languages · a Pencil per row the viewer may change) whose
  edit is a `Modal` of checkboxes. A lead sees only their teams' people as
  editable and a line saying so.
- **The skills action in a rule** (`SkillsActionPanel`): bordered pills
  reading as a sentence, "Speaks [select]" and "and knows [chip ×]", then a
  quiet **+ Skill** `PickMenu`; "Nobody matching available?" with a `Select`
  (fall back to the team's turn / wait in the queue); and the live **"N
  agents match today"** band (`border-compass-200 bg-compass-50`,
  `UsersRound`, `aria-live="polite"`), with who matches but can't take one
  now in a slate-600 `text-xs` line under it.
- **On a ticket**, the language is a Properties row like Priority (a pill
  menu; `Languages` icon in slate-400; "Unknown" in slate-500 when not
  known), its source as the trigger's `data-tt` and in its `aria-label`.
  Changing it writes an internal timeline line, never a public one.

## Helpdesk: customer portal

The customer portal (1.19.1, Enterprise `helpdesk`) is where people
outside the organisation, with no CompassDocs account, raise and follow
requests: `/support` and its pages, `app/(portal)/support`, components in
`components/helpdesk/portal`. It is the third standalone surface beside
the share and public pages (§Standalone link pages): the person has no
account, so there is no preference to honour and no app shell.

- **No CompassDocs chrome, no way into the app.** `PortalHeader` is the
  whole frame: the portal's logo (or its initials in a 32px
  `bg-compass-50 text-compass-700` tile) and name, linking to the portal's
  own home; when signed in, the address and **Sign out** (the address
  hides below `sm`, Sign out keeps its place). Never a sidebar, the bell,
  the palette, a link to `/`, `/help` or `/desk`, or the workspace's name
  where the portal's brand belongs. The portal's own 404
  (`support/not-found`) links nowhere.
- **One column, the mock's widths.** The sign-in and link pages are one
  `max-w-md` `rounded-2xl` card; Your requests, a request and New request
  are a `max-w-3xl` column with the h1 at `text-2xl font-bold`, no page
  icon (the h1 is the thing itself, as on the other standalone pages).
- **Asking for a link always answers the same sentence**
  (`PORTAL_LINK_SENT`), shown in place of the form as "Check your email"
  with "Use a different address". Never a message that depends on whether
  the address is known, allowed or blocked. The link page shows who it
  signs in and one **Continue** button: opening it spends nothing.
- **Status chips** are Get help's words and tones (§Helpdesk: Get help):
  **In progress**, **Open**/**New** `accent`, **Waiting on you** `warn`,
  **On hold** `neutral`, **Solved**/**Closed** `ok`, computed on the server
  (`portalStatus`). Rows are one link each, the chip at the end.
- **A request joined with another** (an agent merged it) reads
  **Joined with #N** `neutral` in the list and on its page, which shows one
  bordered `bg-surface` card with a lucide `GitMerge` icon in
  `text-compass-600`: "This request was joined with #N so one person can
  help with both. Its conversation is there, and so are replies." and an
  **Open #N** link, in place of the reply box. The kept request is in the
  customer's list too (they reach it as a CC does).
- **The conversation** is Get help's recipe: cards, someone else's with
  the `border-l-3 border-l-compass-500` edge, the customer's own as
  "You", plain text bodies. Agents show by **first name and team** only
  ("Priya · Support team"): never a surname, email, photo or contact card.
  No system lines (they name people). Files are neutral chips that
  download from `/support/api/files/[id]`.
- **Files travel with the message** (`PortalFiles`): a bordered `md`
  paperclip icon button (`aria-label` and `data-tt` "Attach files") and
  neutral chips with a remove `X`; nothing uploads ahead. A refusal is the
  `FormError` above Send, never only a toast (the portal has no toast host).
- **Dates** render in the reader's own zone (`PortalTime`, "4 Nov,
  09:12"); the app's `RelativeTime` needs the app's settings and is not
  used here.
- **In the desk**, a portal ticket carries `OutsideCustomerChip`: a
  `neutral` chip with `Globe`, "Outside customer", in the ticket header
  (`md`, with a `data-tt` explaining it) and on queue rows (`sm`,
  `inLink`). Its contact card is minimal (name and email): a portal
  contact is never matched to a directory entry.
- **Desk settings → Customer portal** (`PortalSettings`, nav `Globe`,
  `settings.manage`): the on/off `Toggle` in a card whose action is
  **Open portal** (secondary, `ExternalLink`, a new tab); two cards side by
  side from `lg`: *What customers can ask for* (a checkbox per request
  type, "Title · Team", the team `Select` under a ticked one; a type that
  needs the directory is disabled and muted with "(internal only)" whose
  `data-tt` names why) and *Who can use it* (a `Segmented` Anyone with an
  email / Approved domains only, Brand, Protection); then the lock
  banner (`border-compass-200 bg-compass-50 text-compass-800`,
  `dark:border-compass-500/40`, a 16px `Lock`); and the Customers card, on
  its own **Customers** page since 1.19.4 (§Helpdesk: customer portal help
  centre) (search, a `sm` **Blocked** `error` chip, Block behind a danger
  `confirmDialog`). A `notice-warn` asks for the workspace domain when the
  portal is on without one.
- **The satisfaction survey** (1.19.2, `PortalSurvey`, mock e3) sits under
  the request's title once it is solved or closed and not yet rated: one
  `bg-surface` `rounded-xl` card, the question centred and bold ("This
  request is solved. How did we do?"), three radio tiles in a row (a
  `sr-only` radio in each label; `w-24`/`sm:w-28`, `rounded-xl`,
  `border-[1.5px]`, lucide `Smile`/`Meh`/`Frown` at 28px; the chosen tile is
  `border-compass-500 bg-compass-50` with a `text-compass-600` icon, the
  others `border-slate-200` with `text-slate-400` icons), then "Anything to
  add? (optional)" over a `Textarea` and **Send** at the end. Never stars
  or a 1-to-5 row in the portal. The email's rating links open the
  request with the answer preselected; the customer still presses Send.
  Once rated the card says thanks with the answer's icon and their comment
  in quotes. `print:hidden`.
- **The kept request** lists each of the customer's own requests joined
  with it (`PortalJoinedNotice`): a `bg-surface` card, the day in
  `text-xs text-slate-500` ("Earlier today", "Yesterday", else the date,
  in the reader's zone), then "Your request #N was joined with this one,
  because it was about the same problem. Replies to either go here." No
  icon, no link (they are on the kept request already).

## Helpdesk: customer portal help centre

The help centre (1.19.4, mocks h1 at 1440 and 390, h2) is the portal's
home while it is on: anyone who can reach `/support` searches and reads a
chosen set of documents before raising a request, with no sign-in.
Components in `components/helpdesk/portal/help`; the settings in
`components/helpdesk/desk/settings/PortalHelpCentre.tsx`.

- **One rule decides what is public**: `lib/helpdesk/help-centre`
  `publicArticleScope` (its readers `publicHelpArticles` and
  `publicHelpCounts` only add a SELECT). Every surface (home, category,
  search, the request form's suggestions, an article, its links and
  files) reads through it; a page never selects documents itself. What it
  hands out is an allowlist (`HelpArticle`): never an author, tags,
  comments or history. Search matches only what the outside reads (title,
  summary, body without comments; never tags). An article's body loses
  its HTML comments (`publicBody`) and is drawn by the sanitising
  `MarkdownView` with `rewriteUrl` (`lib/md-url-rewrite`): every address,
  in any Markdown or HTML form, is decided on the parsed tree by
  `helpCentreUrl` (files through `/support/api/help/files`, links to
  documents that are not public reduced to their text, other addresses
  into the workspace dropped, other sites' left as written). Counts are
  true: a category past 300 says "Showing the first 300 of N. Search to
  find the others."
- **Home**: a full-width hero band (`-mx-4 sm:-mx-6 bg-compass-50`,
  hairline under it) holding the h1 "How can we help?" and the search;
  then the categories as a `max-w-5xl` grid of bordered `rounded-xl`
  `bg-surface` link cards (name `font-semibold`, "8 articles" under it in
  `text-slate-500`), three across from `sm` and two on a phone (three at
  390 broke "Troubleshooting" mid-word); then "Still need help?".
- **The search** (`HelpSearch`) is a GET form to `/support/search` (it
  works without script): a 48px `rounded-xl` `TextInput` with a `Search`
  glyph, and the suggestions as an **inline** card right under it, not a
  `Popover` (the hero grows to hold them, as in the mock): one row per
  article, a 16px `BookOpen` in `text-slate-500` and the title, hairlines
  between. Arrows walk the box and the rows, Escape closes; an
  `sr-only` live region says how many. Nothing matching is a
  `SectionEmpty` in the card; a rate-limited answer is the server's
  sentence in a `notice-warn` row over the last suggestions, never "No
  articles match".
- **"Still need help?"** (`StillNeedHelp`) is one bordered `bg-surface`
  card: the question bold, "Raise a request and we'll get back to you by
  email." under it, and a primary **New request** at the end (it stays
  beside the text on a phone). Not shown when nothing can be raised.
- **Article, category and results pages** are the portal's `max-w-3xl`
  column: a back link "Help centre" (`ChevronLeft`), the h1, then the
  content. An article: breadcrumb "Help centre / Category", the title at
  `text-3xl`, "Updated 4 Nov 2026" in the reader's zone, the summary as a
  lede, the body in the `doc-read` card, a **Files** card, then "Still
  need help?". Lists are `ArticleRows`: one link per row with a
  `BookOpen` in `text-compass-600`, the title and a two-line summary.
- **The header** gains "Help centre · Your requests" (a `nav` named
  "Portal") before the address and Sign out, or **Sign in** when signed
  out; the row wraps on a phone. With the help centre on, the sign-in
  form lives at `/support?signin=1` (and wherever `?next=` sends people).
- **The request form** shows "These articles might answer it" under the
  subject from three characters: a `border-compass-200 bg-compass-50`
  box (`dark:border-compass-500/40`) of up to three links that open in a
  new tab (`ExternalLink` glyph and an `sr-only` "(opens in a new tab)"),
  so the form keeps what was typed. Nothing renders with no match. The
  subject goes in a POST body and is never stored as a search.
- **Indexing**: every portal page is `noindex` except the help centre's
  home, categories and articles when the admin ticks "Let search engines
  index the help centre"; `robots.ts` then allows exactly those paths.
  Results pages are never indexed.
- **Desk settings → Customer portal is three pages** under one header
  (§Settings pages: a section with several jobs gets pages; `SubNav`
  "Customer portal settings"): **Settings**, **Help centre**,
  **Customers**. The Help centre page's cards: *Show a help centre*
  (`Toggle`s for it and for indexing; a `notice-warn` when the portal
  itself is off; the Settings page's **Open portal** opens it),
  *What's public* (two **option cards**: the whole card is the label of a
  checkbox, on = `border-compass-400 bg-compass-50`, off = `border-slate-200
  bg-surface`, title `font-semibold` and a `text-slate-500` sentence; the
  chosen spaces as neutral `md` chips with a remove `X` and a secondary
  `sm` **+ Space** menu that never lists private spaces; a stored private
  space shows as an `error` chip with `Lock`), *Categories* (hairline rows:
  the checklist editor's grip, which drags with a pointer, opens Move up /
  Move down from a click or the keyboard, and moves at once with
  Alt+Arrow, announced in a live region; the name; the count in `text-xs`;
  a quiet eye button, `aria-pressed`, `EyeOff` and a neutral `sm`
  **Hidden** chip when off) and *Last 30 days* (a `dl` of three: label in
  `text-sm text-slate-500`, value `text-xl font-bold`, "Not enough yet"
  in `text-sm text-slate-500` when there is no data). One `SaveRow`
  "Save help centre".

## Helpdesk: drafts from Claude and the Claude connector

1.19.1 (agent V1). The Claude connector's helpdesk tools never send a
reply: `hd_draft_reply` saves a draft, and a person sends it.

- **The draft card** (`ClaudeDraftCard`, above the composer in the ticket
  pane, agents who work the ticket only): a `section` labelled by its
  heading "Draft from Claude", `rounded-xl` with a **dashed** 1.5px
  `border-compass-300` on `bg-compass-50` (dark: `border-compass-500/50`,
  `bg-compass-500/10`). The dashed edge is the house sign for "not sent
  yet": never use it for a message that went out. The avatar is a 28px
  `bg-slate-900 text-slate-50` circle with a lucide `Bot` (both tokens
  flip in dark, so it stays legible); the meta line is `text-xs
  text-slate-500` "asked by {person} · {RelativeTime} · not sent" (plus "·
  N older drafts waiting" when several are pending; the newest shows).
  The body is `MarkdownView` indented under the name like a message.
  Actions: primary **Use as reply** (`Pencil`), secondary **Discard**,
  then the fixed line "Claude can only draft. A person sends." Use as
  reply puts the text into the public reply box after anything already
  typed there (`ComposerHandle.fill`), never sends; Discard has no
  confirm (the draft can be asked for again). `print:hidden`.
- **Messages and timeline lines written through the connector** say "via
  Claude": a message's meta line (`Conversation` VIA map, via `mcp`) and
  the end of each ticket-change line ("… changed the priority from Normal
  to High via Claude").
- **Desk settings → Claude connector** (`ClaudeConnectorSettings`, nav
  `Bot`, `settings.manage`): the level as `RadioCards` in a card titled
  "Claude can" (Read only / Read, add internal notes and save reply
  drafts / Also update tickets, one sentence each); a card "Never,
  whatever the setting" listing the three never-rules, each with a muted
  16px `Ban`; and "Recent activity via Claude" (`Card padding="none"`), a
  row per write: initials avatar and name (`sm:w-56`), the summary
  ("Saved a reply draft on #1047"), the `RelativeTime` at the end; under
  `sm` the summary drops to its own line under the name.
  `SectionEmpty` when there is none. The copy lives in
  `lib/helpdesk/claude-connector-shared` so the page, the tools and the
  tests read the same words.

## Helpdesk: Claude in the desk

1.20.0 (mocks c1 to c3; `components/helpdesk/desk/claude/`,
`lib/helpdesk/claude/`). A chat with Claude inside the desk, working on the
open ticket as the agent. It drafts and suggests; a person sends and
applies. The copy lives in `lib/helpdesk/claude/shared` so the panel, the
settings page, the server and the tests read the same words.

- **The Claude button** sits first in the top bar's right-hand group: a
  pill `h-8.5 rounded-full bg-slate-900 px-3 text-sm font-semibold
  text-slate-50` with a 14px lucide `Sparkle` and "Claude" (both tokens
  flip, so it is a dark pill in light mode and a light one in dark mode);
  under `sm` it is a 34px circle with the word `sr-only`. Its `data-tt` is
  "Claude ({mod} J)" and it carries `aria-keyshortcuts`. It opens the
  **launcher** (`Popover role="menu"`, `w-72`, end-aligned): "Ask Claude
  about #1047" in `text-sm font-semibold`, the five quick prompts as
  `menuitem` rows each with a muted `Sparkle`, "Open the chat", and the line
  "Or press {mod} J anywhere in the desk." with the SaveRow keycap recipe.
  With no ticket open the prompts give way to one `text-xs text-slate-500`
  line. Shown only when Claude is on for this agent (licensed, switched
  on, a key in Settings → AI, an agent, a team not switched off).
- **Ctrl/⌘+J** toggles the panel anywhere in the desk, typing included
  (`blockModKey`, never a bare key); with the panel open but focus
  elsewhere it moves focus into the question box first.
- **The panel** is an `aside` labelled by its "Claude" heading, docked
  `fixed` at the right (`sm:top-15 sm:right-4 sm:bottom-4`, 430px,
  `rounded-2xl border border-slate-200 bg-surface shadow-modal`) and
  **full screen under 640px** (`inset-0`, no radius). It is not a modal:
  the desk stays usable beside it, so it takes no focus trap and no scrim.
  Focus starts in the question box; Escape (when focus is inside and no
  overlay is open), Minimise and Close hand focus back to whatever opened
  it. `print:hidden`.
  - Header: a 28px `bg-slate-900 text-slate-50` circle with `Sparkle`,
    "Claude" (`h2`), a `neutral sm` chip "On #1047", then three quiet icon
    buttons with `data-tt` and `aria-label`: History (a `Popover role="menu"`
    with "New chat" and the earlier chats on this ticket as
    `menuitemradio`), Minimise (`Minimize2`) and Close (`X`, which also
    stops a running answer).
  - The conversation is a `role="log"` with `aria-busy` while an answer
    streams, so a screen reader reads the answer once, complete; an
    `sr-only` `role="status"` says "Claude is answering." / "Claude
    answered.". The agent's words are a bubble `max-w-[85%] self-end
    rounded-[12px_12px_4px_12px] bg-compass-600 px-3 py-2 text-white`.
    Claude's answer is `MarkdownView` in the flow, no bubble.
  - **Tool activity line** above the answer: `text-xs text-slate-500`
    items with a 12px lucide icon ("Searched solved tickets", "Read 2
    articles", "Checked ASSET-00421"), one per kind, no verbs in the
    future tense. "Thinking…" with a pulsing `Sparkle` (`motion-reduce`
    stills it) only until the first words arrive.
  - **Source chips** under the answer are links, not status chips:
    `rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700` with a
    12px `Ticket`, `BookOpen` or `Globe`, hover `bg-slate-200`. Only what
    the answer names (a ticket by its number, an article by its title, a
    web citation); a web chip opens in a new tab and says so `sr-only`.
  - **Cards** are `rounded-xl border border-compass-200 bg-compass-50 px-3
    py-2.5` (dark: `border-compass-500/40`, `bg-compass-500/10`), a solid
    edge, since nothing on them was sent (the dashed edge is the connector's
    saved draft, §Helpdesk: drafts from Claude). A **draft card** ("Reply
    draft for Daniel" / "Internal note draft", `Pencil`) shows three lines
    of the text and, at the right, "in your reply box" once
    `ComposerHandle.fill(text, mode, replace)` has put it there; the agent
    edits and sends it under the normal rules (a newbie's reply still waits
    for review). A refined draft **replaces** the earlier Claude draft the
    box still holds unchanged (`mergeDraft`); anything the agent typed or
    edited stays. A draft written while other tickets were in view, or that
    names another ticket (`cites_other`), is never put in the box on
    arrival: its card shows a secondary `sm` **Put in reply box** instead. A **change card** ("Set status to Waiting on requester",
    `SlidersHorizontal`; a checklist uses `ListChecks`) has its hint line
    ("After you send the reply.") and primary `sm` **Apply** with secondary
    `sm` **Skip**; once decided, an `ok` chip "Applied" or a `neutral` chip
    "Skipped". Apply goes through the ticket pane's own patch (the desk's
    PATCH with `via: "claude_desk"`), so every desk rule and prompt applies.
    Solving or closing another ticket from a card is refused with the toast
    "Open #N to solve it there.": the solve flow (time, maintenance,
    required checklist items) runs in the open ticket.
  - "Claude is still answering in this chat" (a second tab) and the
    limits come back as the panel's error line before anything streams.
  - A refusal, a cut-off answer or an error is one `text-xs` line with
    `TriangleAlert` in `ink-warn` (or `text-red-600` and `role="alert"`
    for an error), never a toast.
  - Footer: the **context chips** (the source-chip recipe, as a list
    labelled "What Claude can use": "#1047 and its notes", "Your articles",
    "Web: vendor sites" when web search is on), the question box (a
    one-row auto-growing textarea, Enter sends, Shift+Enter breaks a line;
    a `.frame-input` in its bordered frame, which carries the one focus
    outline; Send `ArrowUp` and, while streaming, Stop `CircleStop`, both icon
    buttons with `data-tt`), with a ticket open and drafts allowed the
    checkbox "May quote internal notes in a reply (this question only)" in
    `text-xs text-slate-600` (the agent's explicit say-so; it clears after
    each question), then the fixed line "Claude works as you, with
    your desk role. It drafts and suggests; you send and apply." in
    `text-xs text-slate-500`.
  - Empty: the centred `Sparkle`, "Ask Claude about #1047" and one
    sentence of what it does (the panel's own region, not an
    `EmptyState` card).
- **Desk settings → Claude in the desk** (`ClaudeDeskSettings`, rail
  `Sparkle`, `settings.manage`, New in 1.20.0): `PageHeader` with the page
  subtitle from c3, then three cards. The first is the master `Toggle`
  ("Uses the key and model set in Settings → AI · Claude Opus 5.5"), a
  `notice-warn` when there is no usable key, and **Teams**: `neutral`
  chips for the teams Claude is on for and "{team}: off" in `text-xs
  text-slate-500` for the others, with a ghost `sm` "Choose teams…" menu
  button whose `Popover role="menu"` rows are `menuitemcheckbox` (chips
  stay statuses, never pickers). "What Claude can do" is five `Toggle`
  rows in `divide-y` with the c3 labels and hints; Search the web is left
  out where the model or provider has no web search (one `text-xs` line
  says so) and, when on, opens the allowed sites (`Textarea`, checked as
  hostnames) and searches per answer. "Spending" has the two monthly
  limits (empty for none), this month's figures as a `dl` (This month,
  Chats, Drafts used, Top user; `text-lg font-bold`), and the data notice
  plus "Costs are estimates…". One `SaveRow`.

## Helpdesk: merge and bulk edit

Merging duplicate tickets and changing many at once from the queue
(1.19.1, Enterprise `helpdesk`; components in
`components/helpdesk/desk/merge`).

- **Row checkboxes** sit beside each queue row's link, never inside it
  (a click on the box must not open the ticket): a native checkbox
  inheriting the accent, `absolute left-4` on the row's subject line,
  `aria-label="Select #1052 {subject}"`, `print:hidden`; the link takes
  `pl-11`. A selected row is `bg-compass-50/60`; the open ticket keeps its
  band. Click toggles, **shift-click** sets the range from the last row
  clicked to that row's state, and **x** toggles the row under keyboard
  focus (through `useDeskKeys`, so the single-key preference covers it).
  Selection is per list: rows that leave the list leave the selection. A
  role without `tickets.bulk` or `tickets.merge` sees no checkboxes.
- **The queue's bulk bar** is the house bulk bar (§Tables) as a strip
  under the list header, the drill-down strip's tint (`border-b
  border-compass-200 bg-compass-50/70 px-3 py-2`), wrapping on a phone:
  a select-all checkbox (indeterminate while some rows are selected),
  "{n} selected" in `text-sm font-semibold text-compass-800`, then one
  `secondary` `sm` menu button per field the role may change (Status,
  Priority, Team, Assignee as `PickMenu`s; Tags as a `Popover` menu of
  "Add a tag…" / "Remove a tag…", each a `promptDialog`), the `primary`
  `sm` **Merge…** (two or more selected, `GitMerge`), and a ghost
  **Clear** last, as mock-up #1 has it. A field the role lacks is left
  out. It mounts with the list so its result dialog outlives the
  selection.
- **Results** are one toast: "3 tickets set to High priority." When the
  server skipped some, "2 tickets … 1 skipped." with a **See why** action
  opening a dialog that lists each skipped ticket (number, subject) with
  the server's own sentence ("You can't change the priority of this
  ticket.", "Merged into another ticket. Change that one instead."). A
  successful edit clears the selection; one where every ticket was
  skipped keeps it.
- **The merge dialog** (mock-up #2) follows §Overlays "Choice dialog":
  the title "Merge 3 tickets" with `GitMerge`, one lede sentence, stacked
  radio cards for the ticket to keep (oldest first and chosen first; the
  line under each: requester · status · "oldest" · "SLA overdue 25m"), a
  **What happens** card (`bg-canvas`, eyebrow) listing exactly what the
  server will do, the "Tell the requesters" checkbox quoting the note
  they get (`mergedNote` in `lib/helpdesk/merge-shared`, which the server
  writes), and a primary that says it: **Merge into #1049**. From a
  ticket's **…** menu ("Merge into another ticket…") the same dialog first
  shows a search over the agent's queues; the found ticket is chosen to
  keep. Refusals show in the dialog's `FormError`, one line per ticket.
- **On the tickets**: the kept ticket's side column has a **Related** card
  (eyebrow, `GitMerge` lines: "Merged in: #1051, #1052", each a link in
  the same queue view, the subject as `data-tt`); a moved message's meta
  line ends "· from #1051". A merged ticket shows "Merged into #1049" in
  the same card and in a tint strip above its conversation, with the link.
- **A merged ticket is read-only** (`MergedComposerLock`): the composer
  and the Claude draft card are replaced by one neutral read-only strip
  (`rounded-lg border border-slate-200 bg-slate-50`, `Lock`, never a
  `notice-*`): "**Read-only** · This ticket was merged into #1049. Reply
  and change its status there." with a `secondary` `sm` **Open #1049**
  (`ArrowUpRight`). The status menu becomes the plain status chip. The
  messages route and PATCH status answer 409 with the same sentence.

## Helpdesk: major incidents

One ticket for an outage, with the tickets people raise about it linked to
it (1.19.2, Enterprise `helpdesk`; components in
`components/helpdesk/desk/incidents`, Get help's in
`components/helpdesk/help/IncidentBanners`).

- **Red is for an open incident only.** The incident's own ticket has a
  `notice-error` strip above its header (`Siren`, "**Major incident** ·
  declared by Ana Kowalski 48m ago · 34 tickets linked · shown in Get
  help"), which turns neutral (`border-slate-200 bg-slate-50`) once it is
  solved. Its queue row's chip is `chipClass("error", "sm")` with `Siren`,
  "Major incident"; a linked row's chip is neutral with `Link2` and the
  incident's number. The queue's views column has a **Major incidents**
  group (house rail rows, `Siren` in red, the open linked count in red
  semibold), shown only while one is open.
- **A linked ticket** shows a neutral strip above its header ("Linked to
  major incident #1101 VPN is down from home · its updates reach this
  requester") with a ghost **Unlink** that confirms first; the incident's
  number is a link only for someone who works its ticket.
- **The incident's cards** sit in the main column above the conversation:
  *Updates to everyone affected* (eyebrow with `Megaphone`; each update is
  time, text and "Ana Kowalski · sent to 34 requesters and shown in Get
  help", from `sentLine`), its composer (a framed textarea, then "Solve the
  incident and its 34 linked tickets" and a primary **Post update** with
  `Send`; solving confirms and lists what it will do), and *Linked tickets
  · 34* (a table with a screen-reader header, rows' Unlink as a hover icon
  button with `aria-label` and `data-tt`, the rule as inline `code` words
  with an Edit pencil, and "Tell requesters when their ticket is linked").
  The side column starts with *Get help banner* (who sees it, a "Shown to"
  menu, a preview in `notice-error`, the Me too and affected counts) and,
  only when the Status page has an internal service, *Status page* (a
  `Toggle`).
- **Per-ticket results** ("2 tickets linked. 1 skipped." / "… left open")
  are one toast with **See why**, opening a dialog that lists each ticket
  with the server's own sentence, as the bulk bar does.
- **The declare dialog** (mock-up a2) is the house Modal: `Siren` title,
  one lede, Title, Team and Priority (two columns from `sm`), the tickets
  to link as one checked radio card, the rule as a prefixed input
  ("Subject or description contains:" in muted ink inside the control),
  the two checkboxes, and **Declare incident** with `Siren`.
- **A control inside a frame** (the prefixed input, the update composer)
  takes `.frame-input` (globals.css, beside `.cmd-input` and `.tiptap`):
  the frame carries the focus outline with
  `has-[:focus-visible]:outline-2 outline-compass-600` (300 in dark), so
  there is one ring, never one inside another.
- **Get help** shows one `notice-error` card per incident under the page
  header (`Siren`, the title in `font-semibold`, the latest update, then
  "IT Service Desk · last update 10:42 · 61 people affected" at
  `opacity-80`) with a secondary `sm` **Me too** (`Users`; `Check` and
  `aria-pressed` once pressed; pressing again takes it back). It wraps
  under the text on a phone. It never shows a ticket number or an agent's
  name.

## Helpdesk: status services per team

The Status page's services on the desk, chosen per team (1.19.2, agent W6,
Enterprise `helpdesk`; components in `components/helpdesk/desk/team-status`,
rules in `lib/helpdesk/status-teams`). The Status page itself is unchanged
and stays the one place services are added.

- **One poll feeds every piece.** `TeamStatusProvider` (in `DeskShell`)
  asks `GET /api/helpdesk/team-status` once a minute while the tab is
  visible and when it comes back; the pill, the pop-ups and the queue
  banner read its answer. Never a second poll per piece.
- **The top-bar pill** sits left of **CompassDocs**. While a followed
  service is degraded or out it is a `rounded-full border h-8` button in
  `notice-warn` (degraded) or `notice-error` (any outage) with a
  `StatusDot`, "N services affected" (the number alone under `sm`) and
  `ChevronDown`; otherwise a quiet `Activity` icon button
  (`data-tt` "Service status") with a green dot. It opens a `Popover`
  (`role="dialog"`, "Your teams' services"): "Services for {teams}", "From
  the Status page · checked 2m ago" (vendor feeds only), one row per
  service (dot, name, detail or "All systems normal", the state chip),
  then a hairline footer: where services are chosen (a link to Desk
  settings → Teams for `teams.manage`, a **Choose services for {team}**
  button opening the same editor in a dialog for a team's lead, or "Your
  team lead chooses these services.") and **Status page** with
  `ExternalLink` in a new tab. An agent sees only their teams' services,
  and nothing at all without the workspace's `status.read` (the Status
  page's own permission): no pill, pop-ups, banners or notices.
- **State colours** are `StatusDot` (emerald operational, amber degraded,
  red outage, sky maintenance, slate unknown; decoration only, the state is
  always written beside it) and `stateTone()` for chips (`ok`, `warn`,
  `error`, `info`, `neutral`). Copy comes from `stateSentence()`: "is
  degraded", "is down", "is operational again".
- **Pop-ups** are cards, not toasts: fixed bottom-right under the toast
  host (`z-40`, `w-[min(25rem,calc(100vw-2rem))]`, `shadow-modal`,
  `bg-surface` with an amber, red or emerald border), at most three, in an
  `aria-live="polite"` region. A down card: `CircleAlert`, "{service} is
  degraded", "{detail}. Started 10:14, 3 new tickets mention mail since.",
  a `sm` primary **Declare major incident** with `Siren` (only when the
  agent may run incidents in that team; once a major incident is open for
  the service, a `sm` secondary **Major incident #N** link to it instead,
  never a second declare) and a `sm` secondary **View
  details** (opens the pill's popover), and a 28px `X` with an
  `aria-label` naming the service. A recovery note (`CircleCheck`, "Back
  to normal at 11:02…") follows only for those who saw the pop-up; a solve
  ask (`Siren`, "{service} is operational again" or "is under
  maintenance", **Solve incident and linked tickets** / **Not now**) goes
  to the people who can still run the incident. Trouble that returns
  within ten minutes is the same spell: no second pop-up or bell. Dismissing is remembered on the server, one
  pop-up per person per episode.
- **The queue banner** opens a team's list (under the list header, above
  the bulk bar) while a followed service is degraded or out: `notice-warn`
  or `notice-error`, `role="status"`, the dot, "**{service} is degraded**
  since 10:14", the detail, then `sm` secondary **Declare major incident**
  (`Siren`; or **Major incident #N** when one is open for it) and **Hide for today** (`EyeOff`; per person, until the end of
  their day). Pop-up level "off" still shows it.
- **Choosing services** (Desk settings → Teams, the "Status services for
  {team}" section beside "Reply targets"; the same `TeamStatusServices`
  editor in the lead's dialog): one sentence on what agents get, a house
  table (follow checkbox labelled by the service's name, **Service**,
  **Now** chip, **Pop-up for** `Select dense` shown only when ticked:
  Outage and degraded, Outage only, Off (banner only)), then "Need another
  service? Add it on the Status page…" and one **Save** (disabled until
  something changed). Saving toasts "{team}'s status services saved."
- **Declaring from a service** reuses W1's dialog with `fromStatus`: the
  lede "Started from the Status page: {service} is degraded.", the title
  and auto-link words prefilled, "Link the N open tickets that mention
  {word} since 10:14" in place of the selection card, and "Solve the
  incident's tickets when {service} is operational again (asks first)".
  Nothing is ever solved without a person's click.

## Helpdesk: recurring tickets and time tracking

Recurring tickets and the Time card (1.19.1, agent V8). Components live in
`components/helpdesk/desk/recurring` and `components/helpdesk/desk/time`.

- **Recurring tickets** (`/desk/settings/recurring`, rail icon `Repeat`)
  is the two-pane settings recipe: the schedules in a `padding="none"`
  card holding a `table-fixed` house table (Schedule · Next), each row one
  `button` stretched over the row (`after:absolute after:inset-0`,
  `aria-current`), the chosen row `bg-compass-50`; the title is the
  subject without its placeholders and the second line `text-xs
  text-slate-500` "Team · first Monday". A paused schedule's Next is a
  `neutral` `sm` chip **Paused**. **New schedule** is the page header's one
  action. Under `lg` the editor stacks below the list and a row click
  scrolls it into view.
- **The editor** is one card (`id="recurring-editor"`): Subject (the
  placeholders as help), Description, Team and Assign to, then
  **Repeats** as a `Segmented` (Daily, Weekly, Monthly, Custom; never tabs)
  with the pattern row under it as plain words and controls ("First
  Monday at 09:00", "Every 2 weeks from … at …"). Weekday picks reuse the
  bordered checkbox labels of §Helpdesk: desk notifications (short day
  visible, full name `sr-only`); months are behind a checkbox "Only in
  some months" and use the same labels at `text-xs`. The holiday choice is
  the mock's checkbox ("…open it on the next working day"); unticked, a
  select offers Skip that date / Open it anyway.
- **The preview** is one `text-xs text-slate-500` line under Priority and
  due, `aria-live="polite"`: "Next three: Mon Dec 7 · Tue Jan 5 (moved
  from Mon Jan 4, New Year closure) · Mon Feb 1", computed by the server
  with the team calendar's holidays. While a changed pattern loads it says
  "Working out the next dates…", never the old dates.
- The action row is right-aligned as in the approved mock: Delete (ghost,
  `hover-danger`, pushed left with `mr-auto`), the amber "Unsaved changes"
  state, **Open one now** (secondary; it saves first when there are
  changes) and **Save** (primary). Hidden in print.
- **The Time card** sits in the ticket's side column above Related: the
  `Timer` eyebrow "Time", the clock in `text-2xl font-bold tabular-nums`
  (`role="timer"`, `text-slate-500` while stopped) with a secondary `sm`
  **Stop** (`Square`) or **Start** (`Play`) beside it, one `text-xs` line
  ("Timer running · you", or a link to the ticket the agent's timer runs
  on), then the entries as hairline rows ("You · today", "Ana Kowalski ·
  investigation", the minutes `font-bold tabular-nums` on the right), the
  total, and a full-width secondary **Log time** (`Plus`). Durations read
  "45m", "1h", "1h 25m" (`formatMinutes`).
- **Entry controls** (Edit `Pencil`, Delete `Trash2`, quiet 24px icon
  buttons with `aria-label` and `data-tt`) appear only on entries the
  person may change. Where a pointer hovers they are `w-0` until the row
  is hovered or a control inside it has focus, so names keep their room;
  on touch they always show. Log time and Edit use `formDialog` (Hours,
  Minutes, Note); Delete asks with `confirmDialog({ danger: true })`.
- **Ask for time on solve** is a `Toggle` on the team's card in Desk
  settings → Teams. Solve then opens a `formDialog` "Log your time before
  solving?" (the running timer prefilled); Cancel keeps the ticket open,
  empty fields solve without logging. Requesters never see time.

## Helpdesk: import

Desk settings → Import (1.19.1, `components/helpdesk/desk/settings/import`):
tickets from a Zoho Desk export or a CSV file, in a fixed sequence of
steps. The first wizard in the desk; reuse it for any flow where nothing
may be written until the person has seen what will happen.

- **Step indicator.** An `<ol aria-label="… steps">` of `li` rows above the
  step's card, never tabs: a 24px circle and the label. Done steps are an
  emerald circle with `Check` (`bg-emerald-100 text-emerald-700`, dark
  `emerald-500/15` / `emerald-300`) and an `sr-only` "(done)"; the current step
  is `bg-compass-600 text-white` with a `font-semibold` label and
  `aria-current="step"`; later steps are `bg-slate-100` numbers. It wraps on
  a phone and is `print:hidden`. Steps are not links: the flow moves with
  its own buttons ("Back to mapping", "Run the dry run").
- **One card per step.** The step's card opens with the file name
  (`text-base font-semibold`) and a `text-slate-500` summary line
  ("Zoho Desk export · 4,812 tickets · …"). Mapping rows are a divided list:
  the source value and its ticket count on the left, the control on the
  right (`sm:w-80`), stacking under `sm`.
- **Dry-run tiles.** Four count tiles (`rounded-xl` bordered, `text-2xl
  font-bold tabular-nums` number, `text-sm` label), two per row on a phone
  and four from `xl`. A skipped count links "see why" to the CSV download.
  Under them, one `text-slate-500` line of the smaller counts.
- **The reassurance strip** ("Safe to run again… No emails are sent") is an
  info tint, not a notice class: `rounded-lg border border-compass-200
  bg-compass-50` with a `text-compass-600` lucide icon. It states a promise,
  so it is never amber.
- **A background job** shows a `role="progressbar"` bar (`h-2`, compass;
  emerald when done, red when failed) under an `aria-live="polite"` line
  ("Importing tickets: 1,240 of 4,812"), the status as a chip, and
  **Stop import** (`danger`) while it runs, **Resume import** after a stop
  or failure. The page polls; the job id travels in the address (`?job=12`)
  so a reload returns to it, and the page loads the job before its first
  render so step 1 never flashes.
- **A check in the background** (1.19.2, mock e1: the dry run, or reading
  the export again after a column change) replaces its step's card while
  it runs: a `Spinner` and "Checking your export" (or "Reading your export
  again") with the file and ticket count at the end of the row, the `h-2`
  compass bar, under it "13,800 of 30,000 tickets checked · about 3 minutes
  left" (`aria-live="polite"`) and the percentage at the end; for a dry run
  four count tiles with the label *above* the number ("To create", "To
  update", "Contacts matched", "Skipped so far"; `text-xl font-bold
  tabular-nums`), then the info strip with `Bell`: "You can leave this
  page. We'll tell you in the bell when the dry run is ready." and, for a
  dry run, **Stop** (secondary) beside the import button waiting disabled
  with the count so far. A rescan has no Stop. The time left appears only
  once there is a pace to go on (`importTimeLeft`). A check that failed
  shows its reason as a `notice-error` on the map step.

## Helpdesk: canned responses

Text-only snippets (1.19.2), separate from macros: inserting one never
changes the ticket. Components: `desk/ticket/CannedPicker.tsx` (the
composer's picker), `desk/settings/CannedSettings.tsx` and
`CannedBodyEditor.tsx` (the library); the pure rules are
`lib/helpdesk/canned-shared`.

- **An inline trigger keeps the typing in the box, and never eats it.** `;`
  at the start of a word arms the picker; it shows *under* the composer
  toolbar (anchored on the Canned response button, `side="bottom"`,
  scrolled into view) only once two letters follow and a response's
  **name or folder** matches (`inlinePickerShows`; the text is not
  searched here). Until it shows, every key is the box's own: ` ;` then
  Enter is a line break, `;D` stays a wink. The agent keeps typing in the
  reply box and the picker's search row mirrors what follows the `;` (with
  a `;` `kbd` at its right). ↑/↓ move the active row, Enter or Tab inserts
  it in place of `;query`, Escape (the overlay stack) closes and leaves the
  text; keys during IME composition (`isComposing`, keyCode 229) are never
  taken. A refused insert (the response was deleted or moved) inserts
  nothing: the server's sentence is a toast and the list reloads. While it is open the textarea carries
  `aria-controls`, `aria-autocomplete="list"` and `aria-activedescendant`,
  and a polite `sr-only` line says how many match. Never fire mid-word or
  in a URL (`cannedTrigger`): the `;` must follow the start, a space or a
  line break, and the query must start with a letter or digit, so `; ` and
  `;)` stay punctuation. Triggers never overlap: `/` (empty box, macros),
  `;` (canned responses), `[[` (articles).
- **The picker** is a `Popover` (`p-0`, `w-[min(29rem,calc(100vw-2rem))]`)
  with a search row, a `role="listbox"` of `role="group"` sections headed
  in `RAIL_GROUP_TEXT` (the ticket's team, other teams, Workspace, Mine),
  options with `MessageSquareText`, the title (`font-medium`) and a
  two-line preview in `text-xs text-slate-500` (placeholders shown as
  written), an `↵` `kbd` on the active row, and a footnote under a
  hairline: "Inserts text at the cursor. Canned responses never change the
  ticket; use a macro for that." From the button, the search row is a real
  `role="combobox"` input.
- **Placeholders as chips.** In the library editor the text is a
  `role="textbox" aria-multiline` contenteditable in the house control
  recipe (`controlClass`) where each `{{tag}}` is a neutral `Chip`
  (`contenteditable="false"`, `data-ph`) reading in words ("requester
  first name", "ticket number", "my first name"); the chips under it
  insert one at the caret. The stored value stays plain text with
  `{{tags}}`. An unknown placeholder, or a stray `{{` / `}}` (a one-brace
  typo), is refused on save and left out on insert, so a reply never
  carries raw braces.
- **The library** (Desk settings → Canned responses, `MessageSquareText`):
  the filter row is a `Segmented` (All, Workspace, each team, Mine; a
  `Select` when there would be more than five), a search box and a primary
  **New**; the table's Shared with is a neutral chip ("Only me", the team,
  "Workspace"), Folder an ink cell with `Folder`, Used (30 days) a number
  (both columns hidden under `sm`), and a quiet pencil (`Eye` for a row the
  viewer can read but not edit). The editor is a card under the table,
  headed in the eyebrow tier ("Editing · {name}"), never a modal, with
  Save, Cancel, "Unsaved changes" and a ghost Delete on the right.
  Managers also get a "Deactivated people's personal responses" card: who
  and how many (never the text), each with a ghost Delete that asks first.
- **Deleting a team** says how many canned responses go with it in its
  confirm dialog (`cannedTeamDeleteNote`).

## Helpdesk: checklists

Checklists on tickets (1.19.2, agent W3; mock-ups c1 and c2). Components
live in `components/helpdesk/desk/checklists`.

- **On a ticket** each checklist is its own `CARD_CLASS` section in the
  main column, between the workflow banners and the conversation: the
  eyebrow tier with `ListChecks` and the name, "4 of 7 done" in
  `text-sm text-slate-500`, then quiet 28px icon buttons on the right
  (**Add an item** `Plus`, **Remove checklist** `Trash2` with
  `hover-danger`; each with `aria-label` and `data-tt`). Under it a 6px
  progress bar (`bg-slate-100` track, `bg-compass-600` fill,
  `role="progressbar"` with "n of m done" as its value text). Items are
  hairline rows: a native checkbox (`accent-compass-600`) with its own
  label; a done item's title is struck through in `text-slate-500` (never
  400); an open required item carries a `warn` `sm` chip **Required**. The
  right-hand meta is `text-xs text-slate-500`: who ticked it, or the owner
  team · "due Mon Jan 4" (`shortDate`), in `ink-warn` once overdue. One
  note under the last card: "Ticking an item is noted on the timeline.
  Required items must be done before the ticket can be solved."
- **Ticking is optimistic**: the box changes at once and goes back if the
  server refuses. A closed or merged ticket's checklists are read-only.
- **The side card** "Checklists" lists each one's name (an in-page link
  to its card) and `n/total` in `font-bold tabular-nums` (`ink-warn`
  while required items are open), then a full-width secondary **Add a
  checklist** that opens a picker menu (§Overlays and modals) of the
  library, each option's hint "7 items · 2 required". An empty library
  is a `SectionEmpty` with "Set one up" for people who manage it.
  The limit (ten) is for adding, as with assets (1.19.4): at ten or more
  **Add a checklist** is the same button `disabled` inside `Tooltip`
  ("A ticket holds up to 10 checklists."), and the server refuses an
  eleventh by hand. A merge moves every checklist, so a ticket may hold
  more than ten; the card lists them all and the solve check reads every
  one. A request type or workflow that would add one past ten leaves an
  internal line instead ("The workflow didn't add the checklist "…": a
  ticket holds up to 10 checklists. An agent can remove one and add it
  by hand.").
- **A refused solve** (every path: Solve, `e`, Send and set Solved, a
  macro, bulk edit, the Claude connector) says "Finish the required
  checklist items first: "…", "…" and 2 more." The desk toasts it and
  scrolls to the first checklist with an open required item, focusing it.
  The sentence's prefix (`CHECKLIST_BLOCK_PREFIX`) is how the desk tells
  it from a task's hand-off 409, which opens Mark done instead.
  On a team that asks for time on solve, the desk checks first
  (`checklistsHoldSolve`): a blocked solve never opens "Log your time" or
  stops the timer. A reply sent while an item was unticked meanwhile is
  still sent, with a second toast "Sent, but the status didn't change."
- **The library** (Desk settings → Checklists, `ListChecks`; Request types
  uses `List`): a house table (Checklist · Items · Added automatically to
  · Used; Items and Used fold into the first cell's second line under
  `sm`), each row a stretched button (`aria-current`, `bg-compass-50`)
  as in Recurring tickets. **New checklist** is the header's action.
- **The editor** is a card under the table, headed in the eyebrow tier
  ("Editing · Leaver: IT"), never a modal: Name, then the items as
  hairline rows. Each row: a `GripVertical` grip (drags with a pointer;
  clicked or from the keyboard it opens a menu with Move up / Move down),
  the title as a borderless input that shows its border on hover and
  focus (Enter goes to the next item or adds one), then the item's state
  in words (**Required** `warn` chip, the owner team and "Due +2 days" as
  `text-xs text-slate-500`), a quiet `SlidersHorizontal` that opens a
  popover (Required `Toggle`, Owner team, Due in business days) and a
  quiet `X` remove. **Add item** is a secondary `sm` button. "Add it
  automatically" lists request types as bordered checkbox labels, and the
  workflow tasks that add it read-only beneath. The action row: ghost
  **Delete** (`hover-danger`, `mr-auto`), amber "Unsaved changes",
  primary **Save checklist**.
- **The workflow builder's Task step** has a "Checklists" section like
  "If the team can't do it": rows naming each chosen checklist with its
  item count and a quiet `X`, and a secondary `sm` **Add checklist**
  picker.
- Requesters, CCs and portal customers never see checklists: no
  requester route returns them and every timeline line is internal.

## Helpdesk: before you solve

Requirement sets (1.20.5, `lib/helpdesk/solve-requirements`). Components
live in `components/helpdesk/desk/solve`. The words are **ticket**,
**solve** and **Before you solve**; never "close a case".

- **The settings page** (Desk settings → Before you solve,
  `ClipboardCheck`) is the list-then-detail pattern (§Settings pages):
  rows show the set's name, an **On** `ok` or **Off** `neutral` `sm`
  chip, one facts line ("IT Support · 2 ticket fields · 3 closing
  fields") and "Answered on 12 tickets" on the right from `sm`. **New
  requirement set** asks for a name, creates the set switched off and
  opens its page.
- **A set's page** stacks four cards over one `SaveRow` ("Save
  requirement set"): **Set** (Name, the On `Toggle`), **Applies to** (a
  `Segmented` "All tickets" / "Chosen teams and request types", then the
  checklist editor's bordered checkbox pills for teams and request
  types), **On the ticket** (a hairline list of checkbox rows, each a
  label and one help sentence; only the fields this install can meet are
  offered) and **Closing fields** (the request form's `FormBuilder` with
  `copy={{ noun: "Field", … }}`; never a second builder). Errors are
  inline `text-xs text-red-600` under the card's control after the first
  Save. Delete is the danger zone.
- **The dialog** ("Before you solve #1047", `CircleCheck`, the solve
  flow's promise-and-host recipe as `SolveMaintenance`) opens before any
  request changes the ticket. Under the subject and one lede sentence:
  an eyebrow **On the ticket** with a `Field` per missing ticket field
  (a `Select` for Owner and Team, a `TextInput` for Category and Tag, a
  search plus a hairline list with `sm` secondary **Link** buttons for an
  asset, an input and a secondary **Log time**), then one eyebrow per set
  with its closing fields drawn by the request form's `FormFieldControl`.
  A setter that saves at once (Link, Log time) says so in its help line
  and becomes a `Check` row ("Time logged. Logged 25m."); everything else
  is saved by the primary. A requirement the dialog can't meet (a reply,
  a field the role may not change) is a sentence saying what to do.
  Errors are inline after the first submit, and a server refusal is a
  `notice-error` line above the actions. The action row is sticky at the
  bottom of the dialog's own scroll (`sticky bottom-0`, a top hairline),
  Cancel then the primary, whose label says what happens: **Solve**, or
  **Send and solve** from the composer. Cancel changes nothing and never
  touches the composer's text.
- **Solve details** is a side-panel card in the eyebrow tier, above
  Properties, in the Request details recipe (`dt` `text-xs
  text-slate-500`, `dd` `text-sm text-slate-800`), read-only, with one
  `text-xs` line "Filled in by Ana 2h ago". With more than one set, each
  set's name heads its answers in `text-xs font-semibold`.
- **A refused solve** on a path that can't ask (bulk edit, the API, the
  Claude connector, an automation) says "Before you solve, this ticket
  needs: an owner, a linked asset, Resolution code and 2 more."
  (`SOLVE_BLOCK_PREFIX`; ticket fields in lower case, closing fields as
  named, up to four).
- Requesters, CCs and portal customers never see the answers: no
  requester route returns them and their timeline line is internal.

## Helpdesk: assets

Assets on tickets (1.19.3; mock-ups i1 to i4). Snipe-IT is the source;
components live in `components/helpdesk/desk/assets`, the server in
`lib/helpdesk/assets` (sources behind `lib/helpdesk/assets/providers`).

- **A device's picture** is `AssetGlyph`: a lucide icon picked from the
  category and model (`assetIcon`: `Laptop`, `Computer`, `Monitor`,
  `Smartphone`, `Tablet`, `Printer`, else `Package`) in a `bg-compass-50`
  `text-compass-700` tile, 36px `rounded-lg` in cards and 48px
  `rounded-xl` as the asset page's masthead; in pickers and tables it is
  the bare `h-4 w-4 text-slate-500` icon. Never a product logo.
- **The side card** "Assets" (eyebrow with `Package`) sits under the
  requester's card. Its header action is a quiet text button **+ Link**
  in `text-compass-700`. Each linked asset is a hairline block: the
  tile, the name (`font-semibold`, a link to the asset's page) over
  "TAG · Snipe-IT" in `text-xs text-slate-500`, a quiet `X` Unlink
  (`aria-label` "Unlink TAG", `data-tt`), then a `dl` of Status (a `sm`
  chip: Deployed `ok`, ready `info`, pending `warn`, else `neutral`;
  `statusText` says "Deployed" for any checked-out asset), Assigned and
  Warranty ("Until Mar 2027" / "Ended Mar 2024"), then under a hairline
  two `text-xs` links: `History` "N earlier tickets on this asset" (to
  the asset's page) and `ExternalLink` "Open in Snipe-IT" (new tab, with
  an `sr-only` "(opens in a new tab)"). Nothing linked is a
  `SectionEmpty`. The card is absent when no source is set up and
  nothing is linked; a closed or merged ticket's links are read-only.
  **+ Link** shows only while a source is connected; at ten linked (a
  merge may bring more, the list just grows) it is disabled inside
  `Tooltip` ("A ticket can have up to 10 assets."). Unlink needs no
  source: it stays on an open ticket after Snipe-IT is disconnected, so
  a wrong or personal device link can always be removed.
- **The link picker** is a `Popover` (`role="dialog"`, `align="end"`,
  26rem) whose first row is a borderless search input with `Search`
  ("Asset tag, serial or name") as a combobox over a listbox. Groups have
  eyebrow headings: **Assigned to <requester>** first, then **Matching
  assets** once something is typed. A row: the bare icon, the name over
  "TAG · linked" (or the person, for a search hit), and the source as a
  `neutral` `sm` chip on the right; an already-linked row is
  `aria-disabled`. The footer line says what the search reaches ("Or
  search every asset by tag or serial.", or the narrower sentence when
  "Agents can search all assets" is off), or the source's error when a
  live lookup failed. With no source connected (the options answer
  `connected: false`, say after a disconnect in another tab) the listbox
  holds only a `SectionEmpty` with the notice ("Snipe-IT isn't
  connected. An admin can connect it in Desk settings, Assets."), with no
  groups and no footer line. The picker closes when the card reaches ten
  or loses **+ Link**, so an Unlink back under ten never reopens it.
  Arrow keys walk the pickable rows; Enter links.
- **The asset page** (`/desk/assets/[id]`) has a trail ("`Package`
  Assets › TAG", `ChevronRight` separators) instead of a back link, then
  the masthead: the 48px tile beside the `h1` (the device is the thing
  itself, so the tile replaces PageHeader's 24px icon, like a person's
  photo in the directory) and "TAG · serial … · from Snipe-IT", with a
  secondary **Open in Snipe-IT** on the right. Below, a two-column grid
  (`lg:grid-cols-[minmax(0,1fr)_20rem]`, stacked under `lg`): the
  **Tickets on this asset** card (a house table that scrolls sideways on
  a phone; ticket, requester, status chip, opened, time logged) and the
  **Details** and **Maintenance in Snipe-IT** (`Wrench`) side cards.
  Tickets the viewer may not open are never named: one `text-xs` line
  counts them. The same holds for maintenance: a record naming a ticket
  ("#1047") the viewer can't open, or an anonymised one, is left out and
  counted ("1 record from a ticket you can't open"). What CompassDocs
  posts to Snipe-IT never carries a subject: the title is "CompassDocs
  #N: <type>" and the note is the agent's own text. When the source can't be reached the page shows the
  cached details under a `notice-warn` line, never an error page.
  `/desk/assets` is the search behind the trail.
- **Desk settings → Assets** (`Package`) is one card per source. Its
  header is the tile, the source's name, one status line ("Connected ·
  1,284 assets · synced 6m ago", the last sync's error, "Syncing now")
  and a chip (Connected `ok`, Sync failed `warn`, Syncing `info`, Not
  connected `neutral`), with a ghost **Disconnect** (confirmed with
  `confirmDialog({ danger: true })`). A saved API key is never shown:
  the field reads as dots with `Lock` and a **Replace** link that turns
  it into an empty password input; changing the address asks for the
  key again and starts a new asset list (the old one's linked assets stay
  on their tickets as "no longer in the source", so a link never moves to
  another device with the same id). The solve behaviour is `RadioCards`; **Test connection**
  (`PlugZap`) and **Sync now** (`RefreshCw`) are secondary buttons that
  toast the result, and the page polls while a sync runs. "Who sees
  assets" is a plain `Card` with the **Agents can search all assets**
  `Toggle`. One `SaveRow` for the page.
- **Microsoft Intune** (1.19.4; mock-ups i1 to i3) is a second source
  with no fields of its own: it signs in with the Microsoft 365 directory
  sync's app registration. Its card sits between Snipe-IT's and "Who sees
  assets": the `Laptop` tile beside a full-width `Toggle` whose label is
  **Microsoft Intune** (`font-semibold`) and whose help line reads "Uses
  your Microsoft 365 directory sync · 1,190 devices · matched to Snipe-IT
  by serial" (the last part only while Snipe-IT is connected). The switch
  applies at once, outside the page's `SaveRow`: switching on tests Graph
  first, and a refusal (most often the missing
  `DeviceManagementManagedDevices.Read.All` permission) stays on the card
  as a `notice-warn` `role="alert"` line with an "About this permission"
  link; switching off is confirmed (`confirmDialog({ danger: true })`)
  and follows Snipe-IT's disconnect rules. Without the licence or the
  directory credentials the switch is `disabled` and the line says why,
  with a "Set up Microsoft 365 directory sync" link for the credentials
  case. While on, a `text-xs` line under it says when it synced, how many
  devices are shown as their Snipe-IT asset, and offers a ghost **Sync
  now** (`RefreshCw`).
- **One asset per device.** A device Intune manages whose serial a
  connected Snipe-IT asset has is shown only as that asset: on the side
  card it gains an **Intune** row in the `dl` ("Compliant · seen 2h
  ago", `intuneSeenLine`); in the picker it reads as its Snipe-IT asset
  (an Intune device's own line adds "Intune: compliant"); on its page the masthead says "from Snipe-IT, matched to
  Intune" (`sourceLine`) and Details end with "Intune: Compliant · macOS
  15.2" (`intuneOsLine`). The Intune line shows only while Intune is on.
  A device only Intune has is an asset of its own with an **Intune** chip:
  Intune has no tags, so the serial stands where the tag would ("SERIAL ·
  Intune"), its page adds "Last seen" and has no maintenance card, and
  **Open in Intune** goes to the Intune admin centre.
- **System notes quote outside text safely.** A name or sentence that
  comes from outside (a device name, which Intune lets its user set, a
  source's error, a checklist, item or person's name) goes into a
  system-written Markdown note only through `mdInline`
  (`lib/helpdesk/md-inline`): on one line, with what could start a link,
  image, emphasis, code, HTML or directive escaped, and literal autolinks
  ("https://", "www.", addresses) broken with an invisible word joiner.
  Ordinary names read unchanged.
- **Solving with a maintenance record** is a `Modal` (max-w-xl) before
  the solve, never after: "`CircleCheck` Solve #N", the subject, then a
  bordered panel with a native checkbox **Log a maintenance record in
  Snipe-IT** (ticked; one checkbox per asset when several are linked),
  the asset line, Type and Supplier `Select`s side by side (stacked on a
  phone; Supplier starts at "In house") and a Note `Textarea` that starts
  "CompassDocs #N.". A record covers at most ten assets. With more than
  ten linked (a merge moves every link), the first ten (oldest link
  first) start ticked; once ten are ticked the other boxes are
  `aria-disabled` (not `disabled`, so they stay focusable) and don't
  tick, and a visible `text-xs text-slate-500` line "Choose up to 10
  assets." under the boxes is linked from each box with
  `aria-describedby`. The primary reads **Solve and log**, or **Solve**
  once unticked; Cancel keeps the ticket open. The record is posted only
  after the solve committed; a failure is a toast ("Solved, but the
  maintenance record wasn't logged: …") and an internal note, and the
  ticket stays solved. It comes before "Log your time", so cancelling it
  never stops a timer, and it checks checklists first so a blocked solve
  never opens it.
- **Get help's Device picker** is a plain `Select` ("Not about one of my
  devices" first) under the request's questions, shown only when the
  requester has devices assigned to their address, and only when that
  address is confirmed (not typed by them, held by no other account). Requesters never see
  anyone else's assets, and never see links on their requests.

## Helpdesk: share and print a ticket

Sharing a ticket with another agent and printing one (1.19.4, mock-ups
u1 to u5). The client pieces live in `desk/share/ShareActions.tsx`
(`useShareMenu`, `ShareDialog`, `PrintDialog`); the paper in
`desk/share/TicketPrint.tsx`; the rules in `lib/helpdesk/share-shared.ts`.

- **The ticket's … menu opens with this group**: "Share with an agent…"
  (`Forward`), "Copy link" (`Link2`, a toast says it was copied) and
  "Print or save as PDF…" (`Printer`) with a `Kbd` Mod P cap at its right
  (`aria-hidden`; the item carries `aria-keyshortcuts`). A separator, then
  the incident items, Merge and Delete. The menu is `w-64` so the cap fits.
- **Ctrl/Cmd+P on an open ticket opens the print dialog** instead of
  printing the desk as it stands. It goes through `blockModKey` and stands
  aside while any other overlay is open (the browser then prints as usual).
- **The share dialog** is a house `Modal`: `Forward` "Share #1047" and the
  subject; "Share with" is a chip field (accent chips with a 16px round
  `X`, `aria-label` "Remove {name}", `data-tt` "Remove") whose input is a
  `combobox` over a bordered `listbox` (`aria-multiselectable`) of every
  other desk agent: initials, name, their teams and "viewing now" or
  "following". An agent who can't work the ticket stays in the list,
  `aria-disabled`, at 60% with the reason at the right ("Can't see IT
  Service Desk tickets"); never hide them, so nobody wonders where a
  colleague went. Arrows walk the enabled rows, Enter ticks, Backspace on
  an empty input drops the last chip. Under it: Message (optional,
  500 characters, a live count as the field's help), the "Make them follow
  this ticket" checkbox (on) with its hint, one muted sentence on what
  they get, then `CopyButton` "Copy link" at the left and Cancel /
  **Share** (or "Share with 3") at the right.
- **A share leaves one timeline row, not a note card**: `Forward`, "Ana
  shared this with Sam · 2m ago" and a `warn` `sm` chip **Agents only**,
  in a bordered surface row. It is an internal/system message marked
  `hd_messages.event = 'share'` (`isShareLine` reads the marker, never the
  text), so requesters, CCs, the portal and follower notices never see it,
  and a note that merely reads like a share stays a note.
- **The print dialog** lists "Include" as checkboxes with a hint line each:
  The conversation (ticked and disabled: it is always printed), Details,
  Internal notes (off), Checklists and linked assets, Time logged (off),
  Attachment names. "Printing is noted in the audit log." Print opens the
  print page in a new tab (`?include=…&print=1`); the page writes the audit
  row itself as it renders, from the parts it rendered, so the browser never
  reports what was printed.
- **The print page** follows §Print's print-first pattern: the `(print)`
  route group (`/desk/tickets/[number]/print`), a `PageHeader` toolbar
  ("Print preview", back to the ticket, "Print or save as PDF") that is
  never printed, one sheet that borrows the printed handbook's sheet
  styles (light on paper in dark mode too), and `@page` margin boxes for
  the furniture: "Workspace · Team" | "Ticket #1047" on top, "Printed by
  … on …. Internal notes (not) included." | "Page 1 of 2" below, every
  string through `cssString`. On screen the same two lines sit inside
  the sheet, `print:hidden`. Each message is `break-inside: avoid`; an
  internal note, when included, has an amber left rule and "internal
  note" in its meta line. Held newbie replies and Claude drafts are never
  printed. One ticket at a time: there is no bulk print.

## Helpdesk: chat apps (Microsoft Teams and Slack)

Desk settings → Chat apps (1.19.4; mock-ups f1 and f2). The page is
`components/helpdesk/desk/chat/ChatAppsSettings`; the server is
`lib/helpdesk/chat` (the platforms in `teams.ts` and `slack.ts`, what the
apps do in `core.ts`).

- **One card per app**, side by side from `lg` and stacked under it, each a
  `section` with the 36px `bg-compass-50` `MessageCircle` tile (never a
  vendor logo), the app's name as an `h2`, one status line ("Connected ·
  tenant 1a2b3c4d…", "Connected · Acme", "Not connected") and, on the
  right, a Connected `ok` chip or a primary **Connect**. Under it one
  `text-sm text-slate-500` line says who connected it and when, and the
  last Test's answer is a `text-xs` line (`ink-warn` when it failed).
- **Connect and Edit open the card's own form** (a hairline above it), not
  a dialog: the credentials, the address to paste into the bot or app as
  read-only `font-mono` text in a control box with a `CopyButton`, the
  setup steps as a closed native `<details>` (Slack's holds **Copy app
  manifest**, with the address already in it), then **Connect** (or
  **Save**) and a ghost **Cancel**. A saved secret is the Assets recipe:
  dots, `Lock`, and a **Replace** link that turns it into an empty password
  input; a new app ID asks for the secret again. Saving calls nobody;
  **Test** (`PlugZap`, secondary) asks Microsoft or Slack and toasts the
  answer. **Disconnect** is ghost and confirmed with
  `confirmDialog({ danger: true })`.
- **What people can do in <App>** is one `Card` per connected app holding
  four full-width `Toggle`s in a `divide-y` list, the label over its help
  line and the switch at the right edge. "Turn a channel message into a
  ticket" is off by default.
- **Channels that open tickets** is a `padding="none"` `Card` with a house
  `Table` (scrolls sideways on a phone): the channel as `Hash` + name over
  the app in `text-xs`, the team, "Opened by" in `text-slate-600` ("Any
  message that mentions @CompassDocs", "The :ticket: reaction"), and an
  icon-only Remove (`Trash2`, `aria-label` "Remove #name", `data-tt`).
  Nothing listed is a `SectionEmpty`. **Add a channel** opens an inline row
  of fields under the table; a Teams channel offers only "A mention".
  Toggles and channels share the page's one `SaveRow`.
- **In the chat** the app writes plain, short lines in the house voice:
  the suggestion ("That sounds like a **Laptop or device problem** for IT
  Service Desk. These might help first: • …"), the **Raise a request?**
  card (type · team, Device, What's wrong; **Raise request** primary and
  **Edit**), "Done: **#1047**. I'll message you here when IT Service Desk
  replies.", a desk reply as "**Ana Kowalski (IT Service Desk)** replied
  on #1047:" with the text, and the **Approval needed** card (requester
  asks for **type** · #N, the answers as facts, **Approve**, **Decline…**,
  **Ask a question**, **Open**). A decision replaces the card with
  "Approved"/"Declined" and one line. Never an internal note, a held
  reply, an emoji the workspace didn't choose, or a word of an error's
  internals.

## Helpdesk: recycle bin

Deleting tickets (1.19.4, mock-ups v1 to v4). Client pieces in
`desk/recycle-bin/` (`DeleteTicketsDialog`, `RecycleBinView`,
`RecycleBinSplit`, `BinnedTicketPane`, `RecycleBinNav`, `actions.ts`);
rules and copy helpers in `lib/helpdesk/recycle-bin-shared.ts`.

- **Delete is a move, so it says where to.** Every place that deletes a
  ticket says "recycle bin" and "30 days": the … menu's "Delete ticket…",
  the bulk bar's red `Trash2` icon button (`aria-label` "Delete 3 selected
  tickets", `data-tt` "Delete…", after Merge and before Clear), the Roles
  row ("Delete tickets" with a `label` chip **Changed**; "Delete for good"
  with **New**, `HD_CAP_BADGES`). Never "This cannot be undone" on a move.
- **The delete dialog lists before it asks** (one dialog for one ticket or
  up to 200): `Trash2` in red beside the question ("Move #1047 to the
  recycle bin?", "Move 2 of 3 tickets to the recycle bin?"), one lede
  ("They leave every queue, view and report, and their requesters no
  longer see them. Nothing is sent to anyone."), a bordered list of the
  tickets as the server's preview checked them, a ticket that stays shown
  muted with a `warn` chip saying why ("Legal hold, stays"; the full
  sentence as `data-tt` and sr-only text) and, under a request's subject,
  one `text-xs text-slate-500` line about its task tickets ("Its task #1101
  goes with it. Task #1102 stays open: you can't delete HR's tickets."),
  the `Undo2` hint line, then
  Cancel (focused first) and the `danger` primary that counts what goes
  ("Move 2 to the recycle bin"). This is the one reversible action that
  asks first: bulk moves change many queues at once and the list is the
  point. The toast after it still offers **Undo** (§Feedback).
- **The bin is a Views row** (`Trash2`, "Recycle bin", the count) after
  the incidents group, for roles with `tickets.delete` only. Its page
  (`/desk/recycle-bin`) keeps the Views rail and drops the queue's list
  column: `PageHeader` with `Trash2`, a search box and a "Team: all"
  `PickMenu`, then a house table (checkbox, Ticket, Team, Deleted by,
  Deleted, "Deleted for good in" in `ink-warn` at 3 days or fewer, a
  `secondary` `sm` **Restore** per row). Selecting rows puts "{n}
  selected", **Restore** and, with `tickets.purge`, the `danger` "Delete
  for good…" at the toolbar's end. Delete for good is irreversible, so it
  is a `confirmDialog` with `typeToConfirm` DELETE. Under `md` the Team
  and Deleted by columns fold into a line under the subject; under `sm`
  the date does too, so the table never scrolls sideways on a phone.
- **A binned ticket opens read-only under a red banner** (`notice-error`,
  `rounded-xl`, `Trash2`): "**This ticket is in the recycle bin.** Ana
  Kowalski deleted it today at 14:02. It's deleted for good on 6 Dec
  unless it's restored." (`binBannerText`) with a `secondary` **Restore**
  for `tickets.delete` and, for `settings.manage`, a `secondary` **Place
  legal hold** / **Lift legal hold** (`Lock` / `LockOpen`) beside it: a held
  ticket is never deleted for good. The ticket under it is dimmed to 60% and `inert`:
  no composer, status menu, side panel or … menu. From the bin it sits
  beside the bin's own list column (`#1038` · "30 days left", subject,
  "Deleted by … · Today, 14:02"); opened by link from a queue it fills the
  ticket pane. A live ticket that points at a binned one never names it:
  "task of a deleted ticket", "Merged into a deleted ticket". Requesters, CCs, approvers and the portal get the ordinary
  not-found page.

## Helpdesk: API tokens and webhooks

Desk settings → **API and webhooks** (1.19.4; mock-up g1; lucide `Webhook`;
`settings.manage`). Components in `components/helpdesk/desk/settings/
ApiWebhooksSettings.tsx`; the server in `lib/helpdesk/api-tokens`,
`api-v1` and `webhooks`.

- **Two table cards, one page.** Each is a `padding="none"` `Card` whose
  header action is its one primary (**New token**, **New webhook**, with
  `Plus`), a house `Table scroll` (it scrolls sideways inside its card on a
  phone, never the page) and a `text-xs text-slate-500` footer line under
  a hairline that says the rule in one sentence. An empty card is a
  `SectionEmpty` with an inline action, not an `EmptyState`: the page
  always has the other card.
- **A secret is shown once, then only its last four.** A token or a
  signing secret appears in exactly one place: the dialog that made it,
  as the intake `KeyOnce` recipe (a `notice-ok` banner "Copy the token
  now. It won't be shown again.", the value in a mono `code` box with a
  `primary` `CopyButton`, a curl example with **Copy command** for a
  token, the signature rule for a secret). Afterwards a row shows the hint
  only, as a mono `code` chip that never wraps (`cdh_…a91f`). A secret is
  never in a toast, an audit row, a log line, a URL or a later GET. The
  dialog is mounted only while open, so a reload of the page behind it
  can't clear the value before it is copied.
- **Token rows**: name (`font-semibold`) over the hint; **Can**, one line
  built from the role's capabilities joined with " · " ("Read tickets ·
  update status, priority, team and tags · add notes · reply"); **Acts
  as** "Shown-as name (Role, Team, Team)" or "(Manager, every team)";
  **Last used** `RelativeTime` or "Never"; **Expires** a short date,
  "Never", or "Expired" in red ink. One quiet icon action, `Ban`
  **Revoke** (`data-tt` + `aria-label` "Revoke <name>"), confirmed with
  `confirmDialog({ danger: true })`.
- **Webhook rows**: the optional name over the endpoint (mono `code`,
  truncated), the event keys as written (`ticket.created, …`, they are the
  receiver's vocabulary), the teams or "All", and **Last delivery** as a
  `sm` chip: `ok` "200 · 2m ago", `error` "Failing · retrying" (or
  "Failing"), `neutral` "Off" (its `data-tt` says why: "Turned off after
  failing for 24 hours."), `info` "No deliveries yet". Actions: `Pencil`
  Edit and `Send` "Send a test" inline (the test toasts the endpoint's
  answer), then the `MoreHorizontal` menu: Delivery log, Rotate secret…,
  Turn off… / Turn on, a separator, Delete… (`danger`). Rotate, turn off
  and delete ask first.
- **The webhook dialog** is a `Modal` (max-w-xl): Endpoint (`https` only;
  the server's sentence for a private or local address), an optional
  name, the events as checkboxes each with its mono key and a
  `text-xs` hint, the teams as a two-column checkbox grid (only the
  admin's own teams; "Leave all unticked for every team" only for someone
  who works every team, else "choose at least one of yours", as the
  server enforces), and the **Include internal notes** `Toggle`.
- **The delivery log** is a `Modal` (max-w-3xl) with a bordered `Refresh`:
  When (`RelativeTime` of the last attempt), Event (mono, with "#1053" and
  "Test" lines), Outcome chip (**Delivered** `ok`, **Queued** / **Retrying**
  `warn` with "4 attempts" and "next in 40m" lines, **Sending** `info`,
  **Failed** `error`), Code (mono; red ink from 400) and Answer (the
  error sentence, then the first 2 KB of the response folded in a
  `details`). Never the payload. One `text-xs` line under it says what is
  kept.
- **What the API and webhooks write is labelled.** A note or reply made
  with a token carries via `api` ("via API" beside the author, like "via
  Claude"), and a ticket change's timeline line ends "via API". The author
  is the token's "Shown as" name.

## Helpdesk: desk background

The transparent desk with artwork (1.19.4; mock-ups t1 to t5). Components
live in `components/helpdesk/desk/appearance`, the server in
`lib/helpdesk/appearance` (the readability rule in `appearance-contrast`,
the image work in `appearance-upload`).

- **Only the desk.** `DeskLookRoot` is the desk shell's root element
  (`.desk-art`) and every rule in `desk-look.css` hangs off it, so the
  CompassDocs app, the portal and print views never get the artwork. The
  CSS is unlayered (it must beat Tailwind's `@layer utilities`) and each
  selector carries the theme, `.desk-art` and its data attribute so it
  also outranks globals.css's dark-mode ink rules. Colours are
  `rgb(var(--…) / alpha)` as everywhere.
- **Three layers, never more.** A fixed layer behind the whole desk
  holds the picture (`cover`, blurred 8px, bleeding 24px past the edges)
  and over it the **scrim**, `rgb(var(--surface) / S)`, so text that sits
  straight on the artwork (the views column, the ticket pane, a settings
  page) has a calm ground. **Panels** are the existing `.bg-surface`
  elements (top bar, rail, list, cards), painted
  `rgb(var(--surface) / P)`. Only the shell's own panels (the top bar,
  the rail, the queue list, the settings rail) add
  `backdrop-filter: blur() saturate(1.35)`, with an explicit stacking
  order: a backdrop filter makes its element a stacking context, so on a
  card a menu opened inside it would be painted under the next card
  (1.19.4 caught this before release: the user menu under the ticket
  pane). The top bar is z 40, above every layer a page uses (popovers 30,
  the pinned Save row 20) and below modals and toasts (50, rendered
  outside the desk root, which is isolated); the rail, the queue list and
  the settings rail are 1. Cards still read as frosted, since the picture
  under them is already blurred. Floating
  panels (`shadow-float`, menus, listboxes, popover dialogs, the sticky
  Save row) stay solid: they open over text, and inside a frosted panel
  (a backdrop root) their own blur could not reach the text under them. Borders on `border-slate-200` drop to 0.6.
  No component changes its classes for the artwork: a new desk screen
  that uses the house surfaces is frosted for free.
- **Readability is measured, not hoped for.** The levels are the
  approved mock-ups' (Glass: S 0.38, P 0.355, blur 18px; Subtle: S 0.6,
  P 0.6, blur 10px; a panel composes to 0.6 / 0.84 over the base scrim).
  Each artwork is measured once (a 64 × 40 probe, composited in sRGB with
  each mode's surface) for the scrim it needs so the weakest ink keeps
  4.5:1 everywhere on it, and S is the larger of the two. Over the
  artwork the inks are strengthened: light mode secondary text as
  slate-600, accent text as the accent's 800 step, red-800, amber-800,
  emerald-800; dark mode secondary as slate-600, accent ink plus 30%
  white (`color-mix`), red-300. `test/helpdesk-appearance` re-measures the
  built-ins and fails if a ratio drops. When a picture needs well over the
  level's base (0.2 more: a bright picture in dark mode, a dark one in
  light), the Appearance page says so under the mode's select ("In dark
  mode the desk covers Sunrise 78% so text stays readable").
- **The plain desk is the fallback, always.** Solid, None, Reduce
  transparency, Increase contrast, forced colours, a data saver and paper
  all give the desk as it was. The first paint is always plain (the
  server can't know the device); the picture is fetched after hydration,
  at the stored width that fits the screen, and the desk turns
  see-through when it has arrived (a 0.4s fade, none with reduced
  motion). It is a fixed layer, so nothing moves.
- **Off until an admin turns it on.** No artwork, and "Let agents choose
  their own" off: an upgrade adds nothing to the desk or its user menu.
- **Uploads are landscape** (at most 4:1), decoded once into a 2560-wide
  master that every copy and the probe come from, two at a time per
  process (a third answers 503 with `Retry-After`). The probe keeps each
  cell's darkest and brightest pixel of the picture as painted (covering
  2560 × 1440, blurred σ 8), never an average. An agent's own picture is
  served `private, no-cache` with an ETag, so the owner check runs on
  every use.
- **Desk settings → Appearance** (`Sparkle`): a "Background artwork" card
  with the library as a grid of thumbnails (uploads first, then the
  built-ins Aurora, Night ridge, Sunrise; labels "(uploaded)" / "(built
  in)"; the ones in use carry the accent border and ring and a bold
  accent label, with the modes in an `sr-only` phrase), a bordered quiet
  **X** on an upload's corner (`aria-label` and `data-tt` "Remove Name",
  confirmed with `confirmDialog({ danger: true })`), and a **dashed upload
  tile** in the grid's last cell (`Upload` icon over "Upload artwork";
  the file input `sr-only`, `tabIndex={-1}`). The tile is the gallery's
  own upload control; a page with one image and no gallery keeps the
  secondary `ImageUp` button (§Settings pages). Uploads act at once and
  never dirty the page. Under the grid, **Light mode** and **Dark mode**
  `Select`s. Then a "Transparency" card: a `Segmented` (Solid, Subtle,
  Glass, each with a `hint`), the help sentence, a hairline and the
  **Let agents choose their own** `Toggle`. One `SaveRow` "Save" with a
  secondary **Preview** (`Eye`; `aria-pressed`, "Stop preview" with
  `EyeOff`) that shows the unsaved choices on this desk until it is
  turned off, saved or left.
- **My desk background** is a row in the desk's user menu, "Desk
  background…" (`ImageIcon`), marked `data-closes-menu` so the menu
  closes and a `Popover role="dialog"` opens under the avatar
  (`w-[min(21rem,calc(100vw-1.5rem))]`, so a phone keeps no sideways
  scroll; `max-h-[calc(100dvh-4.5rem)]` and scrolling inside itself, since
  the desk shell never scrolls and a short window would cut it off). It holds "Only you see this.", `RadioCards` (Workspace artwork
  with the workspace's line, "Fernwood brand · Night ridge in dark mode";
  My own with the thumbnail, a dashed icon-only upload tile and a quiet
  `Trash2`; None, "Plain desk, no transparency") and a `sm` `Segmented`
  for their level. Choosing My own with nothing uploaded opens the file
  picker. Every change saves at once and repaints the desk without a
  reload. Removing their picture asks in place (a small bordered group
  with **Remove** in `danger` and **Keep it**), because a modal would
  close the popover. The row shows while the workspace lets agents
  choose, or while they still have an upload (then the panel says the
  admin has set the background and offers only **Remove it**).

## Helpdesk: help addresses

1.20.2 (`lib/helpdesk/mailboxes`, Desk settings → Email); send-from
addresses 1.20.5 (`lib/helpdesk/send-addresses`).

- **The Addresses card is a list that acts at once.** A `padding="none"`
  `Card` with a secondary **Add address** in its header `actions` and a
  `ul role="list"` of rows (`flex flex-wrap items-start gap-x-4 gap-y-2
  px-4 py-3`): the address in `text-sm font-medium` (`break-all`, an
  address has no spaces to wrap at), chips beside it (**Default** `info`,
  **Sends from this address** `accent`, both `sm`), a `text-xs
  text-slate-500` facts line ("Acme Billing · Billing · 12 tickets"; the
  team reads "No team (use routing)" when none is mapped; it ends with
  " · Sends from support@acme.com" when replies leave from another
  address, as words and not a chip, because an address in a
  `whitespace-nowrap` chip would push a phone sideways; the line carries
  `[overflow-wrap:anywhere]` for the same reason), and the row's
  actions on the right, which wrap under the text on a phone: a secondary
  `sm` **Send test** with its words, then icon-only Edit and Remove
  (`iconButtonClass("quiet", "sm")`, one-word `data-tt`, the whole
  sentence as `aria-label`: "Remove billing@acme.com"). Add, Edit, Remove
  and Send test save or act at once and toast; the page's `SaveRow`
  belongs to the "Who can write in" switches alone.
- **A provider's refusal is words on the row, never a tooltip.** When the
  mail provider turned an address down as a From, the row carries one
  `ink-warn text-xs` line with the provider's own sentence, when it
  happened and what the desk does meanwhile ("Replies go out from … under
  this name until a test goes through"). Send test answers with a toast:
  `ok` naming the recipient and the From it used, `error` with the
  provider's refusal verbatim.
- **Two lists on one page, the second feeding the first's dialog**
  (1.20.5). **Send-from addresses** is a second card of the same recipe
  directly under **Addresses** (`id="send-from"`, its own secondary **Add
  send-from address**, the same row and the same three actions), not a
  page of its own: an item has two fields, and the help address dialog
  picks from this list, so both must be in view together. Each row's
  facts line says who uses it ("From name: Acme Support · Used by
  help@acme.com and billing@acme.com", or "Not used by a help address"),
  and its refusal is the same `ink-warn` line. The card's footer line
  says where the mail goes through and what must be done at the provider
  first. Two icon-only buttons of the same kind on one page name their
  list in the `aria-label` ("Remove send-from address support@acme.com").
  At the list's limit the Add button is disabled inside `Tooltip` ("Up to
  200 send-from addresses."). Removing one that help addresses use is a
  `confirmDialog({ danger: true })` that names them and says where they
  go back to; one that nothing uses says so.
- **A pick from a list kept on the same page** (1.20.5, "Send replies
  from") is a `Select` in a `Field`: the first option is the default in
  words ("The workspace address (notifications@acme.com)"), then one
  option per item ("support@acme.com (Acme Support)"), then, only while
  it applies, an option that adds the thing being typed ("billing@acme.com
  (adds it to your send-from addresses)"). The help line says what the
  pick changes and what it does not ("Answers always come back to this
  help address…"), names a side effect of the chosen item first when it
  has one ('Replies will be from "Acme Support"…'), and says where to
  add more while the list is empty.
- **The Add and Edit dialog** is a `Modal` with the token dialog's frame:
  Address, From name, Team (a `Select` whose first option is "No team
  (use routing)"), Send replies from (above), then a `Toggle
  size="full"` whose help says what on and off do in full sentences. A
  choice that cannot be changed here
  (the first address is the default; the default cannot be switched off)
  is a disabled `Toggle` whose help says how to change it, never a hidden
  control. Client rules mirror the server's (`mailboxAddressProblem`) and
  show after a submit was tried; a server refusal is the dialog's
  `FormError`.
- **Removing one in use says what moves.** The `confirmDialog({ danger:
  true })` body counts the tickets and names where they go ("3 tickets
  came in on it: they move to help@acme.com"), and the toast afterwards
  repeats the count the server moved.
- **On a ticket** the address shows only while more than one is listed:
  " · to billing@acme.com" at the end of the pane's meta line and of the
  side panel's "Opened through" line, after the requester in a queue row
  (`truncate`, an `aria-hidden` middle dot and an `sr-only` ", to "), and
  **Answer from** as a row of the Properties card: a `PickMenu` whose
  options are the address with its From name as the hint. An address is
  longer than the card's other values, so that row's menu wrapper may
  shrink (`flex min-w-0 flex-1 justify-end [&>div]:min-w-0`) and the
  value truncates with the full address in `data-tt` and `aria-label`.
  Without the capability the value is the same control, disabled and
  without its chevron, as the other properties are. The options are the
  agent's own: the default, addresses with no team and their teams'
  (every address with "See every team's tickets"). The address in use
  is always the value, also when it is not one of them; with no other
  address to choose the control is disabled in the same way.
- **The queue's Filter dialog** offers Address (a `Select` of the listed
  addresses) only while more than one is listed, or when the filter in
  hand already names one.


## Helpdesk: the Integrations hub

1.20.2 (`components/helpdesk/desk/integrations`, `lib/helpdesk/integrations-hub`).

- **A hub is a page of tiles, each opening a page of its own.** When a
  settings area gathers things that are set up one by one and each has
  credentials, a test and a status (asset sources, chat apps, the API),
  they are tiles on one hub page, not rail entries: the rail keeps one
  entry (Integrations), lit on every page under it, and each of those
  pages carries `PageHeader back={{ href: hub, label: "Integrations" }}`.
  A feature with policy controls of its own (Claude in the desk) keeps
  its rail entry and gets a tile as well.
- **Groups** are `section`s under a `SectionHeading` (`h2`): Assets,
  Chat, Claude, Developers, Alerts and monitoring, `gap-8` apart; a group
  with no tile the person may open is not rendered.
- **The grid** is a `ul role="list"` with `grid-cols-1 md:grid-cols-2
  xl:grid-cols-3 gap-4`: one column on a phone, three on a wide desk.
- **A tile** is a `li` in `CARD_CLASS flex flex-col p-5`: the icon tile
  (`h-9 w-9 rounded-lg bg-compass-50 text-compass-700`, a lucide glyph at
  `h-5 w-5`), the name as an `h3` in `text-sm font-semibold`, a category
  line in `text-xs text-slate-500` ("Asset management", "Chat app"), and
  the status chip top right; one sentence of description in `text-sm
  text-slate-600`; an optional fact line in `text-xs text-slate-500`
  ("412 devices"), `ink-warn` when it is the reason for Needs attention;
  and a footer pinned to the bottom (`mt-auto pt-4`) with one `secondary`
  `sm` button, **Open** (or **Set up** while not set up), whose name ends
  in an `sr-only` copy of the tile's name, and a quiet **Docs** link
  (`ExternalLink`, new tab, `sr-only` "for X (opens in a new tab)") only
  where a docs page exists. No tile is primary: a page of tiles has no
  one main action.
- **Status chips** are `sm`: **Connected** `ok`, **Not set up**
  `neutral`, **Needs attention** `warn`. They are computed on the server
  from the same data each page reads, behind that page's own capability:
  a tile the person cannot open is absent from the answer, so the hub
  never tells anyone the state of a page they could not see before. A
  tile for settings with no on or off (Asset settings) has no chip.
- **A page that moved keeps its old address**: the old route stays as a
  server page that, after sign-in and the page's own capability check,
  `redirect()`s to the new place (`MOVED_SETTINGS`); never a
  `next.config` redirect, which would answer before authentication.
- **One-click Microsoft setup** (1.20.4 on the Microsoft Intune page; the
  SSO and directory sync panels before it) is `<MsDeviceSetup>`
  (`components/MsDeviceSetup`), placed above the fields it fills in, which
  stay as the way to do it by hand: a `primary` button with one sentence
  beside it saying what the setup creates and grants; then the code to
  enter at microsoft.com/devicelogin with a pulsing dot and a "cancel"
  link; once the server is doing the work the line reads "Setting it up
  with Microsoft. This can take a minute…" and cancel is gone; and a
  closing notice in its place, `notice-ok`, or `notice-warn` (`doneWarn`)
  when the setup finished with something left for the admin to do. A
  refusal is a red line under the button, which can be pressed again.
  Offer it only while it has something to create: Intune's is hidden once
  an app registration of its own is saved, because a second run would
  leave a second app in Entra.
