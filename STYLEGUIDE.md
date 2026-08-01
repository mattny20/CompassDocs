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

Two tiers:

- **Page-level** (the whole page has no content yet):
  `rounded-xl border border-slate-200 bg-surface px-4 py-10 text-center
  text-sm text-slate-400 shadow-xs` — one sentence, say what will appear
  here and how to create it.
- **Section-level** (a list inside a card is empty): plain
  `text-sm text-slate-400` text, no box-in-box.

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

## Icons

- **lucide-react only** — no emoji in UI or marketing-site icons, no other
  icon sets.
- Sizes: page title `h-6 w-6`, section heading `h-4 w-4`, inline/button
  `h-4 w-4`, chip/tiny `h-3 w-3` or `h-3.5 w-3.5`.

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
