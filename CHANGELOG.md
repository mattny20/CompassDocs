# Changelog

All notable changes to CompassDocs are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project follows
[Semantic Versioning](https://semver.org/).

## [0.45.0] - 2026-07-19

### Added
- **Knowledge-base analytics.** A full analytics dashboard (sidebar →
  **Analytics**, approvers and admins) showing how the knowledge base is
  actually read, searched, and used:
  - **KPI strip** with period-over-period deltas: total views, unique
    viewers, average time on document, documents viewed, searches, searches
    with no results, downloads, and public-site views (internal vs external
    share).
  - **Views over time** chart (all views, public-site views, and daily
    active users) with hover details.
  - **Trending documents** (biggest gains vs the previous period), **most
    viewed** (views, uniques, avg time, downloads), and **least viewed**
    published documents — the ones to refresh, promote, or retire.
  - **Search analytics**: top searches (including Ask AI questions) and
    **searches that found nothing** — your content gaps, each linked so you
    can run it yourself.
  - **User engagement** (most active readers with time spent) and **author
    analytics** (docs, reach, views per doc).
  - **Recent activity** feed of views, searches, and downloads.
  - **Filters** for date range (7d/30d/90d/1y), space, category, author, and
    tag — and **click any document for a drill-down** (daily chart, totals,
    top readers).
- **The data behind it**: privacy-conscious view tracking on document pages
  (time-on-page via visibility-aware heartbeats, capped at 30 minutes;
  anonymous tracking only on the public site), search capture across app
  search, Ask AI, and public search (typing bursts collapsed), and download
  counting for real file attachments (inline images excluded). Analytics
  never blocks or slows reading — every write is fire-and-forget.

## [0.44.0] - 2026-07-19

### Added
- **SCIM provisioning** *(enterprise)*. CompassDocs is now a SCIM 2.0 service
  provider, so Microsoft Entra ID (or any SCIM client) can manage the user
  lifecycle automatically — new hires appear, name/email changes flow through,
  and departed employees are deactivated without anyone touching Settings:
  - Endpoints under `/api/scim/v2` (ServiceProviderConfig, ResourceTypes,
    Users with `eq` filtering and pagination, and Entra-compatible PATCH —
    including string booleans and both path/no-path operation forms).
  - **Setup in Settings → Single sign-on**: copy the tenant URL, generate the
    secret bearer token (shown once, stored only as a SHA-256 hash, rotatable),
    and toggle the endpoint on/off. The card shows when Entra last called.
  - Provisioned users arrive as **Viewers** who sign in via SSO — the SSO
    login links them by externalId first, then by email. **Deactivation is
    immediate** (live sessions are revoked) and **deletes are soft**: accounts
    are disabled, never destroyed, so authorship and audit history survive.
  - Every provisioning action lands in the audit log (`scim.user_create`,
    `scim.user_update`, `scim.user_disable`, `scim.user_enable`, plus token
    generation and enable/disable).
  - Group provisioning intentionally stays with Entra group sync (richer
    membership data); the SCIM `/Groups` surface answers politely.
  - Requires an enterprise license with the `scim` entitlement — existing
    enterprise licenses already include it.

## [0.43.1] - 2026-07-19

### Changed
- **One-click block buttons.** The "+ Block" dropdowns are gone: both the
  rich-text toolbar and the Markdown tab now have a row of icon buttons
  (callout, tabs, accordion, checklist, Mermaid, PlantUML, decision guide,
  video, website embed — plus table in Markdown mode), each with a tooltip.
- **Icons instead of emoji.** Callout headers (note/info/tip/warning/danger)
  now use crisp line icons matching the rest of the UI, in both the reader
  view and the editor; the video and embed fallback notices follow suit.

## [0.43.0] - 2026-07-19

### Added
- **Rich blocks are now first-class in the rich-text editor.** The blocks
  introduced in 0.42 no longer appear as raw directive text in WYSIWYG mode:
  - **Callouts** edit as live colored boxes — pick the kind (note/info/tip/
    warning/danger) from a dropdown, type the title inline, write rich
    content inside.
  - **Accordions** edit as titled sections with an inline title field.
  - **Tab groups** edit as stacked, titled panels (each panel fully
    editable); readers still get real tabs.
  - **Mermaid, PlantUML, and decision fences get a live preview** rendered
    right under the code while you type (debounced).
  - **Checklists are native task lists** — click to tick, `- [ ]` GFM under
    the hood, nestable.
  - **Video and website embeds** appear as preview cards with change-URL and
    remove controls.
  - A **“+ Block” menu** in the toolbar inserts any of them (callout, tabs,
    accordion, checklist, diagrams, decision guide, video, embed).
  - Everything still round-trips through the exact same Markdown directives —
    switch freely between Rich text and Markdown modes; storage, diffs,
    export, and the public site are unchanged.

## [0.42.0] - 2026-07-19

### Added
- **Rich document blocks.** Ten new building blocks for documents, all
  authored in plain Markdown (with an **Insert block** menu in the editor's
  Markdown tab) and rendered everywhere documents appear — including the
  public site and the editor's Preview:
  - **Mermaid diagrams** — ` ```mermaid ` fences render flowcharts, sequence
    diagrams, Gantt charts, and more, right in the page (rendered locally in
    the browser, light- and dark-theme aware).
  - **PlantUML diagrams** — ` ```plantuml ` fences render via a PlantUML
    server (plantuml.com by default; point `COMPASSDOCS_PLANTUML_SERVER` at a
    self-hosted server to keep diagram text in-network, or set it to `off`).
    Results are cached; dark mode gets a matching theme.
  - **Callout blocks** — `:::note`, `:::tip`, `:::info`, `:::warning`,
    `:::danger`, each with an optional custom title.
  - **Tabs** — `::::tabs` with `:::tab[Title]` panels, for
    per-platform instructions and side-by-side variants.
  - **Accordions** — `:::details[Section title]` collapsible sections.
  - **Embedded videos** — `::video{src="…"}` for YouTube (privacy-enhanced
    no-cookie player), Vimeo, Loom, uploaded video attachments, and direct
    video files, with an optional caption.
  - **Website embeds** — `::embed{src="https://…" height="500"}` shows a live
    page in a sandboxed frame (dashboards, status pages, forms).
  - **Interactive checklists** — GFM task lists (`- [ ]`) are now clickable
    for every reader; progress is saved per document on their device and
    never modifies the document itself.
  - **Decision trees** — ` ```decision ` fences define a question-and-answer
    flow (`id: question` + `- Answer -> target` lines) that readers walk
    through one step at a time, with a breadcrumb of choices, back/start-over
    controls, and a highlighted recommendation at the end.
  - **Tables with filtering** — every Markdown table with 4+ rows gets a
    filter box and click-to-sort headers (numeric-aware), automatically.

## [0.41.0] - 2026-07-19

### Security
- **Credentials are now encrypted at rest.** The SMTP password, Anthropic API
  key, SSO client secret, backup credentials (S3 secret key / Azure connection
  string), and custom TLS private key are sealed with AES-256-GCM under a
  master key that never touches the database. The key comes from the
  `COMPASSDOCS_SECRET_KEY` environment variable (32 bytes as 64 hex or 44
  base64 characters — recommended), or is auto-generated on first boot into a
  `0600` key file inside the uploads volume (`COMPASSDOCS_KEY_FILE` overrides
  the location). Existing plaintext values are migrated in place on upgrade;
  no re-entry needed. **Keep a copy of the key (or key file) somewhere safe
  that is not your backup bucket** — it's required to restore encrypted
  backups on a new host.
- **Session tokens are stored hashed.** The sessions table now holds the
  SHA-256 of each cookie token instead of the token itself, so a leaked
  database can't be replayed as a login. Existing sessions are migrated in
  place — nobody gets signed out by the upgrade.
- **Backups are encrypted.** New backups are written (and mirrored off-site)
  as `.dump.enc` files — AES-256-GCM under the same master key — and the
  plaintext dump never rests on disk. Restore transparently handles both
  encrypted and older plaintext backups.
- **Login throttling.** Five failed attempts for the same account+IP within
  15 minutes locks that pair out for 15 minutes (HTTP 429 with `Retry-After`);
  30 failures from one IP across any accounts locks the IP. Wrong two-factor
  codes count too, and each lockout is recorded in the audit log
  (`auth.lockout`). Successful logins clear the counter.
- **Security headers on every response**: `Strict-Transport-Security`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy`, a restrictive
  `Permissions-Policy`, and an anti-clickjacking Content-Security-Policy
  (`frame-ancestors 'self'`). The Outlook task pane keeps a carve-out so it
  stays embeddable by Outlook's own origins — the add-in is unaffected.

## [0.40.0] - 2026-07-19

### Added
- **Enterprise-grade versioning.** The version history page is now a full
  revision explorer:
  - **Compare any two versions** — pick A and B from the timeline and see a
    **side-by-side or inline diff** with line numbers, added/removed counts,
    word-level change highlighting inside modified lines, and long unchanged
    runs folded behind a "show" control. Title changes are diffed too.
  - **Restore a previous version.** One click makes an older version the
    current one — as a *new* version on top of the history (nothing is ever
    rewritten), stamped with who restored it and which version it came from
    (a "Restored" badge in the timeline). Restores respect the approval
    workflow: on a published document, editors in strict mode submit the
    restore to the review queue instead of applying it directly.
  - **Change notes.** The editor has a "Change note" field, so every save can
    say *why* it happened; notes appear in the version timeline and survive
    the review queue (approved changes keep the submitter's note and record
    the approver). Every version already records who made it and when.
- **Draft branches.** Editors can branch any document into a private working
  copy (branch button on the document page, or from Version history). The
  branch is invisible in spaces, search, dashboards, and Ask AI, can never be
  published directly, and carries a banner linking back to the original with
  **Merge into original** (with an optional change note) and **Discard**
  actions. Merging follows the approval workflow — approvers/admins merge
  instantly (the branch then moves to the Trash), while editors in strict
  mode submit the merge for review and keep the branch until it's approved.
  A live-branch notice on the source document links to its branches.
- **Audit events** for the new flows: `document.restore_version`,
  `document.branch_create`, and `document.branch_merge` (with actor, target,
  and IP, like every other audit entry).

## [0.39.0] - 2026-07-19

### Added
- **Outlook add-in.** CompassDocs in the Outlook ribbon (Windows, Mac, and
  web; Microsoft 365 / Outlook 2016+): a task pane with keyword search, Ask
  AI with cited sources, and recent documents — and while composing email,
  **Insert link** on any result plus **Insert answer into email** under AI
  answers, dropped at the cursor with a sources footer. The pane is served
  by your own workspace (same origin, same session, same permissions) and
  signs in through an Office dialog that supports both passwords and SSO.
  Admins download a manifest generated for their workspace's address
  (Settings → Workspace → Outlook add-in) and deploy it via the Microsoft
  365 admin center's Integrated apps — re-downloading later updates the
  add-in in place. See the docs guide: Guides → Outlook add-in.

## [0.38.0] - 2026-07-18

### Added
- **Comments on documents.** Every document now has a discussion thread:
  any signed-in user who can see a document can comment on it. Threads
  follow the document's access rules (private-space documents keep their
  comments private), and comment activity is recorded in the audit log.
- **@Mentions with notifications.** Type `@` in the composer to mention a
  teammate (autocomplete from active users). Mentioned users are notified
  two ways: an **email** containing the comment and a link to the document
  (respects each user's notification-email switch), and a **dashboard
  notice** visible only to them with a "View document" button (dismissible,
  auto-expires after 14 days). Self-mentions don't notify.
- **Workplace-safety controls** (Settings → Workspace → Comments):
  - a workspace-wide **on/off switch** — turning comments off hides all
    threads immediately without deleting anything;
  - a **restricted-words list** (case-insensitive; single words match on
    word boundaries, phrases as substrings) — comments containing a listed
    term are rejected with a clear message;
  - **admin moderation**: admins can remove any comment (authors can remove
    their own). Removed comments keep their slot with a "removed" placeholder,
    and the removed text is never sent to clients again.

## [0.37.0] - 2026-07-17

### Added
- **Favicon link chips.** External links in rendered documents and
  newsletters display as a soft chip with the target site's **favicon**
  beside the link text. Icons are fetched once server-side through a cached,
  signed-in-only proxy (public-looking https hosts only — IP literals and
  internal names are refused), so readers never touch the external site just
  by viewing a page. Internal links stay plain; in the editor, external
  links show a chip with an ↗ marker.
- **Header image top padding.** An optional 5 / 10 / 15 px gap above the
  newsletter banner (Settings → Newsletter), reflected in the mini-preview.

### Fixed
- **Color panel automatic text color now survives email delivery.** The
  panel's ink was set on the wrapper div only, which many mail clients
  (Outlook in particular) don't inherit into paragraphs — so white-on-navy
  in the editor arrived black-on-navy in the inbox. The renderer now stamps
  the panel's text color explicitly on every text element inside the panel
  (paragraphs, headings, lists, cells), while highlighted headings keep
  their own dark ink and explicit colors still win.

## [0.36.0] - 2026-07-17

### Added
- **More newsletter appearance controls** (Settings → Newsletter). A
  **header background color** (behind the banner, or behind the default bar
  — the workspace name's ink flips automatically to stay readable); a
  **header image scale** slider (20–100%, centered) so a masthead doesn't
  have to span the full column; and an **outer background** for the area
  around the content card — any color plus an optional subtle tiled
  **texture** (dots, grid, or stripes; served from the app so they render
  in inboxes). A live mini-preview on the settings page shows the combined
  result.

### Changed
- **The editor toolbar is now sticky.** Editing long documents or
  newsletters no longer means scrolling back to the top for formatting —
  the toolbar pins to the top of the window while the content scrolls, in
  both the document and newsletter editors.

## [0.35.0] - 2026-07-17

### Added
- **Newsletter email appearance** (Settings → Newsletter). Admins set the
  email's **content width** (480–900 px, default 640) and can upload a
  **custom header banner** — a masthead image that replaces the default
  logo + workspace-name bar at the top of every newsletter. Remove it to
  return to the default. Applies to test, manual, and scheduled sends.
- **Archive newsletters to a space.** Pick an archive space in the draft
  window and every send files a published copy as a document in that space
  (titled with the subject, tagged `newsletter`) — past issues become
  searchable in the knowledge base. Works for scheduled sends too, and the
  activity thread records the archived document.

### Fixed
- **Image size slider survives dragging.** Grabbing the slider no longer
  makes it vanish after the first pixel (the first change used to steal
  focus and drop the image selection, so the click position became the
  size). The drag now previews live, the image follows to the release
  point, and the controls stay put for repeat adjustments.

## [0.34.0] - 2026-07-17

### Added
- **Tables in the editor.** Insert a 3×3 table (with header row) from the
  toolbar; inside a table, extra controls add/delete rows and columns or
  remove the table. Simple tables store as portable GFM pipe Markdown; the
  new **transparent table** toggle strips all borders and shading — an
  invisible layout grid for side-by-side content (shown as dashed guides
  while editing, invisible to readers and in email).
- **Heading highlights.** With the cursor in an H1–H3, pick a pastel
  background from the toolbar palette. Highlighted headings render as a
  colored pill with automatically dark text — in documents, on the public
  site, and in newsletter emails.
- **Color panels.** A colored container block (the free-form sibling of the
  code and email blocks): wrap any content — text, images, lists, buttons —
  on one of nine backgrounds. The text color **auto-contrasts** with the
  chosen background (white on deep colors, ink on pastels), with an explicit
  Dark/White override.
- **Font choices.** A small set of email-safe fonts — Default, Serif
  (Georgia), Typewriter (Courier), Rounded (Trebuchet) — applied per
  selection, rendering identically in the app and in inboxes.
- **Side-by-side photos.** Images are now inline: size two photos to ~45%
  each and they sit next to each other in one paragraph — in the editor, on
  document pages, and in newsletter emails (the width token becomes a real
  width in email HTML). For finer control, use a transparent table.
- **Image size slider.** The S/M/L/Full presets became a 10–100% slider
  (5% steps) with a live percentage readout.
- **Newsletter email attachments.** Attach up to 5 files (5 MB each) to a
  newsletter; they're sent WITH the email as real MIME attachments — on test
  sends, manual sends, and scheduled sends. Managed on the newsletter page
  by anyone who can edit it; blobs are cleaned up on delete.

## [0.33.0] - 2026-07-16

### Added
- **Richer editing toolbar** (documents and newsletters). New tools:
  **underline**, **text alignment** (left / center / right per paragraph or
  heading), **indent / outdent** (nests list items when inside a list),
  **clear formatting**, a **format painter** (copy formatting from one spot,
  apply it to the next selection), and a one-click **divider**. Every toolbar
  button now shows a proper tooltip. Formatting Markdown can't express is
  stored as small sanitized HTML islands inside the Markdown — it round-trips
  through the raw Markdown view, renders on document pages, the public site,
  and in newsletter emails, and is scrubbed against an allowlist (tags,
  attributes, and CSS properties) everywhere it's rendered.
- **Newsletter content blocks.** The newsletter composer gains
  email-specific blocks: **images** (upload, paste, or drag in — hosted at
  unguessable public URLs so they display in recipients' inboxes),
  **call-to-action buttons** (accent-colored, editable label + URL),
  **dividers**, and **spacers** (three sizes, shown as a striped bar while
  editing, pure whitespace in the email).
- **Scheduled sends.** Approved newsletters can be scheduled for a date and
  time; the app delivers within a minute of the chosen moment (works across
  restarts and multiple instances — the claim is atomic, so no double
  sends). Scheduling and cancelling land in the activity thread and the
  audit log, and the list shows when each approved piece will go out.
- **Newsletters on the dashboard.** A sent newsletter appears as a card on
  every user's dashboard for three days (counted in the sidebar's unread
  badge) until that user dismisses it. Sent newsletters are now readable by
  every signed-in user; the editorial thread stays with the newsletter crew.
- **Choose the From address.** Admins curate a sender list under Settings →
  Newsletter (`Name <address@domain>` entries); each newsletter can pick one
  of them — for test sends, manual sends, and scheduled sends alike — or
  keep the workspace SMTP default.

## [0.32.0] - 2026-07-16

### Added
- **Newsletter editorial workflow.** Newsletters moved out of the admin
  console into a dedicated **Newsletter workspace** (sidebar → Newsletter)
  with a draft → review → approve → send lifecycle. Access is a per-user
  capability — **Contributor** (write drafts and submit for review) or
  **Approver** (also review, comment, edit directly, approve, and send) —
  granted under Settings → Newsletter, with admins always having full
  access. Each newsletter can optionally be restricted to specific
  approvers; leaving the list empty lets any approver act. Approvers can
  add comments and suggestions to an activity thread, edit the content
  directly, send a piece back to the author with required notes, or
  approve it for sending; approved content locks for the author. Review
  requests and decisions are emailed to the people concerned (best-effort,
  when SMTP is configured), the full editorial trail lives in the piece's
  activity thread, and submissions, decisions, sends, and deletions are
  audited.

### Changed
- **Settings → Newsletter** is now the access roster (who can contribute
  or approve) instead of the composer; writing and sending happen in the
  Newsletter workspace. Existing sent newsletters appear in the
  workspace's history unchanged.

## [0.31.0] - 2026-07-16

### Added
- **Directory attributes as fields or tags.** Every custom directory
  attribute now has a display type: **Field** (label + text value — office
  location, employee ID, extension) or **Tags** — comma-separated values
  rendered as badge chips, ideal for skills, certifications, or
  technologies. Pick the type when creating an attribute (Settings →
  Directory) or flip it anytime; tags render on directory cards, in list
  columns, and on profile pages, in light and dark themes.

## [0.30.0] - 2026-07-16

### Added
- **Email template blocks.** Documents can now hold copy-paste email
  templates in a dedicated block — the email sibling of the code block.
  Write an ` ```email ` fence (or click the new **✉ Email template** button
  in the rich editor, which inserts a starter with a distinct in-editor
  look), and readers see a letter-style card: leading `Subject:` / `To:` /
  `Cc:` / `Bcc:` lines become styled envelope fields, the body renders in a
  normal reading font, and **Copy subject / Copy body / Copy all** buttons
  make pasting into a mail client one click per part. Works on the public
  site and in dark mode.

## [0.29.0] - 2026-07-16

### Added
- **Categories within spaces.** Admins can define ordered categories per
  space (Settings → Spaces → Edit → Categories); writers pick one in the
  document editor, and the space page renders documents grouped into
  sections with uncategorized docs under "General". Deleting a category
  keeps its documents; moving a document to another space clears its
  category (or keeps it when the target has the same category id).
- **In-space search.** Every space page gets a search box scoped to that
  space — debounced, keyword-highlighted results that respect visibility
  and draft rules, replacing the document grid while a query is active.
- **App-wide page width as an account preference.** The Normal / Wide /
  Full choice from document pages now applies to the whole app (dashboard,
  spaces, search, directory, links, settings) and is stored on your account
  — set it under Manage account → Preferences or with the toggle on any
  document. **Wide is the default** for new and existing users.

### Changed
- **Icon action buttons on documents.** Print/PDF, History, Edit, and
  Delete are now clean icon buttons (printer, clock, pencil, trash) with
  tooltips and accessible labels.
- Every screen now shares the same page container — consistent width,
  padding, and spacing across the app and settings pages.

## [0.28.0] - 2026-07-16

### Added
- **Unread-announcements badge.** The sidebar's Dashboard entry now shows a
  count of active announcements you haven't dismissed yet (a dot when the
  sidebar is collapsed), clearing as you dismiss them.

### Fixed
- **Announcements are now legible in dark mode.** Info blocks rendered
  dark-on-dark titles and the warning/critical blocks stayed bright; all
  three severities (dashboard block, read-confirmation banner, and the
  admin screen's chips) now have proper dark-theme colors.
- The theme toggle's emoji (☀️/🌙/🖥️) are replaced with the app's icon set
  (Sun / Moon / Monitor).

## [0.27.0] - 2026-07-16

### Added
- **Organization newsletter.** Compose a rich email under **Settings →
  Newsletter** using the **same editor as documents** (headings, lists,
  links, quotes, code, tables) and send it through your SMTP settings as a
  **branded HTML email** — your logo and accent color in the header, the
  subject as the title, a plain-text fallback, and a "Sent by …" footer.
  **Send test to me** delivers a preview to your own inbox without recording
  anything; real sends go to **everyone** or to **selected groups**
  (individual messages, deduplicated, 1000-recipient cap), are listed in a
  send history with recipient counts, and land in the audit log. Relative
  links in the content are rewritten to absolute so they work from inboxes.

## [0.26.0] - 2026-07-16

### Added
- **Organization announcements.** Admins can post messages that appear in a
  colored block at the top of **every user's dashboard** (Settings →
  Announcements): a title, a message, an Info / Warning / Critical severity,
  and an optional auto-hide after 1–30 days. Users can dismiss a message for
  themselves; admins can archive (and restore) it for everyone — personal
  dismissals survive. Optionally, a post is **also delivered** through the
  channels you already configured: **email via SMTP** to everyone or to
  selected groups (targeting affects the email only — the dashboard block
  always shows for all users), and **chat webhooks** via a new
  `announcement.posted` event (Webex, Teams, Slack, generic, email
  channels). Posts, archives, deletes, and email counts are audit-logged.

## [0.25.0] - 2026-07-16

### Changed
- **One "Manage account" page.** The personal settings that were spread over
  four little pages — notification preferences, security & MFA (two-factor
  auth and active sessions), password change, and API tokens / connected
  apps — now live together on a single account page with a profile header
  and quick section shortcuts. Click **Manage account** (or your name) at
  the bottom of the sidebar. Old `/account/*` URLs redirect to the right
  section, and the focused set-a-new-password page still appears when a
  password change is required at sign-in.

## [0.24.0] - 2026-07-16

### Added
- **Easier workspace logos.** Settings → Workspace now offers two new ways to
  set your logo alongside the existing image-URL field: **fetch your
  website's icon** (type `yourcompany.com` and CompassDocs grabs and caches
  the site's favicon), or **upload an image** (PNG/JPEG/GIF/WebP/ICO up to
  1 MB — no SVG, same script-safety policy as attachments). Fetched and
  uploaded logos are stored in the uploads volume (so they're in your
  backups and survive site redesigns), served from a public route so the
  login page and public site show them pre-auth, and a **Remove logo**
  button returns to the compass mark. Changes are audit-logged.

## [0.23.0] - 2026-07-16

### Added
- **Per-space edit rights.** Admins can now restrict who may *author* in a
  space — create, edit, move, or trash documents and manage attachments —
  independently of who can read it. Each space's **"Who can edit"** setting
  (Settings → Spaces) offers **All editors** (default) or **only selected
  people and/or groups** (manual or Entra-synced). An org-wide switch,
  **"All editors can edit all spaces"** (on by default, so nothing changes on
  upgrade), ignores all per-space lists when enabled. Only admins can change
  grants or the switch; admins always retain edit access; approvers still
  review queued changes; anyone with view access can still read and suggest.
  Enforced server-side everywhere — pages, APIs, and the Claude connector —
  and the UI follows: the Edit button disappears and restricted spaces drop
  out of the new-document and move-to-space pickers.

### Fixed
- Deleting an attachment now requires edit access to the document's space
  (previously any editor could delete any attachment by id).
- Restoring a document from the Trash now requires edit access to the space
  it returns to.
- Settings → License now labels the support entitlement "Dedicated support
  (48-hour response)" to match the current plans.

## [0.22.0] - 2026-07-16

### Added
- **Quick links launchpad.** A new **Links** page in the sidebar gives every
  signed-in user shortcuts to the external tools your org uses (HR portal,
  status pages, ticketing…). Admins curate it under **Settings → Links**:
  - **Categories** to organize links into sections, with reordering; deleting
    a category moves its links back to "General".
  - **Group-based visibility** per link — show a link to everyone, or only to
    members of selected groups (manual or Entra-synced). Enforced
    server-side, including the icon.
  - **Icons three ways**: the site's favicon fetched and cached
    automatically when you save (with a re-fetch button), your workspace
    brand logo, or a custom uploaded image (PNG/JPEG/GIF/WebP/ICO, 1 MB max —
    no SVG, same script-safety policy as attachments). Links without a usable
    icon get a letter tile in your accent color.
  - Everything is audit-logged (`link.created` / `link.updated` /
    `link.deleted`, category events, icon uploads).

## [0.21.1] - 2026-07-16

### Fixed
- **Settings → License now lists the Policy acknowledgements entitlement.**
  0.21.0 shipped the feature but forgot to add it to the entitlement list in
  the admin license console, so admins couldn't see whether their license
  granted `policy_ack` (it showed no row at all). The row now appears with
  the usual Enabled / Not licensed / Not in build status.

## [0.21.0] - 2026-07-16

### Added
- **Policy acknowledgements** *(enterprise — new `policy_ack` entitlement)*.
  Approvers and admins can require read confirmation on any published
  document. Readers see an **"I've read and understood this"** banner (and a
  dashboard reminder listing everything awaiting them); each confirmation is
  recorded with person, timestamp, and IP in an append-only ledger and the
  audit log. **Editing the document resets everyone to pending** — a revised
  policy must be re-confirmed. A per-document compliance page shows live
  progress and who's outstanding (scoped to the people who can actually see
  the document, so private spaces count only granted groups), with CSV
  export for auditors. Community/unlicensed installs show none of this and
  the APIs return 402.

## [0.20.0] - 2026-07-16

### Added
- **Space subscriptions with email alerts.** Every space page gains a
  **Subscribe** button — subscribers get a short email whenever a document
  in that space is published or updated (including changes landing through
  the review queue and via the Claude connector). Emails go only to people
  who can actually see the space, never to the person who made the change,
  and use the workspace SMTP settings.
- **Admin-assigned group subscriptions.** In Settings → Spaces, subscribe a
  whole group to a space — every member is subscribed automatically as
  membership changes (works with Entra-synced groups). Individuals can mute
  a group-assigned subscription without leaving the group.
- **Account → Notifications**: a personal page listing every subscription
  (with mute/unsubscribe controls and "via group" indicators) plus a master
  "email me" switch.
- **Account ↔ directory linking.** Accounts link to their people-directory
  entry — automatically by SSO identity or email (an **Auto-link directory**
  button in Users & roles; enterprise directory syncs also link on the fly),
  with the link surviving syncs. Article bylines and profile "documents by"
  lists now resolve through the link, so a renamed directory entry no longer
  breaks them.

## [0.19.1] - 2026-07-15

### Added
- The author byline on a document page links to the author's
  [directory profile](https://docs.compassdocs.io/guides/directory/) when
  their name matches a directory entry (hover shows their title). Authors
  without a directory entry stay plain text.

## [0.19.0] - 2026-07-15

### Added
- **The people directory joins the Ask feature.** Questions like "who is the
  head of IT?" or "who handles payroll?" now surface matching people —
  name, title, department, and contact details — alongside document answers.
  With an AI key configured the model cites directory facts as [Directory];
  in keyword mode the people appear as cards. Matches link to their profile.
- **Person profile pages.** Every directory entry gets a profile at
  `/directory/{id}` — photo, title, department, contact links, office,
  assistant, and custom fields — plus **Documents by {name}**: everything
  they've authored, filtered to the spaces *you* can see. Names throughout
  the directory (table, cards, and department views) now link to profiles.

## [0.18.0] - 2026-07-15

### Added
- **Workspace accent color.** Settings → Workspace → Branding gains an accent
  picker (nine presets plus any custom hex). One color re-tints the entire
  product — buttons, links, focus rings, highlights, and tinted surfaces, in
  light and dark themes, on the login page, and on the public site. The full
  color ramp is derived automatically from your single brand color.
- **A real icon picker for spaces.** The 12-emoji row becomes a searchable,
  categorized catalog of ~90 icons (General & docs, Tech & engineering,
  Business & sales, People & culture, Security & operations, Places & misc) —
  type "security" or "training" to find the right one. Any emoji can still be
  typed or pasted by hand.
- **"Ask CompassDocs" now carries your name**: the sidebar entry, the Ask
  page heading, and the dashboard link all say "Ask {your workspace name}"
  (from Settings → Workspace).

## [0.17.1] - 2026-07-15

### Fixed
- **Moving a document between spaces now works.** Changing the Space in the
  editor and saving was silently ignored — the update API never read the new
  space. Moves now apply immediately for approvers/admins (and in open
  approval mode); an editor's move of a published doc in strict mode rides
  along with their change request, applies on approval, and the review queue
  shows a "→ moves to …" badge so approvers see it. The target space must be
  one the editor can see, and moving a doc out of a Public space immediately
  removes it from the public site.

## [0.17.0] - 2026-07-15

### Added
- **Print / Save as PDF.** Every document page — in the app and on the public
  site — gains a **Print / PDF** button that opens the browser's print
  dialog, where "Save as PDF" is built in on every platform. Print
  stylesheets strip the app chrome (sidebar, buttons, breadcrumbs,
  suggestion box) so the output is a clean document: badges, title, byline,
  and content, with images and code blocks kept whole across page breaks.

## [0.16.0] - 2026-07-15

### Added
- **Image sizing.** Select an image in the rich-text editor and pick
  S / M / L / Full from the toolbar (25/50/75/100% of the text column). The
  size travels as a `"w=NN%"` title in standard markdown —
  `![shot](url "w=50%")` — so it renders consistently in the editor, the
  preview, the document page, and the public site, and can be typed by hand
  in the Markdown tab.
- **Click to zoom.** Images on document pages (app and public site) open in a
  full-screen lightbox on click; Esc or another click closes it.
- **Adjustable page width.** Document pages and the editor gain a
  Normal / Wide / Full width toggle (top right). The choice is per-person,
  remembered in the browser, and shared between reading and editing.
- **Alt text for images.** Select an image and click **Alt** in the toolbar
  to describe it for screen readers (and for when the image can't load). The
  description is stored as the markdown alt — `![description](url)` — and can
  also be edited directly in the Markdown tab.
- The rich-text editor toolbar now uses the app's icon set instead of
  emoji/ASCII labels.

### Changed
- **Copy link** on an attachment now copies a plain URL instead of a
  markdown snippet — embedding an image in the doc is done by pasting it
  straight into the editor.

## [0.15.0] - 2026-07-15

### Added
- **Inline images in documents.** Paste a screenshot (or drag one in, or use
  the new 🖼️ toolbar button) in either editor mode and it lands right at the
  cursor — write a step, paste the screenshot, write the next step. The image
  uploads as a document attachment behind the scenes (stored as standard
  markdown `![alt](/api/attachments/…)`), renders in the rich editor, the
  preview, the document page, and the anonymous public site, and respects the
  existing attachment size limit. Starting a brand-new document? The first
  pasted image quietly saves a draft so it has a document to attach to — you
  keep editing and save as usual.

### Fixed
- The attachment **upload** endpoint now enforces space access like every
  other document route — an editor can no longer upload files to a document
  in a private space they can't see.

## [0.14.0] - 2026-07-15

### Added
- **Public site — share spaces with the world, no login.** Space visibility
  now has three tiers: **Public** (anyone on the internet), **Internal**
  (everyone signed in — the default; existing spaces migrate here
  automatically), and **Private** (granted groups). A new anonymous,
  read-only site at `/public` serves the *published* documents of Public
  spaces: a branded landing page, per-space article lists, full document
  rendering with attachments, and rate-limited full-text search scoped to
  public content only. Drafts, suggestions, internal/private spaces, AI
  answers, the API, and the Claude connector all stay behind the login.
- **Settings → Public site**: master switch (off by default — nothing is
  exposed until an admin turns it on; when off every `/public` page 404s
  and public attachments stop serving) and a **search-engine indexing**
  toggle (off = `noindex`, reachable only by link).
- The review queue badges change requests that target a Public space
  ("🌐 Goes public") so approvers know a change lands on the open internet.
- The space editor warns and asks for confirmation before a space is made
  Public.

### Fixed
- Search-result snippets now HTML-escape document text before highlighting,
  so raw HTML in a document body can't be injected into the search page
  (internal search and the new public search both).

## [0.13.0] - 2026-07-15

### Added
- **Private spaces.** Settings → Spaces now has a *Who can see it* control:
  **Public** (everyone signed in — the default, and how every existing space
  keeps behaving) or **Private** (admins plus granted groups only). Private
  spaces vanish for everyone else across the whole product — sidebar,
  dashboard, space/document pages, version history, full-text search, AI
  answers, attachments, the REST API, and the Claude connector all resolve
  the signed-in user's space scope server-side and return 404s that don't
  even leak the space's name.
- **User groups** (Settings → Groups): named sets of users you can grant on
  any number of private spaces. Create/rename/delete groups and manage
  members by hand; every change is audited.
- **Microsoft Entra group sync** *(enterprise, Microsoft 365 directory sync
  entitlement)*: browse the tenant's security groups, import the ones you
  want, and keep membership mirrored with **Sync now**. Members are matched
  to CompassDocs accounts by SSO identity first, then email; group renames in
  the tenant propagate; removing someone in Entra revokes their space access
  on the next sync. Reuses the Settings → Directory app registration
  (GroupMember.Read.All — the one-click setup already grants it).

## [0.12.0] - 2026-07-15

### Added
- **Email alerts (SMTP).** Settings → Notifications gains an **Email (SMTP)**
  section — host/port/encryption/credentials (password write-only), from
  address, and a send-test-email button. Any relay works (Microsoft 365,
  Google Workspace, SES, Postmark, self-hosted). Add an *Email* channel with
  comma-separated recipients and it behaves like every other channel: same
  events, same space scoping, same Test button and delivery status.
- **Two new notification events**: **Document published** (direct publishes
  from the app or the Claude connector) and **Suggestion left** (reader
  feedback, with a preview of the suggestion text).
- **Per-space channel scoping**: each notification channel can be limited to
  specific spaces — leave unchecked for all. #engineering only hears about
  Engineering docs.

## [0.11.0] - 2026-07-15

### Added
- **Chat notifications for the approval workflow.** Settings → Notifications
  lets admins register outgoing webhooks — **Webex**, **Microsoft Teams**
  (Workflows / Adaptive Cards), **Slack**, or generic JSON — for change
  submitted / approved / rejected events, with per-event subscriptions, a Test
  button, and last-delivery status per hook. Deliveries are fired in the
  background and never slow down a save; webhook URLs are stored write-only.
  Notifications fire from the app UI and the Claude connector alike.

## [0.10.2] - 2026-07-14

### Fixed
- **Domain & HTTPS pushes were still rejected (403) even after 0.10.1.** Root
  cause found by reproducing against a real Caddy: Node's fetch marks every
  request `Sec-Fetch-Mode: cors`, so Caddy's admin API demands an allowed
  `Origin` header — and a bare admin config only accepts its own listen
  address. The app now sends `Origin: http://0.0.0.0:2019` (derived from the
  admin URL, with a fallback), which is accepted by old *and* new configs —
  existing installs self-heal on upgrade with no Caddyfile or volume surgery.

### Added
- **TLS smoke test in CI**: every change to the deploy files, Caddy
  integration, or Dockerfile now boots the real HTTPS stack and walks the full
  flow — setup → login → save a domain (internal CA) → assert the config push
  applied and HTTPS actually serves the app, with a clean Caddy admin log.

## [0.10.1] - 2026-07-14

### Fixed
- **Domain & HTTPS settings never reached the reverse proxy.** Caddy's admin
  API rejects requests whose Host isn't in its allowed origins, and ours only
  allowed the listen address — so every config push from the app (Host
  `caddy:2019`) got a 403 and saving a domain silently did nothing. Both the
  bootstrap Caddyfile and the app-generated config now allow `caddy:2019`.
  Existing HTTPS installs: re-download the Caddyfile
  (`curl -fsSL https://raw.githubusercontent.com/mattny20/CompassDocs/main/deploy/Caddyfile -o Caddyfile`),
  pull the new image, then `docker compose up -d --force-recreate caddy` and
  re-save your domain settings.

## [0.10.0] - 2026-07-14

### Added
- **One-click Deploy to Azure.** A "Deploy to Azure" button (README and docs)
  opens a guided portal wizard that launches the full stack — app, Postgres,
  optional Caddy HTTPS — on an Ubuntu VM via Docker Compose. Fully
  configurable: any VM size (native size picker), new or existing virtual
  network, public IP new/existing/none with a DNS label, separate SSH/web CIDR
  allowlists, OS disk type/size, an optional dedicated data disk (formatted
  and mounted as Docker's data root on first boot), edition + license key,
  HTTPS on/off, headless admin bootstrap, and an Anthropic API key. Templates
  live in `deploy/azure/`.

## [0.9.3] - 2026-07-14

### Fixed
- **HTTPS (Caddy) deployments failed to start** with `exec: "run": executable
  file not found in $PATH` — the TLS compose files overrode the Caddy image's
  command without naming the binary. Both TLS compose files now use
  `["caddy", "run", …]`. Existing installs: re-download the compose file (or
  edit the caddy `command:` to start with `"caddy"`), then
  `docker compose up -d`.

## [0.9.2] - 2026-07-14

### Fixed
- **Settings → System showed a stale version** (stuck at 0.5.2) because
  releases since then never bumped `package.json` — the number the app
  displays. The version is bumped again with every release from now on, and
  the release workflow refuses to tag a release whose version doesn't match
  `package.json`, so it can't silently drift again.

## [0.9.1] - 2026-07-14

### Added
- **"Connect Claude — one click" card** on the API tokens page: shows your
  instance's MCP URL with a copy button and the three steps to add it as a
  custom connector in Claude — no docs required.

## [0.9.0] - 2026-07-14

### Added
- **Two-factor authentication (TOTP).** Any user can add an authenticator-app
  code to their password sign-in under *your name → Security*: scan the QR,
  confirm a live code (so a bad scan can't lock you out), save eight one-time
  recovery codes. Password logins then require the current code — or a
  recovery code — after the password. Admins get a **Reset 2FA** escape hatch
  in Users & roles for lost devices; everything lands in the audit log. SSO
  users keep getting MFA from their identity provider.
- **Active sessions.** The Security page lists every signed-in device
  (browser/OS, IP, sign-in time, current device highlighted) with per-device
  **Sign out** and **Sign out everywhere else**.

## [0.8.0] - 2026-07-14

### Added
- **One-click Claude connect.** CompassDocs now ships its own OAuth 2.1
  authorization server for the MCP connector: discovery metadata, dynamic
  client registration, a browser consent screen ("Claude wants to connect →
  Approve"), PKCE-verified token issuance, and rotating refresh tokens. In
  Claude (desktop or claude.ai), just add `https://your-host/api/mcp` as a
  custom connector and click Connect — no tokens to copy, no config files.
  Personal API tokens keep working for clients without the OAuth flow.
- **Connected apps** on the API tokens page: see every app you've approved
  (with last-used times) and disconnect any of them instantly.
- The login page now supports a safe `next` redirect, so the consent flow
  returns you to the approval screen after signing in.

## [0.7.0] - 2026-07-14

### Added
- **Claude connector (MCP).** CompassDocs now ships a built-in MCP server at
  `/api/mcp`. Connect it to the Claude desktop app and Claude can search your
  knowledge base, read documents, draft new articles straight into CompassDocs
  as markdown, and revise existing ones — acting as you, with your role. Edits
  to published documents follow the approval workflow (queued as change
  requests when review is required), and every action is audit-logged.
  Available in every edition.
- **Personal API tokens.** Each user can mint and revoke tokens under
  *your name → API tokens* (`/account/tokens`). Tokens are shown once, stored
  hashed, display last-used times, and the page generates a ready-to-paste
  Claude Desktop config.
- **Run blocks.** Fenced code blocks now render with a header bar — language
  label and one-click **Copy**. Shell-flavored blocks (```bash, ```sh,
  ```powershell, ```run, …) get terminal styling with a **Copy commands**
  button, built for runbooks. Presentation only; nothing executes.

## [0.6.2] - 2026-07-14

### Added
- **One-click setup for the Microsoft 365 directory sync** *(Enterprise)*:
  the same "Set up automatically with Microsoft" flow as SSO, now on
  Settings → Directory. One tenant-admin sign-in creates the app registration
  with the `User.Read.All` and `GroupMember.Read.All` application permissions,
  **grants admin consent**, mints a 24-month secret, and fills in the sync
  configuration — then "Sync now" runs the first import.
- The directory sync panel also shows its client secret's expiry date.

## [0.6.1] - 2026-07-14

### Added
- **One-click SSO setup** *(Enterprise)*: a "Set up automatically with
  Microsoft" button on Settings → Single sign-on. Sign in once as a tenant
  admin (device code — no pre-existing app registration needed) and CompassDocs
  creates the Entra app registration with the right redirect URI, a 24-month
  client secret, and the service principal, then fills in and enables the
  configuration. The one-time token is discarded; no standing Microsoft
  permission is kept. Manual entry still works as before.
- The SSO panel now shows the stored client secret's expiry date when known.

## [0.6.0] - 2026-07-14

### Added — single sign-on (Enterprise)
- **Sign in with Microsoft.** With the `sso` entitlement, the login page gains
  a Microsoft Entra ID sign-in button (OpenID Connect authorization code +
  PKCE, full ID-token validation). Accounts are matched by directory identity,
  linked by email to existing users, or auto-provisioned with a role you
  choose.
- **Settings → Single sign-on**: tenant/client credentials (secret is
  write-only), auto-provisioning with a default role, an email-domain
  allowlist, an SSO-only mode that hides the password form (with a documented
  break-glass path), and a test sign-in button.
- **Works beyond Entra**: an advanced custom-authority setting points the same
  flow at any OIDC provider (Okta, Auth0, …).
- SSO activity lands in the audit log: `auth.sso_login`,
  `user.sso_provisioned`, `settings.sso`.

## [0.5.2] - 2026-07-13

### Added
- **Collapsible sidebar.** A toggle at the top of the left navigation collapses
  it to a slim icon-only rail — every destination stays one click away (with
  tooltips, and a dot in place of numeric badges) while documents and the
  directory get the extra width. Expanding restores the full layout, and the
  choice is remembered per browser.

## [0.5.1] - 2026-07-13

### Changed
- **Crisp SVG icons replace emoji in the UI chrome.** The sidebar, settings
  navigation, and the directory's view switcher / contact rows now use a
  consistent line-icon set (Lucide) instead of emoji — sharper, uniform across
  platforms, and aligned with the brand. User-chosen emoji (like space icons)
  are untouched.

## [0.5.0] - 2026-07-13

### Added — directory v2
- **Multiple views**: Cards, a sortable **List** (click a column header to
  sort), and **Departments** (grouped). The choice is remembered per browser.
- **Column chooser** for the list view — pick exactly which columns you see,
  including custom fields; preferences persist per browser.
- **Assistant links**: connect a person to their assistant; shown on cards and
  as an optional list column.
- **Custom fields**: admins define extra fields (cost center, pronouns,
  extension, …) that appear in the column picker, optionally on cards, and are
  editable per person.
- **Custom-field Graph mappings** *(Enterprise)*: map any custom field to any
  Microsoft Graph user property — including the Exchange custom attributes
  (`onPremisesExtensionAttributes.extensionAttribute1–15`) — and the Microsoft
  365 sync fills it automatically. Manual values for unmapped fields survive
  syncs.

## [0.4.0] - 2026-07-13

### Added
- **People directory.** A new **Directory** page (📇 in the sidebar) gives every
  signed-in user a searchable phone/people directory — name, title, department,
  email, phones, office — with department filtering and profile photos. Admins
  manage entries under **Settings → Directory** (add, edit, hide, remove).
- **Microsoft 365 directory sync** *(Enterprise)*. Connect a Microsoft Entra
  tenant (app registration with admin-consented `User.Read.All`) and the
  directory fills itself: users, titles, departments, phones, and profile
  photos, synced on demand. Junk-account controls included — guests excluded by
  default, optional require-title/require-phone filters, and optional scoping to
  a single Entra group. Requires the new `directory_sync` license entitlement.

## [0.3.5] - 2026-07-13

### Added
- **Anthropic API key in the setup wizard.** Optionally enter the AI key during
  first-run setup to enable AI answers and proofreading immediately — same
  write-only store as **Settings → AI**, where it can be changed later.
- **Update from a source tarball (manual installs).** The **Version & updates**
  panel now shows tarball-based update steps and a direct download link for
  installs running without Docker, using each release's source `tar.gz`.

## [0.3.4] - 2026-07-13

A first-run-experience release: install, activate a license, and set up your
domain + HTTPS entirely from the one-line installer and the setup wizard.

### Added
- **Domain & HTTPS in the setup wizard.** When CompassDocs runs behind its
  bundled Caddy reverse proxy, the first-run wizard now lets you enter your
  domain and pick an HTTPS mode — **Automatic** (Let's Encrypt, public DNS),
  **Self-signed** (internal CA, for LAN / internal DNS), or **Off** — and applies
  it to the proxy immediately. No separate trip to Settings required.
- **One-command HTTPS install.** Pass `COMPASSDOCS_TLS=1` to the installer to
  bring up CompassDocs behind Caddy on ports 80/443 (community and enterprise):
  ```
  curl -fsSL .../install.sh | COMPASSDOCS_EDITION=enterprise COMPASSDOCS_TLS=1 bash
  ```
  New `deploy/docker-compose.tls.ee.yml` provides the enterprise HTTPS stack.
- **Apply an Enterprise license during first-run setup.** The setup wizard (on
  Enterprise builds) has an optional license-key field, so a customer can
  activate Enterprise features right after install — the plain one-line installer
  is all that's needed. The key is validated before the admin account is created.

### Changed
- **Session cookie security is now automatic.** A new `secure_cookies` setting
  (**auto** / always / never) replaces the manual `COMPASSDOCS_INSECURE_COOKIES`
  toggle as the primary control. In the default **auto** mode, the login cookie
  is marked `Secure` over HTTPS and left un-Secure over plain HTTP — matching how
  each request arrives — so a plain-HTTP install no longer hits a login loop with
  no configuration. Choose it in the **setup wizard**, and switch to **Always
  require HTTPS** later under **Settings → Domain & HTTPS** once your certificate
  is installed. `COMPASSDOCS_INSECURE_COOKIES=1` still works (forces insecure in
  auto mode).

## [0.3.2] - 2026-07-13

### Fixed
- **Login loop on plain-HTTP deployments.** Session cookies are `Secure` in
  production, which browsers won't send back over `http://` — so an install
  served at `http://host:3000` bounced every request back to the login page.
  Serving over HTTPS remains the recommendation; for intentional plain-HTTP
  setups (internal LAN/VPN, or a TLS-terminating proxy the app can't detect),
  set **`COMPASSDOCS_INSECURE_COOKIES=1`** to drop the `Secure` flag. Default
  behavior is unchanged (Secure in production).

## [0.3.1] - 2026-07-13

### Enterprise licensing (open-core)
- **License settings page** (Settings → License) showing whether the running
  build is Community or Enterprise, and the status of any applied license key.
- **Offline license verification** — Enterprise licenses are Ed25519-signed
  tokens verified locally against a built-in public key. No license server and
  no phone-home; works air-gapped, with a 14-day grace period past expiry.
- **Open-core edition system** groundwork: enterprise features (SSO, SCIM,
  audit-log export, priority support) are gated by *both* the build and the
  license. The Community edition is unaffected and fully functional on its own.
- Embedded the production license-signing public key.

### Notes
- Enterprise feature implementations ship in the separate Enterprise build; this
  release provides the core-side licensing framework they plug into.

## [0.3.0] - 2026-07-13

The first public release of CompassDocs — an open-source team knowledge platform
for SOPs, technical docs, and policies, with AI-powered search, roles, and an
approval workflow. Self-hosted, AGPL-3.0.

### Knowledge & authoring
- **Spaces** to organize documents by team, product, or topic — create, edit,
  and manage them from the admin console.
- **Four document types** (SOP, technical, policy, how-to) with tags, summaries,
  and per-space browsing.
- **Rich-text editor** (WYSIWYG) with a formatting toolbar, plus a raw Markdown
  mode and live preview — both edit the same document.
- **AI proofreading** for grammar, spelling, and clarity, with apply-or-dismiss
  suggestions.
- **Full-text search** with keyword highlighting and a ⌘K quick-search.
- **Ask CompassDocs** — AI answers grounded in your own documents, with inline
  citations. Falls back to keyword search when no API key is set.
- **Version history** — every change is snapshotted and attributed.
- **Attachments** and inline images, with a configurable size limit.
- **Import & export** the whole knowledge base as front-matter Markdown.

### Governance
- **Roles** — Viewer, Editor, Approver, Admin — with a last-admin guard.
- **Approval workflow** — strict (review-required) or open publishing, with a
  review queue for change requests and suggestions.
- **Trash & retention** — soft-delete with restore and a configurable
  auto-purge window.
- **Audit log** — an append-only record of security- and content-significant
  actions (auth, users, content, settings, backups); secrets are never logged.

### Administration
- **Settings console** — branding, timezone, date/time formats, light/dark/auto
  theme, idle session timeout, and more.
- **AI configuration** — set the Anthropic API key (validated on save) and model
  from the UI.
- **Custom domain & HTTPS** — a bundled Caddy proxy with automatic Let's Encrypt,
  self-signed, or bring-your-own certificates, configured from the console.
- **Backups & restore** — scheduled full-database backups with retention and
  one-click restore, mirrored off-site to S3-compatible storage or Azure Blob.
- **System page** — version, database, storage, and resource usage at a glance.
- **Update checker** — see when a newer release is available, with the upgrade
  command.

### Deployment
- **One-command Docker install** with a browser-based first-run setup wizard.
- **Multi-arch images** (linux/amd64 and linux/arm64), published to
  `ghcr.io/mattny20/compassdocs`.
- **PostgreSQL** storage; the app migrates its own schema on start.
- Also runs manually with Node.js 20+ and PostgreSQL 14+.

[0.5.2]: https://github.com/mattny20/CompassDocs/releases/tag/v0.5.2
[0.5.1]: https://github.com/mattny20/CompassDocs/releases/tag/v0.5.1
[0.5.0]: https://github.com/mattny20/CompassDocs/releases/tag/v0.5.0
[0.4.0]: https://github.com/mattny20/CompassDocs/releases/tag/v0.4.0
[0.3.5]: https://github.com/mattny20/CompassDocs/releases/tag/v0.3.5
[0.3.4]: https://github.com/mattny20/CompassDocs/releases/tag/v0.3.4
[0.3.2]: https://github.com/mattny20/CompassDocs/releases/tag/v0.3.2
[0.3.1]: https://github.com/mattny20/CompassDocs/releases/tag/v0.3.1
[0.3.0]: https://github.com/mattny20/CompassDocs/releases/tag/v0.3.0
