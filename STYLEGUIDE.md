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
24px lucide icon. Standalone surfaces outside the shell (setup, sign-in,
the forced password change, OAuth consent, error pages, the public site)
keep their own titles.

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
  workspace name, so the tab reads "Users & roles — Acme". Admin pages use
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
a top-level page and uses `PageContainer`, however standalone it feels.

## Sections and cards

- Card: `<Card title description actions icon padding>` from
  `components/Card` (`rounded-xl border border-slate-200 bg-surface
  shadow-xs`; `p-5` for forms and settings, `p-4` for dense content,
  `padding="none"` when the children own it — a table — which gives the
  header an inner `border-b border-slate-100 px-4 py-3` row). The bare
  recipe is `CARD_CLASS` for the rare wrapper that cannot be a `Card`.
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
- **Labels** are `text-xs font-medium text-slate-500`, above the control;
  an optional field says so in the label (`(optional)`) rather than with a
  placeholder. Placeholders are examples, never the label: a control with
  no visible label needs `aria-label`.
- Checkbox *lists*, radio groups and composite pickers (EntityPicker,
  SpaceIconPicker) keep their own markup; their text inputs still use the
  recipe.
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

- A choice of two to five options where exactly one is on (theme, page
  width, interface scale, the document width switch) is
  `<Segmented options value onChange label size>` from
  `components/Segmented`: a `radiogroup` with a roving tabindex, arrows
  move the choice, the current option is `bg-compass-50 text-compass-700`.
  `size="sm"` for toolbars. Options may carry an icon and a `hint`
  (tooltip). Never write a second recipe, filled or tinted.

## Account pages

- Account settings sit inside the app shell under `(app)/account`, framed
  like the console: an "Account" eyebrow, the rail (`AccountNav`, rows from
  `components/RailLink`) and `<AccountPage href>` rendering the section's
  icon, label and description from `lib/account-sections.ts` as the page's
  `h1`. The forced password change (`/account/password`) stays standalone.

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
  header bar, the modal scrim) is **hard-coded literal**, never themed.
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
  a live "3 of 89 users" count, Escape clears. Lookups that fetch keep
  "Search …" (EntityPicker, people search, settings search).
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
  container; `<Table sticky>` keeps the header on screen while the page
  scrolls (never both: a sticky header inside a scroll wrapper sticks to
  the wrapper, not the page). `<Th sort={{ key, by, dir, onSort }}>` is a
  real button with `aria-sort` and a lucide icon (never a typed arrow);
  `<Th fit>` / `<Td fit>` shrink a column to its content (dates, counts,
  actions) so the primary column takes the slack; `TR` carries the hover
  band. Row actions: rare destructive actions keep text buttons (Users,
  Trash); dense admin lists use icon buttons with a separator before
  Delete (People admin).

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
- **Route skeletons** (`loading.tsx`) exist for the dashboard, a space, the
  directory and analytics (`components/Skeleton`): the page's shape, inside
  a `PageContainer` so nothing shifts, one `role="status"` with the
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
- Action results use **toasts** (bottom-right, auto-dismiss, ok/error
  styling) — not top-of-page notices that scroll out of view.
- **Reversible actions tell, they don't ask.** Moving to the Trash,
  discarding a branch, archiving: do it and toast with an Undo action
  (`toast("ok", "Moved to the Trash.", { action: { label: "Undo", onClick } })`)
  that reverses through the existing API. Only the genuinely irreversible
  gets a `confirmDialog`, and its body ends "This cannot be undone."
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
  HTML (`lib/newsletter`, `lib/digest`); react-pdf exports (points); and the
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
or the analytics drill-down.

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
a label on paper.

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
  `focus-visible` (the `data-tt` CSS handles this).
- Secondary text must clear WCAG AA on the canvas tint — that's why our
  `--slate-500` is darker than stock Tailwind; don't "fix" it back.
