# CompassDocs UI Style Guide

The canonical patterns for every page and component in the app. When adding
or touching UI, match these exactly — consistency across pages is a feature.
If a new need doesn't fit a pattern here, extend this guide in the same PR.

## Page skeleton

Every top-level page:

```tsx
<PageContainer>                       {/* honors the Normal/Wide/Full account setting */}
  <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900">
    <SomeIcon className="h-6 w-6 text-compass-600" /> Page title
  </h1>
  <p className="mb-6 mt-1 text-sm text-slate-500">One-sentence subtitle.</p>
  …content…
</PageContainer>
```

- **Never hard-code a page width** (`max-w-*` on the page wrapper) — that
  breaks the user's width preference. Narrow *content columns* inside a page
  (e.g. a reading column) are fine when deliberate.
- The one such column is the **document reading measure**: put `doc-read` on
  the element wrapping the rendered document body, and `globals.css` caps the
  direct children of `.doc-read .doc-prose` at `60ch` — see
  [Reading measure](#reading-measure-rendered-documents) for which blocks opt
  out and why the cap is on the children rather than the container. Only the
  document page, the share page and the public document page set `doc-read` —
  `.doc-prose` is shared with the tiptap editor and every other `MarkdownView`
  (editor preview, newsletter, training player, version history, review queue,
  AI answers), and those must stay uncapped, so the cap lives on the scoping
  class, never on `.doc-prose` itself. Everything outside the prose column —
  masthead, right rail, notice strip, sticky bar — keeps the full
  Normal/Wide/Full width.
- **Every page title carries a lucide icon**, `h-6 w-6 text-compass-600`,
  before the text. Pick the icon once and keep it stable (it may also appear
  in navigation).
- Subtitles: `mt-1 text-sm text-slate-500` (plus `mb-6` when the next block
  needs the gap). Card/section sub-descriptions use the smaller tier:
  `mt-0.5 text-xs text-slate-400`.

## Sections and cards

- Section: `rounded-xl border border-slate-200 bg-surface p-4 shadow-xs`
  (tables/lists that manage their own padding drop the `p-4` and use an
  inner `border-b border-slate-100 px-4 py-3` header row).
- Section headings: `text-sm font-semibold text-slate-800`, optionally with
  an `h-4 w-4 text-compass-600` icon.

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

Empty-state text is `text-slate-500`, not `text-slate-400`: `slate-400`
measures 2.56:1 on the canvas and can't carry a sentence. It stays the
**icon/decorative tone** only — don't darken the token itself, that would
collapse it into `slate-500` across the whole app.

## Buttons

- Primary: `bg-compass-600 … text-white hover:bg-compass-700 font-semibold`.
- Secondary: `border border-slate-200 text-slate-600 hover:bg-slate-50
  font-medium`.
- Destructive hover: `hover:bg-red-50 hover:text-red-600`.
- Prefer **icon buttons with tooltips** where the action is obvious from the
  icon (toolbars, table row actions, dense UI); keep icon + text where the
  action is rare or destructive.

## Tooltips

Use the custom tooltip, never the native `title` attribute on interactive
elements (browsers show `title` slowly, unstyled, and never on keyboard
focus):

```tsx
<button data-tt="Download CSV" aria-label="Download CSV" …>
  <Download className="h-4 w-4" />
</button>
```

- `data-tt="Label"` on the element itself; `data-tt-pos="bottom"` when the
  element sits near the top of the viewport.
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
  a settings page header.
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
- **Form controls come from `components/form`**: `<Field label help error>`
  wrapping `<TextInput/>`, `<Select/>`, or `<Textarea/>`; boolean settings
  use `<Toggle label help checked onChange/>`. Don't hand-roll input
  classes — pass per-instance extras (`font-mono`, heights) via
  `className`, and cap a control's width with a wrapper div (the shared
  style is `w-full`). Keep raw-but-`controlClass()`-styled inputs only for
  compact placeholder-only add-forms and table-row controls. Checkbox
  *lists*, radio groups, and composite pickers stay as they are.
- Settings pages honor the account width preference like every other page —
  `SettingsPage` adds **no** width cap of its own. A readable column here
  would silently override Normal/Wide/Full (this shipped once, in 0.85.0);
  the "never hard-code a page width" rule has no settings exception.
- Destructive page-level actions live in a **danger zone** —
  `<DangerZone><DangerAction label description>…</DangerAction></DangerZone>`
  (red-bordered card, one per page, at the bottom). Per-row destructive
  buttons in lists keep their strong `confirm()` instead.

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
  of these is a **deletion**. Same for `bg-white`: use `bg-surface`.
- Anything that must stay dark in both themes (code blocks, the code-block
  header bar, the modal scrim) is **hard-coded literal**, never themed.

## Notices (persistent inline state banners)

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

`rounded-full px-2 py-0.5 text-[11px] font-medium` + a semantic pair:
`bg-emerald-100 text-emerald-700`, `bg-red-100 text-red-700`,
`bg-amber-100 text-amber-700`, `bg-slate-100 text-slate-500`, or accent
`bg-compass-50 text-compass-700`.

## Feedback

- Action results use **toasts** (bottom-right, auto-dismiss, ok/error
  styling) — not top-of-page notices that scroll out of view.
- Errors render in red (`text-red-600`); never show a failure in the
  success style.
- **Never fail silently.** Every `fetch` that can fail needs an `else` —
  `toast("error", …)` with the server's own `error` field when it sends one,
  falling back to a specific sentence ("Couldn't restore that document."),
  never a bare "Action failed." No `alert()` in the app; `confirm()` stays
  for per-row destructive actions (see Settings pages).
- `toast()` only shows where a `<ToastHost />` is mounted. One is in
  `(app)/layout.tsx` and one in `account/(settings)/layout.tsx` — a new shell
  outside those groups must mount its own or its toasts go nowhere.

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
  icon sets.
- Sizes: page title `h-6 w-6`, section heading `h-4 w-4`, inline/button
  `h-4 w-4`, chip/tiny `h-3 w-3` or `h-3.5 w-3.5`.

## Overlays and modals

- Overlays mount as a **direct child of the app shell's root flex div**
  (`(app)/layout.tsx`), not inside the component that owns them. That div
  creates no stacking context, so a `fixed` child is not clamped — which is
  why the notifications dropdown clips today and the palette doesn't. No
  portals exist in this codebase; if a `transform` ever lands on the shell,
  add one rather than escalating z-index.
- Use `useModalOverlay` (`components/overlay`): it registers the layer on
  the LIFO overlay stack, sets `inert` + `aria-hidden` on the background,
  locks scroll, and hands focus back to whatever opened it.
- **Escape belongs to the top-most layer only.** Anything that binds Escape
  globally must check `overlayOpen()` from `lib/overlay-stack` first.
- Every overlay carries `role="dialog"`, `aria-modal="true"`, and an
  accessible name. The scrim's color is hard-coded (never a themed
  variable — the slate ramp inverts and would paint a near-white wash in
  dark mode).

## Keyboard shortcuts

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
are capped at `60ch`**: that's the measure for body text (~75 characters), and
it is deliberately narrower than the page.

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
- A panel carrying long-form prose is a smell. Callouts are one to three
  sentences by convention; if one grows into an essay, the fix is to promote it
  out of the callout, not to re-narrow the panel.

## Print

Pages people print for records (certificates, transcripts, status, the
compliance matrix) hide their controls with `print:hidden` (buttons, search
boxes, filters) and keep tables/breaks clean (`break-inside: avoid` for
cards and images — see the `@media print` block in globals.css).

## Accessibility

- Interactive icon-only elements: `aria-label` always.
- Keyboard: anything hoverable must be reachable and reveal its tooltip on
  `focus-visible` (the `data-tt` CSS handles this).
- Secondary text must clear WCAG AA on the canvas tint — that's why our
  `--slate-500` is darker than stock Tailwind; don't "fix" it back.
