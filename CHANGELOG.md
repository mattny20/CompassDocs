# Changelog

All notable changes to CompassDocs are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project follows
[Semantic Versioning](https://semver.org/).

## [1.15.0] - 2026-10-23

Directory: download links. Copy a link to an export, put it in an email or
on an intranet page, and whoever clicks it signs in and gets the file.

### Added
- **A download link for every export preset.** Settings → Directory → Export
  has a new **Download link** card under each preset: pick PDF, CSV or
  contact cards (.vcf), then **Copy link**, or open it in a new tab to try
  it. A preset that makes one file per section sends its PDF and CSV as a
  ZIP, and the picker says so. On the
  Directory page, **Export → Copy download link…** does the same for
  anyone who can export, with the preset to pick. The link is built on the
  workspace's custom domain when one is set.
- **Clicking the link signs you in, then downloads the file.** The link
  opens `/directory/download/<preset>`: a signed-out visitor goes through
  sign-in (password, SSO) and comes back to it, and the page starts the
  download at once. It says "Preparing your PDF…" while the file is made,
  then "Downloaded" with the file name once it is in the downloads folder,
  with **Back to home** to the dashboard and **Download again**. A direct
  link sits under the status, while the file is made and after, for a
  browser that blocks the automatic download; taking it hands the download
  to the browser, which reports it. Coming Back to the page from home shows
  "Downloaded" again rather than downloading a second copy; reloading the
  page, or opening the link again, downloads a fresh one.
- The file is made for whoever opens the link, from what their own
  account can see: the same columns, people and restrictions as their own
  Export menu, never the copying admin's. A link carries no secret and
  grants nothing; an account that cannot read the directory is told so.
- A link to a preset that has since been deleted says "This download link
  no longer works" with a way to the directory, instead of quietly serving
  the default preset. A refusal (the export rate limit) or a transfer cut
  off half way is said in words with **Try again**; a session that expired
  goes back through sign-in.
- The audit log's "Exported directory" entry carries `via: "link"` for an
  export made through a link.

### Changed
- A new preset made in the editor is given its id by the server when it is
  first saved, from its name, so its link reads
  `/directory/download/front-desk-list` rather than the placeholder it had
  before ("new-export-3"). The id avoids every live preset's id and every
  deleted one (the workspace now keeps a list of the last thousand deleted
  preset ids), so a link to a deleted preset never starts serving a preset
  made later. A saved preset keeps its id for good: renaming it never
  breaks a link already sent. Through the API, a preset sent without an
  `id` is named the same way; one sent with an id keeps it, which can bring
  a deleted id, and its links, back on purpose. Saves of the presets now
  run one at a time.

### Fixed
- Saving presets whose ids repeated in a particular way (`a`, `a-3`, `a`)
  no longer hangs the save: the duplicate is numbered past a suffix that is
  itself taken.

## [1.14.1] - 2026-10-21

Directory: an assistant written as an AD distinguished name with a
"Last, First" name now links to the right person.

### Fixed
- **An assistant named by a distinguished name with a comma in it now
  links.** AD's `assistant` attribute, synced through a directory
  extension, holds the assistant's distinguished name, and a CN in the
  "Last, First" form is escaped in it: `CN=Ruiz\, Dana,OU=Staff,…`. The
  resolver cut the name at the escaped comma and read the pieces on their
  own, so such an assistant linked nobody, or, when a piece such as `Dana`
  happened to be someone's mail nickname or SAM account name, the wrong
  person; assistants with a "First Last" CN were unaffected. The CN is now
  read with its escapes (`\,`, the hex form `\2C`, the older quoted
  `CN="Ruiz, Dana"`, and the CN's OID `2.5.4.3=`).
- **A distinguished name matches the exact account it points at.** Whenever
  a people field is mapped from Microsoft, the sync also asks Graph for each
  person's `onPremisesDistinguishedName`, `onPremisesSamAccountName`,
  `onPremisesUserPrincipalName`, `mailNickname` and `proxyAddresses` (Graph
  returns them only when asked), and the resolver indexes the person's own
  DN, compared in one canonical form whatever escape spelling either side
  used. A DN now names its account even when two people share the name or
  the CN is not the Entra display name, and an assistant given as an
  on-premises sign-in name resolves too. A DN that is nobody's own (an
  assistant who moved OU while the attribute kept the old DN, a shortened
  DN) still falls back to its CN as a display name, as before.
- **Several distinguished names in one value are told apart.** A
  multi-valued people attribute (AD's `secretary`, a multi-valued
  extension) is now stored with "; " between its values and keeps up to
  4,000 characters, cut only between values; a value is read DN by DN,
  including a DN after an address or a name, and a DN that matches nobody
  is reported once, whole, instead of as its pieces.
- **A SAM account name or mail nickname two people hold links nobody.**
  They are unique only within one AD domain; such a value is reported as
  shared, like a shared display name, instead of linking whichever person
  came first. An on-premises sign-in name or alias never takes an address
  from the person whose primary address it is.
- People columns in a CSV import resolve with the same stored handles as
  the sync (rows still match existing people by email, then by name). The
  sync panel, the health card, the sync report email and a mapping's
  preview separate their samples with " · " or "; ", so a DN's commas no
  longer run into the next sample.
- Letter case was never the cause and is unchanged: every handle and value
  is compared lowercased, so a case-only difference between AD and Entra
  (which Entra Connect does not carry over) cannot break a link. The
  directory guide now says so.

### Upgrading
- Nothing to do. The first directory sync after the upgrade fetches the
  extra properties and fills the missing links; until then the stored
  records match "Last, First" DNs by name. A multi-valued people field
  shows its values with "; " between them once, in the next sync's preview.
  A value that linked an arbitrary one of two people sharing a SAM account
  name or nickname is reported as shared instead. No schema change;
  rollback to 1.14.0 is supported (the extra properties are ignored and
  such DNs stop matching again).

## [1.14.0] - 2026-10-21

Read confirmation, part six: program operations and evidence. The portal
says what to do next (a needs-attention queue, seven tiles and stacked
bars), the programme is snapshotted every month with a SHA-256 an auditor
can verify, bundled as one audit package and summarised in a scheduled
report, every person has one compliance record, group leads see where
their team stands and get one weekly digest for both programmes,
compliance managers act in bulk across policies and people, policies are
grouped into sets for onboarding and the annual cycle, and five policy
events reach chat channels with counts only (Enterprise, `policy_ack`).

### Added
- **The portal knows what to do next: a Needs attention queue on
  Compliance › Overview.** Under the tiles, one row per person and reason
  over the live policies (published, required, not retired), computed in
  one set-based pass and worked to zero: the person (linking to their
  compliance record), the policy (linking to its Record tab) and a reason
  chip, decided in this order: **Overdue · 29 Oct 2026** (the due date and
  the policy's grace have passed), **Escalated** (the escalation has fired
  and still stands), **Never opened** (asked more than 14 days ago and no
  view of the document since the ask), **Opened, not confirmed** (asked
  more than 14 days ago, opened since, still unconfirmed); plus every
  **Standing exemption · review** (an exemption with no end date that has
  stood for more than twelve months, with its reason) and two policy-level
  rows from the decisions ledger that lead the list: **Confirmed text
  drifted 7.8% since v12** (kept edits moved the text past the re-ask
  threshold, the drift measured against the version people confirmed) and
  **Kept against the suggestion 3 times** (three or more kept edits since
  the last ask went against the heuristic's advice), each with **Ask
  everyone to re-confirm…** as its action. The people follow in the order
  above (overdue by due date, the rest by how long they have waited), up
  to 200 rows; the header counts what is hidden: **showing 12 of 19 · 7
  snoozed** (**showing 19 of 19** when nothing is cut; no count line on
  an empty queue). Compliance managers act per row: **Remind**, **Extend 7
  days** (with Undo), **Snooze** (out of the queue and no automatic
  reminders for a week, with Undo; nothing else changes), **Exempt…** (the
  roster's reason and optional end date, with Undo) and, on a standing
  exemption, **Remove exemption** (with Undo). An empty queue reads
  **Nothing needs attention.** In the API, `GET /api/admin/compliance`
  carries `attention: { rows, total, snoozed }` with `reason` one of
  `overdue`, `escalated`, `never_opened`, `opened_not_confirmed`,
  `standing_exemption`, `drifted`, `kept_n`, and `total` counted before
  the limit. A person's latest view is read through `idx_views_doc_user`,
  one index probe per row, never a scan of the document's view history.
- **Snooze hides a row from the queue, and nothing else.** A row whose
  snooze is still running leaves `attention.rows` and is counted in
  `attention.snoozed`. It stays in every number: the Overdue tile, the
  policy's and the person's overdue counts, the roster, the exports and
  the snapshot never look at a snooze, so nobody can snooze the
  organisation to zero overdue. The Overview's Snooze tooltip reads **Hide
  from this queue for 7 days**, and while a snooze hides rows the card
  ends with the sentence that it changes nothing else.
- **Seven tiles on the Overview, and the people behind Overdue.** The
  tiles are **Policies**, **Compliance** (%), **Overdue** (in the error
  ink above zero, with **17 people** under the number), **Due in 7 days**,
  **Pending** and **Exempt**, over the live policies, with
  **Re-confirmation due in 30 days** kept as a seventh; the grid holds
  seven across on a Wide page and five and two on a Normal one. `kpis`
  gains `overdue_people` (the people with at least one overdue row),
  `due_7d` (open, unconfirmed rows whose deadline falls inside the next
  seven days), `pending` (the new name of `outstanding`, which stays),
  `exempt` (exempt rows of active accounts on the live policies, outside
  every denominator), `escalated`, `snoozed` and `drifted` (live policies
  whose confirmed text drifted past the re-ask threshold). Paused and
  retired policies are outside every new sum, as they are outside the old
  ones.
- **A stacked bar on every live Policies row.** Confirmed (accent),
  pending (slate), overdue (red) and exempt (hatched, beside the
  denominator, so it reads in dark mode and on paper), with the legend
  **312 confirmed · 88 pending · 12 overdue · 4 exempt** under it and the
  same four numbers as the bar's accessible name. `docs` rows of the
  portal payload carry `confirmed`, `pending`, `overdue` and `exempt`
  (confirmed and pending partition the people the policy asks; overdue is
  the late part of pending; exempt sits outside the denominator), plus
  `last_reminded_at` (the manual Remind or the sweep's newest stamp,
  whichever is later), `owner_user_id` / `owner_name` (the policy's own
  owner, else the space's Policy owner, else whoever switched the
  requirement on, passing over anyone who is not an active account),
  `edit_default` (`ask` | `material` | `reset`), `overdue_grace_days`,
  `kept_since_reset` and `set_names`; `users` rows carry `exempt` beside
  `overdue`.
- **Sort, "In set" and a filter above the Policies rows.** **Sort** offers
  Most overdue (the default), Lowest compliance, Due soonest and Title
  A-Z; **In set** appears once any live policy belongs to a set and
  narrows the list to that set's policies; **Filter policies** narrows by
  title, space, owner or set name with its live **3 of 28 policies**
  count.
- **The owner, the kept edits and the set on the Policies row.** The first
  meta line ends **· owner Priya Shah**; the second ends **· 3 edits kept
  since v12** once an editor has kept an edit since everyone was last
  asked; each set a policy belongs to is a neutral chip with the set icon,
  **New starter onboarding**, beside the edit-default chip.
- **One Export menu on Policy progress.** For `compliance.export` holders,
  **Export** opens a menu: **Matrix CSV**, **Ledger CSV**, **Audit package
  (ZIP)** and **Print…** last. Each download is an audit row, as before.
- **Standing, Show and a filter on Compliance › People.** Each person's
  row ends with a Standing chip: **Compliant**, **3 outstanding** or **2
  overdue**; a **Show** control (All / Outstanding / Overdue / Compliant)
  and **Filter people** (name, username or role) with its live count sit
  above the table, which pages past 50 rows. The person's name links to
  their compliance record (`/compliance/person/{id}`).
- **The matrix CSV says where everyone stands.** `GET
  /api/admin/compliance?format=csv` ends every row with two new columns
  after the five of 1.13.0: `status` (`confirmed` | `pending` | `overdue`
  | `exempt`, the same rule as the tiles and the bars, with the policy's
  grace applied; a former-staff row reads `confirmed`) and `set` (the
  policy's sets, joined with "; "); the per-policy CSV appends `set`.
- **Tamper-evident snapshots of the read confirmation programme, on
  Compliance › Evidence.** A snapshot is the whole programme serialised
  once to stable JSON text (`format: compassdocs-compliance-snapshot/1`:
  the settings in effect, the totals the Overview's tiles show, every
  policy with the version people are asked to confirm and its SHA-256,
  the matrix (one cell per policy and person with status, source, dates,
  deadline, snooze, exemption and removal), every current confirmation
  with its version, hash, signature, identity proof, statement, reading
  evidence, IP and user agent, the decision ledger, the notice log folded
  per person, and the row count and SHA-256 of the full ledger, hashed but
  not embedded). Keys are in a fixed order, arrays by id, dates ISO, so
  the same data serialises to the same bytes; the SHA-256 is computed over
  exactly that text, stored verbatim (`compliance_snapshots.data`) and
  downloaded verbatim with the hash in `X-Content-SHA256`, so `sha256sum`
  on the file reproduces it. Three kinds: **manual** (**Take snapshot
  now** for `compliance.program_manage`, toast "Snapshot stored · sha256
  {prefix}"; `POST /api/admin/compliance/snapshots` answers `{ ok, id,
  sha256 }`), **monthly** (the hourly orchestrator takes one per calendar
  month, UTC, claimed through a partial unique index so exactly one
  instance stores it) and **retirement** (one per policy, scoped to it,
  written by Retire policy after its commit; a snapshot that fails never
  fails the retire and is audited as `ack.snapshot_failed`). The Evidence
  page (`/compliance/evidence`, for `compliance.export` holders; the tab
  sits after Sets) lists every stored snapshot newest first: Taken (and
  who took it, or "automatic"), Kind (Monthly with its period, Manual,
  Retirement with the policy's title), the SHA-256 prefix with a copy
  control for the whole hash, **Verify** (`GET …/snapshots/{id}?verify=1`
  recomputes the hash over the stored text: "Hash matches", or "Hash does
  not match the stored record") and a download named for the row
  ("Download snapshot 2026-09"); paged at 25 rows; "Monthly snapshots
  start automatically; take one now for a point-in-time record." until
  the first one; the controls hide on paper and the record stays. `GET
  /api/admin/compliance/snapshots` lists the newest 100. Every snapshot is
  audited as `ack.snapshot` {snapshot_id, kind, sha256, period |
  document_id}.
- **The audit package: one ZIP, streamed, with a hash manifest.** `GET
  /api/admin/compliance/audit-package` (`compliance.export`; **Audit
  package (ZIP)** on the Evidence page, with the latest monthly snapshot's
  SHA-256 prefix printed beside it, the latest of any kind until a month
  has passed) bundles everything an auditor asks for: `summary.json` (a
  snapshot of the same instant), `matrix.csv`, `acknowledgements.csv`
  (the full ledger, written from a cursor 500 rows at a time and never
  built in memory), `decisions.csv`, `waivers.csv` (the exemptions),
  `notices.csv`, `audit-extract.csv` (every `ack.*` audit row plus the
  three legacy `document.acknowledge` / `document.ack_required` /
  `document.ack_removed` keys), one folder per policy
  (`policies/{id}/policy.json` with the settings in effect, `roster.csv`,
  `history.csv`, `waivers.csv`, `decisions.csv` and `versions/v{N}.md` for
  every version a current confirmation or a decision cites, read from the
  version history or, for a purged policy, from the archived texts, so
  its SHA-256 in the manifest equals the rows' `content_sha256`), every
  stored snapshot under `snapshots/` and `manifest.json` last
  ({generated_at, app_version, workspace, files: [{name, sha256}],
  generated_by}), so `sha256sum -c` against the manifest verifies the
  whole bundle and the manifest's hash of `acknowledgements.csv` equals
  `summary.json`'s `ledger_sha256`. The audit row `ack.audit_export`
  {format: "package", bytes, policies} is written once the stream has
  closed, with the size that went out.
- **A policy's own package.** `GET
  /api/documents/{id}/acknowledgements?format=package` is the same ZIP
  scoped to one policy (its rows, its ledger, its decisions and notices,
  its audit rows, its retirement snapshot and the texts its confirmations
  cite), so an exporter can hand an auditor one policy's bundle. It
  takes the roster permission the record page takes plus
  `compliance.export`, exactly as the ledger CSV does (the file carries
  IPs and user agents); audited as `ack.audit_export` {format:
  "package", document_id, bytes, policies: 1}.
- **The scheduled programme report, from a card on Program settings.**
  Settings key `ack_report` = `{ enabled, cadence: "weekly" | "monthly",
  recipients: [user ids] }`, read and written through `GET` / `PUT
  /api/admin/compliance/report` (`compliance.export` to read,
  `compliance.program_manage` to write; the GET names the recipients and
  when the report last went out; the PUT takes any subset, refuses the
  first problem with 400 before anything is written (an unknown key, a
  wrong type, "weekly or monthly", up to 50 recipients, "Every recipient
  must be an active account."), and audits each changed key as
  `ack.report_settings` {key, from, to}); `PUT
  /api/admin/compliance/settings` accepts the same `ack_report` object
  with the same checks, "Every recipient must be an active account."
  included, before anything is written. The **Compliance report** card
  under Compliance › Settings (**Send the compliance report**, **Weekly
  (Monday)** / **Monthly (with the snapshot)**, a Recipients picker over
  active accounts, with when the report last went out) saves through the
  report's own route inside the page's one Save; a report that is on
  needs at least one recipient before Save enables. Weekly, the first
  hourly tick of each ISO week (UTC) sends it, claiming the week
  (`ack_report_week`) only after SMTP is found configured and at least
  one recipient is still an active account with an address, so neither
  an unconfigured workspace nor a list whose accounts were all
  deactivated since the save burns the week; monthly, it rides with the
  monthly snapshot and carries that snapshot's hash. The body is the new
  editable template **Compliance programme report** (`ack_program_report`:
  `period`, `summary`, `snapshot_sha256`, `snapshot_label`, `portal_url`,
  `org_name`), the summary being "- **28** policies · **94%** compliance
  (1,412 confirmed, 61 pending, 23 overdue, 9 exempt)", "- **17** people
  overdue · **4** escalations this period · **6** new joiners enrolled ·
  **3** exemptions granted · **4** standing exemptions older than a year"
  (a new joiner is an account created in the period and enrolled in it,
  whether the space or an onboarding set admitted them), "Lowest
  compliance:" (the five live policies with the lowest share confirmed)
  and "Deadlines in the next 14 days:" (per policy, how many people and
  the earliest date). Each send is audited as `ack.report_sent` {period,
  cadence, recipients, sent, snapshot_sha256}.
- **Erasure reaches the snapshots.** Anonymising a person's compliance
  record now also rewrites every stored snapshot that named them (their
  own rows by id: name, username, address, signature, IP and user agent;
  and any value equal to their name or address anywhere in the text), in
  the same transaction, re-serialised the way snapshots are written and
  re-hashed; each rewrite writes `ack.snapshot_rewritten` {snapshot_id,
  user_id, previous_sha256, sha256}, saying the original hash no longer
  applies, and `ack.anonymised` carries the count as
  `snapshots_rewritten`. The name of whoever took a manual snapshot
  (`taken_by_name`, the Evidence page's "by {name}") becomes the alias
  too, and the person's own confirmations now lose their typed signature
  and their browser's user agent as well as their name, address and IP
  (the ledger CSV carries both; an unsigned row still reads unsigned).
- **A per-person compliance record.** `/compliance/person/{id}`, and
  `/compliance/person/me` for your own: everything one person must
  confirm, has confirmed and was told. **Current requirements** is one row
  per open or exempt assignment on a live policy: the policy, its space
  and sets, the standing `confirmed` / `pending` / `overdue` / `exempt`,
  how and when the person was assigned ("by group", "named person", "by
  role", "by hand", "new joiner", "Onboarding set", "everyone in
  Security space", "re-confirmation cycle"), the deadline, the current
  confirmation with its version (marked "(inferred)" for confirmations
  from before 1.10.0, through `version_source`), hash, typed signature,
  identity proof, read time and reached-end report, the IP where the
  viewer may see it, the exemption, a snooze and a per-person re-ask with
  its reason; **Prior confirmations** are the confirmations a later cycle
  replaced, each with what replaced it ("Superseded by: v13 on 3 Sep
  2026 - "Section 4 now covers contractors"", "annual re-confirmation on
  1 Oct 2026", or the person's own later confirmation), assignments
  closed when the person left an audience ("Required 1 Mar to 30 Sep
  (left Engineering)"), open rows on a policy that stopped asking (its
  requirement switched off, or the policy paused or trashed with it on),
  marked **No longer required** and reading "Required from 1 Mar 2026"
  with the standing frozen when it stopped, so a confirmation the ledger
  still carries stays on the record, and rows on retired policies with
  the standing frozen at retirement; **Notices** is the notice log for the
  person, newest first.
  CSV beside Print; the printed page carries "Generated {date} by {viewer}
  · CompassDocs {version}". The API is `GET
  /api/admin/compliance/people/{id}`, answering `{ person, current,
  history, notices, hidden, viewer_kind }` (`{id}` may be `me`; any
  signed-in account may ask; 402 without the licence); `?format=csv`
  downloads the same rows as a 21-column file (`policy, set, status,
  source, assigned_at, removed_at, due_at, acknowledged_at, version,
  version_id, version_source, content_sha256, signed_name,
  identity_proof, read_seconds, reached_end, ip, exempt_reason,
  exempt_by, exempt_until, superseded_by`; a row whose policy stopped
  asking reads "no longer required" in the last), and every download writes
  `ack.record_exported` ("Exported a person's compliance record") with the
  person, the number of rows, the viewer's kind and the hidden count,
  before the response streams.
- **Who sees whose record, decided in SQL.** Four kinds of viewer, in this
  order: the person themselves and holders of the Compliance section see
  every row; a lead of a group the person belongs to (when the Program
  setting **Group leads see policy standing** is on) and a holder of
  `compliance.team_read` (for anyone in a group, as the team page lists
  them, so its links never answer 404) see the person's policies in
  spaces they can read; a holder of `document.ack_roster_read` on a space
  opens the record of someone with an assignment or a confirmation on a
  policy in that space and sees the person's policies there (a global
  grant opens anyone's); anyone else is answered 404 "No such person."
  (Page not found), the same answer an unknown id gets. The filter runs
  inside every query (the current rows, the history, the notices), so a
  lead's page, JSON and CSV never carry a private-space
  policy's title, address or row: a policy the viewer may not see counts
  only in `hidden` ("2 policies you can't view"). The recorded IP address
  is carried only on rows whose space the viewer holds
  `document.ack_roster_read` on, or when the viewer holds
  `compliance.export`; it is `null` otherwise, for the person's own record
  too.
- **Actions on the record** (`compliance.program_manage`): **Remind about
  everything outstanding** (one bundled reminder through the bulk
  endpoint's `remind_people` over every open row, in one call; a policy
  that reminded them within the hour is skipped), **Ask to re-confirm…**,
  **Exempt from…**, **Extend…** and **Remove exemption**, each over the
  policies it applies to, asking in the same words as the Record tab and
  offering Undo in the toast; administrators who may delete accounts also
  see **Anonymise compliance record…** here.
- **Links to the record**: the Record tab's and the portal's roster rows,
  the People page, the needs-attention queue, the team view, the Users
  page's **Compliance record** button, **View your record** on the
  confirmed card at the end of a policy, and **Your record** on My
  policies.
- **A team view for group leads: Compliance › Team.** Leading a group (the
  same group leads Training uses) now opens where that group's members
  stand on the policies that ask them: one card per led group ("{n}
  members · {m} confirmed · {k} open", with an **{x} overdue** chip when
  anyone is), a table of Person (a link to the person's compliance
  record), Policy, Status (Confirmed / Pending / Overdue / Exempt), Due
  and Actions, and a **Show** control (All / Open / Overdue), scoped to
  the spaces the lead can read: a policy a member owes in a space the
  lead cannot see is a count on the member's row (`hidden_count`, "and 2
  policies you can't view") and never a title; a member with nothing to
  confirm still appears once. `GET /api/compliance/team` answers
  `{ groups: [{ id, name, members, confirmed, open, overdue }], rows }`,
  each row with its status, due date, confirmation date, last reminder
  and `may_remind` (whether this viewer may remind it). The **Team** tab
  appears in the Compliance section's row for anyone the page opens for:
  leads when Program settings allow, and `compliance.team_read` holders
  (who see every group; with no groups in the workspace they read "You
  don't lead any groups yet."). The view is an **opt-in for upgraded
  workspaces**: Program settings → *Group leads see policy standing*
  (`ack_defaults.leads_see_policies`) is off for a workspace that had
  saved program settings before 1.14.0 and on for a new install, because
  widening what every existing lead can see is a permissions change.
- **`compliance.team_read`** ("Read team policies": see policy standing
  for groups you lead), the policy twin of `training.team_read`: held by
  the Compliance manager role, grantable to any role, and opening every
  group for a holder, setting or not. In the catalog under `compliance`.
- **A lead's Remind, one person at a time.** `POST /api/compliance/team
  { assignment_id }` queues one reminder for that person through the
  outbox (a manual reminder from the lead, delivered within the minute,
  never coalesced), stamps the row's reminder date and count, and is
  audited `ack.reminder_sent` with `{ by: "lead", user_id, assignment_id
  }`. It is governed by the row's own cadence, not the portal's
  per-document hour: inside the policy's *days between reminders* (the
  policy's number, else the space's, else the workspace's, else 7) it
  answers 429 "{Name} was reminded {n} days ago." ("earlier today" on the
  day), which the page shows as its toast; the success toast reads
  "Reminder queued for Ana Ruiz.". A lead reminds only members of groups
  they lead (403 "You can only remind members of groups you lead."); a
  programme manager may remind anyone the view shows. On a row the
  viewer may not remind (a `compliance.team_read` holder who is neither
  the group's lead nor a programme manager) the page shows **Remind**
  disabled, with **Only the group's lead or a programme manager can
  remind**. A row in a space
  the viewer cannot read reads as absent (404); a confirmed or exempt row
  is 400 with the reason.
- **"You lead a team. See your team's policies"** on My policies: a
  lead's banner above the standing line (and above the empty state for a
  lead with nothing to confirm), only for someone the team page opens
  for. `GET /api/compliance/mine` answers `lead_team: boolean` by the
  page's own rule.
- **Program settings → Team leads**: the card with the toggle **Group
  leads see policy standing** ("Leads of a group see where its members
  stand on policies in spaces they can read, and get the weekly
  summary."), saved with the page's one Save. A first save keeps it on.
- **The Team leads block on the compliance Overview** (programme
  managers): the same block Training's Overview shows (now one shared
  component, `TeamLeadsBlock`), with the policy sentence ("Leads see a
  scoped view of their group's policies (and training, if licensed) and
  get a weekly summary."), a picker per group (an account without a
  display name listed by its username), and a notice with the link
  to Program settings while leads do not yet see policy standing. It
  reads and writes `GET` / `PUT /api/compliance/leads` (the Compliance
  section; `program_manage` to write; 402 without the licence), so a
  compliance manager need not hold the Training section or its licence.
  The leads are one list for both programmes: a lead named on either page
  is a lead on both.
- **The weekly team digest covers policies, from a neutral scheduler.**
  The lead digest moved out of the training sweep into its own module
  (`lib/team-digest`), called by the new periodic orchestrator
  (`lib/periodic`, one `[periodic]` step in the hourly tick after the
  compliance sweep), so a workspace licensed for read confirmations alone
  gets it. One email per lead: a **Training** section when training is
  licensed and a **Policies** section when read confirmations are
  licensed and leads see policy standing ("- **Engineering**: 38 confirmed
  · 6 open · **2 overdue**", then the three most overdue people within the
  lead's scope, "Ana Ruiz · Code of conduct · due 3 Oct 2026"). The
  template key stays `training_team_digest` so an existing override
  survives; it gains the tag `{{policy_summary}}` and a neutral default
  subject "[{{org_name}}] Your team this week" (the label is now "Team
  digest (leads)"). A digest that carried the Policies section writes one
  notice-log row per lead (kind `digest`), so a lead's record shows it
  was sent.
- **`lib/periodic`**: `runPeriodic()` runs, in order and each in its own
  catch, the team digest, the monthly compliance evidence, the weekly
  compliance report and the weekly channel summary; `isoWeekId(d)` and
  `monthId(d)` key the claims; `claimPeriod(key, period)` (lib/db) is the
  settings-table claim the weekly steps share, true once per period
  across instances.
- **Policy sets: onboarding and the annual cycle as one unit, on
  Compliance › Sets.** A set is a named, ordered bundle of policies
  (`policy_sets`, `policy_set_docs`) a compliance manager assigns to
  **people and groups, or to everyone**, in one go, and that **every new
  account lands on on day one** when the set auto-assigns (on by default).
  The **Sets** tab (after People, `/compliance/sets`,
  `compliance.program_read` to open) lists every set with its ordered
  members as chips ("1. Acceptable Use"), its standing over the members'
  open rows ("87% · 6 overdue", "Nobody asked yet"), an **Auto-assign**
  chip while new joiners get it and an **Inactive** chip once
  deactivated. **New set** (`compliance.program_manage`) opens a form
  above the list: **Set name** (for example "New starter onboarding"), an
  optional description, the policies in order (a search box over every
  published, unretired document that appends, and the reordering list of
  the directory export's Section order recipe with move-up / move-down /
  remove, each row naming its space and whether it is "not yet required")
  and the **Auto-assign to new joiners** switch. **Assign** opens a dialog
  with **Add people…** and **Add groups…** pickers, says beforehand
  which members will start requiring confirmation ("These 2 documents
  will start requiring confirmation: …") and which already ask everyone
  who can see their space and will not be narrowed, and offers **Assign
  set** or
  **Assign to everyone** (behind "Assign "New starter onboarding" (8
  policies) to every active member?"); the toast carries the answer's
  counts ("Set assigned: 8 policies, 412 people · 2 switched on").
  Assigning a set writes the same include rules onto every member policy
  (each rule tagged with the set, so a row it admits reads source `set`),
  moves a member to targeted mode unless it already asks everyone who can
  see its space (a set never narrows: such a member is left as it is and
  reported), **switches on a member that did not yet require
  confirmation** with the workspace defaults, and reconciles each member
  exactly as saving its audience does, so every count keeps reading the
  assignment rows; the people a member starts asking get one request
  notice per policy through the shared outbox. Assigning to everyone puts
  each member in space mode with its rules cleared. A new account's
  auto-assign writes the onboarding set's rule naming them on each
  targeted member and admits them past a member policy's own "Enrol new
  joiners automatically" switch: the set is the explicit instruction.
  **Deactivate** stops auto-assign and assignment and changes no row
  (reversible, "Set deactivated · Undo"; its name is free while it is
  deactivated); **Delete** asks with "Policies and confirmations stay;
  only the set is removed. This cannot be undone." (and, for a set that
  auto-assigns, wants the set's name typed) and leaves the rules it wrote
  (untagged) and every assignment. Editing a policy out of a set does the
  same for that policy in the same save: the rules the set wrote on it
  lose their tag and stay as plain rules the Settings tab can then edit,
  and its people keep their rows. Names are unique among active sets,
  case-insensitively. A program_read-only viewer sees the sets and no
  control. The API: `GET` / `POST /api/admin/compliance/sets`, `PATCH` /
  `DELETE` / `POST /api/admin/compliance/sets/{id}` (`{ user_ids?,
  group_ids?, everyone? }`, up to 200 ids each, answering `{ policies,
  people, added, switched_on, not_narrowed }`). Audited as
  `ack.set_created` ("Created policy set"), `ack.set_updated`,
  `ack.set_deactivated`, `ack.set_deleted` and `ack.set_assigned`
  ("Assigned policy set") with the set, the people, the policies and the
  members switched on.
- **My policies groups the rows by set.** Under To confirm, the rows of a
  set sit under their own label, "New starter onboarding · 3 of 8 done"
  (the person's rows in that set over every state), in the set's order; a
  policy in two sets appears under the first; rows in no set follow under
  no label. `GET /api/compliance/mine` rows carry `set_names` and
  `set_position`.
- New tests: `test/ack-attention.test.ts` (the queue's reasons, order,
  limit and numbers; a snoozed overdue row staying in the counts and
  leaving the queue; paused and retired policies absent; the docs row's
  bar numbers, owner cascade, last reminder, edit default and set names;
  the matrix header), `test/ack-retention.test.ts` (the matrix header's
  two new columns), `test/ack-snapshots.test.ts` (byte-stable text hashed
  over exactly its bytes; Verify detecting a changed row; the manifest
  hashes equal to the files and the manifest last; the per-policy package
  carrying only that policy's rows; the ledger streamed across more rows
  than one page; the monthly claim won once across two concurrent calls;
  a retire writing its snapshot; an erasure rewriting and re-hashing with
  its audit row and the snapshot taker's name; the report's bullets,
  windows and settings validation, an exempt and a snoozed overdue row in
  the counts, the per-policy package's waivers, notices and audit
  extract, the weekly run never burning the week without SMTP or with
  nobody to mail and sending once across two parallel runs, new joiners
  admitted by an onboarding set, the per-policy package refused without
  `compliance.export`, and the housekeeping of the deadline claims),
  `test/ack-boot.test.ts` (the tables, the indexes and the column after
  an upgrade boot; a second boot moving nothing),
  `test/ack-record.test.ts` (the four viewer kinds, the hidden count, the
  IP rule, the 21 columns, the CSV's audit row, `me`, the 404s and the
  401), `test/team-policies.test.ts` (the rule; a lead of a broad group
  getting a count, not a title; the per-row remind cadence; 403 outside
  the lead's groups), `test/team-digest.test.ts` (training unlicensed
  with the Policies section still sending; training alone licensed;
  both sections in one email; two `runPeriodic` calls in parallel
  sending once; a failing step reported while the next still runs; the
  week 1.13.0's key already holds not sent again; an override without
  `{{policy_summary}}` rendering without the section),
  `test/ack-sets.test.ts` (create, order, update; assign writing one rule
  per policy and reconciling with source `set`; a member switched on;
  space-mode members not narrowed; a new account landing on an
  auto-assign set's policies on day one; deactivate, delete and the name
  409); e2e specs `compliance-evidence`, `compliance-record`,
  `compliance-team`, `compliance-sets` and the portal spec's new cases
  (the orchestrator runs them on the licensed rig).
- **Bulk actions on Compliance › Policies.** Every live row has a checkbox
  and the toolbar a **Select all shown** checkbox that respects the filter
  and the sort (shift-click selects a range in that order). While anything
  is checked a bar reads **3 policies selected** with **Clear selection**
  and the actions over the checked policies: **Remind** (asks "Remind 2,118
  people?" with the policies it acts on and the ones skipped because they
  were reminded within the hour, then toasts **Reminders queued for 2,118
  people · 1 policy skipped**), **Set deadline…** (the Settings tab's
  Deadline choices, with "Also move existing deadlines"), **Set owner…** (a
  person, or Clear owner), **Set reminders…** (the four reminder numbers; a
  blank field is left as each policy has it unless you clear the blanks so
  they inherit again), **Ask everyone to re-confirm…** (one question naming
  the policies, the confirmations it resets and the people it notifies,
  with the reason inside it), **Add to set…** (an active set; nobody is
  assigned) and, for `compliance.export` holders, **Export CSV (selected)**
  (the matrix narrowed to the checked policies). Deadline, owner and
  reminders tell and offer **Undo**, which re-sends what each policy held.
  On both bars a finished action clears the selection and puts focus on
  **Select all shown**.
- **Bulk actions on Compliance › People.** A checkbox per person, **Select
  all shown** over what Show and the filter leave, and a bar **3 people
  selected** with **Remind about everything outstanding** (one notice per
  person listing every policy they still need to confirm; the outbox
  bundles them), **Ask to re-confirm…** (their confirmed rows on every
  policy, with a reason), **Exempt from…** (the policies the selected
  people owe, a reason and an optional end date) and **Extend due…** (days
  and an optional reason). Exempt and Extend offer **Undo**, which
  reverts every row they changed, in calls of 200 rows.
- **`POST /api/admin/compliance/bulk`** (`compliance.program_manage`): one
  endpoint behind both bars and the record page. `{ action, doc_ids?,
  user_ids?, assignment_ids?, params }` with the actions `remind`,
  `set_deadline`, `set_owner`, `set_reminders`, `reask`, `add_to_set` (over
  up to 200 `doc_ids`) and `remind_people`, `reask_people`, `exempt_people`,
  `extend_people` (over up to 200 `user_ids`, or `assignment_ids` for the
  named rows only). It answers `{ done, queued, skipped: [{ id, title,
  reason }] }` in the shape of `/api/documents/bulk`, plus `previous` (the
  values each policy held, for Undo) on the three reversible policy actions
  and `changed` (the assignment ids) on the people actions; 400 names the
  first problem. Every action composes the programme's existing writes
  (the portal's reminder, the deadline mover, the Settings tab's setters,
  the re-confirmation claim, the set's membership update, the assignments
  dispatcher) and every notice is an outbox row delivered by the minute
  tick: nothing in the request sends mail. `GET
  /api/admin/compliance/bulk?user_ids=1,2` lists the live policies the
  named people owe (what **Exempt from…** offers).
- **`GET /api/admin/compliance?format=csv&doc_ids=1,2,3`** narrows the
  matrix CSV to those policies; the `ack.export` row names them.
- **Audit keys.** One summary row per bulk call: `ack.bulk_remind`,
  `ack.bulk_due_set`, `ack.bulk_owner_set`, `ack.bulk_reminders_set`,
  `ack.bulk_reasked`, `ack.bulk_added_to_set`, `ack.bulk_people_reminded`,
  `ack.bulk_exempted` (and 1.13.0's `ack.bulk_extended` for Extend due…),
  beside the per-policy and per-row rows the underlying writes keep
  writing (`ack.due_set`, `ack.defaults_set`,
  `ack.reconfirmation_requested`,
  `ack.set_updated`, `ack.exempted`, `ack.due_extended`, …).
- **Five compliance events for outgoing webhooks (Enterprise,
  `policy_ack`).** The org-level webhooks (Settings → Notifications) can
  now carry the read-confirmation programme's news to a #compliance or a
  team channel, with the counts and the policy title and never the names of
  the people who owe a confirmation (those reach owners and leads through
  the outbox): `policy.requested` ("**Priya Shah** asked 412 people to
  confirm **“Acceptable Use Policy”** by 29 Oct 2026.", from the portal's
  and the shield's Request with notice, a whole-audience "Ask everyone to
  re-confirm…" (one per policy from the Policies bar's bulk re-ask too),
  an audience save that adds people, a policy set assignment, and an
  annual cycle as "Annual re-confirmation of **“…”** started: 412 people
  to confirm."),
  `policy.deadline_approaching` ("**“…”** is due in 3 days: 88 people
  still to confirm.", once per policy per due date, inside the policy's
  *days before due* window), `policy.escalated` ("7 people are more than a
  week overdue on **“…”**.", from the escalation sweep, once per policy per
  sweep that escalated someone), `policy.weekly_summary` ("Policy
  compliance this week: 94% · 23 overdue across 4 policies · lowest: Data
  Handling 71%.", plus "Monthly snapshot sha256 a1b2c3…" when the month's
  evidence snapshot was taken, one message per hook per ISO week) and
  `policy.retired` ("**“Travel policy”** was retired by Priya Shah; replaced
  by **“Expenses and travel”**."). Each event is sent once per policy, after
  the notice to the people themselves has been queued, and never waits on
  the channel: a slow endpoint never slows a Request or a retire. The
  per-space filter applies (the event carries the policy's space); the
  weekly summary goes only to hooks with no space filter, since a scoped
  hook asked for one space's news. The generic JSON envelope carries a
  `policy` object (`{ id, title, due_at, due_label, counts: { required,
  acked, overdue }, people, days?, cycle?, superseded_by? }`) and, on the
  summary, a `summary` object; the Webex, Teams, Slack and email formats
  carry the sentence. The checklist on Settings → Notifications → Webhooks
  lists the five under a **Compliance** heading while read confirmations are
  licensed; a hook saved with one keeps it either way.
- **`lib/compliance-webhooks`**: `emitPolicyRequested`,
  `emitPolicyEscalated`, `emitPolicyRetired`, `emitPolicyDeadlines` (the
  hourly sweep's deadline pass, claim `ack_deadline_hook_{docId}` on the
  deadline's day) and `weeklyPolicyChannelSummary()` (claim
  `ack_weekly_hook`, run by `lib/periodic`); everything gated on the
  licence, and nothing claimed while no hook subscribes (for a deadline,
  while no subscribed hook covers the policy's space: every one scoped
  elsewhere claims nothing), so a hook added later still hears a deadline
  that is still ahead and a week nobody listened to is not burned. The
  hourly housekeeping drops an `ack_deadline_hook_{docId}` row once its
  policy is purged.

### Changed
- `complianceDocs` resolves each policy's owner and grace and counts its
  exempt rows in the same seven set-based reads it already made (no
  per-policy query was added); `complianceUserSummary` counts a person's
  exempt rows in a subquery of its own, so the open-row join and its three
  counts are untouched.
- **The Overview's tile labels are shorter.** "Policies requiring
  confirmation" is **Policies**, "Overall compliance" is **Compliance**,
  "Outstanding confirmations" is **Pending** and "Overdue confirmations"
  is **Overdue**; "Fully compliant people" is no longer a tile (the People
  page's Standing chip and Show control carry it).
- **The People page's Overdue column is a number.** The count reads in
  the error ink above zero; the **2 overdue** chip moved to the Standing
  column, where it is the person's state rather than a measurement.
- **The drift chip reads "7.8% drift since v12".** The edits count it
  used to carry ("Edited 3 times since v12 without re-asking") is now the
  subtitle's **3 edits kept since v12**; the chip shows only while
  something has drifted, in amber once the drift reaches the re-ask
  threshold (when the Overview's queue lists the policy).
- **The Policy progress card's "Export CSV" link is the Export menu's
  "Matrix CSV".** Same route, same file name, same audit row.
- **The Compliance tab row reads Overview, Policies, People, Sets,
  Evidence, Team, Settings.** Sets opens with `compliance.program_read`;
  Evidence with `compliance.export` (the same key as every CSV;
  `compliance.program_read` alone gets the not-found page on
  `/compliance/evidence`); Team for leads the page opens for and
  `compliance.team_read` holders; Settings with
  `compliance.program_manage`.
- The Record tab's roster rows link each person to their compliance
  record.
- `sha256Hex` and the CSV line writer moved to `src/lib/evidence.ts`,
  which both audit packages share (`manifestFor`, `addStreamedCsv`,
  `hashCsv`); `lib/training-audit` still exports `sha256Hex`.
- `ack_report.recipients` is a list of user ids (the key was reserved in
  1.10.1 with a `{users, groups}` shape that nothing wrote; a stored
  object of that shape reads as its users).
- The training sweep (`trainingHourly`) no longer sends the weekly team
  digest; `lib/periodic` does, under the claim key `team_digest_week`
  (1.13.0's key `training_team_digest_week` is read before the claim and
  written after a won one, so the upgrade week is sent once). Every
  weekly step checks what it needs (a licence, leads
  with an email, SMTP) before claiming the week, so a tick that can send
  nothing does not burn it.
- `claimTrainingPeriod` (lib/db) is now `claimPeriod`; the old name is
  kept as an alias for one release.
- The training-only digest reads as it did in 1.13.0 (no headings); with
  both sections the two are headed **Training** and **Policies**. The
  digest's link goes to `/compliance/team` when the Policies section is
  present, else to `/training/team`.
- `PUT /api/admin/compliance/settings` accepts
  `ack_defaults.leads_see_policies` (true or false; refused otherwise) and
  audits a change as `settings.compliance` like the other program
  settings. The first save that writes `ack_defaults` on a workspace that
  never saved one stores `leads_see_policies` as the value it read (on),
  whatever keys the save names, so a script's save never turns it off.
- Training's Overview renders the shared `TeamLeadsBlock` with its own
  sentence against `/api/training/leads`; nothing it shows or saves
  changed. Its "No groups yet" line is the house `SectionEmpty`.
- `PUT /api/compliance/leads` audits `training.leads_set` (the key the
  training route writes, because the list is one) with
  `via: "compliance"`.
- **The assignment source `set`.** A row admitted by a rule a set wrote
  reads `source = 'set'` (before `user`, `group` and `role`; `space` still
  wins in space mode); a new account's row reads `set` when the
  onboarding set's rule names them, else `new_member`. The hourly sweep,
  the Settings tab's save and every other writer are unchanged.
- **The Deadline and Reminders fields are shared.** The Settings tab's
  Deadline radio cards and the four reminder fields now come from one
  module (`components/PolicyFields`) that the bulk dialogs use too; the
  Settings tab looks and behaves as before.
- **A bulk Remind skips rather than refuses.** A policy reminded within the
  hour is reported as skipped with the minutes ("reminded 20 minutes ago"),
  as is one with nobody pending; the rest are queued. A bulk re-ask treats
  the hour guard the same way ("asked again 12 minutes ago") and skips a
  policy nobody has confirmed yet.
- `lib/periodic`'s `policy_channel_summary` step now imports
  `lib/compliance-webhooks` statically (the dynamic-specifier placeholder
  of wave 1 is gone), so the production bundle carries it.
- `lib/webhooks`: the JSON transport sits behind `webhookTransport.post`
  (the same SSRF-guarded fetch, now a swappable seam the tests use); the
  six existing events' envelopes and formats are byte for byte as before.

### Upgrading
- **Schema additions, all metadata-only.** One new table,
  `compliance_snapshots` (id, taken_at, kind, period, document_id SET
  NULL, taken_by SET NULL, taken_by_name, sha256, data), its partial
  unique index `idx_compliance_snapshots_monthly ON (period) WHERE kind =
  'monthly'` (the monthly claim) and two partial indexes under the SET
  NULL references (`idx_compliance_snapshots_doc`,
  `idx_compliance_snapshots_taken_by`), so purging a policy or deleting
  an account never scans the snapshots; two more, `policy_sets` and
  `policy_set_docs`, with the index `idx_policy_set_docs_doc`; and one
  nullable column, `policy_audience_rules.set_id` (`ON DELETE SET NULL`),
  with the partial index `idx_policy_rules_set` under it so deleting a
  set never scans the rules. All behind the usual catalog guards: no
  one-shot migration, no count moves, nothing backfilled. The first
  monthly snapshot is taken by the first hourly tick after the upgrade,
  labelled with the current month; from then on one is taken by the
  first tick of each calendar month (UTC). The report is off until an
  admin turns it on.
- **Nothing to run for the queue and the numbers.** They read
  `policy_assignments`, `doc_views` (through `idx_views_doc_user`, in
  SCHEMA_SQL since 1.11.0) and `ack_decisions` as they stand. A workspace
  upgraded from 1.13.0 whose rows carry no due date shows no overdue,
  escalated or due-in-seven-days rows until deadlines are set; "never
  opened" and "opened, not confirmed" start naming people 14 days after
  they were asked, which for the rows the 1.13.0 migration wrote is 14
  days after the policy's last ask. The queue's **Remind** is a
  per-person reminder (the bulk endpoint's `remind_people` over that
  row; a person reminded within the hour is skipped), never the policy's
  whole audience.
- **Leads see nothing new until an admin opts in.** One new settings key
  under `ack_defaults`, `leads_see_policies`: a workspace upgraded with a
  saved `ack_defaults` row reads *Group leads see policy standing* as
  off, so `/compliance/team`, the My policies banner, a lead's access to
  a member's record and the digest's Policies section stay closed to
  leads until the toggle is turned on under Program settings → Team leads
  (or `PUT /api/admin/compliance/settings` with `{ "ack_defaults": {
  "leads_see_policies": true } }`). A workspace with no saved program
  settings reads it as on, and a first save keeps it on. Evidence
  appears for whoever already holds `compliance.export`; the compliance
  report stays off until an admin turns it on and names its recipients.
- **Existing `training_team_digest` overrides must add
  `{{policy_summary}}`** to show the Policies section; without it the
  override renders exactly as before (the Training lines only). The
  default subject changed from "Your team's training this week" to "Your
  team this week"; an override keeps its own.
- The `compliance.team_read` permission is added to the Compliance
  manager role on boot, as every seeded role is refreshed; a custom role
  gains it only when granted.
- **Audit log.** New keys `ack.snapshot_failed`, `ack.snapshot_rewritten`,
  `ack.report_settings`, `ack.report_sent`, `ack.record_exported`,
  `ack.set_created`, `ack.set_updated`, `ack.set_deactivated`,
  `ack.set_deleted` and `ack.set_assigned`; `ack.snapshot` and
  `ack.audit_export` (labelled since 1.10.1) are now written;
  `ack.reminder_sent` is also written for a lead's Remind (`by: "lead"`);
  `ack.anonymised` carries `snapshots_rewritten`. Existing keys are
  unchanged; `training.leads_set` is now labelled "Set team leads" (was
  "Set training leads"), since the leads list is shared.
- **Payloads and files.** The portal payload's new keys (`attention`, the
  seven `kpis` keys, the docs and users row fields) and the mine route's
  `set_names`, `set_position` and `lead_team` are additive; a client
  built against 1.13.x ignores them, and the pages fall back to the
  1.13.0 keys where one is missing. The matrix CSV grew two columns at
  the end (32 columns now) and the per-policy CSV one (`set`, 35);
  scripts that read by column name are unaffected, scripts that count
  columns need the new totals. `set_names` on a record's rows is filled
  once sets exist in the workspace; `[]` otherwise. The bulk endpoint
  composes existing writes and outbox rows: reminders sent in bulk are
  queued and delivered within a minute or two, as the portal's Remind
  already is, and **Remind about everything outstanding** queues one
  `due` row per policy naming the people, so a person on more than three
  policies gets one notice listing them (the 1.13.0 bundling) and the
  notice log attributes those rows to the system, as it does the sweep's.
  The record page's **Remind about everything outstanding** goes through
  the same bulk action (`remind_people`): one bundled reminder.
- **Rollback to 1.13.0 is supported.** A 1.13.0 binary on a 1.14.0
  database ignores the three tables and the column (its `UNIQUE
  (document_id, kind, ref, effect)` on the rules still holds); a set
  assigned to people writes rules a rolled-back binary reads as a
  manager's. Snapshots taken on 1.14.0 stay in the table and are listed
  again after the re-upgrade; the report does not send while rolled back.
  The compliance events are new values in the `webhooks.events` list, and
  two settings-table claim keys (`ack_weekly_hook`,
  `ack_deadline_hook_{docId}`) appear as the sweeps first claim them; a
  1.13.0 binary ignores a hook row that names a policy event (it never
  fires them) and the keys.
- **Nothing is sent until a hook subscribes.** Existing hooks keep their
  events; an administrator ticks the compliance events on a hook (or adds
  one) to start receiving them. A hook with no space filter then hears the
  titles of policies in private spaces too, exactly as `document.published`
  does today: scope a hook to a space when its channel should not.

### Security
- Dependency update for an advisory published this week: markdown-it
  14.3.3 (CVE-2026-111758, quadratic-time rendering of a single
  multi-line link reference definition), transitive through the editor's
  Markdown support (tiptap-markdown and prosemirror-markdown).

## [1.13.0] - 2026-10-20

Read confirmation, part five: who must confirm (a policy's audience), a due
date for every person with a policy, space and workspace cascade, automatic
reminders and escalation from the hourly sweep, exemptions, extensions and
snooze on the roster, and asking one person to re-confirm (Enterprise,
`policy_ack`), plus two directory requests in core: section order and
section heads on exports.

### Added
- **Who must confirm: a policy's audience.** A policy asks either **everyone
  who can see its space** (space mode, what every policy did before) or
  **specific groups, people and roles** (targeted mode: Entra, Google or
  manual groups, named people, the ladder roles Viewer / Editor / Approver /
  Admin, minus exclusions, with an option to leave out the document's author
  and the space's approvers) (saving space mode clears the policy's rules,
  exclusions apply in targeted mode only, and the author is matched through
  the directory's linked names). The audience is materialised as one
  **assignment row per person** (`policy_assignments`), and every count
  reads those rows: the portal's tiles and rows, the Record tab, the people
  view, My policies, the sidebar badge, the summary behind the editor's
  question and the notices. The rule that a policy can only reach people who
  can see its space still holds: every audience is intersected with the
  space's visibility, so a rule narrows and never widens, and a person a
  rule names who cannot see the space is not enrolled (the preview counts
  them as "without access"). Saving an audience answers how many people it
  added and removed ("Audience saved: 14 people added, 3 people removed from
  the audience") and queues one request notice for the people it added or
  re-opened, worded with each person's own deadline through the shared
  outbox (people the directory hooks or the hourly sweep add are first told
  by the reminder sweep); the API is `PATCH
  /api/documents/{id}/ack-settings` with `audience_mode`, `rules` (`[{kind,
  ref, effect}]`, up to 200), `exclude_stewards` and `assign_new_members`,
  and `GET …?preview=1&rules=…` counts a draft without saving it (`{ count,
  no_access, sample }`). A saved audience is audited as `ack.audience_set`
  ("Set who must confirm a policy") with the mode, the rules and the counts.
- **Rows are kept, never deleted.** A person who leaves a policy's audience
  (leaves the group, loses access to the space, is excluded by a rule, is
  disabled) keeps their row, closed with the reason (`left_group`,
  `access_removed`, `audience_narrowed`, `disabled`); their past
  confirmations stay on the record. When they return, the same row re-opens
  with a fresh cycle and a new-joiner deadline, its reminder and escalation
  stamps cleared and its exemption history intact, and they are asked again:
  a confirmation from before they left no longer counts. Closing a row never
  touches the acknowledgements ledger.
- **New accounts are enrolled automatically.** A person created locally, by
  SCIM or at their first SSO sign-in gets a row for every policy whose
  audience admits them and has **Enrol new joiners automatically** on (the
  default), due the new-joiner days from the day they join (14 built in, or
  the space's / workspace's number; the same number every later addition to
  an audience gets), and **one welcome notice** listing the policies with
  their due dates ("Welcome: 3 policies to read", linking My policies)
  instead of one request per policy; a single policy goes as the usual
  request. The email is the new editable template **Welcome: policies to
  read** (`ack_welcome`: `count`, `policy_list`, `portal_url`, `org_name`);
  the per-kind Read confirmations email choice is honoured, the master
  switch is not, as for every notice of the family. Audited as
  `ack.auto_enrolled` ("Enrolled new account in policies").
- **Audiences follow the directory.** Adding someone to a group or replacing
  a group's members (a manual edit, an Entra or Google sync), granting or
  removing a group's membership of a private space, changing a space's
  visibility, and disabling or re-enabling an account bring the policies
  concerned in line at once. Changes made in Roles & permissions take effect
  within the hour: the hourly compliance sweep reconciles every live policy
  first (and heals a policy switched on by a rolled-back 1. A group write
  reconciles only the policies the group reaches: those with a rule naming
  it, and those in private spaces the group holds a membership grant on (or
  every private space when it holds read-all globally); the hourly sweep
  covers the rest. One policy's failure no longer stops the others: it is
  logged and counted, and the sweep heals it.12.0 binary that has no
  settings row). The scheduled directory sync's report gains the line
  **Policy audiences updated: +12 / −3** when a run moved anyone. Each
  change that moved rows is audited `ack.audience_reconciled` ("Updated a
  policy's audience") with the counts.
- **Only the people a policy asks can confirm it.** The confirmation card,
  the sticky control and the notice row appear only for a person with an
  open row; someone outside the audience, or excused from it, reads the
  document like any other, and `POST /api/documents/{id}/ack` answers 400
  "This document doesn't ask you for a read confirmation." for them.
- **Deadlines per person, with a policy, space and workspace cascade.**
  Every assignment row now carries a due date (`policy_assignments.due_at`),
  set the moment the person's clock starts: when they are enrolled, when an
  annual re-confirmation cycle fires, and when a manager asks them again.
  The date comes from the policy's own rule when it has one (a number of
  days after assignment, or a fixed date such as "by 30 June"), else from
  the space's **Policy defaults**, else from the workspace's **Program
  settings**, else from the built-in 14 days. A fixed date applies while it
  is still ahead; once it has passed, new assignments fall back to the
  relative rule rather than starting overdue. A fixed date is a calendar
  day: the person is due until that day ends in the workspace's time zone,
  so the chip, the roster and the email all name the day the manager chose.
  A deadline never blocks the document: an overdue policy is confirmed the
  same way, and the record shows the date it was confirmed.
- **Two grace periods, named apart.** *Days for new joiners* is what anyone
  who joins a policy's audience after it was switched on gets, from the day
  they are added (a new account, a person a rule, a group change or a space
  grant admits, a returner), 14 days built-in; the audience a switch-on
  enrols, and the rows the upgrade wrote, get the days to confirm instead,
  so the card's help ("New accounts and people added to the audience get 14
  days from the day they join") is what the rows do. *Grace days after the
  due date* is the time after a due date before a person counts as overdue
  (0 built-in: the moment the date passes). Overdue means the due date plus
  the grace has passed and no current confirmation stands; a confirmed row
  is never overdue, however old its date, and a row with no due date never
  is.
- **Program settings: Deadlines and reminders.** A fourth card on
  `/compliance/settings` with the seven numbers every policy inherits: days
  to confirm, days for new joiners, grace days after the due date, the first
  reminder's lead time, the days between reminders, the days overdue before
  escalation, and the days between nudges for a policy with no due date. A
  blank field keeps the built-in (the help reads "Built-in: 14"); a typed
  value must be a whole number of days in range (1 to 365; the grace 0 to
  90; nudges 0 to 365). In the API, `PUT /api/admin/compliance/settings`
  takes the seven as keys of `ack_defaults` (`due_days`, `new_joiner_days`,
  `overdue_grace_days`, `remind_before_days`, `remind_every_days`,
  `escalate_after_days`, `nudge_every_days`; `null` for the built-in) and
  refuses anything out of range with the first problem named. Each key that
  changes writes an `ack.defaults_set` audit row ("Changed policy defaults")
  with `{scope: "workspace", key, from, to}`.
- **Space policy defaults.** A space can set its own layer of the cascade:
  `PATCH /api/admin/spaces/{id}` accepts `policy_defaults`, any subset of
  the seven numbers plus `owner_user_id` (the person escalations go to for
  the space's policies), each `null` to inherit from the workspace again.
  Keys are merged over what the space holds, validated the same way as the
  workspace's, and audited per changed key as `ack.defaults_set` with
  `{scope: "space", space_id, key, from, to}`.
- **Read confirmation emails say when.** The `ack_request` template gains
  `{{due_line}}` ("Please confirm by 29 Oct 2026.") and `{{due_suffix}}` ("
  by 29 Oct 2026", appended to the default subject), and `{{due_date}}` and
  `{{days_left}}` are now filled: each from the recipient's own assignment
  row, so one notice to people with different deadlines renders once per
  distinct date, and the in-app line reads "Please read and confirm "Code of
  Conduct" by 29 Oct 2026." Dates are formatted the workspace's way (its
  date format and time zone). People with no due date get the sentences as
  before. A workspace that overrode the template keeps its own body and
  subject and adopts the new tags when it next edits them; the preview
  pane's sample now shows a due date.
- **Annual re-confirmation restarts the clocks.** When a cycle fires, every
  open assignment row of that policy gets a fresh due date from the cascade,
  and its reminder and escalation stamps are cleared, in the same
  transaction as the marker, so the notice that goes out already says the
  new date. Exempt and removed rows are left alone. The sweep's `ack.recert`
  audit row gains `rearmed` (the rows restarted).
- **Moving existing deadlines.** Changing a policy's relative rule applies
  to people enrolled from then on; **Also move existing deadlines** on the
  Settings tab recomputes every open row of the policy from the rule as it
  now stands (the fixed date while ahead, else the later of each row's cycle
  start and its assignment, plus the days, so a row the upgrade wrote dates
  forward from the upgrade and a re-asked row from its re-ask), leaves a row
  whose date would not change alone, re-arms an escalation that already
  fired when the new date is ahead, and puts the old and new dates onto the
  row's `due_history` (`{kind: "moved", from, to, by, at, reason}`, the last
  ten kept beside a manager's "extend" entries) so an SLA change is never
  lost; a move is undone by applying the previous rule again, never as an
  extension. Audited as `ack.due_moved` ("Moved read confirmation
  deadlines") with `{policy, n, from_rule, to_rule}`; the rule itself is
  `ack.due_set` ("Set read confirmation deadline") when it is saved from the
  Settings tab.
- **Automatic reminders.** Nobody clicks thirty Remind buttons any more: the
  hourly sweep reminds every person whose confirmation is due soon or
  overdue, on a cadence each policy can set and otherwise inherits (the
  Settings tab's **Reminders** card, the space's policy defaults, then
  Program settings: first reminder 3 days before the due date, then every 7
  days while it is due or overdue; a policy with no due date is nudged every
  N days only when N is above 0, never by default). A reminder is one in-app
  notice, **Due in 3 days: confirm "Acceptable Use Policy"** / **Due today:
  …** / **Overdue: …** with the date as its body, linking the confirmation
  card, and one email from the new editable template **Read confirmation due
  reminder** (`ack_due`: `doc_title`, `doc_url`, `due_date`, `due_line`,
  `status_label` Due soon / Overdue / Reminder, `org_name`). Someone with
  more than three policies to confirm in the same hour gets one notice
  instead, **You have 5 policies to confirm**, listing the titles and due
  dates and linking My policies (the template **Read confirmation reminders,
  bundled**, `ack_due_bundle`: `count`, `policy_list`, `portal_url`,
  `org_name`); the record still shows one row per policy. Snoozed, exempt
  and removed rows, confirmed people, disabled accounts, paused and retired
  policies are never reminded, and the grace days keep a row "due" rather
  than "overdue" until they have passed.
- **Escalation.** Once someone is past the due date, its grace and the
  policy's **Escalate after** days (7 by default), the policy's owner is
  told once per person: **Overdue: 7 people on "Acceptable Use Policy"**,
  body **More than 7 days overdue: Ana Ruiz, Ben Lo, +5**, linking the
  Policies page with that policy's roster expanded when the owner holds the
  Compliance section, else the policy's Record tab. Without an owner of its
  own the policy falls to its space's Policy owner (the space's Policy
  defaults), then to whoever switched the requirement on, then to the
  space's approvers; switching the requirement on records who did it, and
  the first requester is kept; an owner or requester who is not an active
  account that can see the space is passed over, and both settings routes
  refuse such a pick with 400 "The owner must be an active account that can
  see this space." The leads of every group the overdue people belong to
  hear too, linked to the policy itself (a team view comes later), but only
  about policies in spaces they can read: a lead of a broad group gets
  nothing about a private-space policy. The email is the new template
  **Overdue read confirmations, escalation** (`ack_escalation`:
  `policy_title`, `overdue_count`, `overdue_list`, `portal_url`,
  `org_name`). Extending a person's due date re-arms their escalation.
- **Two notification rows.** Account → Notifications gains **Policy
  reminders** ("A policy you must confirm is due soon or overdue") and
  **Compliance escalations** ("People you own or lead are overdue on a
  policy"), each with in-app, webhook and email switches; the bell shows the
  reminder with a clipboard-clock icon and the escalation with a shield.
  Like read confirmation requests, these emails ignore the personal master
  switch and honour the per-event email choice, and the record shows it.
- **Every automatic send is on the record.** Each reminder writes one
  ack_notices row per person and policy (kind `due`), each escalation one
  row per recipient (kind `escalation`), with the channels that went out; a
  delivery that fails is retried from the record like every other notice.
  The audit log gets `ack.reminder_auto` {policy, reminded, overdue} and
  `ack.escalated` {policy, overdue, recipients, days} by the system when the
  sweep claims, and a second entry of each with the delivery counts
  (pending, emailed, noticed, bundled) when the notices have gone out.
- **The portal's manual Remind** now also stamps the rows it reaches
  (`reminded_at`, `reminder_count`), so the automatic cadence counts from
  it. Every event-driven notice (a request, an edit's re-ask, Remind, the
  annual cycle) reaches only people who can still see the policy's space at
  delivery: a person whose grant was revoked in Roles & permissions is
  neither told nor stamped while the hourly reconcile has yet to close their
  row.
- **Exemptions, extensions and snooze on a policy's roster.** Three
  per-person levers on a policy assignment, each with a recorded reason or
  date and its own audit entry, so a programme can reach 100% honestly and
  the record explains every gap. **Exempt** (a reason, required, up to 300
  characters; an optional end date) takes the person out of every
  denominator at once: the Overview tiles, the policy's progress, the People
  view, My policies, the pending lists and the reminder and escalation
  sweeps, while the roster keeps the row with status **Exempt** and the
  exemption in plain text ("On leave until 1 Dec · Priya Shah · 3 Oct"). An
  exemption's end date is a calendar day in the workspace time zone, stored
  as that day's last instant the way a fixed deadline is, so the roster, the
  CSV and the audit row name the day the manager chose and the hourly sweep
  clears the exemption once that day has ended there. Removing an exemption,
  an exemption that expires and a per-person re-ask give the row the same
  deadline the reconcile and the re-confirmation cycle would: the policy's
  fixed date, ending in the workspace time zone, while it is still ahead,
  else today plus the days the cascade resolves. The server refuses
  exempting yourself with 400 "Ask another compliance manager to record your
  exemption.", and nothing in that request is written. **Remove exemption**
  returns the person to pending with a fresh deadline from the defaults
  cascade (the policy's days, else the space's, else the workspace's, else
  14; a fixed date still ahead wins) and their reminders start over. An
  exemption with an end date is cleared by the hourly sweep once the date
  passes and the row is re-armed the same way; a standing exemption (no
  date) stays until it is removed. **Extend** pushes a deadline out by 1 to
  365 days (7 by default) from today or from the current date, whichever is
  later, clears the escalation and any snooze, and keeps the move on the row
  (`due_history`, the last 10 moves: `{ kind: "extend", from, to, by, at,
  reason }`); **Undo** is the inverse of the last extension on each row.
  **Snooze** pauses automatic reminders for 1 to 30 days (7 by default) and
  changes nothing else: a snooze never changes a person's status, the
  numbers, the roster, an export or the record, and overdue stays a function
  of the deadline and the confirmation alone. **Unsnooze** resumes them.
- **Two endpoints, one bound.** `POST /api/admin/compliance/assignments {
  action, assignment_ids, days?, reason?, until? }` with `action` one of
  `exempt`, `unexempt`, `extend`, `undo_extend`, `snooze`, `unsnooze` or
  `reask` (the per-person re-ask, which needs a reason of 10+ characters)
  and 1 to 200 ids, for holders of `compliance.program_manage`; and its
  space-scoped twin `POST /api/documents/{id}/acknowledgements/actions` with
  the same body for a holder of `document.ack_require` on the policy's space
  (or a program manager), whose every write is bound to that document, so
  ids from another policy's roster are never touched and come back in
  `skipped`. A retired or switched-off policy takes no lever (the twin
  answers 400 "This document doesn't ask for a read confirmation.", the
  admin route reports the ids as skipped); a paused policy keeps its rows
  and takes them, so an exemption can be recorded ahead of its resumption.
  Both answer `{ ok, action, changed, skipped }` (`until` on a snooze) and
  400 with the first problem named; 402 without the licence.
- **The record and the exports carry it.** The JSON record (`GET
  /api/documents/{id}/acknowledgements`) rows gain `assignment_id`,
  `due_at`, `exempt`, `exempt_reason`, `exempt_by_name`, `exempt_at`,
  `exempt_until`, `snoozed_until` and `asked_again_at` (the person's own
  cycle start when they were asked again individually; `null` otherwise).
  The per-policy CSV's `status` column takes `exempt` (an exempt row is in
  no count, whatever confirmation it holds), and both the per-policy and the
  portal-wide CSV end with five new columns after the six of 1.12.0:
  `exempt_reason`, `exempt_by`, `exempt_until`, `snoozed_until`, `due_at`.
  Former-staff rows carry five blanks. Existing columns stay in place.
- **One audit entry per row changed**, against the policy: `ack.exempted`
  (the person, the reason, until), `ack.exemption_revoked` (by a manager, or
  by the sweep when the date passed), `ack.due_extended` (from, to, the
  days, the reason), `ack.due_extension_undone`, `ack.snoozed` (until) and
  `ack.unsnoozed`; a bulk extend adds one `ack.bulk_extended` summary (the
  count and the days). A per-person re-ask through these endpoints writes
  `ack.reconfirmation_requested` with `scope: "users"` and the `user_ids`,
  one per policy.
- **Dialogs can ask for a date.** `formDialog` fields take `type: "date"`
  (the native date input; like every native control it takes the workspace
  accent from the global rule).
- **Ask one person to re-confirm, with a reason.** Until now a re-ask was
  all or nothing: **Ask everyone to re-confirm…** moved the document's
  marker and every confirmation went stale. A suspect three-second
  confirmation, a colleague back from leave, a manager's request for one
  person: those now have their own action. **Ask to re-confirm…** on a
  roster row (the Record tab and the portal's expand row; the bar over
  ticked rows says **Ask 3 people to re-confirm**) opens one question, *Ask
  Ana Ruiz to re-confirm "Expense policy"?*, with the standing ("Their
  confirmation of version 12 stays in the record. They are asked to read the
  document and confirm again.") and one required field, **Why is this person
  being asked again?** (10 characters or more). On confirmation the document
  marker does not move: one statement restarts the confirmation cycle of
  that person's assignment row (`policy_assignments.cycle_started_at`), so
  their confirmation alone stops counting, they get a fresh deadline from
  the policy's rule (the fixed date while still ahead, else today plus the
  days to confirm) and their reminder and escalation stamps clear so the
  automatic reminders start over for the new deadline. Everyone else's
  confirmation, the Remind cooldown and the annual cycle's next date are
  untouched, and the prior confirmation stays in the record tied to the
  version it covered. The History tab gains a row (**Asked again**, source
  *Manual*, your reason, "1 affected"), and only the people named are told,
  at once, in the re-ask wording with your reason as the body. On the
  document they see *"Dana Whitfield asked you to confirm this document
  again on 3 Mar 2026: "…""* above the statement, the strip's *"… asked you
  to confirm this document again on 3 Mar 2026. Please read it and confirm
  again."*, and the sticky chip **Re-confirm needed**; the roster row reads
  **Asked again 3 Mar 2026**. People named who are exempt, whose row was
  closed, or who were never asked are skipped and listed back; when nobody
  named has an open row the request is refused ("This person isn't asked to
  confirm this document." / "None of these people are asked to confirm this
  document.") and nothing is written. A per-person ask has a brake of its
  own: a person asked *again* within the last hour is skipped (a person in
  their first cycle, however recent, can be asked at once, so a suspect
  three-second confirmation is never held up); when that is why nobody named
  could be asked, the route and the assignments endpoints' reask answer 429
  "Ana Ruiz was asked again 12 minutes ago." ("These people were asked again
  12 minutes ago." for several), and otherwise those ids are listed in
  skipped. It stamps no policy-wide cooldown, so asking one person again
  never blocks Remind or a whole-audience ask, and vice versa.
- **The per-person re-ask API.** `POST /api/documents/{id}/ack/reconfirm {
  reason, user_ids }` (the same route and guards: `document.ack_require` on
  the space or `compliance.program_manage`; 402 without the licence) takes
  `user_ids` as a list of up to 200 user ids (duplicates collapse) and
  answers `{ ok, reset, queued, user_ids, skipped }`: `user_ids` the people
  whose cycle restarted (and who are notified), `skipped` the rest of the
  list. 400 with the first problem named: "user_ids must be a list of user
  ids.", "Choose at least one person.", "Ask up to 200 people at a time.",
  the reason rule, or the nobody-open sentence above (the answer then also
  carries `skipped`); 429 when nobody named could be asked because everyone
  with an open row was asked again inside the last hour (the answer carries
  `skipped`). Without `user_ids` (or with `null`) the route is the
  whole-audience ask it was. The assignments endpoints' `reask` action
  reaches the same statement by assignment id, across policies.
- **A per-person ask on the ledger.** It is a `reset` row of scope `users`
  (`ack_decisions.scope`, reserved since 1.10.0): `confirmations_affected`
  is the number of rows re-opened, `eligible` the audience, `decided_at` the
  same instant the rows carry as their new cycle start, `reason` yours. The
  audit entry `ack.reconfirmation_requested` carries `scope` (`all` |
  `users`), `user_ids` (the people re-asked; `null` for a whole-audience
  ask), `skipped` and `cooldown` (the subset of `skipped` held by the hour),
  beside the counts it had.
- New tests: `test/ack-audience.test.ts` (the rule sanitiser and the toast;
  space mode equal to the old set on an internal and a private space; the
  cycle-aware currency across the reader, the summary, the roster and My
  policies; a group rule hit and miss, a named person, an exclude rule, the
  preview, and back to space mode re-opening the same rows; a named person
  without access not enrolled until the grant; stewards left out;
  leave-and-rejoin re-opening the same row with its history; disable and
  re-enable; the 400 for an unassigned person; a new account enrolled with
  one welcome, one mail and one record row per policy, a single policy as a
  request; the migration leaving every count identical) with the shared
  fixture helper `test/support/assign.ts`; `test/ack-due.test.ts` (the
  cascade with its origins and both validators, the end of a fixed day in
  four zones, a past fixed date falling back, calendar days left, overdue
  with grace, the three layers and the workspace audit row, moving deadlines
  with the history bounded to ten, the cycle's re-arm through every layer,
  the email tags with and without a date, one notice to three people with
  two dates); `test/ack-sweep.test.ts` (two parallel sweeps claim each row
  once; the cadence through the policy, space and workspace layers; snoozed,
  exempt, removed, confirmed and disabled rows and paused or retired
  policies never claimed; the grace; escalation once after due plus grace
  plus escalate days, the recipients per policy and a lead off a private
  space; the re-arm after an extension; the manual stamp) and
  `test/ack-outbox.test.ts` (the bundle for a person on four rows with one
  mail, the per-person wording and the email opt-out, a failed bundle
  charged to every row and resumed by the retry, the escalation row's two
  links); `test/ack-exempt.test.ts` (an exempt row out of every denominator;
  self-exemption refused and nothing written; the 300- and 200-bounds;
  un-exempt re-arming through the cascade; expiry; the extend math,
  `due_history` and the last-ten rule; undo; snooze clamped at 30 with the
  invariant proved by a before-and-after snapshot of status, summary, roster
  and CSV; the document bound on every lever; the per-person re-ask through
  the dispatcher) and `test/ack-retention.test.ts` (both headers' legacy
  prefix with the five columns); `test/ack-reask.test.ts` (a per-person ask
  leaving the marker and everyone else's currency; the decision row's scope
  and counts; only the people named told; exempt and removed people skipped;
  the whole-audience path unchanged); `test/ack-boot.test.ts` (the three
  tables, the indexes, the flag, the spaces column and the payload column
  after an upgrade boot; a second boot moving nothing; the KPI equality
  before and after the migration) and `test/compliance-settings.test.ts`
  (`due_days` a known key). The e2e specs gain the per-person re-ask's two
  400s (`e2e/compliance-portal.spec.ts`) and the eleven trailing CSV columns
  (`e2e/compliance-rbac.spec.ts`).
- **Export presets: a preview of the sections, and their order.** In a
  preset's **Order and filter** card, choosing a **Sections by** field now
  opens a **Section order** list right under it: one row per section the
  field makes of the people the preset prints (its **Only people where**
  filter applied), labelled as the PDF prints them, with a count ("Phoenix ·
  12 people"), in the field's own order (a field with options in their
  order, other values alphabetically). Move up and Move down put the
  sections in the order the file should print them; **Reset to field order**
  goes back to the field's own. A value that is not in the list (a new
  office, a value nobody had when the order was set) prints after the listed
  ones, in the field's order, and "No <field>" stays last. The PDF (the
  table, the two- and three-column layouts and the photo cards), the CSV's
  Group column and the contacts export follow the order; a **One file per**
  zip split by the same field names its files in it too. The Directory
  page's Groups view is unchanged. In the API: a preset's `section_order`
  (the group values, up to 200, each once; dropped when the preset has no
  Sections by field, and cleared when the field changes), `GET
  /api/admin/directory/export-presets/sections?field=<key>&filter=<JSON>`
  (`{ sections: [{ value, label, count }] }`; 400 for a field the export
  cannot section by), and `section_order` as an export override (a JSON
  array; a request that overrides `group_by` without one, "What I see"
  included, starts from the field's order).
- **Section heads: the people who head a department, an office, any
  section.** Under **Settings → Directory → Fields**, the options of any
  field the directory can make sections by (what **Sections by** offers)
  gain a **Heads** list: for each option, up to five people, picked by name
  and shown with their own value for the field ("Jane Smith · Executive"),
  since the point is a head who sits elsewhere, as department heads in an
  executive or admin department do. On the Directory page's **Groups** view
  each group lists its heads first, in the order set, with a **Head** chip
  after the name, and its heading reads "Engineering (13) · Head: Jane
  Smith" ("Heads: Jane Smith, Pat Lee" for several); a head whose own value
  is another group is an ordinary tile there as well. On exports that make
  sections by that field (the PDF's table, its two- and three-column
  layouts, the photo cards, and every file of a **One file per** zip), each
  section starts with its heads as rows like any other, the name followed by
  " · Head" (after the name format and the marker symbols), and the
  section's heading carries " · Head: Jane Smith"; a head who sits in the
  section they head prints once, at its top, and the heading's count covers
  members and heads. A head is drawn from the people the export covers, so
  one a preset's **Only people where** leaves out leads no section in it,
  and every file of a **One file per** zip draws from the whole zip (a head
  whose own value is another section still leads their section's own file).
  The CSV ends every row with a **Section head of** column, after Markers,
  listing the sections the person heads ("Engineering; Design"), whether or
  not the file makes sections; a head prints once in the CSV, where their
  own value puts them (a head of the section they sit in leads it), as in
  the contacts export, so the toggle changes no row of a spreadsheet. The
  contacts export is unchanged: one card per person, where their own value
  puts them. A new preset toggle in **Order and filter**, **Section heads
  first** (on; shown only once the Sections by field has a head), puts the
  heads at the top; off, they print only where their own value puts them and
  the heading carries no suffix. The **Section order** list names each
  section's head under its count. A person who leaves the directory, or is
  hidden, stops heading a section at once, with nothing to edit. In the API:
  an option's `heads` (directory person ids) on `GET` / `POST
  /api/admin/directory/fields` and `PATCH …/fields/{id}` (400 for an id that
  is not a whole number, more than five, or a person the directory does not
  have), `section_heads` on a preset and as an export override, and `heads:
  [{ id, name }]` per section from `GET
  /api/admin/directory/export-presets/sections`. A field save that changed
  who heads a section audits as `directory.field_updated` with
  `heads_changed: true`.
- **Settings tab: Who must confirm, Deadline and Reminders.** The Read
  confirmation page's Settings tab gains three cards between Confirmation
  statement and Re-confirmation, all under its one **Save settings** row.
  **Who must confirm**: a stacked radio group, **Everyone who can see this
  space** ("Every active account with access to the space, and anyone who
  gains access later.") or **Specific groups, people and roles** ("Only the
  groups, people and roles named here, minus any exclusions."); the second
  opens the pickers **Groups** (each group marked Entra, Google or Manual),
  **People** (under it the rule "People must be able to see this document's
  space. Someone who cannot is shown as "No access" in the preview and is
  not required until access is granted in Space settings."), the **Roles**
  checkboxes (Viewer, Editor, Approver, Admin) and **Exclude** (groups and
  people in one box, placeholder "e.g. Contractors"); a targeted audience
  naming nobody is refused inline ("Name at least one group, person or
  role."). Two checkboxes apply in both modes: **Exempt the document's
  author and approvers** (off) and **Enrol new joiners automatically** (on,
  with "New accounts and people added to the audience get 14 days from the
  day they join"). The live line under them counts the rules as the card
  holds them, nothing written: "Applies to 412 people · 3 without access"
  (the clause only when someone named cannot see the space). Saving toasts
  "Audience saved: 14 people added, 3 people removed from the audience" or
  "Audience saved. Nobody was added or removed." **Deadline**: a stacked
  radio group, **Inherit (14 days, from Security)** (or "…, the workspace
  default" / "…, built-in", naming where the number comes from), **Days
  after assignment** with a Days field (1 to 365, refused inline outside
  that) or **Fixed date** with a date (today or later; "The deadline cannot
  be in the past."; a stored date that has passed shows "This date has
  passed; new assignments use the inherited days until you set another
  date." and Also move existing deadlines recomputes from the inherited days
  without re-sending it One Save applies the deadline rule before the
  audience, so people the same save adds are dated by the rule as saved;
  "Also move existing deadlines" runs after both.); the helper line "Current
  audience: due 29 Oct 2026 · new joiners: 14 days after they join" reads
  the stored rule; the secondary button **Also move existing deadlines**
  recomputes every open deadline from the rule as the card holds it and
  toasts "Moved 412 deadlines" with **Undo** (the previous rule re-applied
  the same way) when the rule changed, or without Undo when it did not (a
  move under the same rule has no inverse). Changing the days applies to
  future assignments; setting or changing a fixed date moves every open
  deadline by itself and the save toasts "Moved 412 deadlines" beside
  "Settings saved.", with Undo. **Reminders**: four number fields in a
  two-column grid, **Remind before due (days)**, **Remind every (days while
  overdue)**, **Escalate after (days overdue)** and **Nudge without a
  deadline every (days, 0 = never)**, each reading "Inherited from workspace
  (3)", "Inherited from Security space (3)" or "Built-in (3)" while blank
  and the field's own sentence once set; and **Policy owner**, a people
  picker whose placeholder is whoever switched the requirement on, with
  "Hears when people are overdue. Leave blank for whoever switched the
  requirement on, else the space's approvers." Re-confirmation and Lifecycle
  are unchanged.
- **`PATCH /api/documents/{id}/ack-settings` takes the three cards'
  fields.** Beside the audience fields above: `due_days` (1 to 365 or null
  to inherit), `due_at` (`YYYY-MM-DD`, today or later, or null) and
  `move_existing` (true moves every open deadline to the rule as it now
  stands; a new or changed fixed date moves them without it; the answer
  carries `moved`), `remind_before_days`, `remind_every_days`,
  `escalate_after_days`, `nudge_every_days` (each in its range or null to
  inherit) and `owner_user_id` (a user id or null; "Owner not found." for an
  unknown id, "The owner must be an active account that can see this space."
  for one who is not), any subset in one call, 400 naming the first problem
  before anything is written; one save of the audience writes the rules and
  reconciles the rows, answering `added`, `closed` and `reopened`, and a
  targeted audience with no include rule is 400 "Name at least one group,
  person or role.". `GET` answers every field beside `owner_name`,
  `requested_by` (whoever switched the requirement on: written by the
  switch-on itself, through the portal's Request or the popover, and kept
  across a later switch-on), `defaults` (the cascade resolved with the
  policy's own layer: `values`, `origin` per key, `space`) and `inherited`
  (the same cascade without it: what a blank field falls back to). Audit:
  `ack.audience_set` {mode, rules, exclude_stewards, assign_new_members,
  added, closed, reopened}; `ack.due_set` {due_days, due_at, from_rule,
  moved_existing, moved} beside the move's own `ack.due_moved`;
  `ack.defaults_set` {scope: "policy", space_id, key, from, to} per reminder
  number or owner that changed, as the space and workspace layers audit
  theirs; the 1.12.0 fields keep `ack.settings_changed`.
- **The shield popover links All settings.** The Read confirmation popover
  keeps its four controls (the Require toggle, the status line with View
  record, When the text changes, Ask everyone to re-confirm…) and gains one
  link, **All settings**, to the document's Read confirmation Settings tab
  for holders of `document.ack_require` on the space or
  `compliance.program_manage`; the audience, the deadline and the reminders
  are set there, never in the popover.
- **Space settings: Policy defaults.** Editing a space (Settings → Spaces)
  opens a **Policy defaults** disclosure with the seven numbers of the
  deadline cascade (Days to confirm, Days for new joiners, Grace days after
  the due date, First reminder, Days between reminders, Days overdue before
  escalation, Days between nudges), each with the placeholder "Inherit (14)"
  showing the workspace's number, and a **Policy owner** picker; a blank
  field inherits, and the values save with the space through `PATCH
  /api/admin/spaces/{id}` `policy_defaults` (refused inline outside each
  range). A policy in that space then reads "Inherit (21 days, from
  Security)" on its Deadline card and "Inherited from Security space (3)"
  under a blank reminder field.
- **The roster acts on its rows.** The Record tab and the portal's expand
  row (`AckRoster`) gain a leading checkbox column, row actions as icon
  buttons (Extend due date…, Exempt…, Remove exemption, Snooze / Unsnooze
  (the date in the toast; Unsnooze's Undo re-snoozes for the days that were
  left), Ask to re-confirm… on a row with a current confirmation) and a bulk
  bar "{n} selected" with the same actions over the checked people (up to
  200 at a time). Every action tells and offers Undo as the inverse call
  ("Exempted Ana Ruiz from "AUP" · Undo", "Extended 12 deadlines by 7 days ·
  Undo", "Snoozed reminders for Ana Ruiz until 27 Oct 2026 · Undo"); the
  re-ask is a notice already sent and offers none ("Ana Ruiz will be asked
  to re-confirm."). A steward holding `document.ack_require` on the policy's
  space acts through the document's own route, a program manager through the
  admin route; the control is disabled while a request is in flight and
  focus returns to the row.
- **Due and Exemption columns.** The roster shows each person's deadline
  and, in plain text, their exemption ("On leave until 1 Dec 2026 · Priya
  Shah · 3 Oct 2026"), the reason and asker of a per-person re-ask, or a
  snooze ("Snoozed until 22 Oct 2026"); the snooze invariant is spelled out
  under the table whenever a snoozed row is on the page.
- **Overdue, Exempt and "Asked again" on the roster.** Status chips gain
  **Overdue** (red, past the due date and the policy's grace) and **Exempt**
  (neutral); a row asked to re-confirm on its own carries "Asked again
  {date}" beside Pending after a real re-ask; the Show filter gains Overdue
  and Exempt.
- The roster JSON (`GET /api/documents/{id}/acknowledgements`) adds
  `asked_again_reason` and `asked_again_by` to each row's re-ask fields and,
  beside `rows`, `defaults.overdue_grace_days`, the policy's resolved grace.
- **Due dates for readers.** A policy's deadline now reaches the person it
  applies to, as information and never a wall: the confirmation card at the
  end of the document carries a chip "Due 29 Oct 2026" (neutral more than
  three days out, amber at three or fewer) or "Overdue since 29 Oct 2026"
  (red); once overdue, one sentence above the same button says "This was due
  29 Oct 2026. Confirming now still records today's date." The notice
  strip's one sentence gains " by 29 Oct 2026" and keeps its one action; the
  sticky document bar shows "Due in 2 days", "Due tomorrow", "Due today" or
  "Overdue" beside the jump link (only "Overdue" stays on a phone). Every
  cue leaves with the pending state. The date comes from the reader's own
  assignment row and the grace from the policy's defaults cascade, formatted
  in the workspace's date format and time zone, so the three surfaces name
  one day.
- **My policies knows about deadlines.** Each row carries the person's due
  date; the To confirm group is ordered overdue first, then the soonest
  deadline, then the most recently changed, and its chips read "Overdue ·
  due 29 Oct 2026" (red) or "To confirm · due 29 Oct 2026" (amber); "Changed
  since you confirmed {date}" and "Confirmed {date} · v12" are unchanged.
  The empty state says policies will appear "with their due dates". `GET
  /api/compliance/mine` rows gain `due_at` and the state `'overdue'`, and
  arrive in the page's order.
- **The dashboard counts the overdue ones.** The "Needs your attention" row
  reads "3 policies need your read confirmation · 1 overdue" and names each
  deadline in its detail ("Expense policy (due 29 Oct 2026)" after the
  space's icon), listing the overdue policy first. New
  `countOverdueAcksFor(userId, scope)` beside `countPendingAcksFor`;
  `listPendingAcksFor` rows gain `due_at` and `overdue`.
- **Each reader is told their own reason.** After a per-person re-ask the
  person asked reads "{name} asked you to confirm this document again on
  {date}" on the strip (ending "by {date}" with their fresh deadline) and
  the card (with the reason), while someone whose confirmation lapsed with
  an earlier whole-audience ask keeps reading that one: the page matches the
  ledger row written at the same instant as the reader's own row (new
  `getMyAssignment(docId, userId)`), and falls back to the newest
  whole-audience reset otherwise. The popover's "asked {date} by {name}"
  speaks for the whole audience only.
- **The portal row's Settings button.** Each live row on Compliance ›
  Policies carries an icon button, **Read confirmation settings** (the
  tooltip and the accessible name), for `compliance.program_manage` holders,
  opening the policy's Settings tab (`/doc/{id}/acknowledgements/settings`):
  who must confirm, the deadline, the reminders, the statement and the rest
  live there, not on the portal.
- **"+6 enrolled this week" on the portal row.** A live row's meta line says
  how many people joined the policy's audience in the last seven days (open
  rows assigned since then: a new account enrolled on arrival, a person a
  rule or a group change admitted, everyone a switch-on enrolled); nothing
  when nobody did. Someone returning to the audience keeps their row and is
  not an enrolment.
- **The deadline on the portal row.** The same meta line reads the policy's
  rule and its standing: **Due 14 days after assignment** (the policy's own
  days, else the space's, the workspace's or the built-in 14) or **Due 29
  Oct 2026** for a fixed date, followed by **· 12 overdue** once anyone is
  past their due date and the grace with no current confirmation.
- **The reminder cadence on the portal row.** A second meta line replaces
  the bare "last reminded 3 hours ago": **last reminded 2 days ago · next
  automatic reminder 29 Oct 2026**, the first half from whichever came
  later, the manual Remind or the sweep (both stamp the same rows), the
  second from the hourly sweep's own rule (before the due date, every N days
  while overdue, a snooze pushing it out), **never reminded** while nobody
  has been, and the next re-confirmation date after it as before.
- **Overdue confirmations on the Overview.** Compliance › Overview gains a
  sixth tile, **Overdue confirmations**: over the live policies, the open
  rows whose due date and grace have passed with no current confirmation
  (the part of Outstanding that is late). `GET /api/admin/compliance`
  carries it as `kpis.overdue`.
- **An Overdue column on the People page.** Each person's row shows how many
  of their outstanding confirmations are past their due date: an error chip
  **2 overdue** when any is, a plain 0 otherwise. `users` rows of the portal
  payload carry `overdue`.
- **The portal payload's new row fields.** Every `docs` row of `GET
  /api/admin/compliance` carries `enrolled_week`, `overdue`, `due_rule` (`{
  due_days, due_at, resolved_days }`: the policy's own rule, both null when
  it inherits, and the days the cascade settles on) and `reminder` (`{
  last_reminded_at, next_reminder_at }`, null on a paused or retired row).
- New tests: `test/ack-statement.test.ts` gains the settings route's new
  fields (the GET's two resolutions agreeing on a fresh policy; the preview
  in space mode and for one user rule, its 400s, nothing written; the
  audience's five refusals, a targeted save closing the unnamed rows with
  its audit row, space mode re-opening them; the deadline's four refusals,
  30 days applying to future rows only, the move dating each row cycle start
  plus 30 with `ack.due_set` and `ack.due_moved`, a fixed date moving by
  itself to the end of its day, the same date again writing nothing; the
  cadence's four refusals, three keys audited as `ack.defaults_set` with
  scope `policy`, the same values again writing none, a clear audited; no
  `ack.settings_changed` from any of it); `test/my-policies.test.ts` (the
  deadline order with its tiebreak over 21 policies, the dashboard's order
  and `due_at` / `overdue`, an overdue row first and counted once by
  `countOverdueAcksFor`, `getMyAssignment`); NEW `test/ack-portal.test.ts`
  (a backdated row overdue on the policy and the person while a confirmed
  one is not and the required and confirmed counts do not move; a row with
  no due date never overdue; the space's grace delaying both counts and a
  shorter one restoring them). The e2e specs gain the Settings tab's three
  cards and the space disclosure (`e2e/ack-settings.spec.ts`), the Record
  tab end to end (NEW `e2e/ack-roster.spec.ts`: the Due and Exemption
  columns, the Overdue and Exempt filters, Extend and Exempt with Undo,
  Snooze and Unsnooze, Ask to re-confirm… with its chip, the bulk bar over
  two rows), the twin route's bound, the snooze invariant and the
  self-exemption 400 (`e2e/compliance-rbac.spec.ts`), My policies' overdue
  row and the reader's cues (NEW `e2e/my-policies.spec.ts`), the per-person
  re-ask's own sentence on the card (`e2e/acknowledgements.spec.ts`) and the
  portal row's settings button, "+1 enrolled this week", the deadline copy,
  the Overdue tile and the reminder subtitle
  (`e2e/compliance-portal.spec.ts`).

### Changed
- "Who owes a policy" is no longer recomputed from the space's visibility at
  read time; it is the policy's open assignment rows (not removed, not
  exempt) for active accounts. The portal, the Record tab, the people view,
  My policies, the badge, the dashboard row, the summary, the counts frozen
  on retirement and the notices all read the same rows, and a confirmation
  is current against the later of the document marker and the person's own
  cycle start, so a per-person re-ask or a return to the audience shows that
  person pending and nobody else.
- The nav gate for Compliance (`hasPolicyInScope`) now asks whether any
  policy in scope asks this person, not whether a policy exists in scope:
  people outside every audience no longer see the item.
- Switching a policy's requirement on and un-retiring it reconcile the
  audience at once (the switch-on also writes the policy's settings row);
  retiring leaves the rows as they are, since `ack_required = 0` already
  takes the policy out of every sum.
- **The document's "last decision" is the whole audience's.** The shield
  popover's status line, the summary API's `last_decision`, the Record tab's
  subtitle and the portal's "Last asked" line are dated from the newest
  decision that concerned everyone (scope `all`); a per-person re-ask is a
  row in History, not the document's last ask. (`lastAckDecision` takes
  `scope`; `ackSummary` asks for `all`.)
- `claimReconfirmation` no longer throws on `userIds`: it is the per-person
  statement, in the same transaction shape as the whole-audience one (the
  ledger row and the notice roll back with it). Its answer carries `scope`,
  `asked_at`, `user_ids` and `skipped` on both paths.
- The hourly tick's read-confirmation work is one orchestrator,
  `complianceHourly` (the audience reconcile, expired exemptions, reminders,
  escalations, then the re-confirmation cycles, each an atomic claim with
  its own error handling, tagged `[compliance]` in the log), in place of the
  1.12.0 inline re-confirmation call. `claimDueRecertifications` and
  `recertifyDueAcks` take the workspace defaults and time zone the tick
  loads once (`defaults`, `timeZone`) and read them themselves when a caller
  passes none.
- `GET /api/documents/{id}/acknowledgements` rows and the roster sort exempt
  rows last (pending, then confirmed, then exempt).
- The pg `date` parser now reaches two columns: `documents.ack_effective_at`
  and `policy_settings.due_at`, both read as `'YYYY-MM-DD'` text on purpose.
- The empty-body answer of `PATCH /api/documents/{id}/ack-settings` lists
  the eighteen settable fields.
- The Settings tab saves only the fields that changed since the last save
  (the rules travel whole whenever any of them moved), so an unrelated save
  never re-judges a stored fixed date that has since passed.
- The Record tab's Show filter is All / Pending / Overdue / Confirmed /
  Exempt; Pending still lists everyone who has not confirmed (overdue people
  included) and never an exempt person.
- The version history's reset chip says "Asked 3 people to re-confirm"
  ("Asked 1 person …") for a per-person re-ask instead of "Asked everyone to
  re-confirm" (the history page passes the decision's scope and count).
- The audit label for `ack.reconfirmation_requested` is now "Asked to
  re-confirm" (it covers the whole-audience and the per-person ask).
- The dashboard's policies row lists the person's priority (overdue, then
  the soonest deadline, then the most recently changed) instead of the most
  recently changed alone, so its three titles are My policies' first three.
- **The portal row's meta text is two lines.** The first is the audience and
  the deadline ("Updated 3 Oct 2026 · +6 enrolled this week · Due 29 Oct
  2026 · 12 overdue"), the second the reminders and the cycle ("last
  reminded 2 days ago · next automatic reminder 29 Oct 2026 · Next
  re-confirmation 1 Jan 2027"); nothing moved off the row.
- **The expand row's roster acts.** Expanding a policy row on Compliance ›
  Policies now shows the Record tab's roster with its checkbox column, the
  Due and Exemption columns, the Overdue / Exempt / Asked again chips, the
  row actions and the bulk bar, posting to
  `/api/admin/compliance/assignments` for `compliance.program_manage`
  holders and read-only for everyone else; every action and every Undo
  reloads that roster and the counts above it.
- The All confirmations view and the ledger CSV measure a confirmation
  against the later of the document marker and the person's own cycle, as
  every count does, so after a per-person re-ask they agree with the Current
  version view.
- A pause does not stop the clock: when a paused policy is published again
  (by hand, in bulk, on schedule or through an approved change request), or
  a retired one is un-retired, every open row whose deadline ran out
  meanwhile is re-armed from the cascade with its reminder and escalation
  stamps cleared, so nobody is overdue and escalated at the first tick for a
  date that passed while nothing was asked.

### Upgrading
- **Schema additions, all metadata-only.** Three new tables
  (`policy_settings`, `policy_audience_rules`, `policy_assignments`) with
  four indexes; one column on `spaces`, `policy_defaults` (jsonb, NOT NULL
  DEFAULT `'{}'`); and one on `ack_outbox`, `payload` (jsonb, nullable, no
  default: what a sweep hands the delivery beside the recipient list). A
  1.12.0 binary boots on a 1.13.0 database and ignores all of them. Every
  existing space reads as inheriting everything; the workspace's existing
  `ack_defaults` keys (`edit_default`, `keep_reason_required`,
  `recert_months`) are untouched, and the seven new keys are absent until an
  admin saves the card, which reads as the built-ins.
- **One migration, and no count moves.** On the first boot a one-shot
  migration (flag `policy_assignments_migrated`, counts logged as `[ack]
  policy audiences materialised: …`) writes one settings row per policy that
  requires confirmation or was retired (space mode, new joiners enrolled)
  and one open row per person who owed it under 1.12.0's rule, dated from
  the confirmation marker, so every roster, every tile and every
  confirmation's currency are the same before and after
  (test/ack-boot.test.ts proves it on a 1.12.0-shaped database, booted
  twice). Nothing is sent: the welcome notice is for accounts created after
  the upgrade. A policy switched on by a 1.12.0 instance during a rolling
  deploy, or an account created or a policy switched on while rolled back to
  1.12.0, heals at the next hourly sweep; the rows it writes take the
  policy's cycle, so every confirmation recorded in the meantime stays
  current and no count moves.
- **Nothing starts overdue, and nothing is reminded or escalated on its
  own.** The migration dates nobody; due dates appear as rows are enrolled,
  re-asked or cycled from now on, and a workspace that wants its existing
  audiences dated sets a rule on the policy's Settings tab and uses "Also
  move existing deadlines", which dates every open row from its cycle start.
  A row is reminded only once its due date is within the cadence, and
  escalated only once it is past the due date by the grace and the escalate
  days, so a workspace whose policies get 14-day due dates sees its first
  automatic reminders eleven days later; set the numbers under Program
  settings → Deadlines and reminders before then if the built-ins are not
  wanted. A crash between the claim and the notice drops that cycle's
  reminder (the next cadence step sends it), as training does.
- Read confirmation emails and in-app lines gain the "by {date}" clause only
  for people whose row carries a due date; everyone else sees the 1.12.0
  copy. Custom `ack_request` templates are not changed.
- **Rollback to 1.12.0 is supported.** The exemption, snooze and deadline
  columns live on `policy_assignments`; 1.12.0 ignores them and counts
  eligibility the old way, so after a rollback a targeted audience reads as
  everyone in the space and an exemption recorded on 1.13.0 is not honoured
  (everyone is counted again) until the upgrade is repeated; nothing is
  lost.
- Both CSV headers grew five columns at the end (the per-policy file now has
  34 columns, the portal-wide file 30). Scripts that read by column name are
  unaffected; scripts that count columns need the new totals.
- `POST /api/documents/{id}/ack/reconfirm` now accepts `user_ids` (a client
  that sent it before 1.13.0 was answered 400 "Per-person re-asks arrive
  with audiences."); the `ack.reconfirmation_requested` audit entry gains
  `scope`, `user_ids` and `skipped`, and existing keys are unchanged.
- **Audit log.** New keys `ack.audience_set`, `ack.auto_enrolled`,
  `ack.audience_reconciled`, `ack.due_set`, `ack.due_moved`,
  `ack.defaults_set`, `ack.exempted`, `ack.exemption_revoked`,
  `ack.due_extended`, `ack.due_extension_undone`, `ack.bulk_extended`,
  `ack.snoozed`, `ack.unsnoozed` and `ack.reminder_auto`; `ack.escalated` is
  now written; `ack.recert` carries `rearmed`. The seven deadline and
  reminder numbers under Program settings audit as `ack.defaults_set` (scope
  `workspace`) rather than `settings.compliance`; the other program settings
  are unchanged.


- Nothing to run for the cards, the roster, the reader's cues or the portal:
  they read the rows and columns the migration and the sweeps write. A
  policy without a `policy_settings` row (switched on by a 1.12.0 binary
  during a rolling deploy) gets one on its first save from the Settings tab
  or at the next hourly reconcile, whichever comes first; until a policy has
  an assignment row for a person, that person sees no card and no cues, as
  the audience rules say.
- The portal payload's new fields (`kpis.overdue`, `users[].overdue`, and
  `enrolled_week`, `overdue`, `due_rule`, `reminder` on `docs` rows) and the
  roster JSON's `asked_again_reason`, `asked_again_by` and `defaults` are
  additive; a client built against 1.12.x ignores them. The overdue counts,
  the tile and the People column read `policy_assignments.due_at` through
  the grace cascade, so a workspace upgraded from 1.12.0, whose migrated
  rows carry no due date, shows 0 overdue until deadlines are set.
- **Directory: nothing to migrate.** A preset saved before 1.13.0 has no
  section order and prints its sections in the field's order, as it did; no
  option has heads until an admin picks some, and until then every page, PDF
  and CSV is what it was (a preset saved before 1.13.0 reads as **Section
  heads first** on, which prints nothing new while no field has a head). A
  1.12.x binary reads a field with heads and ignores them; saving that field
  while rolled back writes its options without their heads, which must be
  picked again after the re-upgrade.

## [1.12.0] - 2026-10-19

Read confirmation, part four: a page of your own, the Record tab as a
ledger, the statement and a typed signature on every confirmation, annual
re-confirmation on an interval, and retirement. (Enterprise, `policy_ack`.)

### Added
- **My policies.** Compliance in the main navigation now opens on a page
  of your own: every policy you are asked to read and confirm, and where
  you stand on each. A standing line ("3 of 5 policies confirmed") and a
  progress bar, then two groups: **To confirm** (the most recently
  changed first, matching the row's "Updated" line) and **Confirmed**. Each row is the policy's space and title,
  linking straight to the confirmation card at the end of the document,
  when it was last saved ("Updated 3d ago"), and one chip from a closed
  set: **To confirm**, **Changed since you confirmed 3 Mar 2026** (an
  edit, a re-ask or the annual cycle lapsed an earlier confirmation) or
  **Confirmed 3 Mar 2026 · v12**. A filter box appears over ten rows.
  With nothing in scope the page reads "Nothing to confirm"; once
  everything is confirmed, "You're up to date. 5 policies confirmed."
  closes the Confirmed group. No history, print or CSV here: the person
  record (1.14.0) holds those. In the API: `GET /api/compliance/mine`
  answers `{ rows: [{ id, title, space_icon, space_name, state,
  acknowledged_at, prior_acknowledged_at, rev, updated_at }], confirmed,
  total }` with `state` one of `pending`, `reconfirm` or `confirmed`
  (`overdue` arrives with due dates in 1.13.0); any role, 402 without the
  licence.
- **The Compliance section is routed.** One header and a tab row over
  **My policies** (`/compliance`), **Overview** (`/compliance/overview`,
  the tiles), **Policies** (`/compliance/policies`: Request read
  confirmation, every policy's progress with Remind, Ask everyone to
  re-confirm…, Stop requiring, the per-policy download, the roster expand
  and the Paused group, and the matrix's Export CSV on the Policy progress
  card) and **People** (`/compliance/people`), with **Settings**
  (`/compliance/settings`) as the last tab. The row lists only the tabs
  the viewer may open: the three portal pages need
  `compliance.program_read` (anyone else gets the not-found page, as the
  training pages answer), Settings needs `compliance.program_manage`.
  Every portal action, dialog, toast and sentence is as it was.
- **Who sees Compliance.** The sidebar row shows for anyone with a policy
  in a space they can see, not only portal managers, and never without
  the licence: people whose workspace keeps every policy in spaces they
  cannot see never get the row, and it stays once everything is
  confirmed. The row carries a badge with the number of policies to
  confirm ("3 policies to confirm" to a screen reader), like Training's
  open assignments; while it does, the sidebar's More fold stays open, so
  work waiting for you is never behind a fold.
- **What the reader confirms is on the record.** Every confirmation now
  stores the confirmation statement the server showed when the button was
  pressed, as `statement_text` on the row, so an auditor reads the words the
  person agreed to rather than the words the workspace uses today. The
  statement is the policy's own when it has one (below) and the workspace
  default from Program settings otherwise; the client never supplies it. The
  row also keeps the browser's User-Agent (`user_agent`, the first 300
  characters; the audit row carried it since 1.10.1, the record did not),
  shown and exported under the same rule as the IP address. The JSON record
  (`GET /api/documents/{id}/acknowledgements`) carries `statement_text`,
  `signed_name` and `identity_proof` on every row and former-staff row
  (`null` while pending). Confirmations from before 1.12.0 read as unsigned
  with no statement text; nothing is backfilled or guessed.
- **A policy can carry its own confirmation statement.** The Read
  confirmation page gains a **Settings** tab (Record · History · Settings,
  shown to holders of `document.ack_require` on the space and to program
  managers) with a card, **Confirmation statement**, and one **Save
  settings** row. The statement field ("Shown above the confirm button and
  stored with every confirmation. Legal teams may add a clause such as "and
  that I will comply with it".") takes up to 500 characters, shows the
  workspace default as its placeholder and reads as the default when left
  blank; the card at the end of the document renders it as Markdown directly
  above the button, so pressing the button is the confirmation itself and no
  dialog asks twice. `GET /api/documents/{id}/ack-settings` answers `{
  statement, statement_default, signature }` and `PATCH` takes any subset of
  `{ statement, signature }` (the statement trimmed, 500 characters at most,
  `null` or blank to return to the default; `signature` a boolean), answers
  the same shape read after the write, refuses the first problem it finds
  with 400 (an unknown key included, so a field from a later release never
  saves silently) and writes one `ack.settings_changed` audit row `{
  statement_changed, signature, signature_changed }` when something
  changed, none for a no-op. The route takes the guards of its sibling
  routes, in their order: the document in the caller's scope (404, a draft
  the caller may not read included), the licence (402), then
  `document.ack_require` on the document's own space or
  `compliance.program_manage` (403), so the shipped Compliance manager
  preset, which the Settings tab admits, saves from the tab too.
  `superseded_by_title` is answered only when the replacement is in the
  caller's own scope (the id always is, so the chip falls back to
  "Document #id"). Everything a PATCH can be refused for is judged before
  anything is written, the replacement first, and `next_recert_at` on a
  policy with no interval (and none in the same call) answers 400 "Set an
  interval before a next re-confirmation date.", so a 400 means nothing
  changed and no audit row was written.
- **Optional typed signature per policy.** The same card's switch, **Require
  typed signature** ("The reader types their full name; local accounts also
  re-enter their password. SSO accounts are identified by their sign-in
  session."), adds a **Sign to confirm** block to the card at the end of the
  document: **Type your full name to sign** ("Exactly as it appears on your
  account: Dana Whitfield") and, for an account with a password,
  **Re-enter your account password**. The confirm button waits, with the
  help "Sign above to confirm" under it, until the typed name matches the
  account's (case and spacing do not matter); the password is checked on the
  server. The done state then reads "You confirmed version 12 on 3 Mar 2026,
  14:02, signed as Dana Whitfield." and the printed standing line ends
  "· signed as Dana Whitfield". A
  kept edit's **Re-confirm the current text** asks for the signature again
  on such a policy. The row stores the name as typed (`signed_name`) and how
  the signer was identified (`identity_proof`: `password` for a local
  account that re-entered it, `sso_session` for an SSO account, which has no
  password to re-enter and is identified by the session that reached the
  route, `typed_name_only` for a local account that somehow carries no
  password hash; `''` on an unsigned row). The password is never stored and
  never reaches an audit row: the route takes it out of the body before
  anything else reads it. `POST /api/documents/{id}/ack` accepts `{
  signed_name, password }` beside `version_id` and `reached_end`, answers
  409 "Type your full name exactly as it appears on your account (Dana
  Whitfield)." or "Password check failed. Re-enter your account password to
  sign." without recording anything, and its 200 body gains `signed_name`.
  The password check sits behind the sign-in throttle, counted against
  the username-and-address pair only: five wrong passwords lock that pair
  for fifteen minutes, for signing and for the sign-in form alike, and the
  route answers 429 "Too many failed attempts. Try again in 15 minutes.";
  the sign-in form's per-address spray counter is not fed, so an office
  signing a policy from one address cannot lock its own sign-in. A
  signed-in session is therefore not an unthrottled way to guess the
  account's password, and a wrong password is on the record as a failed
  sign-in is: `auth.login_failed` with `via: "attestation"` against the
  policy, and `auth.lockout` (`minutes: 15`) when that miss engaged the
  lock. The password itself reaches no row. The audit row
  `document.acknowledge` gains `signed_name` and `identity_proof` beside
  `user_agent`.
- **The Record tab is a real table.** The per-document Read confirmation
  page's Record tab now runs on the house table with the house controls
  over it: a **Show** switch (All / Pending / Confirmed), a **Filter
  people** box with its live count ("3 of 42 people"), paging at 50 rows,
  and a **View** switch between **Current version** (one row per person
  asked, their confirmation that counts against the marker) and **All
  confirmations** (every confirmation ever recorded for the document,
  newest first, including the ones a later re-confirmation or a re-ask
  replaced). The current view's columns are Person, Role, Status,
  Confirmed, Version, **Signed** (the name typed when the policy requires a
  signature, behind a pen icon; blank otherwise), Read time and Reached end
  (self-reported); the All confirmations view shows Person, Confirmed,
  Version, Signed, Read time and, for a viewer who holds
  `compliance.export`, **IP**. A confirmation whose account has since been
  removed shows the name recorded at the time with an **Account removed**
  chip. The collapsed former-staff section gains the Signed column too; the
  two footnotes and the progress bar stay.
- **An Export menu replaces the Export CSV button** on the record page:
  **Export CSV** (the per-policy record, as before), **Ledger CSV (all
  confirmations)** (every confirmation ever recorded for the policy, for
  `compliance.export` holders only, because it carries the IP address and
  user agent of each) and **Print…** last. The printed page opens with a
  title line "Read confirmations · {policy} · as of {date}" and keeps every
  control off paper.
- **The ledger.** `GET /api/documents/{id}/acknowledgements?view=all`
  answers every confirmation ever recorded for the document as JSON (`rows`
  with `superseded`, `account_removed`, `current`, the version, hash and
  evidence fields, the statement, signature and identity proof; `ip` and
  `user_agent` blank unless the caller holds `compliance.export`).
  `GET /api/documents/{id}/acknowledgements?format=ledger` downloads the
  same as CSV, and `GET /api/admin/compliance?format=ledger` the whole
  workspace's ledger (every document, purged ones under the title recorded
  at the time, grouped by document, newest first within each); both need
  `compliance.export` and answer 403 without it. The ledger header is
  `document,document_id,space,name,username,email,role,acknowledged_at,superseded,version,version_id,content_sha256,version_source,statement,signed_name,identity_proof,read_seconds,reached_end_self_reported,ip,user_agent,account_removed`.
  A row is `superseded` when the current view no longer shows it: a later
  confirmation by the same person exists, or everyone was asked again after
  it. The two ledger downloads write `ack.export` with `{ format: 'ledger',
  doc_id: <id> | 'all', rows, with_ip: true }` before the response streams,
  beside the roster and matrix rows 1.10.1 introduced.
- **Annual re-confirmation on an interval.** A policy can ask everyone to
  read and confirm it again every 6, 12 or 24 months (any whole number of
  months from 1 to 60 through the API) without anyone editing it. Each
  policy stores its **next re-confirmation date**: set with the interval
  (the last ask plus the interval, or 14 days out when that is already
  past, so a policy last asked two years ago schedules a first cycle
  people can see coming instead of firing at the next tick), restarted by
  every reset (a material change, a merge, a restore, an approval, a
  scheduled publish, **Ask everyone to re-confirm…**, a cycle) and left
  alone by an editorial fix. When the date passes, the hourly sweep moves
  the confirmation marker to the newest version in one atomic claim (the
  statement moves the date its own condition tests, so every app instance
  may run it and each cycle fires once), writes a **Reset** row from
  source *Annual re-confirmation* by *Scheduler* on the History tab with
  the confirmations it reset and the people eligible, and queues one
  notice that goes out at once and is never coalesced: *Please re-confirm
  "Expense policy"* with "Annual re-confirmation: it has been 12 months
  since you confirmed "Expense policy". Please read it again and confirm."
  The reader's strip and card already show the cycle's own sentence
  instead of a comparison (1.11.0, B3). A paused (unpublished), trashed or
  retired policy, and a draft branch, wait until they are live again. Each
  cycle is audited as `ack.recert` ("Asked for annual re-confirmation") by
  the system with the version, the confirmations reset and the people
  eligible; the delivery writes its own `ack.recert` with the counts, as
  before.
- **Effective date.** A policy is dated the day its requirement is first
  switched on (`ack_effective_at`), kept through an off-and-on and through
  an upgrade (existing policies are undated until someone dates them on
  the Settings tab). The effective date and the next re-confirmation date
  are calendar days and read as the day chosen in every time zone: the
  card's "Effective 1 Jan 2026", the popover's "next 1 Jan 2027", the
  portal row's "Next re-confirmation 1 Jan 2027" and the Settings tab's own
  line go through one day formatter pinned to UTC, so a workspace west of
  UTC no longer reads the day before.
- **Program settings → Re-confirmation.** A **Re-confirm every** default
  (Never / 6 months / 12 months / 24 months; Never until an admin chooses)
  that a policy receives when it is first set to require read
  confirmation, with "Applied when a policy is first set to require
  confirmation. Each policy can change it on its Settings tab." Saved as
  `ack_defaults.recert_months` (null, 6, 12 or 24; anything else answers
  400 "must be 6, 12 or 24 months, or null for never", and a hand-edited
  value the build does not offer reads as Never), audited
  `settings.compliance` per changed key like the other defaults. A
  policy's own interval survives a later change of the default and an
  off-and-on of its requirement.
- **Retire a policy.** A policy can be retired: an end-of-life state beside
  the document's status that keeps the evidence. `POST
  /api/documents/{id}/ack/retire { reason }` (ten characters or more)
  switches the requirement off and records who retired it, when and why in
  one statement, guarded on the policy not being retired already (409 "This
  policy is already retired."). The confirmation marker stays where it is,
  so the final roster is reproducible from the ledger; the policy's queued
  notices (a reminder, a re-ask not yet sent) are cancelled; and the decision
  ledger gains a **retired** row with the standing frozen at that moment
  (confirmed of required, and the version people had been asked to confirm).
  The document itself is untouched: unpublish it separately if people should
  no longer read it, and a paused (unpublished) policy can be retired too.
  For holders of `document.ack_require` on the space or
  `compliance.program_manage`; the answer is `{ ok, acked, required, rev }`.
  Audit: `ack.retired` ("Retired policy") with the reason, the replacement,
  the frozen counts, the version and the number of notices cancelled.
- **What readers see on a retired policy.** The confirmation card and the
  sticky control are gone (the policy asks nobody), and the notices strip
  shows one neutral row for everyone: "Retired 3 Mar 2026 · replaced by
  Expense policy 2026", with the replacement as a link when the reader may
  open it, or "Retired 3 Mar 2026" alone. For a manager, the shield
  popover shows "Retired 3 Mar 2026 · un-retire it on the Settings tab"
  (the tab linked) in place of the Require readers to confirm switch,
  which PATCH /ack would only refuse with 409.
- **Un-retire.** `POST /api/documents/{id}/ack/unretire` clears the
  retirement (the replacement too) and switches the requirement back on.
  Confirmations made before the policy was retired count again, unless the
  text changed while it was retired: a save with the requirement off moves
  the marker, so those people are asked again rather than shown as current
  for words they never read. A re-confirmation cycle that fell due while
  the policy was retired is moved a whole interval out in the same
  statement, so nobody is asked again the day a policy comes back. An
  unpublished document resumes as Paused. 409 "This policy is not retired."
  otherwise; the answer is `{ ok, current, eligible }`. Audit:
  `ack.unretired` ("Resumed retired policy") with the standing and
  `superseded_by_cleared`, the replacement the un-retire removed (`null`
  when there was none), as `ack.retired` names the one that was set. The
  "Policy resumed: 42 of 50 confirmations still current" toast offers
  **Ask everyone to re-confirm…** while anyone's confirmation is still
  current, on the Settings tab and in the portal: the same question and
  reset as the page header's button.
- **A replacement.** `documents.ack_superseded_by` names the policy that
  replaced a retired one; it is validated as a published document other
  than the policy itself, inside the caller's scope. `PATCH
  /api/documents/{id}/ack-settings { superseded_by }` sets it (400 with
  the reason when it is refused), audited as `ack.settings_changed` with
  the old and new ids.
- **The compliance portal keeps retired policies.** `GET
  /api/admin/compliance` lists them after every live and paused policy,
  each with `ack_retired_at`, `ack_retired_by_name`, `ack_retired_reason`,
  `ack_superseded_by`, `superseded_by_title` and `retired_rev`, and with
  `required` and `acked` frozen at retirement (the final standing, "42 of
  50 confirmed v12"). The tiles leave them out, and the request picker
  (`candidates`) never offers one, so "Request read confirmation" cannot
  silently re-require a retired policy.
- **The Trash keeps the evidence.** A trashed document with confirmations
  on record is no longer removed by the retention sweep. It waits in the
  Trash with a chip, "Retired policy · 42 confirmations on record" (or
  "Policy · 42 confirmations on record" for one that was never retired),
  and "kept until deleted forever" in place of its purge date, until an
  administrator chooses **Delete forever**, which archives the confirmed
  text first as before. Trashing a retired policy is allowed.
- New tests: `test/attestation.test.ts` (the name rule and its username
  fallback, local versus SSO versus hash-less accounts, a wrong password,
  the throttle engaging on the fifth failure, which says so, and refusing
  the right password until it lifts, the pair-only rule: another account
  on the same address still signs after one account's five failures and
  the address is not locked for sign-in, and that the result never carries
  the password or the typed name); `test/ack-statement.test.ts` (the stored
  statement is the served one, workspace default or the policy's own,
  never the client's; the User-Agent cut at 300; a 1.11.x-shaped call takes
  the defaults; a signature policy's 409s, the signed row, the roster and
  `getCurrentAck` carrying the name, and the audit row without the
  password; a wrong password audited as `auth.login_failed`, the fifth as
  `auth.lockout`, the right one then 429; a console spy proving the
  password reaches no log line; the settings route's GET, every 400, the
  trim, the no-op, the subset, the clear, a viewer's 403 and an anonymous
  401; a refused replacement beside other fields changes nothing and
  writes no row; a next date without an interval refused by name);
  `test/training-signature.test.ts` (the training route's signature branch
  driven directly: wrong name 409 and wrong password 409 in the route's
  own words, the sixth attempt 429, the right pair 200 with the name
  recorded, a miss audited without the password);
  `test/markdown-inline.test.ts` (the inline schema keeps emphasis, code
  and a link and drops an embed, a video, an image, a task list, a
  heading, raw HTML and styles); `test/ack-ledger-view.test.ts` (the
  ledger's ordering, superseded rule, removed-account snapshot and
  purged-document rows) and the CSV headers' legacy prefixes, the ledger
  header and the personal-data rule (ip and user agent blank without
  `compliance.export`); `test/my-policies.test.ts` (the three states and
  their order, the scope rule, the badge count, a retired policy absent);
  `test/ack-sweep.test.ts` (two sweeps in parallel fire one cycle, one
  ledger row and one notice; a marker older than the interval schedules the
  first cycle 14 days out; a paused, trashed or retired policy waits; a
  reset moves the next date) and the default interval round-tripping and
  refusing 7 in `test/compliance-settings.test.ts`; `test/ack-retire.test.ts`
  (retire freezes the counts and writes the ledger row, a second retire is
  refused, edits while retired advance the marker, a retired policy is out
  of the candidates and the pending list, the purge guard, un-retire with
  the prior confirmations current, the PATCH 409, the cancelled outbox
  rows); and the double-boot test's three blocks (every new column, default
  and foreign key after an upgrade boot, existing rows unsigned and no cycle
  scheduled, a 1.11.x-shaped INSERT taking the defaults, values set between
  boots surviving a second boot). The e2e specs gain the signature document
  (the settings route's defaults and validation, the policy's own statement
  on the card, the button waiting on the name, a wrong password's toast, the
  signed confirmation and the record carrying the name and the proof), the
  Record tab's controls, the All confirmations view listing a superseded
  row, the Export menu and the ledger download, the 403 on both ledger files
  for a role without `compliance.export`, My policies (the API shape, the
  standing line, the row and its chip and link, the badge, the dashboard
  row, the up-to-date line, the "Changed since you confirmed" chip after a
  re-ask, and a plain viewer's one-tab section with the portal paths
  answering not found), the routed portal pages, and the API-level retire
  and un-retire flow (403 for a read-only role, the DocNotices row, the
  card restored).
- **The compliance portal's Retired group.** Compliance › Policies lists
  retired policies in a collapsed **Retired · 3** group at the foot of the
  Policy progress card, below Paused, each row with a neutral **Retired
  3 Mar 2026** chip (who retired it is the chip's tooltip), the final
  standing frozen at retirement ("42 of 50 people confirmed v12"), the
  reason, **Replaced by** with the replacement as a link when one was
  named, **View record** (the policy's Read confirmation page, which stays
  open with History) and the per-policy CSV for exporters. No Remind, no
  re-ask, no Stop requiring: nothing is asked and nothing can be stopped.
  **Un-retire** is the row's one action for `compliance.program_manage`
  holders: it asks once ("Resume read confirmation for "Expense policy"?
  Confirmations made before it was retired stay on record. If the text
  changed while it was retired, people whose confirmation is older than the
  current version are asked again." / **Resume**) and toasts "Policy
  resumed: 42 of 50 confirmations still current"; while any confirmation
  is still current the toast carries **Ask everyone to re-confirm…** as
  its action, the row's own question and POST, for the case where that
  number is the wrong one.
- **Retire policy… on the portal row.** Beside Remind, Ask everyone to
  re-confirm… and Stop requiring, managers get **Retire policy…**, which
  opens the same question as the Settings tab's Lifecycle card ('Retire
  "Expense policy"?', the standing, "Why is this policy being retired?" with
  a reason of at least 10 characters, **Retire policy**), posts to the
  policy's retire route and toasts "Policy retired: 42 of 50 confirmations
  on record"; the row moves to the Retired group.
- **Re-confirmation on the portal.** A policy with an interval shows
  "Next re-confirmation 1 Jan 2027" on its row's meta line, after "Updated
  … · last reminded …". Compliance › Overview gains a fifth tile,
  **Re-confirmation due in 30 days**, counting the live policies (published,
  required, not retired) whose next date falls within 30 days; `GET
  /api/admin/compliance` carries it as `kpis.recert_due_30`, and every
  `docs` row now carries `ack_recert_months`, `ack_next_recert_at` and
  `ack_effective_at`.
- **The Record tab's subtitle counts cycles.** On a policy with an interval
  the sentence under the Read confirmation title ends "· Cycle 4 · annual"
  ("· Cycle 2 · every 6 months"): the first ask is cycle 1 and every annual
  re-confirmation on the History tab starts the next.
- **Settings tab: Re-confirmation and Lifecycle.** The Read confirmation
  page's Settings tab gains two cards under its one **Save settings** row.
  **Re-confirmation**: **Re-confirm every** (Never, 6 months, 12 months or
  24 months, the workspace's value marked "(workspace default)", and an
  interval the API set outside those four shown as it is, "18 months");
  **Next re-confirmation**, shown once an interval is chosen and prefilled
  the way the server schedules it (the day everyone was last asked plus the
  interval, or 14 days out when that has already passed), with the help
  "Everyone is asked again on this date. A material change restarts the
  interval." and a past date refused inline ("The next re-confirmation date
  cannot be in the past."); a warning when the first cycle was pushed out
  ("People last re-confirmed 18 months ago. The first cycle is scheduled
  for 2 Nov 2026: change the date, or use Ask everyone to re-confirm
  now."); and **Effective date**. **Lifecycle**: **Replaced by**, a picker
  over the published documents you can see, saved with the settings and
  shown to readers once the policy is retired; **Retire policy…**, which
  asks the same question as the portal row (above) and retires the policy
  in place, the card then reading "Retired 3 Mar 2026 by Mia Manager" with
  the reason; and **Un-retire**, which asks the same question as the
  portal's and resumes with the same toast, "Policy resumed: 42 of 50
  confirmations still current". Only a date you change is checked: a
  stored next date that has already passed (a retired or paused policy's,
  which the sweep leaves alone) shows the hint "This date has passed; the
  next cycle fires when the policy is live again." under the field, and
  the statement, the signature and the replacement still save. After
  Retire or Un-retire, focus lands on the button that replaced the one
  used (the card's heading for a moment while the page refreshes), never
  on the page body.
- **`PATCH /api/documents/{id}/ack-settings`** takes `recert_months` (a
  whole number of months from 1 to 60, or null for never),
  `next_recert_at` (a date not in the past, or null to schedule from the
  last ask), `effective_at` (a date, or null) and `superseded_by` (the id
  of a published document in your scope, or null), any subset in one call,
  400 naming the first problem ("A policy cannot be replaced by itself.",
  "The replacement must be a published document you can see."). `GET`
  answers them beside `marker` (when everyone was last asked),
  `recert_default` (the workspace interval) and `superseded_by_title`. The
  `ack.settings_changed` audit row carries what the PATCH moved
  (`recert_months`, `next_recert_at`, `effective_at`, and the replacement's
  old and new ids as above), and a PATCH that changes nothing writes none.
- **The cycle on the document.** The shield popover's status line gains a
  second line, "Re-confirm yearly · next 1 Jan 2027", and the confirmation
  card's version line gains "Effective 1 Jan 2026 · re-confirm yearly"
  (either half alone when the other is unset; nothing without both).

### Changed
- **CSV columns appended; existing columns unchanged.** Both the per-policy
  CSV and the portal matrix append six columns at the end, in this order:
  `statement` (the confirmation statement the person confirmed under),
  `signed_name`, `identity_proof` (`password`, `sso_session` or
  `typed_name_only` when the policy requires a signature; blank otherwise),
  `recert_months`, `effective_at` and `next_recert_at` (the policy's
  re-confirmation settings, blank while none are set). The per-policy CSV's
  `user_agent` column, reserved and blank since 1.10.1, is now filled for
  confirmations made on 1.12.0 or later under the same rule as `ip`: filled
  only when the caller holds `compliance.export`, blank otherwise. The JSON
  roster rows carry `user_agent` beside `ip` for an exporter.
- **The portal matrix leaves out retired policies**, as the portal's tiles
  do: nobody owes a retired policy, so it has no row there. Its evidence
  stays exportable through its own record page (Export CSV and the ledger
  CSV) and in the workspace ledger.
- **A retired policy stays retired until un-retired.** `PATCH
  /api/documents/{id}/ack { required: true }` on a retired policy answers
  409 "This policy is retired. Un-retire it first.", and so does every
  portal action on one (`POST /api/admin/compliance` with `request`,
  `remind` or `stop`); the switch-on itself refuses a retired policy, so no
  path but un-retire brings the requirement back while the retirement
  stands.
- The decision ledger's `retired` outcome, reserved since 1.10.0, is now
  written; the History tab and the ledger exports show it with the frozen
  counts.
- **The portal's roster expand is the Record tab's roster.** Expanding a
  policy row on Compliance › Policies now shows the same table as the
  policy's Record tab: Person with email, Role, the Confirmed / Pending
  chip, the confirmation time, the version, the typed signature, Read time
  and Reached end, with the **Show** filter, **Filter people** and its live
  count, and a pager past 50 people, in place of the four-column table of
  1.10.1. The IP column is not shown here (it belongs to the All
  confirmations view, which the expand row does not offer); the per-policy
  CSV and the Record tab remain the complete record.
- The Overview's tiles follow the page width.
- `GET /api/documents/{id}/ack` (the summary) carries `ack_recert_months`,
  `ack_next_recert_at` and `ack_effective_at`.
- The Settings tab saves only the fields that changed since the last save,
  so a stored next date that has since passed is never re-judged by a save
  that did not touch it.
- **Ask everyone to re-confirm…** and every reset of a policy's
  confirmations now also restart its re-confirmation interval; nothing
  changes for a policy without one. A cycle also stamps the policy's
  reminder time, so **Remind** keeps its one-hour cooldown after the
  cycle's notice went out. A policy with an interval of its own that is
  stopped and requested again keeps its next re-confirmation date, unless
  that date passed while it was off: then the request moves it out a whole
  interval, as un-retire does, so the hourly sweep does not ask everyone a
  second time on top of the request that just went out.
- The training deck's e-signature gate runs through the same check as the
  policy signature (`lib/attestation`, extracted from the training route):
  its two sentences are unchanged, and its password branch is now throttled
  like a sign-in, as above: the sixth wrong password answers 429, the lock
  holds for the sign-in form too, and a wrong password is audited as
  `auth.login_failed` (`via: "attestation"`) and `auth.lockout` against
  the deck's document.
- The card's confirmed sentence and the printed standing line read
  "signed as {name}" on a signed confirmation; unsigned confirmations read
  as before. The card's confirmation statement is rendered as inline Markdown (one
  sentence at the card's own size): a clause may carry emphasis, code or a
  link, and nothing else; a directive, an image, an embed, a task list or
  raw HTML in a statement is dropped on the card rather than rendered; the
  default statement renders exactly as it did.
- The dashboard's attention row reads "3 policies need your read
  confirmation" (it said "3 documents need…"), counts every pending
  policy rather than the first twenty, and opens the one policy's
  confirmation card when exactly one is pending and My policies otherwise
  (it used to open the first policy whatever the count).
- `/compliance` no longer sends people without the Compliance section to
  the dashboard: it is My policies for everyone. The portal's **Export
  CSV** moved from the page header, now the section's, to the Policy
  progress card on the Policies page; the header's Settings button is the
  Settings tab.
- The palette's "Go to Compliance" follows the sidebar's rule and also
  answers "my policies", "read confirmation" and "confirm".

### Upgrading
- **Schema additions, all metadata-only.** On `documents`: `ack_statement`
  (text, null = the workspace default), `ack_signature` (integer, NOT NULL
  DEFAULT 0), `ack_recert_months` (integer), `ack_next_recert_at`
  (timestamptz), `ack_effective_at` (date), `ack_retired_at`,
  `ack_retired_by` (references `users`, SET NULL when the account goes),
  `ack_retired_by_name`, `ack_retired_reason` and `ack_superseded_by`
  (references `documents`, SET NULL when the replacement is purged); on
  `acknowledgements`: `statement_text` (text, NOT NULL DEFAULT ''),
  `signed_name` (text, null when unsigned), `identity_proof` (text, NOT
  NULL DEFAULT '') and `user_agent` (text, NOT NULL DEFAULT ''); and three
  partial indexes: `idx_documents_ack_recert` on `documents
  (ack_next_recert_at) WHERE ack_required = 1 AND ack_recert_months IS NOT
  NULL`, for the hourly sweep, and `idx_documents_ack_retired_by` and
  `idx_documents_ack_superseded_by` under the two SET NULL references
  (each `WHERE … IS NOT NULL`, so they hold only retired rows), so that
  removing an account or purging a replacement does not scan `documents`. Every line is a catalog-guarded `ADD COLUMN
  IF NOT EXISTS` with a constant default, or a guarded index: no rewrite,
  no backfill, no lock on an up-to-date table. The Record tab, the ledger
  reads and My policies add no schema of their own; they are served by
  `idx_ack_doc` and `idx_ack_user` from 1.10.0.
- **Nothing to migrate, and nothing fires.** Existing policies keep the
  workspace statement and ask for no signature; existing rows read as
  unsigned with no statement text and no user agent. No policy has an
  interval until someone sets one, and the workspace default applies only
  to policies switched on from then; existing policies carry no effective
  date until it is set. No policy is retired. Bookmarks to `/compliance`
  open My policies; the portal's lists are under `/compliance/policies` and
  `/compliance/people`, its tiles under `/compliance/overview`;
  `/compliance/settings` is unchanged.
- The portal's two new payload fields (`kpis.recert_due_30` and the three
  re-confirmation columns on `docs` rows) are additive; a client built
  against 1.11.x ignores them.
- **Rollback to 1.11.2 is supported.** 1.11.2 ignores the new columns and
  the indexes and leaves them in place. While rolled back: a row it writes
  takes the defaults (unsigned, no statement text, no user agent), a
  policy's own statement and signature switch wait unused, and a policy
  that requires a signature records unsigned confirmations until 1.12.0
  runs again; no cycle fires, and an interval is honoured again on
  re-upgrade; a retired policy reads as a policy whose requirement is off
  (the columns and the ledger row stay for the re-upgrade), and if someone
  re-requires a retired policy from 1.11.2's request picker while rolled
  back, it comes back as retired after the re-upgrade (its requirement
  reads as on in the record, and Retire is refused as already retired):
  use Un-retire to resume it; and the
  retention sweep purges trashed documents with confirmations as it did
  before (the archive still keeps every cited text).
- Scripts that read the CSVs by column name are unaffected; scripts that
  count columns should expect six more at the end of both files.
- Privacy: the password a local account re-enters to sign is checked
  against the stored hash and discarded; it is not stored on the row, in
  the audit log or in any log line. The User-Agent now kept on the row was
  already on the confirmation's audit row; on the record and in the CSV it
  is filled only for holders of `compliance.export`, as the IP address is.
  The ledger exports and the IP column of the All confirmations view are
  the only new places the recorded IP address and user agent surface, and
  both are behind `compliance.export`; a roster reader without that key
  sees the same ledger rows with those two fields blank.

## [1.11.2] - 2026-10-19

Directory settings, organised: a Display page, export presets as a list
beside a grouped editor, markers in front of names, and name formats.

### Added
- **Directory settings: a Display page.** The Directory page defaults (the
  list's columns, the field the Groups view opens on, Sort names by) leave
  the Export page for a page of their own, **Settings → Directory →
  Display**, as one card, **Directory page defaults**, with one Save. The
  tab row is now People · Display · Fields · Offices · Export · Sync.
- **Export presets: a list beside the editor.** The Export page is a
  preset list on the left (one row per preset, lit when open, with a
  **Default** chip, a **ZIP** chip when the preset makes one file per
  value, and a **Scheduled** chip with the schedule sentence under it)
  and the selected preset's editor on the right: its name and actions
  (Make default, Duplicate, Download PDF, Delete; Download PDF waits, and
  says so, while anything on the page is unsaved, the markers included)
  over five cards, each
  one job: **Document** (preset name, title, subtitle, footer note, file
  name, name format, workspace logo), **Page** (paper, orientation,
  density, margins, layout, cards per row or page layout, shaded rows,
  page numbers, printed date, office information and its blocks per row),
  **Columns** (the columns in order with Wrap after, assistant details,
  photos, the markers to print), **Order and filter** (sections by, sort
  by, then by, pinned people first, only people where, one file per) and
  **Schedule** (the email schedule, with
  a notice when mail is not set up). One Save for the page, as before;
  every control, rule and message is unchanged. The list stacks over the
  editor on a phone. The settings search finds the cards ("Export ›
  Columns", "Display › Directory page defaults").
- **Directory export markers.** Settings → Directory → Export gains a
  **Markers** card: a symbol (an asterisk, a dagger, or any character the
  PDF can print) in front of a person's name on exports, for people who
  match a field value, with a name for the key: "* Public notary",
  "† Partner". A marker reads any field but the name and the link columns
  (a synced attribute, a custom attribute, a manual one), matches as the
  export filter matches (the raw value, the option's code or its label,
  case-insensitively; a multi-valued field on any of its values), and a
  blank value marks everyone who has any value. Each preset ticks the
  markers it prints under **Columns → Mark people with**; the symbols go
  in front of the name in the PDF's table and cards and in the CSV's Name
  column, every assistant's name carries the assistant's own symbols, the
  PDF's footer prints the key on every page (one marker after another,
  separated by a middle dot) and the page plan leaves room for it, and the CSV ends each row with a
  **Markers** column listing the labels. Up to 24 markers; a symbol the
  PDF cannot print is refused by name rather than saved to come out as a
  box. An export made by someone who is not a directory admin prints only
  the markers the preset lists (the export route's `markers` override can
  drop one, never add one), and a marker on a column they may not see is
  left out of its key and its Markers column altogether. In the card, Add
  a marker lands on the new row's name, Remove moves to the next row (or
  back to Add a marker when the table is empty), and Other… opens straight
  into the symbol box. In the API: `GET` / `PUT /api/admin/directory/markers`, a preset's
  `markers` (marker ids) and the audit entry `settings.directory_markers`
  ("Updated directory markers").
- **Name formats on exports.** A preset's **Document → Name format**
  writes the Name column, the who's-who cards and assistant names one of
  six ways: *As written*; *First name Last name*; *Last name, First name*;
  *First name Last initial*; *Last name, First initial*; or *First initial
  Last name* ("Smith, Jane A." becomes "Jane Smith", "Smith, Jane", "Jane S.",
  "Smith, J." or "J. Smith"). Honorifics, suffixes and credentials come
  off as the name sort already drops them, a particle surname rides whole
  ("van Beethoven, Ludwig") and its initial is the surname proper's
  ("Ludwig B.", "Maria C." for "de la Cruz, Maria"), and a single-word
  name prints as it is.
  Sorting is unchanged. In the API: a preset's `name_format`; both options
  ride on the export route as overrides like the other preset options.

### Changed
- The ordered column list wraps its per-row controls on a phone instead
  of pushing the card sideways, its add-column menu never exceeds the
  card, and its Move up, Move down and Remove are the house icon buttons
  on both the Display and the Export page.
- The preset editor's cards size their grids by the editor pane rather
  than the window, so at the Normal page width the Page card's selects and
  the Order and filter card's filter keep a readable width instead of
  clipping; the Markers table fits the settings column at that width
  without scrolling sideways.
- Delete on the last remaining preset says why it is off ("Keep at least
  one preset"); Add a marker says so at 24 ("Up to 24 markers."). Ctrl/⌘+S
  on the Export page saves the presets only; Save markers has its own
  button and no shortcut, so one keystroke never fires two saves.

### Upgrading
- Nothing to migrate. A preset saved before 1.11.2 prints no markers and
  writes names as written: its PDF and CSV are the files it made before.
  Markers are empty until an admin adds one.

## [1.11.1] - 2026-10-19

Directory export: wrap a column after a number of characters, sort by
first or last name, assistant details on the sheet, and page margins.

### Added
- **Wrap a column after a number of characters.** Every column in a
  preset's "Columns, in order" list carries a **Wrap after** input (8 to
  120 characters; blank keeps the column automatic). A long title or
  email wraps onto the next line instead of running on, or being cut in
  the two- and three-column layouts, which charge a wrapped row the lines
  it takes (counted at a tenth fewer characters a line than the limit, so
  a value of capitals or digits exactly at the limit never spills onto an
  unplanned page; over-counting only leaves white space). Columns without
  a limit keep the widths every export had; limited columns that would
  take more than two thirds of the row are scaled down together so the
  table still fits. A value out of range disables Save as soon as it is
  typed and is named once you leave the box; a problem in another preset
  than the one on screen is named above Save. A limit belongs to the
  column while it is in the preset. Hidden for the photo-cards layout,
  where columns have no width. In the API the preset's `column_limits` is
  `{ "title": 24 }`, kept for the preset's own columns only.
- **Sort by first name or last name.** "Sort by" and "Then by" offer
  **First name** and **Last name** under Built-in, right after Name, so a
  phone list can read Smith, Jane without renaming anyone. The parts come
  from the display name: "Smith, Jane A." sorts as Jane / Smith, "Dr. Jane
  A. Smith Jr." as Jane / Smith, "Ludwig van Beethoven" as Ludwig / van
  Beethoven (a particle surname keeps its particles; a two-word name never
  loses its first word), honorifics and suffixes are dropped as the
  initials already drop them, credentials (PhD, MD, JD, CPA, Esq.) come
  off the end only ("JD Vance" sorts as JD / Vance), and a single-word
  name is both. Ties fall through to the next key and then to the full
  name. The
  keys are `name:first` and `name:last` wherever a sort key is accepted
  (a preset's `sort` / `sort2`, the Directory list, the export's `sort`);
  they are never columns.
- **Sort names by, on the Directory page.** The toolbar gains **Sort
  names by** (Full name, First name, Last name) in every view: it orders
  the list's Name column, the cards, and the members of each group in the
  Groups view and the cards' sections (when titles carry no option order,
  which otherwise comes first). The choice is remembered in the browser
  and starts from the admin's default; "What I see" exports carry the
  same sort, so the PDF matches the screen. The Directory defaults card
  gains the same choice as the admin default (`directory_name_sort`, read
  and written by `GET` / `PUT /api/admin/directory/list-columns` as
  `name_sort`; anything but `full`, `first` or `last` is refused with
  400).
- **Assistant details on the sheet.** When the Assistant column is in a
  preset, an **Assistant details** list offers the assistant's own fields
  (phone, extension, office, any custom field); the ticked ones follow
  each assistant's name on paper and in the CSV, as "Pat Lee · 602-555-0100
  · x204", blanks skipped, several assistants joined with "; ". The
  details are read from the assistant's own row among everyone the viewer
  may see, not from the rows in the file: a "What I see" export of the
  people on screen shows an assistant's phone when the assistant is off
  screen, a one-office sheet shows an assistant who sits in another
  office, and every file in a "One file per" zip reads the same list. An
  assistant the viewer may not see at all shows the name alone. With no
  fields chosen the column reads as before.
  In the API the preset's `assistant_fields` is `["phone", "extension"]`.
- **Page margins.** A **Margins** choice of Normal (every export's page
  until now), Narrow (0.3 in), Wide (1 in) or Custom, with Top, Right,
  Bottom and Left in inches (0.2 to 2, one decimal place) when Custom. A
  value with more decimals, or out of range, is refused inline and Save
  waits; what is typed is what is saved. The footer and the two- and
  three-column page plan follow the margins.
  In the API: `margins` (`normal` | `narrow` | `wide` | `custom`) and
  `margin_custom` (`{ top, right, bottom, left }` in inches).
- `POST /api/directory/export` (and the `GET` form) accepts the four new
  options as overrides on top of a preset: `column_limits`,
  `assistant_fields`, `margins` and `margin_custom` (JSON-encoded on a
  `GET`). Each is sanitised like the stored preset: unknown columns,
  out-of-range numbers and junk are dropped or clamped, never refused.
- Tests: the layout planner (margins, column widths, wrapped rows), the
  name parts and the first- and last-name sort, the assistant text, the
  sanitiser, and a rendered PDF and CSV.

### Changed
- The export's row cells (PDF, cards and CSV) read one cell function, so
  the assistant details and every other value are the same text in each
  format. The export route strips a viewer's restricted contact columns
  from a preset's assistant details as it already does from its columns.
  The preset editor's "Columns, in order" list is a fieldset with a
  legend, so a click on a row's text no longer focuses the first row's
  Wrap after input.

### Upgrading
- Nothing to migrate. A preset stored before 1.11.1 has none of the new
  keys; it reads as automatic widths, no assistant details and Normal
  margins, and renders exactly as it did. The admin's "Sort names by" is
  Full name until changed.

## [1.11.0] - 2026-10-16

Read confirmation, part three: every write path decides, readers see what
changed since they confirmed, and reading evidence lands on the record.
(Enterprise, `policy_ack`.)

### Breaking
- **Integrations that edit the text of a confirmed policy must now say
  what readers should see.** Until 1.10.1 a `PATCH /api/v1/documents/{id}`
  or a connector `update_doc` that changed the text or title of a published
  document people have confirmed went through, and the document's edit
  default decided for it (under the recommended default: everyone was asked
  again, silently from the caller's point of view). From 1.11.0 such a call
  is refused until it decides: `PATCH /api/v1/documents/{id}` answers **428
  Precondition Required** with `{ error: 'This document requires read
  confirmation. Pass ack_policy "keep" (editorial fix) or "reset" (material
  change), with ack_reason.', decision_required: true, confirmations: 42,
  eligible: 50, baseline: "v12", change: { pct, wordsChanged,
  blocksChanged, headingsChanged, numbersChanged }, suggested: "keep" }`,
  and nothing is written; `ack_policy` with no usable `ack_reason` (a reset
  needs a reason of at least 10 characters; a keep follows Program settings'
  **Require a reason for editorial fixes too**; longer reasons are cut at
  500) answers **400** "ack_reason is required when the text of a confirmed
  policy changes.", and any other value of `ack_policy` answers 400
  'ack_policy must be "keep" or "reset".'; the field is validated whenever
  it is sent, on every path, so a bad value is refused even on a change
  that is not substantive. The connector's `update_doc` returns `{ ok: false, decision_required:
  true, confirmations, eligible, baseline, change, suggested, hint: "Ask the
  person whether this is an editorial fix or a material change and why,
  then call update_doc again with ack_policy and ack_reason." }` (a result,
  not a tool error, so the assistant asks instead of guessing) and `{ ok:
  false, error }` for the two 400s. The same rule applies to a PATCH or an
  `update_doc` with `publish: true` that puts a draft live whose text
  drifted from the confirmed version: the publish is where the decision is
  taken. A metadata-only change (summary, tags, type, status to draft, a
  move), a draft that stays a draft, and a document that does not require
  read confirmation are never refused for want of a decision (only a bad
  `ack_policy` value is, as above). A script
  that edits policies through the API or the connector must send
  `ack_policy` and `ack_reason` on those calls; a script that only reads,
  creates, or edits ordinary documents is unaffected. The app's own `POST
  /api/documents/{id}/merge`, `POST /api/documents/{id}/versions/{vid}/restore`
  and `PATCH /api/change-requests/{id}` answer the same 428 and 400 on the
  same condition (see **Added**). The invariant the tests pin: **tokens may
  edit a policy and must decide; tokens can never confirm one.** A personal
  API token (`cdk_`) or an OAuth access token (`cdo_`) is accepted by the
  v1 API and the connector and refused with 401 by `POST
  /api/documents/{id}/ack` and `POST /api/documents/{id}/ack/reconfirm`,
  which resolve the person from the session cookie only, and the connector
  offers no tool that confirms.

### Added
- **Every write path decides, in the same words.** The v1 API, the Claude
  connector, zip imports, the editor's schedule field, a branch merge, a
  version restore and the review queue now carry the read-confirmation
  decision through one shared pre-flight (`lib/ack-decision`), so a refusal
  reads the same and shows the same numbers whichever door the change came
  through. Until now a merge, a restore or an approved change request that
  changed the text of a confirmed document followed the document's edit
  default with nobody asked. Merging a branch into, or restoring an older
  version over, a published document that people have confirmed, when the
  incoming text differs from the version they confirmed, is answered **428**
  with the body under **Breaking** until the call says `ack_policy` `keep`
  (editorial fix) or `reset` (material change) with an `ack_reason` (a
  reset needs a reason of at least 10 characters; a keep follows Program
  settings' **Require a reason for editorial fixes too**; 400 for a bad
  policy or an unusable reason); nothing is written on a refusal. Restoring
  the confirmed version itself, merging a branch whose text matches it, or
  a merge that changes nothing substantive asks nothing (a bad `ack_policy`
  value is still refused). In the app the note typed in the question is
  the version note and the recorded reason, for a restore as for a merge
  (`POST /api/documents/{id}/versions/{vid}/restore` accepts `note` for
  the same purpose; absent, the note reads "Restored version N from
  YYYY-MM-DD", as before). The decision is recorded on the History tab
  from source *Merge* or *Restore* with the reason, and the audit rows
  `document.branch_merge` and `document.restore_version` carry
  `{ ack_policy, confirmations_reset }`, where `ack_policy` is `keep` or
  `reset` (what was applied) or `null` when nothing was decided (a merge or
  restore that changed nothing substantive), the vocabulary
  `document.scheduled_publish` uses.
- **The submitter recommends, the approver decides.** A change request now
  carries the submitter's recommendation for the readers (`ack_policy` `keep`
  | `reset`, or none, and `ack_reason`), taken from every way a request is
  made: a save without publish rights, a merge or a restore that queues for
  review (the branch banner and version history ask the submit question
  before queuing), the v1 API and the MCP connector. Approving a request
  that changes the text of a confirmed, published document applies the
  approver's own `ack_policy` when they send one (`PATCH
  /api/change-requests/{id}` takes `{ action, note, ack_policy, ack_reason
  }`; a reset needs a reason of at least 10 characters; a keep follows
  Program settings' **Require a reason for editorial fixes too**), otherwise
  the submitter's recommendation, and when the request carries none the
  approval is answered **428** with the same body so the review queue can
  ask. A stored recommendation is checked against the same reason rule at
  approval; one whose reason fails it counts as none, so the approval
  answers 428 and the queue asks, with the recommendation pre-selected,
  rather than complaining about a reason the approver never sent.
  `change_request.decide` is checked on the document's own space, and on
  the target space when the request moves the document; a role holding it
  on another space is answered 403 before anything is read, so the 428
  numbers never reach someone who may not decide. The decision row records
  both sides: what was recommended and by whom, what was applied and by
  whom, and the reason (the approver's when they gave one, else the
  submitter's, else the change note), so version history can read
  "Editorial (recommended by Alex, approved by Priya)"; the approver's
  reason, when given, is also the version note (else the request's note, as
  before). The review list tells the queue whether each target requires
  read confirmation and which version people confirmed. The audit row
  `change_request.approve` gains `{ ack_policy, confirmations_reset,
  submitted_policy }` (`ack_policy` is `keep` or `reset` as applied, or
  `null` for an approval that decided nothing, such as a metadata-only
  request, so a recommendation the approval did not act on is never
  audited as applied), and the author's "approved" notice ends with what
  the decision did: "Confirmations kept." or "42 people asked to
  re-confirm."
- **A merge refuses to overwrite a newer live document.** `POST
  /api/documents/{id}/merge` accepts `base_updated_at` (the source's
  `updated_at` the client last saw) and answers 409 in the same shape as a
  save (`{ conflict: true, error, current_updated_at, current_author }`) with
  "The live document changed since this branch was created. Review it before
  merging." when the source was saved since; clients that send nothing keep
  the historical behaviour.
- **The v1 API and the connector say where a policy stands.** `GET
  /api/v1/documents/{id}` gains `ack_required`, `ack_edit_default` (`ask` |
  `material` | `reset`) and `ack: { confirmations, eligible, version }`
  ("v12", or null before the first version), the standing an integration
  needs before it edits; `PATCH` accepts `ack_policy` and `ack_reason`, uses
  the reason as the version note when no `note` came, and answers with the
  same document shape plus `ack_outcome` (`changed`, `substantive`, `reset`,
  `confirmations_reset`, `policy`, `source`), as the app's PUT does. The
  connector's `update_doc` schema gains `ack_policy` (enum `keep` | `reset`:
  "Required when the document requires read confirmation and the body or
  title changes: keep = editorial fix (people are not asked again); reset =
  material change (everyone re-confirms). Always include ack_reason saying
  what changed and why.") and `ack_reason`; `read_doc` says so up front on
  such a document ("> read confirmation: required · 42 of 50 people have
  confirmed v12 · a change to the body or title needs ack_policy (keep or
  reset) and ack_reason in update_doc"; "1 of 1 person has confirmed v3"
  when one person is eligible). Decisions taken this way are rows
  on the History tab with source *API* or *MCP*, the token's owner as the
  decider and the reason given, and are echoed to the audit log as
  `ack.confirmations_kept` / `ack.confirmations_reset`, as before, with
  the caller's IP address (the connector's audit rows carried none until
  now; see **Changed**).
- **Imports no longer overwrite a policy by accident.** Settings → Import
  gains the checkbox **Also overwrite documents that require read
  confirmation**, off by default. Off, a document that requires read
  confirmation is left unchanged when the zip carries a document with the
  same space and title and the document is published, or is paused
  (unpublished with the requirement on) and the zip would publish it,
  counted as skipped and listed under the warnings ("expense-policy.md:
  "Expense policy" requires read confirmation and was left unchanged. Tick
  "Also overwrite documents that require read confirmation" to replace
  it."); a zip that keeps a paused policy a draft updates the draft, and
  the decision waits for the publish as it does for every draft edit;
  every other document is imported as before. On, the policy is
  overwritten and its edit default decides what readers see (source
  *Import*, the importer as the decider, "Imported" as the reason), and
  the summary says what that did: "3 policies will ask people to
  re-confirm." and "2 policies that require read confirmation were left
  unchanged." when some were. The run is audited as one row,
  `document.import` ("Imported documents": the file name, the counts
  created, updated, skipped, policies skipped and re-asks queued, and
  whether the box was ticked), and every overwritten policy is echoed as
  `ack.confirmations_kept` / `ack.confirmations_reset` with the importer as
  the actor and their IP address, as every other write path echoes its
  decision. For scripts, `POST /api/import` reads the multipart field
  `overwrite_policies` (`"1"` to allow) and the result gains
  `reconfirm_requested` (policies whose readers will be asked again) and
  `policies_skipped`.
- **The editor says what a scheduled publish will do, and the scheduler
  says what it did.** Arming **Publish automatically at** on a draft that
  requires read confirmation, whose title or text differs from the version
  people confirmed, shows under the field "Publishing on schedule will ask
  42 people to re-confirm: the text changed since version 12." (or, when
  the document's *Ask only when a change looks material* setting would keep
  an editorial-looking change, "Publishing on schedule will keep
  confirmations: the change since version 12 looks editorial (document
  setting)."), because nobody is there to be asked when the schedule fires.
  The hint follows the fields as you type and disappears when the text
  matches the confirmed version again. The scheduled publish itself writes
  `document.scheduled_publish` with `{ ack_policy, confirmations_reset }`:
  `ack_policy` is `reset` or `keep` (the edit default decided), or `null`
  when there was nothing to decide (the text is what people confirmed, or
  the document asks nobody).
- **An unpublished policy is paused, not gone.** Until now unpublishing a
  document that requires read confirmation made it vanish from the
  compliance portal, the per-person numbers and the dashboard, with the
  requirement still on and nobody told. From 1.11.0 the requirement stays
  on, every confirmation is kept, and the policy moves to a collapsed
  group at the foot of the portal's Policy progress card, headed **Paused
  (unpublished) · 3** with its count, each row carrying an **Unpublished**
  chip (its tooltip:
  "Read confirmation is paused while the document is unpublished.
  Confirmations are kept.") and its standing ("3 of 5 people confirmed")
  and no action: Remind, **Ask everyone to re-confirm…**, **Stop
  requiring** and the record download all need a published document.
  The four tiles count published policies only, so taking a policy down
  for a rewrite neither drops the overall percentage nor adds outstanding
  confirmations; the People table and the dashboard's "documents need
  your read confirmation" row skip it for the same reason (nobody owes a
  policy that is down). Publishing it again with the text people confirmed
  puts it straight back in the live list with its counts; publishing it
  with changed text is the same decision as any other publish of a
  drifted draft (the editor's question, or the edit default for a caller
  that cannot ask). The editor's **Unpublish this document?** question
  says so on a policy: "Read confirmation is paused while the document is
  unpublished. Confirmations are kept." A scheduled unpublish of a policy
  writes `document.scheduled_unpublish` with `{ ack_paused: true }`.
- **The side doors are on the record.** An image placed by the Claude
  connector's `add_image` (with `insert`) or dropped through an upload
  link into a confirmed, published document keeps every confirmation and
  is recorded exactly like an editor's editorial fix: a **Kept** row on
  the History tab from source *Image* or *Ticket* with the reason "Added
  image" / "Added file", the version note "Added image" / "Added file" in
  version history, an `ack.confirmations_kept` audit entry, and a count on
  the portal's drift chip ("Edited 2 times since v12 without re-asking ·
  1.4% drift"), so a diagram that *was* the policy is caught by the
  compliance manager and re-asked with **Ask everyone to re-confirm…**
  rather than resetting everyone for a screenshot, and never passing
  silently. The image's alt text (or the file name standing in for it) is
  kept to one line with no markdown in it (line breaks, brackets,
  parentheses, angle brackets, backticks and backslashes become spaces;
  300 characters at most), so what lands in the text is exactly one image
  line and nothing else, never a second image or a line of policy text
  recorded as an editorial fix. The person who minted the upload link is
  the row's decider.
- **What changed since you confirmed.** A re-confirmation no longer looks
  like a first request. When a reader's confirmation has lapsed, the notice
  strip says so in one sentence with the day, "This document changed since
  you confirmed it on 3 Mar. Please read the changes and confirm again.",
  with the same **Jump to confirmation** link, and the sticky bar's control
  reads **Re-confirm needed** (**Re-confirm** on a phone) instead of
  "Confirmation pending". The card at the end carries, above the statement,
  one line saying why: after a text change "Updated 3 Mar by Matt: "Section
  4 now covers contractors"" (the change note from the decision ledger; an
  edit, a merge, a restore, an approval, the API and the rest all read this
  way), after **Ask everyone to re-confirm…** "Matt asked everyone to
  confirm this document again on 3 Mar: "Section 4 now applies to
  contractors too."", and, when the annual cycle arrives, "Annual
  re-confirmation. It has been 12 months since you confirmed this document.
  Please read it again and confirm." When versions were written since the
  one the reader confirmed, a disclosure **What changed since you last
  confirmed (2 versions)** lists them with their notes, authors and dates,
  then renders the difference against the confirmed text (the same rendered
  diff as the editor's "Show changes") under a "+12 / −3 lines" header, with
  **Open in version history**, which opens Version history with the
  confirmed version and the current one already selected
  (`/doc/{id}/history?from={versionId}&to=current`). The confirmed text is
  read through the attested-version store, so the comparison works for the
  version a record cites even when it is not the marker's version, and a
  confirmation from before 1.10.0 is compared against the newest version
  that existed when the person confirmed ("Compared with version 11 (version
  inferred), which you confirmed on 3 Mar 2026."). A manual re-ask with no
  text change shows the reason and no disclosure, and the strip reads
  "Everyone was asked to confirm this document again on 3 Mar. Please read
  it and confirm again." rather than claiming the document changed. Nothing
  is served by a new endpoint: the page passes the two texts to the card.
  (The **Changed since you confirmed** chip on My policies arrives with that
  page in 1.11.1.)
- **Version history opens on a compare.**
  `/doc/{id}/history?from={versionId}&to={versionId|current}` preselects the
  two versions; only the document's own version ids are honoured, and
  anything else falls back to the default compare (previous against
  current).
- **Reading evidence on the record.** Every confirmation now stores two
  things beside the version and its hash: how long the document was open
  on screen for that person since everyone was last asked, and whether
  their browser reported that the end of the text had been on screen.
  The read time is summed on the server from the browser's view
  heartbeats (every 15 seconds while the tab is visible; each view capped
  at 30 minutes and bounded by the time the page was actually open) at the
  moment the confirmation is posted; the confirmation itself never sends a
  time. The reached-end flag is the same
  latch that flips the sticky bar to "Confirm now" (scrolling to the end
  or moving focus into the card both set it), stored as the reader's own
  report and labelled as such. The **Record** tab gains a **Read time**
  column ("6 min", "under 1 min", blank when no view was recorded) and a
  **Reached end (self-reported)** column with a check mark or nothing;
  the collapsed former-staff section carries both too. A read time is
  shown in amber only when it is shorter than a quarter of a typical read
  of the document at 200 words per minute, measured against the live
  text, with the tooltip "Shorter than a typical read of this document";
  a footnote under the table says what the columns are and that neither
  is proof of comprehension. Nothing is gated: the card's button is as
  available as it was, and confirmations from before 1.11.0 show a blank
  read time and no check mark.
- **CSV and API.** The per-policy CSV appends `read_seconds` (whole
  seconds, blank when unknown) and `reached_end_self_reported` (`yes` /
  `no` on a confirmed row, blank while pending) after
  `version_approved_by`; every existing column stays in place. The JSON
  roster and former-staff rows carry `read_seconds` and `reached_end`
  (`null` on a pending row). `POST /api/documents/{id}/ack` accepts
  `reached_end` and records it only for the JSON boolean `true`; a missing
  field, a string or a number records `false`. A confirmation made through
  the API without opening the page records no read time.
- New tests: the integration suite gains the submitter's recommendation on
  a request, the approver's choice over it (keep over reset, reset over
  keep, the reason rules, nothing applied for a non-substantive request),
  a keep without a reason on a merge while the program setting is off,
  a decision key held on another space only (403, the request stays
  pending), the pre-flight a review decision goes through and the notice
  sentence;
  `test/ack-tokens.test.ts` (new) drives the route handlers directly and
  pins the token invariant (a cdk_ and a cdo_ bearer accepted by the v1
  API and the connector and answered 401 by both confirmation routes; no
  connector tool confirms), the v1 PATCH contract (the 428 body verbatim,
  both 400s, a refused call writes nothing, metadata is never refused for
  want of a decision, keep
  and reset with their ledger rows, a draft edit never refused and the
  publish of a drifted draft refused until decided), the connector's
  `decision_required` result and its publish-of-drift case, and the import
  guard (skipped and named, a paused policy the zip would publish skipped
  the same way, overwritten when allowed with the reset counted and echoed
  to the audit log, an unchanged re-import counted as no re-ask); six
  lifecycle
  cases (every metadata path, bulk tag, type, move and status, nested
  pages, schedules, trash and restore, keeps the counts; a pause keeps the
  counts, leaves the per-person numbers and the dashboard, and resumes on
  republish; unpublish, edit, republish asks again and the shared
  pre-flight answers 428 for that publish; draft branches are out of every
  compliance query even when forced; the two side doors through their real
  call shapes, the drop link through its route handler, an alt text or
  file name carrying markdown landing as one image line; the scheduler's
  audit rows); `getLatestAck` (the newest confirmation, current or lapsed,
  the version it cites, the inference for a row without one, and that
  another person's row is never returned); the read time summed since the
  marker and its 30-day fallback, the stored flag and the whole-seconds
  rule, the body rule, the threshold rule, the CSV cells, and the
  double-boot test asserts the two columns and the index after every boot
  (from a 1.9.4-shaped and a 1.10.0-shaped database). The e2e specs gain
  the restore-on-policy flow (428, 400, 200, no question for the confirmed
  version), the API-level approval flow (recommendation applied,
  overridden, 428 until decided, both sides on the row, the author's
  notice), the v1 flows over HTTP (GET fields, 428 then 200, metadata,
  publish-of-drift, the connector's hint and `read_doc` line, and a token
  that edits a policy and cannot confirm it), the paused group, the
  re-confirmation after a material change (the strip, the sticky control,
  the reason line, the disclosure with the diff, the history link opening
  the compare, confirming again) and a manual re-ask with no text change
  (the reason line, the honest strip sentence, no disclosure).

### Changed
- The review queue's Approve now toasts its result ("Approved." and the
  decision sentence); before it only removed the card. Reject is
  unchanged. The editor's question takes three more modes (approve,
  restore and merge) and an optional title; in every mode the note typed
  in it is the version note as well as the recorded reason; the save and
  submit modes and their labels are unchanged. A merge or a restore that
  goes to the review queue asks the submit question in the app ("Submit
  changes to a confirmed document?", the same two cards, the note
  prefilled from the banner's note or "Restored version 9 from
  2026-02-01", a primary that reads **Submit. Recommend keeping
  confirmations** / **Submit. Recommend re-confirmation**), so the request
  carries the submitter's recommendation and reason the way the editor's
  own submission does. Version history and the History tab show what the
  submitter recommended when the approver overrode it: "Editorial (kept)
  recommended material change by Alex, approved by Priya"; when the two
  agree the line stays "recommended by Alex, approved by Priya". Keyboard
  focus returns to the button that opened a question from a 428, so
  Cancel no longer leaves a keyboard user at the top of the page; each
  review-queue card is an article named by the request's title.
- The History tab's source label for a branch merge reads **Merge** (was
  "Branch merge"). The compliance portal's paused group reads **Paused
  (unpublished) · 3**, its description says "program", and the four tiles
  are a description list, so the number is the definition of its label
  for assistive technology. The admin import page's checkbox help says
  what the import does: "On, such documents are overwritten and each
  one's edit default decides what readers see (under the recommended
  default everyone is asked to re-confirm)." Every scrolling table (the
  Record tab among them) prints whole on a portrait page: the minimum
  width that makes it scroll on screen is dropped in print.
- An approval of a text change to a confirmed policy no longer resets by
  default when the submitter recommended keeping confirmations: the
  recommendation applies unless the approver overrides it. A request with
  no recommendation and an approval with no decision keeps the 1.10.1
  behaviour (the document's edit default decides) only through
  `approveChangeRequest` itself; the API answers 428 first.
- `PUT /api/documents/{id}` checks `ack_policy` before the review queue as
  well as before a direct save, so a request submitted with a bad value is
  refused (400) instead of queued without a recommendation. The v1 API,
  the MCP connector, a merge, a restore and an approval refuse the same
  value the same way: the field is validated whenever it is sent, before
  the question whether the change is substantive, so `ack_policy: "auto"`
  or garbage on a metadata-only change is 400 on every path.
- The connector's audit rows (`document.update`, `document.publish`,
  `attachment.upload` and the two decision echoes) now carry the caller's
  IP address, as the v1 API's and the drop link's already did.
- The 1.10.0 sentence "Integrations that edit policies through the v1 API
  or the MCP connector keep working; a text change resets confirmations as
  before" no longer holds for the text of a confirmed policy: see
  **Breaking**. Metadata edits, drafts and ordinary documents keep working
  unchanged.
- **Draft branches are never policies.** The compliance portal, the
  per-person numbers and the dashboard's pending row now exclude draft
  branches in the query itself (a branch could never carry the
  requirement, since only the shield's switch writes it, and branching
  copies nothing of it; the queries now say so, as the Request picker
  already did).
- The portal-wide CSV matrix (`GET /api/admin/compliance?format=csv`)
  lists published policies only; a paused policy's record is still on its
  own Read confirmation page and in its per-policy CSV. `GET
  /api/admin/compliance` rows gain `status` (`published` or `draft`), and
  `kpis` are the sums over the published rows. `POST /api/admin/compliance`
  on a paused policy still answers 404 "Document not found or not
  published."; switch it off, if you must, from the shield on the
  document (`PATCH /api/documents/{id}/ack { required: false }`).
- The end-of-document card's confirmation now posts `{ version_id,
  reached_end }`: `reached_end` is the page's own report that the end of the
  article has been on screen (the latch the sticky bar already used), stored
  with the record as evidence (see the reading-evidence entry). The card
  never sends a reading time; the server sums that from the view
  heartbeats itself.

### Upgrading
- **Schema additions.** `change_requests.ack_policy` (text, default
  `'auto'`) and `change_requests.ack_reason` (text, default `''`);
  `acknowledgements.read_seconds` (integer, null when unknown) and
  `acknowledgements.reached_end` (integer, NOT NULL DEFAULT 0); and the
  index `idx_views_doc_user` on `doc_views(document_id, user_id, viewed_at
  DESC)`, which the read-time sum and the later never-opened probe share.
  All of them are catalog-guarded `ADD COLUMN IF NOT EXISTS` / `CREATE
  INDEX IF NOT EXISTS` lines; the two `change_requests` columns are added
  after the `doc_views` index is built, so on a rolling upgrade the
  exclusive lock they take on `change_requests` (which every app page
  reads for the review badge) is held for the tail of the boot, not across
  the index build. No backfill: the evidence starts at upgrade,
  and requests pending at upgrade carry no recommendation, so approving one
  that changes the text of a confirmed policy asks the approver (428
  through the API) until they decide.
- **Unpublished policies reappear as paused.** Policies that were
  unpublished before 1.11.0 with the requirement still on reappear in the
  portal's **Paused (unpublished)** group (they were invisible on 1.10.x;
  the record never went anywhere). Nothing is sent and nothing is reset by
  the upgrade.
- **The per-policy CSV gains two trailing columns**, `read_seconds` and
  `reached_end_self_reported`, after `version_approved_by`; the portal-wide
  CSV is unchanged. No existing column moved.
- Privacy: no new tracking is added. The read time is a sum of the view
  records the workspace already keeps, copied onto the attestation record
  because view records are not retained with the document, and shown only
  to people who may read the record (`document.ack_roster_read`). The
  reached-end flag is reported by the reader's browser and is never
  treated as more than that.
- **Rollback to 1.10.1 is supported.** 1.10.1 ignores the new columns and
  the index and leaves them in place: a request submitted on 1.11.0 with a
  recommendation is approved there as the document's edit default decides,
  and the recommendation stays on the request unused and unrecorded; rows
  written on 1.10.1 during a rollback carry no read time and no report;
  paused policies are hidden again, unchanged; images through the connector
  and upload links follow the document's edit default again (under the
  recommended default everyone is asked); and the import checkbox is
  absent.

## [1.10.1] - 2026-10-16

Read confirmation, part two: tell people once, a settings popover on the
shield, a deliberate re-ask, and a portal that asks before it sends.
(Enterprise, `policy_ack`.)

### Added
- **Tell people once.** A material change now tells everyone whose
  confirmation lapsed. Every read-confirmation notice (the portal's
  Request and Remind, and the new re-confirmation notice after a reset)
  is a row in a notification outbox, delivered within a minute by
  whichever instance's timer gets there first, never on the request path:
  a save of a 500-reader policy returns at once and no proxy timeout can
  leave half the people emailed. A reset queues its notice inside its own
  transaction (a rolled-back approval or merge tells nobody); notices from
  a text save (edit, merge, restore, approval, schedule, the API and MCP)
  wait two minutes and merge, and a person who already heard about a
  document that day is not told again unless they confirmed it since, so
  three saves in an afternoon are one notice. A manual "ask everyone to
  re-confirm" always delivers. Links in a notice use the custom domain
  when one is set; otherwise they use the address of the request that
  queued it (the portal, the editor's save), carried on the queue row, so
  a workspace without a custom domain still gets absolute links and
  nothing is remembered from one request to the next.
  In-app: "Changed. Please re-confirm "Expense policy"" with "{who}
  changed "{title}": {change note}. Please read the changes and confirm
  again."; every link lands on the confirmation card
  (`/doc/{id}#confirm-reading`), including notices written before 1.10.1.
  The audit entry `ack.reset_notified` (`ack.requested` /
  `ack.reminder_sent` for the portal's actions) is written when the
  delivery finishes, with the real counts
  `{pending, emailed, noticed, skipped_recent}`. Two Requests at once (a
  double submit, two managers, the portal and the popover) queue one
  notice: only the call that switched the requirement on queues it, and
  Remind's one-hour limit is one atomic claim, so two clicks in the same
  second send one reminder and the other answers 429.
- **A per-person notice log.** Every notice is provable per recipient:
  `ack_notices` keeps who was told, about which policy, in what way
  (request, reminder, updated), when, by whom, and the channels that
  actually went out (`inapp`, `email` only when the mail server accepted
  it, `webhook`). A row whose channels lack `email` because the person
  turned the read-confirmation email off reads "email opted out". The row
  outlives the account (name and email snapshot) and the policy (title
  snapshot), and anonymising a person rewrites it like every other record
  (and the queue row's requester name; the queue's error column names a
  person by id, never by address). The record is written as soon as the
  in-app notices are, before the mail goes out, and an instance keeps its
  claim on the queue fresh while it delivers, so a long delivery (hundreds
  of readers on a slow mail server) is never taken over by another
  instance and sent twice. A delivery that fails (SMTP down, a template
  that will not render, an inbox that took no rows) keeps its row for a
  retry after ten minutes, up to three attempts; the retry resumes from
  the notice log, emailing only the people the earlier attempt could not
  reach and never repeating an inbox row. The third failure closes the row
  with its error and is audited `ack.notice_failed`; a row an instance
  died on during its last attempt is closed and audited the same way by
  the next delivery run, so nothing is left half-done and unreported.
- **The shield is a popover.** The read-confirmation shield on a document
  opens **Read confirmation** instead of toggling: **Require readers to
  confirm**, the standing ("42 of 50 confirmed · v12 · asked 3 Mar 2026 by
  Matt", or after a quiet switch-on "Required 3 Oct by Matt (no notice
  sent)" and, reopened, "0 of 42 confirmed · v12 · no notice sent yet"
  until someone is asked) with **View record**, **Ask everyone to re-confirm…**, and **When the text
  changes**, the per-document edit default: *Ask the editor each time*,
  *Ask only when a change looks material* or *Always ask everyone to
  re-confirm* (the workspace default is marked). Switching the requirement
  on asks "Require read confirmation?" with the audience ("Everyone who
  can see this space (42 people) will be asked to read and confirm this
  document.") and **Require and notify** / **Require quietly**; Cancel
  leaves it off. Switching it off keeps the record and offers **Undo** in
  the toast. A document receives the workspace value from Program settings
  the first time it is set to required. Under *material* the editor's
  question opens only for a change the heuristic calls material or
  borderline; an editorial-looking save is kept without asking ("Saved as
  an editorial fix (document setting). Confirmations kept.") and recorded
  on the History tab from source *Default*, so it is never silent. Under
  *always* nothing is asked, the change note is required (the field says
  so inline) and the toast reads "Saved. 42 people will be asked to
  re-confirm." Callers that cannot ask (merge, restore, the API, MCP,
  imports, an approval, a scheduled publish) follow the same default, so a
  procedure set to *material* no longer re-asks everyone for a corrected
  typo that came in through the API, and a change request approved on
  such a policy, or a scheduled publish of one, keeps an editorial-looking
  change from source *Default* and asks everyone again for anything else
  from source *Approval* or *Schedule*. The help under the change note says
  which applies. The approver's progress row left the notice strip: the
  popover carries it, so an approver who is also a reader no longer sees
  two rows. The portal shows the setting as a chip (**Asks editor** /
  **Asks when material** / **Always re-asks**) with the full option
  sentence as its tooltip.
- **Ask everyone to re-confirm, without editing.** Until now the only way
  to ask readers again was to change the text. **Ask everyone to
  re-confirm…** sits in three places that always read the same: the
  popover, the Read confirmation page header beside **Export CSV**, and
  the compliance portal's policy row beside **Remind**. It opens one
  question, *Ask everyone to re-confirm "Expense policy"?*, with the
  standing ("42 of 50 people have confirmed version 12. This resets those
  confirmations, notifies everyone who can see the document, and shows
  them your reason.") and one required field, **Why are readers being
  asked again?** (10 characters or more). The button says what it does:
  **Ask 42 people to re-confirm**. On success the toast reads "42 people
  will be asked to re-confirm." and the roster shows everyone Pending; the
  prior confirmations stay in the record, tied to the version they
  covered. When nobody has confirmed the current version the control is
  disabled with "Nobody has confirmed this version yet. Use Remind." No
  version is written: the text did not change. The marker, the version it
  points at and the Remind cooldown move in a single database statement
  whose guard is the cooldown itself, so two managers, two tabs or two
  instances asking at once produce exactly one reset, one ledger row and
  one notice; the other is answered 429 "Readers were asked again 12
  minutes ago." Request, Remind and the re-ask share that hour. Anyone who
  may require read confirmation on the space (`document.ack_require`) or
  run the compliance programme (`compliance.program_manage`) may ask.
- **The portal asks before it sends anything.** **Request read
  confirmation** opens the same question as the shield (*Require read
  confirmation for "Expense policy"?*, the audience, **Require and
  notify** / **Require quietly**); Cancel sends nothing and switches
  nothing on. **Remind** asks too, because sending mail cannot be undone:
  *Remind 88 people?* ends "This cannot be undone." and the button reads
  **Send reminders**. Each policy row gains **Stop requiring** (the record
  is kept; the toast carries **Undo**, which switches it back on quietly).
  The toasts say what was queued: "Read confirmation required: 42 people
  will be notified." / "Reminders queued for 88 people."
- **The read / manage / export split is enforced.** The three compliance
  permissions were defined in 1.9.x but never checked: anyone granted the
  Compliance section could mail the workspace and export the matrix.
  Every portal handler now carries its own key: `compliance.program_read`
  opens the portal and its JSON, `compliance.program_manage` is needed to
  request, remind, stop or change the program settings,
  `compliance.export` to download any CSV. A role without a key is
  answered 403, and the portal hides the controls a read-only holder
  cannot use. Every export writes one audit row, `ack.export`, with the
  format (`matrix` or `roster`), the document, the row count and whether
  the IP column was filled. The per-policy record gains two trailing
  columns, `ip` and `user_agent`, filled only for a caller who also holds
  `compliance.export`; a roster reader without it still gets the version,
  hash and name columns an auditor verifies against, with the IP left
  blank (`user_agent` is reserved and blank: the record does not store it
  yet). `document.ack_roster_read` and `document.ack_require` are checked
  on the document's own space: a role granted either key on one space
  cannot read the record of, or switch the requirement on, a document it
  can merely read in another (403). The per-policy record, the re-ask and
  the shield's settings answer 404 for a draft the caller may not read,
  as the document itself does.
- **Program settings.** The portal gains **Settings**, which opens
  `/compliance/settings` for anyone who holds `compliance.program_manage`:
  the defaults every policy inherits, on one page with one Save row and an
  unsaved-changes guard. **Editing**: **When the text of a policy
  changes** (the edit default a policy receives when it is first set to
  require read confirmation) and **Require a reason for editorial fixes
  too** (on by default). **Confirmation statement**: the **Default
  statement** on the card at the end of every policy, with a live preview
  (one sentence of up to 300 characters; the house sentence until
  changed). Both are honoured in this release: the end-of-document card
  shows the workspace's statement, and when the reason requirement is
  off an editorial fix needs no change note (the field reads "Change note
  (optional)"; a material change always needs one, and anything typed is
  recorded either way). Until an administrator changes something, every
  default reproduces the behaviour the product already had. Deadlines, reminders,
  annual re-confirmation, evidence and the typed signature arrive with the
  items that honour them, so the page never shows a control nothing
  reads.
- **Who published and approved the version.** Each version now records
  who published it and, when it came through a change request, who
  approved it and which request carried it. The read-confirmation summary
  exposes `published_by_name` / `approved_by_name` for the version people
  confirmed and for the newest version; the card and the version history
  say "published 3 Mar 2026 by Matt · approved by Priya", and both CSVs
  gain `version_published_by` and `version_approved_by`. Versions written
  before 1.10.1 get the publisher's name from the byline and the
  approver's name from the "approved by" note where one was written; the
  rest stays blank.
- **Email template.** The *Read confirmation request* template gains the
  tags `change_note`, `reason`, `due_date` and `days_left` (blank when
  they do not apply), `request_label` now reads *Action required*,
  *Reminder*, *Updated* or *Annual re-confirmation*, the body says "read
  and confirm" and ends with "Open the document and confirm at the end
  that you have read and understood it." The subject is unchanged. A
  workspace that edited the template keeps its own wording and adopts the
  new tags and sentence when it next edits or resets it. The free-text
  tags of this template (`requester_name`, `doc_title`, `change_note`,
  `reason`) are rendered as written: markdown or HTML typed into a change
  note or a re-ask reason appears as those characters in the mail, not as
  a link or an image. Other templates are unchanged.
- **API.** `PATCH /api/documents/{id}/ack` takes `{ required?,
  edit_default?, notify? }` (400 with no known field or a wrong type;
  `required: true` runs the portal's request sequence, with `notify`
  defaulting to false as the 1.10.0 toggle told nobody, and is a no-op on
  a document that already requires confirmation) and answers `{ ok,
  ack_required, edit_default, queued, eligible }`; `GET
  /api/documents/{id}/ack` adds `workspace_edit_default` and
  `keep_reason_required`, and `edit_default` is now the document's real
  value. `PUT /api/documents/{id}` with `ack_policy: "keep"` no longer
  needs a 10-character `ack_reason` when Program settings turns off
  "Require a reason for editorial fixes too"; `reset` always needs one. `POST
  /api/documents/{id}/ack/reconfirm { reason }` answers `{ ok, reset,
  queued }` (400 when the document is not published or not required, or
  the reason is under 10 characters; 402 unlicensed; 403 without either
  permission; 404 outside the caller's space scope; 429 inside the hour;
  `user_ids` is accepted and refused with "Per-person re-asks arrive with
  audiences." until the per-person re-ask ships). `POST
  /api/admin/compliance` validates `action` against `request` | `remind`
  | `stop` and answers 400 `Unknown action.` otherwise (before 1.10.1
  anything but `remind` meant `request`, so a malformed call switched a
  policy on and mailed everyone); `request` accepts `notify: false` and
  answers `{ ok, queued, eligible }`, `remind` answers `{ ok, queued }`,
  `stop` answers `{ ok, acked, required }`; `GET
  /api/admin/compliance?preview={docId}` returns `{ eligible, pending,
  required }` and the GET payload gains `can: { manage, export }`. `GET`
  and `PUT /api/admin/compliance/settings` read and write the program
  settings (`PUT` takes any subset, validates every key and answers 400
  with the key named; the response echoes the saved settings and
  `changed`). Every `PATCH /api/documents/{id}/ack` answer carries the
  five fields, read after the writes, whichever fields were sent; `POST
  /api/admin/compliance` refuses a `notify` that is not `true` or `false`
  (400); a second `request` for the same policy that lands in the same
  instant is answered 400 "already asks" rather than queuing a second
  notice, and a second `remind` in the same second answers the 429.
- **Audit.** `document.ack_required { notify, eligible, queued }` and
  `document.ack_removed { acked, required }` from the shield and the
  portal; `ack.edit_default_set { from, to }`;
  `ack.reconfirmation_requested` with the reason, the version, `reset`,
  `eligible`, `queued` and the ledger and outbox row ids; `ack.export`;
  `settings.compliance` ("Updated compliance settings"), one row per
  changed key with `{ key, from, to }`; `ack.notice_failed`.
- New tests: the integration suite grows with the outbox and the notice
  log (coalescing, the daily rule, retries that never repeat a row,
  rollback leaves no notice), the program settings, the re-ask (two
  parallel claims produce one reset and one refusal, the shared hour, no
  version written), version provenance and the per-document edit default;
  e2e specs for the portal's questions, Stop requiring with Undo, both
  CSV downloads, the re-ask flow, a read-only compliance role and the
  popover.

### Changed
- The portal's **Request** and **Remind** queue instead of sending: the
  response says how many people will be told, the one-hour Remind
  cooldown is unchanged, and a request that requires without notifying
  starts no cooldown. The 429 inside the hour reads "A reminder went out
  less than an hour ago. Give people a moment." Two Request or two Remind
  calls at the same moment queue one notice, not two: only the call that
  switches the requirement on queues the request, and the Remind cooldown
  is stamped in the same statement that admits the reminder, so the hour
  is enforced atomically.
- **Compliance portal hygiene.** Every portal action runs through the
  house action helper with toasts (no more top-of-page notice banners),
  the People table and the per-policy roster are the house table with a
  pager (50 rows a page), the roster expand shows **Confirmed** /
  **Pending** chips with the time and the version confirmed, a roster that
  cannot be loaded says so in a toast and folds the row back, and a
  policy's cached roster is dropped after Request, Remind, Stop requiring
  and Undo. The licence gate offers **Open License** only to someone who
  can open Settings → License.
- The inbox fan-out reports what it reached (inbox and webhook counts and
  the ids behind them) instead of returning nothing, and an inbox insert
  skips an account deleted a moment earlier instead of failing the whole
  batch.
- Read confirmation request emails say "read and confirm", never
  "acknowledge".
- Both compliance CSVs guard against spreadsheet formula injection: a cell
  that starts with `=`, `+`, `-` or `@` is prefixed with an apostrophe, so
  a name, a title or a reason is never run as a formula when the file is
  opened.
- The popover's **When the text changes** select never shows two
  parentheticals: the workspace's option reads "Ask the editor each time
  (workspace default)". The disabled **Ask everyone to re-confirm…**
  (shown until someone has confirmed the current version) can be reached
  with the keyboard and announces its reason, "Nobody has confirmed this
  version yet. Use Remind.", instead of explaining itself on hover only.
  The Program settings licence gate offers **Open License** to the same
  people as the portal's gate: anyone who can open Settings → License.

### Fixed
- On a phone the compliance portal's policy-row actions (Remind, Ask
  everyone to re-confirm…, Stop requiring, the download) wrap onto a
  second line instead of being clipped by the card, and printing the
  portal leaves its controls off the paper, as the record page already
  did. The document toolbar spans the content width on a phone, so the
  share, review-schedule and read-confirmation popovers no longer hang off
  the left edge of the screen when the toolbar holds only a few icons.

### Upgrading
- **Boot takes no lock on an up-to-date table.** Every `ADD COLUMN IF
  NOT EXISTS` and every `CREATE INDEX IF NOT EXISTS` in the schema now
  looks the catalog up before it runs (Postgres locked the table first and
  looked second, so each of them locked `users`, `documents`,
  `doc_versions` and the rest for a moment on every start, and a start
  that raced a save could deadlock against it), and the remaining
  every-boot statements (the `users` ladder trigger, the training
  history's NOT NULL and foreign-key swap, the `spaces` visibility
  default) are guarded the same way. A boot against an up-to-date
  database runs, at the top level, only `CREATE TABLE IF NOT EXISTS`,
  catalog lookups, one `CREATE OR REPLACE FUNCTION` and three row-level
  updates: no exclusive and no share lock on any table, so a rolling
  restart no longer blocks or deadlocks against a save on another
  instance. The first boot after an upgrade runs the identical DDL. A
  unit test reads the schema out of the source and fails on any
  unguarded statement; the double-boot test checks the catalog after
  every boot, from a 1.9.4-shaped and from a 1.10.0-shaped database.
- The schema adds the tables `ack_notices` and `ack_outbox`,
  `documents.ack_edit_default`, and five columns on `doc_versions`
  (`published_by`, `published_by_name`, `approved_by`, `approved_by_name`,
  `change_request_id`; created once in a guarded block). A one-shot backfill fills the provenance
  names for existing versions and records `migrated_version_provenance =
  1` in settings. Existing policies start on *Ask the editor each time*;
  the workspace default applies to policies first required after the
  upgrade.
- Nothing is sent for anything that happened before the upgrade: the
  notice log starts now. Closed outbox rows (delivered, or given up after
  three attempts, with their error) are dropped after 30 days by the
  hourly maintenance; the audit entry is what lasts.
- A custom role that held only `compliance.program_read` could request,
  remind and export before 1.10.1; it cannot now. Grant
  `compliance.program_manage` and/or `compliance.export` to the roles that
  should run or export the programme (the built-in Compliance manager
  role holds all three).
- **Rollback to 1.10.0 is supported.** 1.10.0 ignores the new tables and
  columns: a reset sends no notice (the portal's Request and Remind send
  at once, as before), the editor is asked on every text change whatever a
  policy's edit default says, and the version columns are left as they
  are. A notice queued and not yet delivered goes out when 1.10.1 boots
  again, so a policy also reminded from the 1.10.0 portal may be noticed
  twice. Versions published while on 1.10.0 show no publisher or approver
  after re-upgrade (the backfill runs once), and an account anonymised on
  1.10.0 keeps its name in the notice log until it is anonymised again on
  1.10.1.

## [1.10.0] - 2026-10-16

Read confirmation, part one: no more silent resets, and the confirmation
sits where reading ends. (Enterprise, `policy_ack`.)

### Added
- **The editor asks before it resets anyone.** Saving a text or title
  change to a document people have confirmed opens one question, before
  anything is busy: "How should readers see this change?" with the numbers
  ("42 of 50 people have confirmed version 12"), two choices (**Editorial
  fix. Keep confirmations** / **Material change. Ask everyone to
  re-confirm**), one sentence saying which looks right and why ("Looks
  editorial: 14 words in one paragraph changed (1.1% since v12)."), a
  **Show changes** diff against the confirmed version, and a change note
  that both choices require. The primary button says what will happen:
  "Save. Keep confirmations" or "Save and ask 42 people to re-confirm".
  Ctrl+S, Save changes, Publish on a drifted draft and Submit for review
  all pass through it; Cancel leaves the editor dirty; a save that only
  touches tags, the summary, the category or the type never asks, even
  after an editorial fix. Without publish rights nothing is asked: the
  save goes to the review queue as before, and approving a text change
  asks everyone again (the submitter's recommendation and the approver's
  choice arrive in 1.11.0).
- **Confirm at the end.** A document that requires read confirmation ends
  with a confirmation card after the text: the statement ("I confirm that
  I have read and understood this document."), the version being
  confirmed ("Version 12 · published 3 Mar 2026 by Matt") and one button.
  The notice strip at the top is a one-sentence pointer with "Jump to
  confirmation" instead of a live button. The sticky bar carries a
  "Confirmation pending" jump link that reads "Confirm now" once the end
  of the text has been on screen, and a "Confirmed {date}" chip afterwards;
  on phones it shows the control and the title only. Nothing is ever
  locked: the card's placement is the only gate. Once confirmed, the card
  reads "You confirmed version 12 on {date}" (a link to your own record
  arrives with My policies in 1.11.1), and after an editorial fix it
  offers "Re-confirm the current text (v13)".
  A printed policy carries the printer's standing.
- **Every confirmation is tied to a numbered version and its SHA-256.**
  The page declares the version it rendered; the record stores that
  version and the hash of its text. Confirming a document that changed
  while you were reading it records nothing: the page says so and
  refreshes. Confirmations made before 1.10.0 show "version inferred".
- **The decision ledger.** Every keep and every reset is a row: the
  version, who decided (and who submitted, on an approval), the source
  (edit, merge, restore, approval, schedule, bulk, API, MCP, import,
  image, ticket, default),
  the reason, what the heuristic suggested and whether it was overridden,
  the share of words changed, and how many confirmations it touched.
  The per-document record is now a **Read confirmation** section with a
  **Record** tab (the roster, with the version each person confirmed) and
  a **History** tab (the ledger). Version history rows carry "Asked
  everyone to re-confirm" or "Editorial (kept)"; the compliance portal
  shows "Last asked {date} by {name}: {reason}" per policy and, once edits
  have been kept, "Edited 3 times since v12 without re-asking · 7.8%
  drift".
- **Attestation records outlive the person and the policy.** Deleting an
  account keeps its confirmations with a name and email snapshot;
  disabling one drops it from the count but not the record; a collapsed
  "Former staff and disabled accounts" section lists them. Purging a
  policy from the Trash first archives every version a record cites, so a
  stored hash stays verifiable after the document is gone. Settings →
  Users gains **Anonymise compliance record…** (typed confirmation) which
  replaces a person's name, email and IP on every confirmation and
  decision with "Former staff #id"; counts, dates, versions and hashes
  stay. Audit log entries are kept as written: each
  `document.acknowledge` row still carries the name, IP and browser
  recorded at confirmation, and `ack.anonymised` names the account.
- **One word for read confirmation.** The product now says "read
  confirmation" everywhere a person reads it: readers confirm or
  re-confirm, chips read Confirmed / Pending, a text is "version 12"
  (v12). On the Compliance portal "Request acknowledgement" is "Request
  read confirmation" and the tiles read "Policies requiring confirmation"
  and "Outstanding confirmations"; the request email is the "Read
  confirmation request" template with the subject
  `[Workspace] Action required: confirm "Title"` (a workspace that edited
  the template keeps its own wording). API paths, audit keys, permission
  keys and the licence label keep "acknowledgement". The style guide
  documents the glossary, the choice dialog and the end-of-article card.
- **API.** `GET /api/documents/{id}/ack` returns the read-confirmation
  summary for anyone who may edit the document or read its roster
  (`?baseline=1` adds the confirmed text); a draft is hidden from anyone
  who may not read drafts, as the document itself is. `PUT
  /api/documents/{id}` accepts `ack_policy` (`keep` | `reset`; absent =
  reset, anything else 400) and `ack_reason` (cut at 500 characters),
  answers 400 when the text of a confirmed document changes without a
  note of at least 10 characters, and echoes `ack_outcome`.
  `POST /api/documents/{id}/ack` requires `{ version_id }` (400 when
  absent, 409 `{ stale: true }` when it is not the latest version).
- **Audit.** A full read-confirmation vocabulary under `ack.`
  (`ack.confirmations_kept`, `ack.confirmations_reset`, `ack.anonymised`
  and the rest of the family), labels for `document.ack_required` and
  `document.ack_removed`, the version and hash on `document.acknowledge`.
- New tests: the integration suite grows from 118 to 188 (version
  anchoring, retention, the decision ledger, the change heuristic, the
  roster sentence, and a double-boot upgrade check), plus an e2e spec for
  the reader flow, the phone sticky bar, the editor question, the
  bulk-publish guard and the API rules.

### Changed
- **Confirmations no longer reset on every save.** A confirmation counts
  while it is newer than the document's confirmation marker, which moves
  only when the text or title changes and the editor chooses to ask again
  (or a caller that cannot ask saves a text change). Changing the summary,
  tags, category or type, moving a document, scheduling, unpublishing and
  republishing unchanged text, trash and restore, bulk edits and a save
  with nothing changed never ask anyone again. A save that changes nothing
  is not a save: no version, no "updated" time, no notice, no
  `document.update` audit row (a save that only sets a schedule or moves a
  page under another parent is still audited, with what changed, and a
  branch merged with its text unchanged still records
  `document.branch_merge`, marked unchanged, as it moves to the Trash).
- Callers that cannot ask (branch merge, version restore, change-request
  approval, a scheduled publish of a draft whose text drifted from the
  confirmed version, the MCP connector, the v1 API, image placement,
  importers) reset confirmations when they change the text, with the
  version note (on an approval, the change request's note) as the reason;
  the decision is recorded with its source, and an approval row names the
  submitter beside the approver. A bulk publish of such a drifted draft is
  skipped instead, with "requires a re-confirmation decision; publish it
  individually". The choice for merge, restore and change-request approval
  arrives in 1.11.0.
- A reset sends no notice in this release; the re-confirmation notice and
  the outbox it queues through arrive in 1.10.1.
- Both compliance CSVs keep every existing column in place;
  `revision_as_of` now holds the confirmation marker date (it was the last
  save), and these columns are appended: `version`, `version_id`,
  `content_sha256`, `version_source`, `former_staff`, `asked_at`,
  `asked_by`, `reason`, `kept_since_asked`.

### Upgrading
- The schema adds `documents.ack_revision_at` (backfilled from
  `updated_at` inside the schema transaction, so no existing confirmation
  changes state) and `ack_version_id`; `acknowledgements.version_id`,
  `content_sha256`, `user_name`, `user_email`, `document_title`; the
  tables `attested_texts` and `ack_decisions`; the index `idx_ack_user`.
  Two one-shot migrations run on the first boot and record
  `ack_marker_schema = 1` and `ack_retention_schema = 1` in settings: the
  version inference for existing rows, and the swap of the acknowledgement
  foreign keys to ON DELETE SET NULL (added NOT VALID, then validated, so a
  large ledger is checked without blocking writes). The ledger starts at
  upgrade; nothing is backfilled into it.
- **Rollback to 1.9.x is supported.** 1.9.x ignores the new columns and
  tables. After a rollback, edits made on 1.9.x move only `updated_at`, so
  on re-upgrade confirmations that 1.9.x showed as stale become current
  again until the next text change; records whose person or policy was
  deleted while on 1.10 are invisible to 1.9.x and reappear on re-upgrade.
  Two more consequences of time spent on 1.9.x: the one-shot inference
  does not run again, so documents and confirmations created there carry
  no version id after the re-upgrade (they show "version inferred" with no
  number; a document's marker catches up at its next text change), and
  accounts deleted there leave their records without a name or email
  snapshot.
- Integrations that edit policies through the v1 API or the MCP connector
  keep working; a text change resets confirmations as before.

## [1.9.4] - 2026-10-14

### Fixed
- **A link opened while signed out now lands on that page after sign-in**
  instead of the dashboard. Someone who receives a link to a document,
  a search or any other page and is not signed in is sent to the sign-in
  page with the page remembered, and arrives there once they sign in —
  with a password, through Microsoft or SAML single sign-on, and even
  when a first-login password change comes first. The remembered page
  can only ever be a page in this workspace: an address that points
  off-site, at the sign-in page itself or at an API falls back to the
  dashboard.

## [1.9.3] - 2026-10-02

Documents, part four: the places you find things.

### Added
- **The Ask page has a first-run state.** Before a question it offers
  suggested questions, operator chips (type: tag: space: author:) that
  insert at the caret, the documents people here read most this month
  (scoped to what you can see), and your own recent questions, kept in
  this browser only. A question in the address bar still runs at once.

### Changed
- **The dashboard's Spaces are a compact grid** of the eight most recently
  active, instead of one 70px card per space in a single column; Latest
  never repeats a document already in the pick-up cards and always shows
  eight; the inert clock icon on each row is the document's type badge.
- **Search results use the screen**: a column grid (one at Normal, two at
  Wide, three on a wide monitor) with two-line snippets, and the empty
  state spans it. The "related" badge explains itself to readers too.
- **Inside a space, cards show the author** and a "Review overdue" chip
  instead of repeating the space's own name, and the layout switcher is
  the house segmented control.

## [1.9.2] - 2026-10-02

Documents, part three: one standalone document, a history pane that uses
the screen, and a palette you can drive with a mouse.

### Added
- **The command palette has mode chips** — All, Actions, People, Spaces,
  Shortcuts — under the search box, mirroring the Tab cycle, so mouse
  users can filter too; focus stays in the box. **Links are indexed**:
  searching "Clio" finds the configured shortcut in its own Links group
  and opens it in a new tab. The results are a proper listbox with
  labelled groups, a busy state and a spoken result count; keycaps read
  "Enter", not a glyph.

### Changed
- **Shared and public documents are one page.** The share page and the
  public document page render the same standalone document — the same
  masthead, summary, reading card, attachments panel and print output —
  so they can no longer drift. On all three reading surfaces a body that
  opens with "# Title" no longer shows the title twice: the leading
  heading is dropped when, and only when, it repeats the document's
  title.
- **Version history's compare pane grows with the screen** (never smaller
  than before), the Original and Modified radios have readable labels and
  spoken names ("Original: version 3"), and notes get the house tooltip.

## [1.9.1] - 2026-10-02

Documents, part two: the editor's layout.

### Changed
- **Properties sit beside the text.** At Wide and Full the editor's
  properties — space, parent page, category, type, schedule, summary,
  tags, change note — live in a sticky rail to the right of the editor,
  under the Cancel/Save row, so writing starts near the top of the page
  instead of 660px down and a select no longer stretches to 740px on a
  wide screen. At Normal and on narrow screens they sit above the text
  as before, in the shared field controls.
- **The toolbar never jumps.** It is two rows: every tool that applies
  anywhere, and a row for the current block — heading highlights,
  table, image, panel, button and spacer tools — that is always present
  at one height, so the text under the toolbar no longer shifts when
  the caret enters a heading or a table.
- **The Markdown pane grows with the document** instead of scrolling
  inside a fixed box; the page scrolls, as it does for rich text.

## [1.9.0] - 2026-10-02

Documents, part one: the editor wraps where the page wraps, the table of
contents moves into the rail, and publishing is a button.

### Added
- **Publishing is an explicit action with a visible status.** The editor
  shows the saved state as a chip beside the title ("Draft", "Published",
  "Not saved yet") and offers the actions that state and your rights
  allow: Save draft and Publish on a draft; Save changes and Unpublish
  (which asks first) on a published document; Submit for review when you
  cannot publish directly. The Status select is gone, the scheduling
  fields follow the real status, and Ctrl+S keeps the document as it is.
- **The table of contents lives in the rail** at Wide and Full — "On this
  page", capped at half the viewport with its own scroll — and stays a
  collapsible card above the body at Normal and on narrow screens. Both
  mark the heading you are reading as you scroll, and a link to a heading
  lands on it when the page opens.

### Changed
- **The editor shares the reader's measure.** Rich text and the Preview tab
  wrap running text at the same Normal / Wide / Full measure as the
  document page, so the editor looks like what it produces instead of
  running 230-character lines across a Full column; tables, code, callouts,
  accordions, tabs and embeds keep the full width, and the newsletter and
  template editors are unchanged.

## [1.8.2] - 2026-10-02

The admin console, part three: a way to the fix, a picker instead of a
wall, one place for "New", a Trash that scales, and a vocabulary.

### Added
- **Failing diagnostics link to their fix.** "Email (SMTP) — Attention"
  now carries "Set up SMTP"; AI, semantic search, the licence and the
  MCP connector likewise. Every "Settings → X" reference in the product
  is a link when you can open that section and plain text when you
  cannot, and each settings section has a Docs button to its page on
  docs.compassdocs.io.
- **A searchable picker replaces the checkbox walls** for webhook spaces,
  link groups, newsletter and announcement audiences: type to find,
  chips to remove, Enter never submits the form by accident. A link
  restricted to groups can no longer widen to everyone by removing the
  last chip — Save waits for a group or "Everyone".
- **The Trash is paged and searchable.** Fifty at a time with "Showing
  1–50 of 4,333", a filter by title or space, and no document bodies
  loaded to draw a list. Users and Spaces share the same filter box with
  a live "3 of 89" count; the audit log's pager sits above and below the
  table.
- **One place for the primary create action**: top-right of the intro
  row, opening the inline form above the list. "Add user" moves there
  (Auto-link beside it), Groups gets "New group", Spaces already had it.

### Changed
- The audit log never prints a raw key: 163 actions have labels
  ("Updated person", "Assigned training") and anything unknown reads
  "Directory · Person updated". "Users & roles" is "Users"; "docs" is
  "documents"; controls that narrow a list say "Filter …", lookups that
  fetch say "Search …". The guide has a Vocabulary section.

## [1.8.1] - 2026-10-02

The admin console, part two: sections with several jobs get pages.

### Changed
- **Roles & permissions** is four routed pages — Roles, Assignments,
  Explain access, Health — so a deep link lands on the right one and the
  old Section access address goes straight to Assignments instead of
  the wrong tab.
- **Workspace** is two pages, Branding (name, logo, accent, date & time)
  and Content (trash retention, attachments, document organisation,
  comments, Outlook add-in, session timeout, approval workflow), each
  with its own Save that sends only its own settings — a save on one
  page can no longer reset the other's fields.
- **Notifications** is four pages — Webhooks, Email, Email templates,
  Ask in chat — instead of one page stacking a link card, an
  89-checkbox webhook form, SMTP and chat.
- Settings search knows every new page and card; nothing was added to
  the rail.

## [1.8.0] - 2026-10-02

The admin console, part one: one sub-navigation, and a settings search
that finds the card you mean.

### Added
- **Settings search finds pages and cards, not just sections.** Typing
  "timezone", "trash", "saml" or "restore" in the rail's search box now
  shows "Workspace › Date & time", "Workspace › Trash retention",
  "Single sign-on › SAML 2.0", "Backups › Backups and restore" — rows
  that link straight to the card. Enter opens the first match, Escape
  clears, the down arrow moves into the results, and screen readers hear
  the match count. People with a delegated role only see rows inside
  sections they can open.
- The Notifications section has two pages, Channels and Email templates,
  under one header and tab row; the templates page no longer hand-writes
  its own title and back link.

### Changed
- The directory's tab row is the shared sub-navigation, and the tabs of
  a section are declared once in the settings registry, so the rail
  search and the tab row cannot disagree.

## [1.7.3] - 2026-10-02

Forms, part four: empty states, notices, tooltips, shortcuts, the visitor
404 and one password rule.

### Added
- **A way to turn single-key shortcuts off** (WCAG 2.1.4). Account →
  Preferences → Keyboard: with the switch off, the bare keys (/ @ > # ?
  c and the g-chords) do nothing, and the shortcut sheet stops listing
  them. Ctrl or ⌘ K always works. Default on, so nothing changes until
  you ask.
- **Relative times carry the exact time.** "3d ago" in space tables and
  version history is a real time element: the workspace-formatted exact
  time shows on hover and on keyboard focus, and the raw database string
  is gone.
- The public site has its own not-found page inside its header, and the
  root 404 is written for a visitor: neutral copy, Sign in, and Browse
  the knowledge base when the public site is on.
- The OAuth consent screen explains a failed connection with a heading,
  a notice and a way back instead of a bare red sentence.

### Changed
- **One password minimum everywhere: 8 characters.** Setup, the forced
  first-login change, Account → Security and admin resets all agree, the
  forms say so under the field, and the API refuses the same way. The
  forced-change page carries the brand mark and a sign-out link.
- Thirty hand-rolled "nothing here" lines are the shared empty-state
  components, with an action where there is somewhere to go; the Status
  page no longer shows an emerald "All services operational" banner over
  zero services; the licence gates (Compliance, SCIM, SSO) are one notice
  with a route to the License page for people who can open it.
- Prerequisite states ("Email options need SMTP…", a built-in role is
  read-only) look like notices with an action, never like validation
  errors, and the bare amber hints use the AA colour pair in both themes.
- Native title attributes on controls are the house tooltip (they never
  showed on keyboard focus); accent swatches are named and announce
  their pressed state; a guard test scans whole files for the rule.

## [1.7.2] - 2026-10-02

Forms, part three: real modals, undo instead of "are you sure", and row
actions that cannot misfire.

### Added
- **Undo instead of a question.** Moving a document to the Trash and
  discarding a draft branch no longer ask "are you sure" — they do it and
  say so, with an Undo button on the toast that restores through the
  Trash. Toasts can carry one action and stay a little longer when they
  do.
- **Row actions that cannot double-fire and never fail silently.** Delete,
  archive, unlink, restore, purge, reset, vote and the role select ignore
  a second click while the first is in flight, stay busy until the
  refreshed page has arrived, and report the server's own reason (or a
  specific sentence) when something fails — twelve of them used to fail
  without a word. Restoring from the Trash says "Restored".
- **The editor's small questions are dialogs.** Insert video, embed a
  page, insert or edit a button and describe an image open themed dialogs
  that validate (a video URL must be one the player can show; an embed
  height has bounds). The Link button opens a small anchored panel under
  it: type or paste the address, Enter applies, Remove clears it.
- Menus (Write with AI, directory Columns and Export) take keyboard focus
  when they open and walk their items with the arrow keys.

### Changed
- The lightbox, the video theater, the insert-video dialog and the
  analytics drill-down are the one Modal: Escape through the shared
  overlay stack (a lightbox over a training deck closes only itself),
  the page behind is inert, focus returns to what opened them, each has
  a name, and the drill-down finally closes on Escape. The theater scrim
  no longer turns into a near-white wash in dark mode.
- The irreversible confirmations share one dialect ("This cannot be
  undone.").

## [1.7.1] - 2026-10-02

Forms, part two: a Save row that knows what you did, and dialogs that
belong to the product.

### Added
- **Save knows whether there is anything to save.** Every settings page
  with a Save button (Workspace, AI, Domain, Backups, Single sign-on,
  SAML, Microsoft sync, directory offices, schedule and export presets)
  shares one row: disabled while nothing changed, "Unsaved changes" with
  a Ctrl/⌘+S hint while something has, "Saved" for a moment after, and
  pinned to the bottom of the screen only while there is work to save.
  Leaving the page with unsaved changes asks first — the guard the editor
  already had, now shared with it. The editor shows the same state text.
- **Dialogs that match the product.** Confirmations and small prompts no
  longer use the browser's own boxes, which ignore the theme, sit outside
  the overlay order and are suppressed in some kiosk profiles. The new
  dialogs are themed, focus-trapped, close on Escape through the shared
  overlay stack, hand focus back, and say what the button does ("Delete
  user", not "OK"). Destructive ones start on Cancel. Temporary passwords
  are typed into a masked field with a length check; renames and template
  names validate before they are sent; "extend due dates" takes a bounded
  number.
- **Type to confirm** for the actions that cannot be undone: restoring a
  database backup (RESTORE), making a space public (PUBLIC), and deleting
  a space that still holds documents (its name). The two chained restore
  confirmations are one dialog.
- Changing someone's role from the users table asks first, and warns when
  you are about to remove your own admin access.

### Changed
- 59 native confirmations across 42 files are the themed dialog. The
  editor's leave prompt stays the browser's own on purpose: it must work
  while any other dialog is open.

## [1.7.0] - 2026-10-02

Forms, part one: fields that assistive tech understands, one input recipe,
and controls that are as wide as what goes in them.

### Added
- **Fields speak for themselves.** Every labelled field links its help or
  error text to its control (aria-describedby, aria-invalid), and an error
  is announced the moment it appears — there was not a single one of either
  in the product before. A form-level failure (a wrong password, a server
  that said no) is an alert, not a silent red box.
- **Bounded numbers validate inline.** Trash retention, attachment and
  video sizes and the session timeout show "Must be between 0 and 3650"
  under the field instead of letting the server clamp the value while the
  toast says "saved"; Save refuses with a reason while a field is wrong.
  The add-user form checks the username, email and password rules the API
  enforces before it sends anything, and focuses the first problem.
- **A width scale for single-line controls** (xs / sm / md / lg / full):
  a number is 160px, a name or password 448px, a URL or key 576px, so a
  display-name field no longer runs 2,000px across a 2560 screen with a
  switch 1,950px from its label. Toggle rows are bounded by default.

### Changed
- Login, setup, change-password, add-user, API tokens, licence, profile,
  preferences and the Outlook add-in forms are built on the shared field
  controls — same label size, same focus, same disabled look — with every
  autocomplete, input mode and length attribute kept. Setup focuses its
  first field. The Outlook sign-in form has real labels, its header uses
  the workspace accent instead of a hard-coded blue, and a server error
  during search says so instead of "No results".
- The 55 hand-rolled input class strings across the product (editor
  settings, training, newsletters, audit filters, search boxes, pickers)
  now come from one recipe, with a compact variant for table rows and
  toolbars. A hand-written input fails the build.

## [1.6.3] - 2026-10-01

The component system, part four: working states, feedback, hit areas.

### Added
- **You can see that something is happening.** Sidebar and settings rows
  show a small spinner while the next page loads (after a short delay, so
  fast clicks never flash it); the dashboard, a space, the directory and
  analytics show the shape of the page while their data loads; tables
  that are refreshing dim and say so to screen readers; one spinner and
  one loading row replace the five loader styles; the audit log says
  when a filter fails.
- **Toasts that screen readers hear.** Success and error regions are
  always present, so the first toast is an announcement rather than a
  box that appears with its text already inside; errors use the alert
  role and stay longer; timers pause while the pointer is over a toast;
  each carries an icon and a dismiss target you can hit. The inline
  "Saved" flash on the profile is a toast like everything else.
- **One copy button.** Copy → Copied with a check and an announcement,
  at every place a value is copied (share links, tokens, the Claude
  connector URL and config, SCIM endpoints, role ids, attachments, code
  blocks, the update command).

### Changed
- **Targets you can hit.** Every icon-only control sits in a box at least
  28px square (sidebar "manage spaces", the page-tree chevrons, directory
  card actions, toast dismiss); the Toggle grows to 44×24 with a visible
  off state. "Remove key" on the AI page moves into a danger zone.

## [1.6.2] - 2026-10-01

The component system, part three: tables, icons, floating panels.

### Changed
- **Tables that behave.** Sortable headers are real buttons with
  `aria-sort` and an icon instead of a typed arrow; the audit log's header
  stays on screen while its thousands of rows scroll; rows light up on
  hover so a title and its actions 1,600px apart on a wide monitor read
  as one row; dates, counts and action columns shrink to their content
  so the primary column takes the slack. Users, Trash, the audit log,
  role assignments, the space table, the directory list and People admin
  use it; People admin's row actions are icon buttons with a separator
  before Delete.
- **Icons instead of typed glyphs.** The "＋", "✓", "✨" and "📋"
  characters that sat off the baseline and ignored the accent are lucide
  icons at the house sizes; "Submitted for review" is built on the shared
  empty state; buttons that open an editor say "New …", buttons that
  append a row say "Add …"; a scan test keeps glyphs out.
- **One floating panel.** Menus, pickers and popovers (the bell, the
  directory's Columns and Export menus, the editor's Write menu, the
  profile QR card) share one `Popover`: one radius and padding, the
  floating elevation tier, outside-click, Escape through the overlay stack
  and focus back to the trigger. Three elevation tiers (card, float,
  modal) are tokens.

## [1.6.1] - 2026-10-01

The component system, part two: cards, headings, chips, table headers.

### Changed
- **One card and one heading ladder.** Cards share one wrapper (`Card`),
  and the headings inside a page step down one size per level: section
  heading, card title, sub-heading, eyebrow. The eight card-title styles
  and seven uppercase label combinations are gone; the oversized
  text-lg card titles drop one step, so "Users & roles" finally reads
  larger than "Users (2)", and the uppercase labels that were as large as
  body text drop to the eyebrow tier.
- **One chip.** Status, type and tier badges come from one `Chip` with a
  closed set of tones, each carrying its dark-mode pair (dark space pages
  are no longer walls of pale mint and lilac) and a print override so a
  dark-mode chip prints light. Status text is label-cased ("Active",
  "Published"), emerald is the single success hue, audit categories
  render neutral, and one Enterprise badge replaces the hand-written
  copies.
- **One table header.** Every table's header row is the same AA grey,
  semibold eyebrow, and digits line up in every column (tabular numerals
  on every table). Sorting, sticky headers and row hover follow in 1.6.2.

## [1.6.0] - 2026-10-01

The component system, part one: one button, one page title.

### Changed
- **One button.** Every text button now comes from one recipe
  (`Button` / `buttonClass`): primary, secondary, ghost and danger
  variants; three sizes with fixed heights so adjacent controls line up
  (row actions in tables are the small size, forms and headers the
  default, sign-in and hero actions the large one); a busy state that
  keeps the label. The 41 slightly different primary recipes measured in
  the review — different heights, weights, radii and disabled opacities,
  eight of them too light to read — are gone, and a guard test fails the
  build on a new one.
- **One page title.** Every top-level page renders its title through
  `PageHeader` (icon, title, subtitle, back link, actions), so the heading
  ladder is real: page title, document title, section heading, card
  title, eyebrow. The three training sub-pages that used a smaller title
  and the pages that lacked an icon (New document, Version history, Read
  confirmations) now match the rest. A guard test fails the build on a
  hand-written page title.

## [1.5.2] - 2026-10-01

Account inside the shell, one segmented control, back links, the inbox.

### Added
- **A Notifications page.** The bell's panel now ends with "See all
  notifications" and "Preferences"; the page lists everything newest first,
  loads older pages on demand and marks all read. The notifications API
  pages opt-in (`?before=<id>&limit=`) and keeps its shape otherwise.
- **One segmented control** (`Segmented`) for theme, page width, interface
  scale and the document width switch: arrows move the choice like a
  native radio, Tab lands on the current one, and the three styles it
  replaces are gone. Picking a page width on Preferences re-flows the page
  at once.

### Changed
- **Account settings live inside the app.** Profile, preferences,
  notifications, security and API tokens keep the sidebar, palette, toasts
  and width preference instead of dropping into a separate gradient shell
  with a "Back to CompassDocs" link to the dashboard. The frame matches the
  settings console (an eyebrow, a rail, the section as the page title);
  URLs are unchanged, and the forced password change stays standalone.
- **One back link and one breadcrumb.** Sub-pages (a person's team, a
  document's history and read confirmations, training transcripts,
  certificates and archived decks, a newsletter, email templates) share one
  back link — an arrow and the destination's name, never "Back to X" — and
  the document and public document pages share one breadcrumb trail.
- **The dashboard's search box is the Ask entry.** It no longer shows a
  Ctrl K keycap that opens something else, grows with the page instead of
  truncating at 1920 and above, and the sidebar trigger uses the palette's
  own placeholder. "Ask Acme" is spelled from one source everywhere.

## [1.5.1] - 2026-10-01

Rails and the settings console frame.

### Changed
- **One navigation-row recipe for every rail.** The sidebar, the settings
  rail and the account rail used three slightly different rows (radius,
  icon tint, label style, hover); they now share one (`RailLink`), with the
  same current-page marker for assistive tech. Shell widths are tokens, so
  the sidebar and the rails grow together with the interface scale.
- **The settings console shows the section as the page.** "Settings —
  Manage your workspace" is a small eyebrow instead of a second page title,
  and the section ("Users & roles") is the page's heading at the normal
  page-title size, so the first control sits near the top and every admin
  page has exactly one top-level heading. The rail is tighter, sticks while
  a long page (Workspace, Notifications, Backups) scrolls, and scrolls inside
  its own box so all twenty entries fit a 900px-tall laptop.

## [1.5.0] - 2026-10-01

Shell and wayfinding.

### Added
- **Every page has its own browser title**, page first and workspace last
  ("Users & roles — Acme", "History · Production Deployment SOP — Acme"),
  so tabs, history and password managers stop reading the same product
  name everywhere. Sign-in, setup, the forced password change and the OAuth
  consent page are not indexed, and a robots file keeps crawlers out of
  everything except the public site when indexing is on.
- **The sidebar always lights the page you are on.** Trash, Newsletter,
  Analytics, Announcements and Compliance used to live behind a closed
  "More" fold with no active row; a folded destination is now shown
  whenever it is the current page, and **Settings is pinned** for admins so
  every settings page lights its row. Long workspace and page names
  truncate with a tooltip instead of colliding with the bell; the account
  footer is one link (avatar, name, role) instead of three to the same page.
- **Tooltips that never clip.** The bell, the collapse toggle and every
  editor toolbar button show their tooltip below the control instead of
  off the top of the screen; the collapsed rail's tooltips sit to the right
  of the icon and escape the rail's scroll area; the brand's tooltip grows
  rightwards so a long workspace name stays on screen; the toolbar no
  longer shows two bubbles per button, and long labels wrap.
- **Screen-reader wayfinding.** Every navigation and sidebar landmark is
  named, breadcrumb separators are silent, the skip link really lands on
  the content, badge counts say what they count ("3 pending reviews"),
  unread notifications say so, the bell declares its popup, and Escape in
  the notifications panel defers to an open palette and returns focus to
  the bell.

## [1.4.4] - 2026-10-01

### Added
- **A visible keyboard focus ring everywhere.** One rule gives every link,
  button, switch, tab, menu item and form control a 2px accent outline on
  keyboard focus (lighter in dark mode); the pale ring inputs used to draw
  measured 1.3:1 and 83 controls hid the outline altogether. The command
  palette input and the editor body, whose panels are the frame, are the
  two documented exceptions.
- **Accent colours that always pass AA.** Buttons, links and focus rings
  derive from a shade that keeps white text at 4.5:1; a light accent is
  darkened for those while tinted surfaces keep the chosen hue. The Teal,
  Emerald and Amber presets move to their AA shades, the picker shows the
  live ratio and what a too-light colour becomes, and the swatches are named
  for screen readers. Dark-mode accent ink is one token
  (`--compass-ink`) instead of two hand-synced copies.
- **Reduced motion.** The OS "reduce motion" setting now collapses every
  transition and animation (spinners excepted), not only the palette scrim.

### Fixed
- Red text in dark mode lifts to a readable red (about 6:1 instead of
  3.6:1); delete controls hover to a tint instead of a pale pink slab in
  dark mode (`hover-danger`); "Unsaved changes" and other free-standing
  amber or green text use shades that pass AA in both themes (`ink-warn`,
  `ink-ok`); links inside sentences are underlined (`link`), starting with
  every empty-state link.

## [1.4.3] - 2026-10-01

Contrast and dark-mode fixes that touch nearly every page.

### Fixed
- **Readable secondary text.** Help lines, descriptions, timestamps,
  captions, rail labels, palette and notification copy and "nothing here"
  lines used a grey that measured about 2.5:1 on the light surface, below
  the WCAG AA floor. Every run of words now uses the next step up (389
  sites); the lighter grey is kept for icons, dividers and placeholders.
- **Dark mode on the roles page.** The "Built-in roles are re-derived…"
  note and the permission-group rows rendered as light slabs with grey ink
  in dark mode. Five double-flipped overrides deleted; eleven classes that
  never generated anything removed with them.
- **Shared links, the public site, the upload page, sign-in and the Outlook
  pane** no longer half-flip in dark mode: a client with a dark OS who opens
  a share link used to get a dark canvas with white cards whose text had
  inverted to near-white. Those surfaces now use the themed surface and
  canvas tokens, byte-identical in light mode.
- `test/style-drift.test.ts` fails the build on a dark-mode slate override,
  a compass-950 class, slate-400 text or a bg-white on a themed surface.

## [1.4.2] - 2026-10-01

### Added
- **Interface scale** under Account › Preferences: Compact (90%), Default,
  Large (110%) or Larger (120%). A multiplier on the fluid root, so the
  sidebar, rails, icons, chips, tooltips and reading measures all follow the
  same factor — which browser zoom alone cannot do without breaking
  overlays. Saved to the account and applied before first paint, so a
  Large page never flashes at the default size. Print output is unchanged.

## [1.4.1] - 2026-10-01

The interface scales with the monitor.

### Added
- **Fluid interface scale.** One rule grows everything together — type,
  icons, the sidebar, rails, tooltips, toasts, the Normal/Wide columns —
  from 16px on a laptop (up to 1280 wide) to 18px on a large monitor (from
  2400 wide; about 17px at 1920). Browser zoom and the OS text-size setting
  keep working, breakpoints do not move, and print output is unchanged.
- **Card grids follow the column, not the monitor.** Directory cards and
  tiles, the org chart and team pages, Links, the dashboard and the space
  Cards view pick their column count from the width you chose (and whether
  the sidebar is open) instead of the viewport, so a 2560 monitor at Wide no
  longer packs five 200px cards into a 1,088px column, and Full gets six or
  seven readable ones.
- **Full is a wide, centred page** (112rem, about 2,016px on a large
  monitor) instead of edge-to-edge on an ultrawide. Nothing changes below
  about 2,100px of window width.
- **Normal on the document page** stacks the right rail under the article
  and gives the text a 65-character measure; it used to share the column
  with the rail and run 45 characters wide. The table of contents hugs the
  reading measure instead of spanning the whole column.
- The public site and the share page use a column that grows with the
  screen (56rem on a laptop, up to 76rem on an ultrawide).
- `e2e/scale.spec.ts` asserts the root sizes, the print reset, the bounded
  Full width and that nothing scrolls sideways at 2560 and 3440.

## [1.4.0] - 2026-10-01

First of the interface-scaling releases. Nothing looks different yet: this
release moves every pixel-pinned size onto the rem scale so that 1.4.1 can
grow the whole interface with the monitor from one rule.

### Changed
- Two new text steps, `text-2xs` (11px) and `text-3xs` (10px), replace the
  arbitrary `text-[11px]` / `text-[10px]` on chips, keycaps, captions and
  tags across the app; the document body is `1rem` instead of `16px`, code
  `0.8125rem` instead of `13px`; tooltips and palette keycaps are sized in
  rem; the editor height, the users-table minimum width, the version-compare
  pane and the toggle knob are on the spacing scale. Pixel-identical at the
  default root size.
- STYLEGUIDE gains a *Scaling* section (rem only, the px allow-list) and
  `test/style-scale.test.ts` fails the build on a new px literal.

### Security
- Dependency updates for advisories published this week: nodemailer
  10.0.13 (address-parser denial of service, GHSA-prgh-xp8r-p3m5 and
  GHSA-v53p-9fqp-m79j) and undici 8.11.2 (CVE-2026-19534, CVE-2026-84961
  and eight related fixes).

## [1.3.5] - 2026-09-27

### Added
- **Teams presence** (Enterprise). *Show Teams presence* on the Microsoft
  365 sync settings puts a live dot on every synced person's avatar —
  cards, list rows, grouped tiles — and a badge beside the name on their
  profile: Available, Busy, In a meeting, Presenting, Do not disturb,
  Away, Offline, with the detail on hover. Read from Microsoft 365 while
  the page is open (one batched request a minute for the whole page,
  cached briefly on the server), never stored. Needs the
  `Presence.Read.All` application permission; the one-click setup now
  grants it, a hand-made registration adds it under API permissions.
  Off by default.

## [1.3.4] - 2026-09-27

What each person may see, and directories that deliver themselves.

### Added
- **Who sees a field.** Every field — and each of the contact columns
  email, phone and mobile — can be for *everyone signed in* or *admins
  only*. An admin-only value is stripped on the server before it reaches
  the directory, a profile, the people API, an export, a contact card or
  the Columns menu, so a mobile number the whole firm should not have
  never leaves the building. Set per field in its row under Fields, and
  for the contact columns in the new *Contact details* block there.
- **One file per office.** A preset can make a zip with one PDF (or CSV)
  per value of any group-by field — every office its own sheet, each
  titled with the office — from the Export menu (marked *ZIP*) or ad hoc
  with `split=office` on the export route.
- **Who's who.** A preset's layout can be *photo cards*: a grid of two to
  five cards a row, each with the person's 240px photo (or initials),
  name, title and the other columns underneath, in the preset's sections
  and order, with the office blocks still closing the document.
- **Presets that email themselves.** Each preset can go out weekly (on a
  weekday) or monthly (on a day of the month) at a UTC hour, as PDF or
  CSV, to the recipients you list — the same file the button makes, as an
  attachment. A schedule starts from the moment it is saved, so the first
  send is the next slot, not the one that just passed; one instance runs
  it, and the Export page shows when each preset last went out.

### Changed
- The per-user export limit is 30 a minute (was 12): an admin trying
  presets, a zip per office and a who's who in one sitting fits.

## [1.3.3] - 2026-09-27

Who reports to whom.

### Added
- **Reports to.** A built-in people field, one manager per person, with
  *Direct reports* as its other end. On Enterprise it fills itself from
  the identity system — Microsoft's manager relationship
  (`manager.mail`) and Google's manager relation — unless you clear the
  mapping under Fields. Set it by hand on the People page, or import a
  *Reports to* column from a CSV. Both ends show on cards, profiles, the
  list and every export.
- **Org chart.** A fourth view of the directory: the heads of the
  company at the top, each person's reports beneath, three levels open
  and the rest a click away, with a badge for the size of each team.
  Search keeps the matches and the line above each; people not yet in a
  reporting line sit in their own section. A reporting line that loops is
  broken at one person and said so.
- **Team on the profile.** Every profile shows the chain above the person
  (top of the company first), the people alongside them, and their direct
  reports, with *Open in org chart* and a **team page** — everyone below
  them, level by level, exportable as PDF, CSV or contact cards.
- **Directory health** flags reporting lines that loop.

## [1.3.2] - 2026-09-27

### Security
- **Dependency updates.** Next.js 16.2 → 16.3.6 (fixes an unauthenticated
  remote code execution in the image optimisation API, GHSA-2xp9-vwfh-vxw4,
  and CVE-2026-75604), nodemailer 9.0 → 9.1.1 (address-parser denial of
  service and recipient-domain bypasses), sharp 0.35.3 → 0.35.5 (libheif),
  and the js-yaml, nanoid, @xmldom/xmldom, mermaid and DOMPurify advisories
  in the tree. No code changes. The remaining advisory in the tree is a
  moderate one in Tiptap 2 whose fix is the Tiptap 3 major, which will ship
  with an editor upgrade rather than a patch.

## [1.3.1] - 2026-09-27

The directory as something an admin runs, not just fills.

### Added
- **Directory health.** The People page opens with what the data says
  needs a hand: people with no office, title, phone or email; values an
  option list does not know; two people with the same name; people
  references the last sync could not match; a sync that has not run in a
  while; hidden entries; people without a photo. Each finding counts,
  names a few examples, and links to the page that fixes it.
- **Import from CSV.** Paste or upload the export's format, or any
  spreadsheet with a name or email column. CompassDocs reads the columns
  and suggests a target for each, shows what every row would do — add,
  update, unchanged, or a problem it names — and writes nothing until
  you say so. Rows match people by email, then by exact name; a synced
  person takes the manual layer only, and new rows are manual entries.
- **Preview a sync** (Enterprise). *Preview* beside *Sync now* fetches
  from the tenant or the Workspace account and shows who would be added,
  changed (and which fields), removed or adopted — without writing
  anything. A real sync now reports the same breakdown when it finishes.
- **Scheduled syncs with a report** (Enterprise). Each provider can sync
  every hour or every day at an hour you pick; one instance runs it. After
  each scheduled run an email goes to the recipients you set with what
  changed, what could not be matched, and whether the removal brake held
  anything back. Quiet runs are silent unless you ask otherwise.

## [1.3.0] - 2026-09-27

Reaching a person, not just finding them.

### Added
- **Save contact.** Every profile has a contact card (.vcf) — name, title,
  company and department, work and mobile numbers as typed, email, the
  office's address, main line and fax from its profile, a link to the
  profile, the assistant and card fields as notes, and the photo — and a
  **QR code** a phone camera scans to add the person with no app and no
  account. The Export menu adds **Contacts (VCF)** for everyone on screen,
  and a preset can be exported as one; each office's address rides on its
  people.
- **Teams and Outlook.** People synced from Microsoft 365 get *Chat in
  Teams* and *Schedule a meeting* on their profile and card.
- **Bigger photos.** The sync now stores a 240px copy beside the 48px
  thumbnail; the profile page shows it, the contact card carries it, lists
  stay light. Admins can **upload a photo** for anyone on the People page
  (cropped square, both sizes made on the server); a provider's photo
  replaces it on the next sync.
- **Date fields.** A field can be a *Date* (ISO, "5/1/2020", "May 1, 2020"
  and Graph's `employeeHireDate` all read; shown as "May 1, 2020"; sorts
  chronologically). A date field can mean *the start date* — profiles show
  "Since May 2020 · 6 years", the directory opens with **Started this
  month** and **Anniversaries** — or *a birthday*, for **Birthdays this
  month**. All three strips appear only when there is someone to show.
- **What the records hold.** The mapping editor lists every property the
  stored records actually contain, with how many people carry a value and a
  sample; click one to map it. Suggestions add `employeeHireDate`.
- "No office / No department" sections on the Groups view link admins
  straight to the people missing the value.

## [1.2.8] - 2026-09-25

### Changed
- **Office blocks stand side by side** at the end of the PDF — one to four
  to a row, chosen per preset (two by default); a lone full-width block
  lays its fields two abreast, narrower ones stack them. A row of blocks
  moves whole to the next page when it does not fit. The **Export** menu on
  the Directory page has an *Office information* switch for "what I see"
  exports; each preset keeps its own.

## [1.2.7] - 2026-09-25

### Added
- **Three-column PDF layout**, beside the two-column one — for a name-and-
  extension list on landscape paper, or any table narrow enough to stand
  three abreast.

## [1.2.6] - 2026-09-25

### Fixed
- **Assistants named by display name now link.** A people-field value only
  resolved when it was an email or an Entra object id; a tenant whose
  custom attribute holds "Dana Ruiz", "Ruiz, Dana", a sign-in name, a mail
  nickname or SAM account name, a distinguished name
  (`CN=Dana Ruiz,OU=…`) or "Dana Ruiz <dana@firm.com>" saw the mapping
  preview fill and the sync report nearly every one unresolved, with no
  links on the directory or the PDF. All of those forms resolve now,
  against the synced records and against people typed in by hand; a name
  two people share resolves to nobody and the sync report says so
  ("(2 people share this name)") rather than guessing.

## [1.2.5] - 2026-09-25

### Added
- **Two-column PDF layout.** A preset can lay the table out in two columns
  side by side, so a short table — name and extension — fills the sheet
  instead of running down the left of an empty page. Rows are dealt into
  columns of a known height for the paper, orientation and density; a
  section header never sits alone at the foot of a column; values are cut
  to one line. The office blocks still close the last page.
- **Alternate rows shaded** on the PDF (on by default for every preset, with
  a switch), so the eye keeps its line across a wide page.
- **"Then by" sort.** A second sort key breaks ties in the first — Office,
  then Title — each with its own direction; the name always breaks the
  final tie. The sort menus group keys as Built-in / Fields / Links, so a
  synced custom field is as easy to pick as Name; a field with options
  sorts in the admin's order.

## [1.2.4] - 2026-09-25

### Added
- **Office profiles.** `Settings → Directory → Offices` describes each
  office beyond the people in it — address, main phone, fax, hours, parking,
  shared spaces by default, and any field an admin adds (multi-line or not,
  in the order they print). Offices come from the Office field's options
  and from the values people carry; one nobody is in yet can be added by
  hand. A **PDF export closes with a block for every office that appears in
  it** — the Phoenix sheet carries the Phoenix details, a firm-wide list
  carries every office — placed after the last row; a block that does not
  fit on the last page moves whole to the next. Each preset has an *Office
  information* switch (on by default), and "what I see" exports honour it.

### Changed
- **Directory settings are pages now**: People, Fields, Offices, Export and
  Sync each have a route under Settings → Directory with a tab row under the
  section header, instead of one long page with a save button in every card.
  Each page keeps one primary action; the Offices page saves fields and
  values together. Bookmarks to `/admin/directory` still open People. The
  settings rail stays lit for every page of the section.
- The Style Guide now says when a settings section should split into pages
  and where a card's primary action sits.

## [1.2.3] - 2026-09-25

### Added
- **Manager from Entra ID.** A mapping that reads `manager.*` (`manager.mail`,
  `manager.userPrincipalName`, `manager.displayName`) now works: the
  enterprise sync expands the manager relationship, which Graph never returns
  from a plain property list. A people field mapped to `manager.mail` gives a
  "Reports to" link, or the other way round with the direction set to "the
  people this person is … to".
- **Typed picks in a path.** `relations[assistant].value`,
  `phones[work].value` — a bracketed word other than `primary` keeps the
  array elements whose `type` matches, which is how Google Workspace stores
  relations, phones, emails and addresses.

### Changed
- The mapping editor for a people field says up front that Entra ID has no
  assistant attribute and lists where a tenant keeps one (Exchange custom
  attributes 1–15, a directory extension, the manager relationship); the
  suggestions for a people field are those, not the text-field properties.

## [1.2.2] - 2026-09-25

### Fixed
- **"Not mapped" did not stick.** Saving a directory field's mapping as
  *Not mapped (manual only)* cleared the new mapping but left the legacy
  path column behind, and the field read that column back — so the property
  returned on the next load. For fields mapped before 1.2 the editor also
  opened on *Not mapped* while the row showed the mapping. The legacy column
  now follows the mapping on every save, and a legacy-only mapping is read as
  the one mapping it is.

## [1.2.1] - 2026-09-25

### Fixed
- **Upgrading to 1.2.0 failed at boot on any workspace with provider-mapped
  custom fields** (`column "k" does not exist`). The migration that moves a
  sync's values out of the manual layer read `jsonb_each` with the wrong
  column names; it only ran when a field had a Graph or Google mapping, which
  the release verification database did not have. The statement is fixed, the
  migration resumes from where it stopped (the steps before it were recorded
  as done and are not repeated), and nothing written by 1.2.0 needs undoing.
  Workspaces without mapped fields were never affected.

## [1.2.0] - 2026-09-25

The directory becomes something you configure rather than something you
work around: every field is a row in a registry, every value can be mapped
in from your identity system, and every view — including the PDF — reads the
same configuration.

### Added
- **The directory registry.** `Settings → Directory → Directory fields` now
  lists every attribute the directory shows, built-in columns included. A
  field has a **kind** (text, choice, or people), optional **options** — an
  ordered list of values with labels and aliases — and a **mapping** per
  connected provider. Options are what give the directory an order: the
  Groups view sections and the sort inside them follow the option order, so
  "Attorneys, then Admin, IT, Accounting, Records" is a list an admin drags
  into shape, not the alphabet. Labels turn a code into a name (`PHX1` shows
  as "PHX1 – Phoenix"); aliases fold raw values into one option
  (`*Attorney*`, `Partner`, `Of Counsel` → Attorney) without anyone editing
  Entra. A **"Values seen in data"** harvester lists what the field actually
  holds, with counts, and flags what matches no option.

- **A mapping engine, with preview.** A mapping is no longer one property
  name. It can read a property (dotted paths, array indexes, Google's
  `[primary]` entries), **compose** several (`{officeLocation} – {city}`),
  **extract** with a pattern (`x(\d{2,5})$` over the phone numbers),
  fall through a list of **fallbacks**, derive **initials** or the local part
  of an email, or read **group membership** — each provider group a person is
  in contributes a value. Every mapping can be **previewed against the stored
  records** before it is saved ("fills 84 of 96 — 3 would be empty", with
  samples), and saving re-applies it to everyone immediately, with no resync.
  The sync now keeps each person's raw provider record for exactly this.

- **Two layers per person.** What a sync produced (`synced`) and what an admin
  typed (`custom`) are stored separately; the admin's value wins per key, and
  clearing it — "use synced value" — reveals the provider's again. Admins can
  now open the editor for synced people: name, title and contact details stay
  read-only (they belong to the provider), everything else is theirs and
  survives every sync. This also fixes a bug where a value cleared in Entra
  never cleared here.

- **Assistants, properly.** The single assistant link is now a many-to-many
  relation — one legal assistant supporting five attorneys is five links, an
  attorney with a primary and a backup is two — shown from **both ends**:
  "Assistant: Dana Ruiz" on the attorney, "Assists: Ortiz, Chen, Diaz" on
  Dana. Both appear on cards, in the list (two columns), on profiles, in
  exports and in search. Any field of kind *people* works this way, so a
  "Supervising attorney" or "Backup assistant" field costs nothing extra.
  From Entra, a people field maps to an attribute holding emails, sign-in
  names or object ids (Graph has no assistant property), on either end — an
  admin says whether the value on a person names *their* assistants or the
  people *they* assist. Unresolved references are reported on the sync panel
  and retried each run.

- **Group by anything.** The Departments tab is now **Groups**: sections by
  any field an admin marks *group by* — department, title, office, a
  practice-group field — in option order, with an "attorneys first" order
  inside each section when Title has options, and each attorney's assistants
  named on their tile. Cards can be sectioned the same way. A filter menu
  offers the grouped field's values.

- **Pins.** Admins pin people to the top of every view (reception, IT, the
  records desk), in an order they set; each person can also star their own.

- **PDF and CSV export.** The Print button is now **Export**: server-rendered
  PDFs from admin-defined **presets** — paper size (Letter, A4, Legal),
  orientation, density, workspace logo, title and subtitle, columns and
  order, sections by any group-by field, sort, a filter (one office's sheet),
  photo thumbnails, a key-contacts section, a footer with the printed date,
  "Page X of Y" and a confidentiality line, and a file name — plus **"What I
  see"**, which exports exactly the people, columns and grouping on screen,
  as PDF or CSV. The old print-columns setting migrates into the default
  preset. Browser print remains as a fallback.

- **Admin defaults for the on-screen list**: the default columns (Title is no
  longer in the shipped default — it took the room contact details need) and
  the field the Groups view opens on. The column menu shows how many people
  have a value for each column, so a column that would be blank all the way
  down says so first.

- **A new hire typed in by hand is adopted by the sync** that later matches
  their email — the same row, now owned by the provider — so links, pins and
  manual values survive the first sync, and a community workspace that
  licenses the sync does not end up with everyone twice.

### Changed
- **Chips are neutral by default and show the option's label**, never a raw
  code. Fields that were tag-style before keep the accent colour; new ones opt
  in, and an option can carry its own colour. A "Notary" field holding an
  office code no longer renders as a red box saying `PHX1`.
- Choosing a view no longer inherits the sort last clicked in the list — the
  grouped views used to silently reorder by whatever column was last sorted.
- Built-in field keys are reserved; an existing custom field keyed like one
  is renamed (`department` → `department_custom`) at boot, with its values.

### For the enterprise overlay
- The sync may now hand core each person's raw provider record (`record`)
  and let core apply the mappings; the previous `custom` path still works.
  Core publishes the properties and group ids the current mappings need.

## [1.1.1] - 2026-09-25

### Fixed
- **Fresh installs of 1.1.0 could not start.** The `image_upload_tickets` table
  added in 1.1.0 was declared in the schema before the `users` and `documents`
  tables it references. Every existing database already had both, so upgrades
  were unaffected and the release verification — run against a long-lived
  database — passed; a brand-new database failed at boot with
  `relation "users" does not exist`. The table is now declared after its
  dependencies, and the schema is verified against an empty database.

## [1.1.0] - 2026-08-03

### Added
- **The MCP connector can actually add images now.** `add_image` accepted one
  thing — the whole file base64-encoded inside a tool argument — and that fails
  two independent ways. Base64 inflates by a third, so a 300 KB screenshot is
  ~400,000 characters in one argument, well past the caps clients put on tool
  input (a 10,000-character cap allows 7.3 KB, which is a favicon). And a
  screenshot pasted into a conversation reaches the assistant as *vision* input:
  there are no bytes for it to re-emit, at any size. That second one is the
  commonest request there is, which is why the failures looked arbitrary —
  sometimes a refusal, sometimes plausible-looking base64 that failed the type
  sniff.

  Three more ways in, all server-side, all through the same validator:

  | | when to use it |
  | --- | --- |
  | `source_url` | the image has a public address — the server fetches it, so the bytes never touch the conversation and size stops mattering |
  | `from_attachment_id` | reuse an image already in the workspace (copied, not shared, so deleting the original can't blank the copy) |
  | `request_upload` | the picture only exists as something a person can see — returns a link they drop the file into |
  | `data` | still there, still base64, still only sensible for small files |

- **`insert`.** `add_image` can place the image in the body in the same call
  (`"append"`, `"top"`, or `"none"` to keep the old behaviour of returning just
  the snippet). Uploading and placing used to be two calls, and the second one
  got skipped — or done as a whole-body rewrite that clobbered a concurrent
  edit. `insert` appends or prepends and touches nothing else.

- **Image drop links (`/upload/<token>`).** `request_upload` returns a link the
  assistant hands to a person; they drag, paste, or choose a file and it is
  attached and placed automatically. The page needs no login on purpose — the
  screenshot is often on a different device from the session that asked for it.
  What keeps it narrow: 24 random bytes, one document, one hour, one use (the
  claim is an atomic `UPDATE`), image bytes only, rate-limited per IP, and the
  upload is attributed and audited as the person who minted it.

### Changed
- The connector's tool descriptions and server instructions now steer toward
  `source_url` and `request_upload` rather than base64, and the "no image given"
  error says which of the four to use for a picture that only exists in the
  conversation.

## [1.0.3] - 2026-08-03

### Changed
- **The reading measure now scales with the page-width setting.** Paragraphs and
  bullet lists were capped at one width whatever you picked, so on a wide
  monitor at **Full** the text used about 40% of the column while tables and
  callouts beside it spanned all of it — the width control visibly did nothing
  to the part you were actually reading.

  Choosing a wider page is a request for density, so the measure widens too:

  | Setting | Text | ≈ characters per line |
  | --- | --- | --- |
  | Normal | fills the column | ~71 |
  | Wide | 75ch | ~98 |
  | Full | 90ch | ~117 |

  It stays bounded rather than uncapped on purpose. Letting text fill the column
  outright is ~190 characters per line on a 2000px window — far past the point
  where lines become hard to track, and the problem the measure was added to
  solve in 0.88.

  The share page and the public document page are unchanged at ~78 characters:
  they have no width preference to read, and legibility is the right default for
  an anonymous reader.

## [1.0.2] - 2026-08-03

### Fixed
- **The rest of the document blocks follow the page width.** 1.0.1 freed tables,
  fenced code and diagrams from the reading measure but missed five block types,
  so a page could render visibly ragged — a callout at the measure sitting
  directly above a table spanning the column, an accordion half the width of the
  code block above it.

  Callouts, the accordion, tabs, the decision tree, video and embeds now follow
  the content column like everything else that is a panel or a piece of media.
  Body text is unchanged.

  Containers mattered most: a table inside a tab or an accordion was capped by
  its narrow parent as well as by its own width, so the same table rendered at
  roughly half the size inside a tab as outside one.

## [1.0.1] - 2026-08-03

### Fixed
- **The page width setting now changes the document you're reading.** The
  reading measure introduced in 0.88 capped the whole prose container rather
  than the text inside it, which had two consequences. **Wide and Full rendered
  the document body identically** — both hit the same ceiling, so choosing Full
  moved nothing you were looking at. And anything wide by nature was squeezed
  into that same column: a ten-column table or a long command line scrolled
  sideways inside a narrow strip while the rest of the page sat empty beside it.

  The measure now applies to the text, which is what it was for. Tables, fenced
  code and rendered diagrams use the full column instead, so on a wide screen a
  table that used to hide four columns behind a horizontal scroll simply fits.
  Body text is unchanged at every setting — it was already at the measure and
  stays there.

  Nothing was ever unreachable: the hidden columns scrolled, they just gave no
  sign they were there.

- `tsc --noEmit` was failing on a type error in the 1.0.0 authorization test
  (`spacesWith` returns `"all" | number[]`, and the test called `.sort()` on the
  union). The test passed at runtime and the app build was unaffected, since
  the build doesn't typecheck `test/`.

## [1.0.0] - 2026-08-03

The role ladder is gone. Everything CompassDocs decides about access is now a
permission, held by a role, assigned to a person or a group — optionally on a
single space.

### Changed
- **Seeing drafts and publishing without review are permissions.** These were
  the last two questions still answered by the four-rung ladder, and they were
  asked at about thirty-five places: search, the space list, the nested page
  tree, the command palette's recent documents, relation and backlink pickers,
  the Outlook add-in, the MCP connector, and the document page itself. None of
  them consulted the permission model, so a custom role holding **Read drafts**
  saw no drafts anywhere, and one holding **Publish document** still had its
  work queued for review. Both now do exactly what they say.

  Where the page or endpoint knows which space it is working in, the grant is
  checked against that space — so a role granted on one space reveals drafts
  there and nowhere else.

  **If you use custom roles, this widens what they can do** — to what the role
  already said. Nobody gains access they were not granted. Workspaces using
  only the four built-in roles see no change: the built-in roles hold exactly
  the permissions their rung used to imply.

- **Notifications and rosters follow permissions too.** Six queries decided who
  to notify, who is expected to acknowledge a policy, and who can be reached
  for review by checking `role = 'admin'` directly in SQL. Somebody holding
  "Read every space" through a custom role could open a private space and still
  be left out of its notifications, with no permission check anywhere that
  would have shown it. The weekly digest had the same gap and covered only
  public spaces for them. Review notifications can now also be held per space,
  so a reviewer scoped to one space is finally told about it.

- **The last-admin guard asks the right question.** Demoting, disabling or
  deleting a user was blocked by counting accounts with the `admin` rung. In a
  workspace that has moved to custom roles that is the wrong count: five people
  could hold "Change user roles" and the last legacy admin still could not be
  demoted. The guard now asks whether anyone would be left who can restore
  access — the same check every role edit and revocation has used since 0.94.

- **Per-space editors can be anyone.** The Spaces admin screen only offered
  accounts at editor rung or above as per-space editors. That was right while a
  per-space grant merely unlocked rights the rung already carried; it now
  prevents the thing the grant exists for. Any active account can be granted
  authoring in a single space without being promoted anywhere else.

### Removed
- **The three legacy per-space grant tables** (`space_groups`, `space_editors`,
  `space_editor_groups`). 0.99 copied them into role assignments and stopped
  reading them; 1.0 deletes them. The copy runs once more at boot before the
  drop, so nothing is lost even if a grant was written after the 0.99
  migration recorded itself as done, and the drop refuses to proceed at all if
  the roles the grants move into are missing.

  **This is a one-way door.** A workspace that starts 1.0 and then rolls back
  to 0.98 or earlier loses its per-space grants, because the tables they lived
  in no longer exist. Take a backup before upgrading, as always — and if you
  want to verify the migration first, run `tools/verify-rbac-migration.sql`
  *before* the upgrade, while the original rows are still there to compare
  against.

### Notes
- The `COMPASSDOCS_AUTHZ_LEGACY=1` break-glass remains, and now restores the
  pre-1.0 behaviour at every one of the newly ported sites as well. It is there
  so a workspace can recover from a bad role edit without database surgery or
  an image rollback.
- Roles → Health shows which route and permission pairs the two models disagree
  about. Before 1.0 that was a porting scoreboard; now that nothing else
  consults the ladder, a pair that starts differing without a role edit behind
  it is worth reporting.

## [0.99.1] - 2026-08-03

### Fixed
- **Custom roles now work over the public REST API.** Every `/api/v1` endpoint
  checked the old four-rung role ladder and consulted no permission at all, so
  a custom role that worked perfectly in the app was ignored by the API: a
  viewer granted "Create document" could create one through the web app and got
  `403 Creating documents needs the editor role` through `POST
  /api/v1/documents`. The API now asks the same question the rest of the app
  asks — and asks it per space, so a role granted on one space authorises work
  there and nowhere else.

  Token scopes are unchanged and still apply independently: a read-only token
  stays read-only however privileged its owner becomes.

  **If you use custom roles, this widens what your API tokens can do** — to
  exactly what the role already allowed everywhere else. Nobody gains access
  they weren't already granted; the API stops ignoring the grant. Workspaces
  using only the four built-in roles see no change.

## [0.99.0] - 2026-08-03

### Changed
- **Per-space access is role assignments, all the way down.** Space membership
  and per-space edit rights were the last things still living in their own
  tables (`space_groups`, `space_editors`, `space_editor_groups`) — read
  alongside role assignments since 0.95, but never actually replaced by them.
  They are now assignments of two seeded roles, **Space member** and **Space
  author**, scoped to the space you grant them on. Existing grants migrate
  automatically at first boot; the Spaces admin screen works exactly as before.
  The difference is that a per-space grant now shows up in the roles console,
  the effective-permission explainer, and the audit trail like every other
  grant, instead of being invisible to all three.

  The old tables are left in place, unread, so a workspace can still roll back
  to 0.98. A later release removes them.

### Added
- An integration test suite (`npm run test:integration`) covering the directory
  removal brake against a real PostgreSQL — including the case 0.98.1 fixed,
  where re-running a sync could never clear a tripped brake. It runs in CI
  ahead of the end-to-end suite.

## [0.98.2] - 2026-08-02

### Changed
- The two directory panels now use the shared notice classes rather than
  hand-written colors. No visible change — both already carried their dark
  variants — but the style guide keeps notice color in one place precisely so
  the next person to touch these doesn't have to remember to.

## [0.98.1] - 2026-08-02

### Fixed
- **A directory that legitimately shrank could never finish syncing.** The
  removal brake — which stops a sync from deleting more than half the people it
  owns, so a broken credential can't empty your directory — compares what just
  arrived against what is currently stored. That means it cannot tell a broken
  sync from a deliberately smaller one, and re-running changed nothing: a team
  that narrowed its group filter, or really did lose that many people, tripped
  the same brake on every subsequent sync, forever. The panel now says what was
  held back and offers **Sync and remove the N** to allow it once, after a
  confirmation naming the count. Normal syncs are still braked; nothing turns
  the guard off implicitly.
- **A blocked Microsoft 365 sync said nothing at all.** The Microsoft path
  discarded the brake's report and returned only a count, so a tenant whose
  sync had quietly stopped removing departed staff saw a plain success on every
  screen. It now surfaces the same warning and the same override as Google.

## [0.98.0] - 2026-08-02

### Added
- **Google Workspace directory sync works end to end** (Enterprise). Connect a
  service account, test the connection, and pull people and groups — alongside
  Microsoft 365 if you run both. Each provider owns the people it synced, so
  connecting one never removes the other's. Settings → Directory now has a
  Google panel with a connection test, a sync button, group import, and the
  client ID and scopes to paste into Google's delegation screen.

### Changed
- **Section access has moved into Roles & permissions.** Announcements,
  Compliance, and Training have been backed by real roles since 0.94, so the
  separate page was a second view of the same thing — and a partial one: it
  could never show someone who reached a section through a custom role. The
  delegation shortcut now lives on the Assignments tab, where the full picture
  is. The old link redirects, and the API behind it still works.

## [0.97.0] - 2026-08-02

### Added
- **Google Workspace can now be configured.** Settings → Directory takes a
  service-account key and the administrator to impersonate, and tells you the
  exact scopes to authorise and the client ID to paste into Google's
  domain-wide delegation screen. A malformed key is rejected when you paste it
  rather than failing at the next sync with an error that points elsewhere.
- **Single sign-on has a vendor choice.** Picking Google sets the right sign-in
  authority for you; before this it meant knowing to paste a URL into an
  "Advanced" field. Existing setups are untouched and stay on Microsoft.
- **Directory fields can map from both providers.** Each custom field holds a
  Microsoft attribute path and a Google one, so a workspace connected to both
  populates the same field from either.

### Fixed
- **Users & roles showed only part of the picture.** Someone holding a custom
  role — running the launchpad, or the audit log — appeared as a plain
  "Viewer", so the obvious page for auditing access gave an incomplete answer.
  Every role a person holds is now listed beside their role, with the number of
  spaces where a grant is scoped to one.

## [0.96.0] - 2026-08-02

### Added
- **Groundwork for Google Workspace alongside Microsoft.** CompassDocs can now
  hold two corporate directories at once without them fighting: each owns its
  own people and groups, has its own attribute mapping, and can be synced
  independently. Sign-in gains a vendor choice, so Google no longer has to be
  configured through an "Advanced" override field.
- **A brake on directory removals.** If a sync returns far fewer people than the
  directory currently holds — a bad credential, a filter that stopped matching —
  the removals are skipped, the updates still apply, and the reason is logged.
  A misconfiguration can no longer empty your directory.

### Fixed
- SCIM provisioning recorded every pushed user under the same generic provider,
  so users from two different directories could be matched to each other.
- The external-id lookup documented itself as case-insensitive while doing an
  exact match. It is case-insensitive now, and can be scoped to one directory.
- Group identifiers were required to be unique across all directories rather
  than within one, which would have made the same team syncable from only one.

## [0.95.0] - 2026-08-02

### Added
- **Roles can be granted for a single space, and it now means something.**
  Assignments have carried a space since custom roles arrived, but nothing
  consulted it. Grant a role "in Engineering only" and it unlocks Engineering
  and nothing else — including read access to a private space, which previously
  could only come from a group.

### Changed
- **The last two hard-coded administrator bypasses are permissions.** Seeing
  every space and authoring in every space are now `space.read_all` and
  `space.author_all`, held by the Administrator preset. Administrators are
  unaffected; the difference is that these are grants a workspace can move,
  audit, and see explained, instead of constants buried in a module.

  Everything here is additive — no existing access changes, and per-space
  grants sit alongside the group and per-space edit rights you already have.

## [0.94.0] - 2026-08-02

### Changed
- **Section access and the newsletter are role grants now.** Delegating
  Announcements, Compliance, or Training used to be stored separately from
  everything else, as did who can write and approve the newsletter. Both are
  ordinary roles today, so the same grant can go to a group, be explained in
  Roles & permissions, and be revoked in one place. The settings pages work
  exactly as before — the storage moved underneath them, and existing grants
  were carried over on first start.
- **Training team leads.** Leading a group still opens the team view on its
  own. It can now also be granted as a permission, which closes the one check
  in CompassDocs an administrator could not reach at all.

### Fixed
- A change to someone's role could have silently revoked their section
  delegation or newsletter access. Caught before release; the two are now kept
  properly separate.
- The "does everyone have a role" health check counted delegated grants as
  ladder mismatches, reporting problems that weren't.

## [0.93.0] - 2026-08-02

### Added
- **Custom roles are here.** Settings → **Roles & permissions** lets you build
  a role out of any of the ~200 things CompassDocs can do, and grant it to a
  person or a group — for the whole workspace, or for a single space. A group
  grant follows the group, so people joining or leaving pick up and lose the
  role without anyone revisiting the page.

  This is what the last two releases were building toward: **permissions now
  decide access**, not the four fixed roles. Someone can run the launchpad, or
  the audit log, or backups, without being made an administrator.

- **A permission matrix that's usable.** Permissions are grouped by what they
  act on, each group collapses, and a search box filters across names, keys,
  and descriptions at once, with select-all per group.

- **"Why can this person do that?"** The **Explain access** tab lists
  everything someone effectively holds and which role — and which group — gave
  it to them.

- **Health checks for the model itself.** One tab answers the three questions
  worth asking: can anyone still restore other people's access, does the new
  model still agree with the old role ladder, and does everyone have a role.

### Changed
- **The settings console is no longer all-or-nothing.** Each section now has
  its own permission, so a delegated role sees exactly the sections it can use
  and the navigation shows only those. Previously the whole console required
  the administrator role even for a section you'd been given.
- Your four existing roles are unchanged and keep working exactly as before —
  they are now presets you can duplicate and modify. The presets themselves
  stay read-only so that upgrades adding new permissions keep granting them.

### Security
- Any change that would leave **nobody** able to manage users — editing a role,
  deleting one, revoking a grant — is applied, checked, and rolled back with an
  explanation. The workspace cannot be locked out of itself.
- `COMPASSDOCS_AUTHZ_LEGACY=1` restores the previous role-based enforcement at
  startup if a workspace needs to fall back. The console shows a banner while
  it is set.

## [0.92.0] - 2026-08-02

### Added
- **Every part of the app now knows which permission it requires.** Work
  continues on custom roles: all 166 places the API checks whether you're
  allowed to do something have been labelled with the specific permission
  they're protecting — "create a group", "restore a backup", "revoke a
  share link" — rather than just a role name. Administrators can see the
  running comparison between the old role check and the new permission
  check under the API; it currently reports **189 agreements and no
  disagreements**.

  **Nothing about your access changes in this release.** The old check is
  still the one that decides. The new one runs alongside it purely so any
  difference shows up before it can affect anyone, and the switch happens
  in a later release once that comparison stays clean.

## [0.91.0] - 2026-08-02

### Added
- **Groundwork for custom roles.** CompassDocs is moving from four fixed
  roles to real role-based access control, where a role is a named set of
  permissions you can create and edit, and can be granted for the whole
  workspace or for a single space. This release installs the machinery —
  the permission catalogue, the roles themselves, and who holds them — but
  **nothing about your access changes yet**. Viewer, Editor, Approver and
  Administrator are now ordinary roles holding exactly the permissions they
  always implied, and everyone keeps the role they had. The screens for
  creating and assigning roles arrive in a later release.
- Administrators get three read-only views under the API to inspect the
  new data: the role list, a cross-check that every account's role came
  across intact, and — most usefully — **who could still restore everyone
  else's access** if something went wrong.

### Changed
- The protection that stops you removing the last administrator no longer
  counts people with the "admin" role, because with custom roles that
  wouldn't mean anything. It now asks the question that actually matters:
  is there still at least one active person who can manage other people's
  roles? Demoting, disabling and deleting are all checked against it.

## [0.90.0] - 2026-08-02

### Changed
- **Authoring in a space now requires being able to see it.** The internal
  check for "may this person write here?" trusted its callers to have
  already confirmed the space was visible to them. That assumption was
  wrong twice — it's what made 0.89.1 possible — so the check now confirms
  visibility itself. The workspace-wide "editors may edit any space they
  can see" option is unchanged and still on by default; it was only ever
  meant to widen writing across spaces you can already see, and now it
  can't do more than that.

### Fixed
- Internal groundwork for the permissions rewrite: the value that carries
  "which spaces may this request see" can no longer be constructed by hand
  or accidentally left out of a database query. Seventeen queries could
  previously be called without it and would then return results from every
  space; that only ever happened on admin-only screens, where it was
  correct, but it was one typo away from not being. Those screens now say
  so explicitly, and three places that build their own view of the
  workspace — the public site, the Slack/Teams integration, and analytics —
  now go through named, reviewable entry points.

  No behaviour changes for anyone who could already see what they were
  looking at.

## [0.89.1] - 2026-08-02

### Security
- **An editor could publish a document out of a private space they had no
  access to.** Creating a share link checked that you may *edit* the space
  but never that you may *see* it — and because the default "editors may
  edit any space they can see" setting makes the edit check pass for every
  editor, any editor could mint an anonymous `/share/…` link for any
  document in any private space, then read it (and its attachments) with no
  account at all. Restoring a document from the Trash had the same missing
  check, letting an editor pull documents back into a space they cannot see.
  Both now verify space visibility first, as the equivalent move and review
  routes already did.

  Affects every release since share links shipped in 0.57.0. Exploiting it
  required an account with the Editor role or higher. Workspaces with no
  private spaces are unaffected; so are workspaces that turned share links
  off. Existing share links are unchanged — review them under each
  document's Share menu if you want to be certain none were created this
  way.

## [0.89.0] - 2026-08-02

### Fixed
- **Dark mode had white slabs everywhere.** About fifty tinted panels were
  written for light mode only and rendered as cream rectangles punched into
  dark pages — including the most important message on Domain & HTTPS.
  Several places had the opposite bug and were genuinely unreadable: the
  command palette's own input text, the new-document template picker's
  heading, and the header of every code block.
- **Empty pages looked like different products.** Sixteen pages that can be
  empty used eleven different treatments. They're now one, and they tell
  you how to fill them — an empty Links page offers "Add links" instead of
  only describing where links would go.
- **The workspace date and time settings now apply everywhere.** Roughly
  half the app ignored them, so the audit log could read "2026-08-02, 03:58"
  while the account security page two clicks away read "08/02/2026, 3:58 AM"
  for a comparable event. The per-user timezone was dead on those surfaces
  too.
- **Dates could be a day out.** Several pages formatted timestamps inside
  the database, in the server's timezone, so a document touched near
  midnight showed the wrong day to anyone in a different zone. The weekly
  digest email had the same bug and ignored each recipient's format.
- The audit log honoured the workspace date format but silently ignored the
  per-user preference.

## [0.88.0] - 2026-08-02

### Added
- **The sidebar now shows you where you are.** The main navigation was the
  only one in the app that never highlighted the current page — settings,
  account and the space tree all did. It does now, in both the wide and the
  icon-only rail.
- **Documents have a readable line length.** Body text ran to 98 characters
  per line at the default width and 187 on a wide monitor, well past the
  comfortable range. Prose is now capped at a readable column — around 64
  to 70 characters — while the title, notices, toolbar and side panel keep
  using the full width you chose. Body text is also a point larger.

### Fixed
- **The mobile navigation was unusable with a screen reader.** On a phone
  the rail is always collapsed, so the entire primary navigation was
  unlabelled icons; spaces announced as the name of their emoji. Everything
  is now named, and the phone controls are proper 44px tap targets.
- **The mobile navigation drawer wasn't a real dialog.** It ignored Escape,
  left the page behind it scrollable and focusable, and in dark mode washed
  the page white instead of dimming it.
- **Escape now closes only the top layer.** The overlay ordering added in
  0.86.0 was never actually wired up, so each overlay handled Escape itself
  — with a palette open over the navigation drawer, one press could close
  both.
- **Controls that only worked with a mouse.** Stop tracking a service,
  unlink a related document and reorder sub-pages were invisible on phones
  and tablets — not merely awkward, but permanently hidden — and drew their
  focus ring on an invisible box when tabbed to. The directory's sortable
  columns weren't operable by keyboard at all.
- Unnamed form controls got accessible names, including each row's role
  selector in Users, which previously announced thirty identical anonymous
  dropdowns with no indication of whose role was about to change.
- The table of contents now remembers whether you opened it, and stops
  listing the document's own title as its first entry.

## [0.87.0] - 2026-08-02

### Fixed
- **The editor no longer discards unsaved work.** Previously you could type a
  paragraph, press Ctrl+S out of habit (which did nothing), click something
  in the sidebar, and the work was gone with no warning. Now Ctrl/Cmd+S
  saves, and an editor with unsaved changes asks before letting them go — on
  reload, on tab close, on Cancel, and on that sidebar click. A document you
  haven't touched never nags you.
- **Save no longer scrolls out of reach.** The Save button now rides along
  with you down a long document, the way the formatting toolbar already did.
- **Content you couldn't get to.** Below roughly 1180px the user list silently
  dropped its Status and Actions columns, so Reset password, Disable and
  Delete were unreachable rather than merely awkward; on a phone the buttons
  to create a document in a space, and to edit or trash one, sat off the edge
  of the screen entirely. Board view gave document titles as little as three
  characters of room while leaving a quarter of the row empty, the directory
  clipped every card on a phone, and the analytics tables handed most of
  their width to single-digit columns.
- **Real not-found and error pages.** A link to a deleted document used to
  eject you to a stock browser-style 404 with no way back — and a white slab
  in dark mode. You now get a proper page inside the app that explains the
  likely cause and offers a way onward.
- **Failures that said nothing now speak.** Twelve actions that either popped
  an OS dialog or failed silently — including revoking a share link, which
  could fail while still showing the live link — now show the server's actual
  explanation. Account settings never had a toast host mounted at all, so its
  confirmations went nowhere.
- The dashboard's search box still hard-coded a ⌘K hint, showing the wrong
  key on Windows and Linux next to a sidebar that showed the right one.
- Account settings ignored the Normal/Wide/Full page-width preference — on
  the very page that offers it.

## [0.86.0] - 2026-08-02

### Added
- **Command palette.** Press **⌘K** (**Ctrl+K** on Windows and Linux) from
  anywhere to open a search overlay that floats in front of whatever you're
  looking at — it never navigates you away. It searches documents, people,
  spaces, every navigation destination, and actions, all in one list, with
  the documents you opened recently offered before you type a thing.
- **People search.** `@` opens a dedicated people mode over the directory,
  matching on name, email, job title, and department, with photos.
- **Keyboard shortcuts.** `/` search · `@` people · `>` actions · `#` spaces
  · `?` the full shortcut sheet · `c` new document · and `g` then a letter
  to jump anywhere in the left-hand navigation (`g h` dashboard, `g p`
  people, `g t` training…). Shortcuts you have no access to aren't bound.
  Press `?` any time for the list, which names the right modifier for your
  platform.
- Shortcuts never fire while you're typing — in the editor, an input, or
  with another dialog open — and the mode keys work on European keyboard
  layouts where they're typed with AltGr.

### Fixed
- ⌘K was advertised on the dashboard but did nothing when the sidebar was
  collapsed or on a phone, because the shortcut lived inside the sidebar's
  search box. The palette is now mounted app-wide, and the sidebar's search
  affordance works in both the wide and the icon-only rail.
- `/api/search` no longer returns a server error for a negative `limit`, and
  is now rate limited like the other search endpoints.
- Closing a zoomed image while taking a training deck no longer throws you
  out of the deck — an open overlay now owns the Escape key.
- The document-link and @mention pickers had unreadable highlighted rows in
  dark mode.

## [0.85.1] - 2026-08-01

### Fixed
- **Settings pages ignored the page-width preference.** 0.85.0's readable
  column pinned settings content to a fixed width inside the page
  container, so Normal / Wide / Full had no effect on most settings pages
  (the few table-heavy ones still responded, which made it look
  inconsistent). Settings now follow the account preference like every
  other page.
- Single sign-on, the team-lead training view, the training player, the
  training certificate, and the new-document template picker had the same
  problem from earlier releases — all now honor the preference. Printed
  certificates are unchanged: the certificate itself keeps its fixed
  width, only the page around it widens.

## [0.85.0] - 2026-08-01

### Added
- **Settings console, phase 2.** Building on 0.84's structure:
  - **Shared form controls.** Every settings form now uses one set of
    primitives — labeled fields with help text and error states, selects,
    textareas, and proper toggle switches for boolean options — so every
    page looks and behaves the same.
  - **Readable width.** Settings content sits in a comfortable reading
    column instead of stretching across ultra-wide screens; table-heavy
    sections (users, audit log, spaces, content health, directory,
    templates) keep the full width.
  - **Danger zones.** Destructive actions get a clearly separated
    red-bordered card — starting with license removal.

### Changed
- Boolean options across Workspace, Public site, SSO/SAML/SCIM, Directory
  sync, Spaces, Templates, and Chat panels render as toggle switches with
  their explanations attached.

## [0.84.0] - 2026-08-01

### Added
- **Settings console, phase 1.** The admin settings got a full structural
  refresh:
  - The settings rail is now **grouped by area** — Platform, Content,
    People & access, AI, and Operations — with a search box that filters
    across every section by name and keywords.
  - Every settings page has a **unified header** (icon, title, one-line
    description) driven by a single registry, so the nav and the page can
    never disagree about what a section is called.
  - **Toast notifications.** Saving anything in settings now confirms with
    a toast in the corner (and failures show a red one) instead of
    transient inline "Saved." flashes that varied page to page. Persistent
    status — license expiry, TLS state, import summaries — stays inline.

### Changed
- Duplicate panel titles removed across settings: pages no longer repeat
  their own name above the content, and multi-panel pages use clear
  sub-headings ("OpenID Connect (OIDC)", "Webhooks", "All links").
- Several previously silent actions (adding a webhook, saving a document
  template, switching the approval workflow) now confirm with a toast.

## [0.83.0] - 2026-08-01

### Added
- **Custom tooltips.** A new app-wide tooltip system replaces the browser's
  native `title` bubbles (slow, unstyled, and invisible to keyboard users):
  styled, theme-aware tooltips that appear on hover *and* keyboard focus.
  All 124 control tooltips across the app now use it, and every icon-only
  control gained a matching `aria-label` for screen readers.
- **Platform style guide.** `STYLEGUIDE.md` codifies the UI patterns —
  page skeleton, title icons, subtitle tiers, empty states, buttons,
  tooltips, chips, color/theming rules, print rules, and accessibility —
  so every future page ships consistent by construction.

### Changed
- Ask now follows the Normal / Wide / Full page-width preference like every
  other page.
- Page subtitles unified to one style across Directory, Links, Review,
  Trash, Settings, Analytics, Ask, and Training.
- The Service status page and the training compliance matrix hide their
  controls when printing, for clean record copies.

## [0.82.1] - 2026-08-01

### Fixed
- **Service status follows your page-width preference.** The Status page was
  hard-coded to a narrow column and ignored the Normal / Wide / Full setting;
  it now uses the standard page container like every other page.
- **Consistent page-title icons.** Newsletter, Review queue, Links,
  Directory, Ask, Settings, Trash, and Service status now carry the same
  accent-colored icon beside the page title that Analytics, Announcements,
  Compliance, and Training already had — and Training's title now matches
  the standard size.

## [0.82.0] - 2026-08-01

### Added
- **Compliance matrix.** A new Matrix tab in the training console: every
  person × every deck in one grid — done, waived, open, overdue, or not
  assigned — with person search and CSV export.
- **Point-in-time snapshots.** A snapshot of the full training record is
  stored automatically every month (and on demand with one click), hashed
  with SHA-256 over the exact stored text — `sha256sum` on the downloaded
  file reproduces the stored hash, so evidence is tamper-evident.
- **One-click audit package.** Overview → Evidence exports a single ZIP:
  summary, compliance matrix, all assignment and history records as CSV,
  every stored snapshot, and a manifest with a SHA-256 for each file.
- **Scheduled monthly report.** Opt-in email (with a recipient picker) sent
  alongside each monthly snapshot: completion rate, overdue counts, and the
  decks that need attention. Template editable under Email templates.
- **E-signature confirmations.** A per-deck "Require e-signature" setting:
  trainees type their full name — and local accounts re-enter their
  password — before the confirmation is recorded. The signed name appears
  on the certificate and in every export. Every completion (signed or not)
  now also records a SHA-256 of the exact content confirmed.
- **Question-level quiz analytics.** Each deck card shows how often every
  quiz question is answered correctly across attempts, so a confusing
  question stands out from a confusing slide.
- **Team leads.** Managers can name leads per group: leads get a scoped
  `/training/team` view of just their group's status (no manager access
  needed) plus a weekly email digest.

### Fixed
- Native checkboxes, radios, sliders, and progress bars now follow the
  workspace accent color — they previously stayed browser-default blue
  regardless of the color chosen in the console settings.

## [0.81.0] - 2026-08-01

### Added
- **Training console, rebuilt for scale.** Manage decks is now a dense,
  searchable table — sort by title, lowest completion, or most overdue;
  filter by free-form deck tags; click a row to expand the full deck card.
- **Bulk people actions.** Each deck's people table gains status filter
  chips, name search, and row checkboxes with a bulk bar: remind, waive,
  **unassign** (open assignments only — completed records are never
  removed), and **extend due dates** (someone on leave no longer trips the
  escalation with no remedy). Completed rows get a per-person **Reopen**.
- **Per-person training transcript.** Click any name for one page with a
  person's live assignments and every prior certification cycle — quiz
  scores, waivers, confirmed versions — printable, with CSV export. The
  record auditors actually sample.
- **Needs-attention queue.** The Overview's inert overdue list is now a
  triage queue combining overdue, quiz-below-pass, and stalled (14+ days
  idle) assignments, with inline Remind / +7 days / Snooze — work it to
  zero.
- **Manager deck preview.** Walk any deck exactly as trainees will, without
  assigning it to yourself; nothing is recorded.
- **Evidence retention.** Completed training now survives deletion:
  offboarding a user or deleting a deck archives the completions to the
  history table first, and history rows carry name/title snapshots instead
  of vanishing with their foreign keys.

### Changed
- Deck settings (due days, auto-assign, quiz pass %, recertification, tag)
  are all editable after creation; programs are editable too (rename,
  add/remove/reorder decks, auto-assign toggle separate from active).
- "Remind now" sends email as well as the in-app notification and resets
  the reminder cadence, so the sweep no longer double-nudges within hours.
- Action feedback moved to toast notifications that are visible wherever
  you are on the page (and settings-save failures are no longer silent).
- Deck cards and Overview bars now agree on the numbers: counts cover
  active users only, and waived is reported separately from completed
  everywhere. Per-deck CSV gained the quiz and prior-completion columns
  the org CSV already had.
- The drop-off insight ("most stop at slide N") shows without opening the
  people list, and Overview's deck bars sort lowest-completion first.

## [0.80.0] - 2026-08-01

### Added
- **Quizzes.** Add a `:::quiz` block to any slide (editor button included):
  multiple-choice questions, single- or multi-select. Grading happens
  server-side — the answer key never reaches the trainee's browser — and a
  per-deck pass threshold (default 80%) must be met before the final
  confirmation unlocks. Scores appear on the dashboard, in CSV exports, on
  certificates, and in the audit record.
- **Recurring recertification.** Give a deck a "recertify every N months"
  interval and completed assignments reopen automatically when it elapses —
  the prior completion is preserved in a history table, the person is
  notified, and the due clock restarts. A "Reopen completed" button does the
  same on demand after a material document update.
- **Completion certificates.** Every real completion (not waivers) gets a
  printable certificate — name, deck, date, quiz score, document version,
  and the assignment record number — linked from the player, the My
  Training card, and the manager's people list.
- **Org-wide Overview tab.** Training managers get KPIs (active decks,
  people, completion %, overdue), per-deck completion bars, an overdue
  list, and a whole-program CSV export for auditors.
- **Per-person deck view.** Each deck card now expands to a people table —
  status (open/overdue/completed/waived), quiz score, prior completions —
  with a per-person **Remind now** button that bypasses the reminder
  cadence, and certificate links.
- **Overdue escalation.** When someone crosses a week overdue, the deck's
  creator gets a notification (once per assignment).
- **Drop-off insight.** Deck cards show the slide where most in-progress
  trainees stopped.
- **Claude connector training tools.** `create_training_deck`,
  `assign_training`, and `training_status` — ask Claude "who hasn't
  finished security onboarding?" or have it assign the new SOP deck.
  Gated by the training entitlement and Training-section access.

## [0.79.0] - 2026-08-01

### Added
- **Onboarding programs.** Bundle training decks into a named package (e.g.
  "New starter onboarding"): active programs auto-assign every deck to each
  new member, and a program can be assigned to people, groups, or everyone
  as one unit — with a single notification instead of one per deck.
- **Waivers for existing staff.** Rolling CompassDocs out to a team that
  already did the training elsewhere? Waive a deck for selected people or
  for everyone: it's marked done without anyone being nagged, recorded as
  *waived* (not completed, no confirmed version) in the dashboard and CSV
  so the audit trail stays honest.
- **Archive & delete decks.** Retire a deck to the new Archived decks page
  (hidden from everyone's Training tab, history kept, restorable any time)
  or delete it permanently along with its assignment history.
- **Training page breaks you can see while editing.** The editor button now
  inserts a break that previews as a labeled "slide break" marker — and on
  the published document page the break renders as nothing at all, so a
  deck doc reads as one clean page outside the player.
- **Save & exit in the player.** Leave a deck mid-way from the header button
  (or Esc) — progress is saved continuously, so Continue picks up where you
  left off.

### Changed
- **Searchable pickers replace long dropdowns.** Creating a deck now opens a
  search-as-you-type picker showing the ten most recently updated published
  docs; the same combobox pattern replaces entity dropdowns elsewhere that
  got clunky with many items.

### Fixed
- **Custom accent color in dark mode.** Accent-colored text and icons no
  longer fall back to the stock blue when a workspace accent is set — text,
  buttons, and tints now derive from the same accent everywhere (the
  Training screens made the mismatch obvious).

## [0.78.0] - 2026-07-31

### Added
- **Training & onboarding** (enterprise `training` entitlement). Any
  published document becomes a training deck: slides split on `---` lines
  (new editor buttons insert slide breaks), and an optional
  `:::compliance` block at the end sets the wording of the final
  confirmation gate. Assign decks to people, groups, or everyone — or
  auto-assign to every new member — with a due-in-N-days deadline. The
  new **Training** tab shows everyone their assignments with progress and
  due dates; the slide player (next/back, arrow keys, resume) ends in a
  recorded confirmation that captures the document version confirmed.
  Managers (admins or Training-section grantees via Settings → Section
  access) get the deck builder, a per-deck progress dashboard, and CSV
  export for audit evidence. Assignment and due/overdue reminders flow
  through the notification center and two new editable email templates.

## [0.77.0] - 2026-07-31

### Changed
- **Cards view handles sub-page-heavy spaces gracefully.** Sections now use
  masonry packing (cards fill columns top-to-bottom), so one document with
  a long sub-page list no longer opens a block of dead space beside its
  neighbors. Sub-page lists under a card cap at 4 rows and fold the rest
  behind "N more sub-pages…" — expandable in place, with the cap spanning
  the whole nested subtree.

## [0.76.0] - 2026-07-31

### Added
- **Image uploads through the Claude (MCP) connector.** The new `add_image`
  tool takes a screenshot or any image as base64 (a `data:` URI works too),
  stores it as a normal document attachment, and returns the exact markdown
  snippet to place in the body. The file type is detected from the bytes —
  PNG, JPEG, GIF, and WebP are accepted (SVG deliberately not); the
  workspace's attachment size limit applies, uploads respect space edit
  rights, and every upload is audited. The connector's writing guide and
  instructions now cover the image workflow end to end.

## [0.75.0] - 2026-07-30

### Added
- **One-click updates from the admin console.** Deploy the optional updater
  companion from the docs' compose block (Watchtower with its HTTP API — the
  Docker socket never touches the web app, and the updater has no published
  ports) and **Settings → System → Version & updates** gains an
  **Update now** button: pull the new image, restart, and watch the console
  confirm the new version, usually in under a minute. Triggers are
  admin-only and audited; without the companion, nothing changes.
- Release images now also carry the **`:latest`** tag, so installs (and the
  updater) can follow releases without editing tags.

## [0.74.1] - 2026-07-30

### Added
- **Outbound proxy support.** On egress-locked networks (Azure NSGs,
  corporate firewalls) set `HTTPS_PROXY` / `NO_PROXY` on the container and
  every server-side fetch — status polls, outgoing webhooks, AI and
  embeddings calls — routes through the proxy. Pair with
  `NODE_EXTRA_CA_CERTS` when the proxy re-signs TLS.
- **An "Outbound HTTPS" diagnostics check.** Settings → System → Diagnostics
  now probes a public status page from the server (direct or via the
  configured proxy) and, on failure, names the actual blocker — DNS, a
  refused tunnel, TLS — instead of a silent status board stuck on "Unknown".

## [0.74.0] - 2026-07-30

Is it just me, or is Zoom down? CompassDocs now answers that — and tells
everyone.

### Added
- **A Status page for the tools your org relies on.** Admins pick services
  from a catalog (GitHub, Zoom, Slack, Cloudflare, Dropbox, OpenAI,
  DocuSign, Box, NetDocuments, iManage Cloud, Google Workspace, Salesforce,
  AWS, Microsoft 365, …) or point at any custom status page. CompassDocs
  polls each vendor's own status page about every five minutes — the
  Atlassian Statuspage JSON format covers most of SaaS, with dedicated
  adapters for Slack, Google, Salesforce, and AWS, and an RSS/Atom fallback
  for everything else. A fetch hiccup never flips a state.
- **Outage alerts, everywhere people already look.** When a tracked service
  goes down — and when it recovers — everyone gets a bell notification and
  a personal chat-webhook post (with its own row in the notification routing
  grid), a banner appears at the top of the dashboard, and the sidebar's
  Status entry shows a count.
- **Manual incidents for internal systems.** Phones, on-prem servers,
  anything without a status page: approvers declare an incident (severity,
  title, first update), post updates that build a timeline, and resolve it
  when it's over — with notifications at both ends. Incidents can also
  annotate a vendor outage with org-specific guidance.
- **Microsoft 365 tenant health (enterprise).** The M365 catalog entry reads
  real service health (Exchange, Teams, SharePoint…) from Microsoft Graph
  using the same Entra app registration as the directory sync — grant it
  `ServiceHealth.Read.All` and it lights up.

## [0.73.4] - 2026-07-29

### Fixed
- **The Claude connector's Approve button works again in Chromium browsers.**
  The 0.64.1 Content-Security-Policy sent `form-action 'self'` on the OAuth
  consent page, and Chrome/Edge enforce that directive against the redirect
  that follows approval — so clicking **Approve** silently did nothing and the
  page never advanced. The consent page now allows exactly the redirect
  targets registration accepts (https and loopback); every other page keeps
  the strict policy.

## [0.73.3] - 2026-07-29

### Added
- **Claude connector check in Diagnostics.** Settings → System → Diagnostics
  now verifies the MCP connector's sign-in advertisement: it shows the OAuth
  origin your install advertises (and whether it came from the custom-domain
  setting or the proxy's forwarded headers), flags plain-`http://` issuers,
  host mismatches, and missing `X-Forwarded-Proto`, and probes the advertised
  discovery URL from the server — so "unable to connect to the sign-in
  service" in Claude turns into a named cause and fix on your own System page.

## [0.73.2] - 2026-07-29

### Fixed
- **The doc page always shows what you just saved.** Saving in the editor
  navigated to the document before flushing the client-side page cache, so
  the page could show the pre-save copy — a freshly applied heading
  highlight looked lost even though it saved fine, until a hard reload.
  The cache now flushes before the redirect.

### Changed
- **Version compare pickers read "Original" and "Modified"** (instead of
  A / B), and the compare header says "Original vN → modified vM".

## [0.73.1] - 2026-07-28

### Changed
- **Version compare now opens in a rendered, doc-layout view.** The history
  page diffs versions section-by-section and renders each section through
  the real document pipeline — callouts, lists, and tables look like the
  page, removed sections sit red-tinted directly above their green-tinted
  replacements, and long unchanged runs fold away. The exact source diffs
  are still there as **Markdown** (side-by-side) and **Inline** views.

## [0.73.0] - 2026-07-28

Your account, properly. The account page is now a real settings area — and it
learned some long-requested tricks.

### Added
- **A settings shell that scales.** Account settings now use a left-rail
  layout with focused sections — Profile, Preferences, Notifications,
  Security, API tokens — each with its own URL. Password changes moved into
  Security (the forced first-login reset keeps its focused page).
- **Profile editing.** Set your display name, email, and a profile photo
  (resized in the browser, shown in the sidebar and account header; initials
  remain the fallback). Single sign-on and SCIM accounts see name and email
  read-only — the identity provider stays the source of truth.
- **Theme that follows you.** Light/dark/auto is now saved on your account
  and applied on any browser you sign in from. The sidebar toggle still
  works — it writes through to your account.
- **Per-event notification routing.** A delivery grid in Account →
  Notifications: for each event type (mentions, comments, subscribed spaces,
  change requests, review decisions, review reminders, read confirmations)
  choose whether it reaches your in-app inbox, your chat webhook, and — where
  an email exists — your email. Defaults preserve existing behavior exactly.
- **Your time zone, your dates.** Pick a personal time zone and date format;
  timestamps on documents, history, the dashboard, and acknowledgements
  render in them (workspace settings remain the default). The weekly digest
  now arrives Monday morning in each recipient's own time zone.

### Changed
- **One style of add button in the doc panel.** Sub-pages' "+ New" link and
  Related documents' "Link a document" button now use the same compact
  bordered chips as Attachments, right-aligned in each section header — the
  Related-documents chip also pops a collapsed section open.
- **"Less" moved to the bottom of the sidebar fold.** After clicking "More",
  the toggle now sits below the expanded items (Newsletter … Settings), so
  "Less" closes the list it ends instead of hiding above it.

## [0.72.0] - 2026-07-27

A calmer document page: the side panel is for content, actions moved to the
toolbar.

### Changed
- **Share link and Review schedule moved to the toolbar.** Both are now
  compact popovers behind icons next to Print/History/Edit (the review icon
  turns amber when a review is overdue) instead of permanently-expanded
  panel cards. Same controls, a click away, out of the reading path.
- **Collapsible panel sections.** Sub-pages, Related documents, and
  Attachments now collapse: sections with content start open, empty ones
  start tucked to a slim header row (with their add-buttons still in
  reach), and your choice is remembered per browser. Sections that are
  empty stay entirely hidden for viewers, as before.

## [0.71.0] - 2026-07-27

Video, upgraded end to end.

### Added
- **Self-hosted video that actually streams.** The attachment endpoint now
  serves byte ranges (`206 Partial Content`), so uploaded videos seek and
  scrub properly — and play at all in Safari. Playable video types stream
  inline instead of downloading.
- **A video size limit of its own.** Settings → Attachments gains a
  separate cap for video uploads (default 200 MB, up to 2 GB) — screen
  recordings no longer fight the document-attachment limit.
- **More providers.** `::video` now also embeds **SharePoint / Microsoft
  Stream**, **Google Drive**, **Wistia**, and **Dailymotion** links, plus
  `dai.ly` short links — joining YouTube, Vimeo, Loom, and direct files.
- **A real insert dialog.** The editor's Video button opens a dialog with
  live provider detection, optional caption and poster, and an
  upload-a-video-file option (no more URL prompt). Pasting a supported
  video link on its own line auto-converts to a video block.
- **Theater mode & posters.** Hover any video for a theater-mode button
  that expands it to fill the screen (Esc closes); uploaded videos accept
  a `poster="…"` pre-play thumbnail.

## [0.70.0] - 2026-07-27

Concurrent-edit safety, and a permanent end-to-end test suite.

### Added
- **Edit-conflict protection.** Saving a document that someone else changed
  while you were editing is now refused with a clear message (and a link to
  the latest version) instead of silently overwriting their work. The editor
  sends the version it loaded; the server compares before applying.
- **Editing presence.** Open a document another editor already has open and
  both of you see a banner naming who else is in — lightweight awareness,
  no locking. Heartbeats age out server-side within seconds of a closed tab.
- **End-to-end test suite in CI.** A Playwright suite (login, dashboard,
  create/search, the strict-mode approval loop with its inbox notification,
  the REST API scope matrix, and the new conflict + presence behavior) runs
  against a real production build + PostgreSQL on every pull request.

## [0.69.1] - 2026-07-27

### Added
- **Zoomable diagrams & images.** Mermaid and PlantUML diagrams (workflows,
  decision trees, sequence charts) now open in a full-screen viewer on
  click — scroll wheel or ＋/− to zoom (25%–800%), drag to pan,
  double-click to toggle, Esc to close. Inline images use the same viewer
  (they previously only expanded to fit the screen).

### Fixed
- Attachment and DMS-link rows show the **full file/link name in a
  tooltip** on hover — long names truncate in the narrow side panel and
  were unreadable.

## [0.69.0] - 2026-07-27

Link out to your document-management system.

### Added
- **DMS links.** Documents can now carry links into **iManage**,
  **NetDocuments**, and **SharePoint** (or any https URL) — shown alongside
  attachments with a branded badge per system, but nothing is stored in
  CompassDocs: they're titled deep links that open in the source system,
  which keeps enforcing its own permissions. Editors add them with **＋
  Link** in the Attachments panel (URL + optional display name — the system
  is auto-detected from the host, including iManage `iwl:` desktop links);
  anyone who can see the document can follow them. Adds and removals are
  audited. Up to 50 links per document; only `https://` (and `iwl:`) URLs
  are accepted.

## [0.68.0] - 2026-07-27

A public REST API, and token scopes to go with it.

### Added
- **REST API at `/api/v1`** for scripts and integrations, authenticated with
  personal access tokens (`Authorization: Bearer cdk_…`):
  - `GET /me` (introspection), `GET /spaces`
  - `GET/POST /documents`, `GET/PATCH/DELETE /documents/:id` — with paging,
    space/status filters, and the approval workflow honored: an editor's API
    edit to a published doc is queued as a change request (`202`), never
    silently published
  - `GET /search?q=` — the app's hybrid search, operators included
  - JSON errors, and a 120 req/min per-user rate limit
- **Token scopes.** Personal access tokens now carry `read`/`write` scopes,
  chosen at creation (Manage account → API tokens shows each token's scope).
  Read-only tokens are enough for search/exports and are refused by write
  endpoints — and by the Claude connector, which needs read + write.

### Changed
- Tokens created before 0.68 keep full read + write access (their historical
  behavior); nothing breaks.

## [0.67.0] - 2026-07-27

A notifications center: everything that happens to you in CompassDocs now
lands in one inbox behind a bell in the sidebar.

### Added
- **Notification inbox.** A bell in the sidebar with an unread badge, a
  dropdown of recent notifications, one-click mark-read (or mark-all), and
  deep links into the right document. Notifications cover:
  - **@mentions** and **new comments** on threads you've participated in
  - **Publishes and updates** in spaces you subscribe to
  - **Change requests** — approvers hear when one is submitted; authors
    hear when theirs is approved or declined (with the reviewer's note)
  - **Content reviews coming due** (approvers) and **read-confirmation
    requests** (enterprise)
- **Personal chat webhook.** Paste a Slack or Teams incoming-webhook URL in
  Manage account → Notifications and your notifications are also posted
  there. Server-side the delivery goes through the SSRF-safe fetch layer,
  and only `https://` URLs are accepted.
- `GET/POST /api/notifications` for the inbox (list, unread count,
  mark-read).

### Changed
- Mention and read-confirmation notices moved from targeted dashboard
  announcements into the notification inbox — the dashboard announcement
  board is now purely for org-wide posts. Existing targeted announcements
  still display until dismissed or expired.
- In-app notifications are delivered even when SMTP isn't configured
  (emails remain optional on top).
- Read notifications older than 90 days are pruned by the hourly
  maintenance sweep.

## [0.66.0] - 2026-07-27

The dashboard grew up: it is now a personal work hub built around what YOU
need to do, not workspace trivia — its first significant redesign since the
initial release.

### Added
- **Personal greeting** with your local time of day, plus a prominent
  search / Ask bar right on the dashboard.
- **Needs your attention.** One card that gathers everything waiting on you —
  change requests to review, documents needing your read confirmation,
  content reviews coming due, and open reader suggestions — with a direct
  link for each. Only appears when something actually needs you.
- **Pick up where you left off.** Your in-progress drafts (jump straight to
  the editor) and the documents you most recently opened.
- **Latest in your spaces.** Recent publishes and updates as an
  author-attributed activity list instead of anonymous cards.

### Changed
- Spaces moved to a compact side column with document counts.
- The static stat tiles (documents / spaces / tags) and the tag cloud are
  gone; search covers tag discovery.

## [0.65.0] - 2026-07-27

Operations release: audit-log export for compliance teams, first-class
monitoring endpoints, and database housekeeping.

### Added
- **Audit-log export** (Enterprise). Admins can download the audit log as CSV
  or JSON from Settings → Audit log, filtered by category and date range. The
  download streams in batches, so a year of events exports without straining
  the server, and every export is itself recorded in the log. Also available
  at `GET /api/admin/audit/export?format=csv|json&category=&from=&to=`.
- **Date-range filters** on the audit log screen (all editions).
- **Health probes.** `GET /healthz` (liveness — process up) and `GET /readyz`
  (readiness — database reachable, with latency) for load balancers and
  orchestrators. Both are unauthenticated and dependency-appropriate: a
  struggling database fails `/readyz` without tripping `/healthz` restarts.
- **Prometheus metrics** at `GET /metrics`: process memory/uptime, pg pool
  state, login/search/AI/export counters, and workspace gauges (users,
  documents, sessions, audit events). Scrapers authenticate with a bearer
  token via `COMPASSDOCS_METRICS_TOKEN`; signed-in admins can view it in a
  browser without one.
- **Diagnostics panel** on Settings → System: live checks of the database,
  upload storage, SMTP, AI provider, semantic search, license, and metrics
  endpoint, with a re-run button.
- **Structured logging option.** `COMPASSDOCS_LOG_FORMAT=json` switches
  operational events to JSON lines for log shippers.

### Changed
- Expired sessions and used OAuth codes are now purged hourly instead of
  accumulating forever; supporting index added.
- Document lookups by slug got an exact `(space_id, slug)` index for large
  spaces.

### Fixed
- Audit-log entries with identical timestamps could interleave out of order in
  the admin list (text-ordered tiebreak); ordering is now strictly numeric.

## [0.64.1] - 2026-07-27

Security hardening release from a full internal audit. No action required on
upgrade; two settings auto-migrate (see notes).

### Security
- **Stored XSS in search snippets fixed.** The in-space search box and the
  Outlook add-in rendered `ts_headline` output without escaping; document text
  containing HTML could execute in a viewer's browser. All snippet renderers
  now share one escape helper.
- **SSRF hardening on outbound fetches.** The AI (OpenAI-compatible) and
  embeddings endpoints now go through the SSRF-guarded fetch, and that guard
  now **blocks private/RFC1918 ranges by default** (cloud-metadata and loopback
  were already blocked). Deployments that intentionally fetch internal hosts
  can opt back in with `COMPASSDOCS_FETCH_ALLOW_PRIVATE=1`.
- **Access-control scope checks** added to change-request approve/reject and to
  the review-schedule, page-move, and suggestion-resolve endpoints, so an
  approver/editor can't act on documents in a private space outside their
  scope.
- **SSO account-linking hardened** (Enterprise). SSO no longer silently links
  to an admin account or one already bound to a different provider; OIDC now
  ignores an explicitly-unverified email and never treats the mutable
  `preferred_username` as an identity; multi-tenant Entra requires an
  email-domain allowlist. SAML gained a single-use replay guard.
- **Login throttle** now derives the client IP from the trusted proxy hop
  (`COMPASSDOCS_TRUSTED_PROXY_HOPS`, default 1) instead of a spoofable
  `X-Forwarded-For`, so the lockout can't be bypassed.
- **Secrets & 2FA at rest.** The Microsoft 365 directory-sync client secret and
  the TOTP secret are now sealed like every other credential (both auto-seal on
  next boot / next enrollment). TOTP codes can no longer be replayed within
  their validity window.
- **Content-Security-Policy** tightened from frame-only to a full policy
  (`default-src`/`script-src`/`connect-src` locked to `self`), and per-user
  rate limits added to the AI and PlantUML endpoints.

## [0.64.0] - 2026-07-27

### Added
- **SAML 2.0 single sign-on (Enterprise).** Connect any SAML identity
  provider — Okta, OneLogin, Google Workspace, ADFS, Entra SAML apps —
  alongside (or instead of) Microsoft OIDC sign-in, under Settings → Single
  sign-on. Paste the IdP metadata XML to auto-fill the endpoints and signing
  certificate, hand the IdP admin the shown SP entity/ACS URLs, and choose
  just-in-time provisioning and default role. Uses the same `sso` license
  entitlement as OIDC. Each sign-in is bound to its own request (replay- and
  CSRF-resistant), and assertion signatures are verified against the
  configured certificate.
- **Search operators.** Narrow results with `type:`, `tag:`, `space:`,
  `author:"name"`, and `status:` (draft/published, for people who can see
  drafts) — mixed freely with keywords. Active filters show as removable
  chips, and an operator-only query browses the newest matching documents.

### Changed
- **Better search ranking.** Titles now outrank body text, an exact title
  match gets a boost, and recently-updated documents win ties — so the most
  relevant, freshest document tends to come first. A no-results search now
  suggests what to try instead.
- **Accessibility & readability.** A full pass brings text contrast to WCAG
  AA across every screen in both light and dark themes, adds larger touch
  targets and clearer labels, and confirms no page overflows horizontally on
  a phone.
- **Next.js 16.** The application now runs on Next.js 16 with the Turbopack
  build — faster builds and up-to-date dependencies, with no change to how
  the app works.

## [0.63.1] - 2026-07-27

### Changed
- **Tailwind CSS 4.** The UI build moved from Tailwind 3.4 to 4.3 (CSS-first
  configuration, faster builds). No visual or behavioral changes: the
  themeable palette, dark mode, and the workspace accent color work exactly
  as before — verified page-by-page in both themes.

## [0.63.0] - 2026-07-26

### Added
- **Weekly digest email.** An opt-in Monday-morning summary (Account →
  Notifications → *Weekly digest*): what changed in your subscribed spaces
  this week, reviews to handle (approvers and admins), and the week's
  most-read documents — each scoped to what the recipient can see, and only
  sent when there's something to report. Fired once per week no matter how
  many app instances run.
- **Bulk operations in the space table view.** Select documents with
  checkboxes and publish, unpublish, set the type, move to another space,
  or add/remove a tag in one action. Every document is checked against the
  same rules as a single edit — space scope, edit rights, and the approval
  workflow — and anything ineligible is skipped with a reason, never
  forced.
- **Scheduled publish & auto-unpublish.** Drafts can be given a *publish
  automatically at* time and published docs an *unpublish automatically at*
  time (visible to users with publish rights, next to Status in the
  editor). A minute-level scheduler fires them with atomic claims (safe
  across instances), notifies space subscribers on publish exactly like a
  manual publish, and records `document.scheduled_publish` /
  `document.scheduled_unpublish` in the audit log. Stale schedules on
  hand-published or trashed docs are cleared, never re-fired.
- **"Was this helpful?" on documents.** A thumbs-up/down at the end of
  every document (one vote per person, revisable; a "No" invites an
  optional note). Ratings feed a new **Poorly rated** section in
  Settings → Content health: three or more votes and mostly "not helpful."
- **Installable app (PWA) & accessibility.** CompassDocs now installs to
  the home screen / dock (web app manifest, brand icons and theme color) —
  no service worker by design, so signed-in content is never cached stale.
  Keyboard users get a skip-to-content link past the sidebar, and the main
  content region is a proper labeled landmark.

## [0.62.0] - 2026-07-26

### Added
- **Bring your own AI provider.** **Settings → AI** now has a provider
  choice for Ask, ✨ Write, and ✨ Proofread: **Anthropic (Claude)** — the
  default, unchanged — or any **OpenAI-compatible** `/v1/chat/completions`
  endpoint: OpenAI itself, an Azure gateway, or a fully local engine
  (Ollama, LM Studio, vLLM) via a custom URL, so answers can be generated
  without anything leaving your network. The API key is optional for local
  engines and sealed at rest like every credential; the endpoint is
  validated with a tiny live request when you save, with specific messages
  for a wrong URL, bad key, or unknown model. This matches the provider
  flexibility [semantic search] has had since 0.49.

## [0.61.0] - 2026-07-26

### Added
- **AI writing assist in the editor.** A new **✨ Write** menu beside
  Proofread: **draft from the title** (a structured starter with
  `[placeholders]` instead of invented facts), **improve**, **expand**,
  **make shorter**, **summarize into the summary field**, and **change
  tone** (professional, friendly, concise, confident). Every result shows
  in a review panel first — nothing touches your document until you click
  apply — and the helpers use the same admin-configured Anthropic key and
  model as Ask and proofreading, degrading gracefully when no key is set.
  Markdown structure and code blocks are preserved, and rewrites never
  invent facts.
- **Ask CompassDocs from Slack and Teams.** A Slack slash command (e.g.
  `/askdocs how do we roll back a deploy?`) and a Microsoft Teams outgoing
  webhook answer questions in-channel with the same grounded, cited answers
  as in-app Ask — sources linked back to the knowledge base. Chat answers
  draw **only from published documents in non-private spaces**, so private
  content never reaches a channel. Set up under **Settings → Notifications
  → Ask in chat**: paste each platform's verification secret (sealed at
  rest like every credential) and flip the enable switch — requests are
  authenticated with Slack request signing (with replay protection) and
  Teams HMAC.
- **Content health report.** A new **Settings → Content health** page shows
  where the knowledge base is quietly rotting, computed live from signals
  the app already tracks: **broken internal links** (references to deleted
  pages), **orphaned documents** (nothing links to them), **overdue
  reviews**, **stale documents** (published, 180+ days unedited, on no
  review cycle), **unread documents** (no views in 90 days), **possible
  duplicates** (near-identical openings by embedding similarity, when
  semantic search is configured), and documents whose **author is no longer
  an active user**. Scorecards up top; every row links to the document.
- **Import from Confluence or Notion.** A guided migration under
  **Settings → Data → Migrate from another tool** takes the zip you export
  from Confluence (*Export space → HTML*) or Notion (*Export → Markdown &
  CSV*), auto-detects the format, and imports it into a new or existing
  space. It rebuilds the page hierarchy as **nested pages**, converts
  Confluence's HTML (headings, lists, tables, code) to clean Markdown,
  strips Notion's page-id suffixes, and pulls in **images and file
  attachments** — rewriting every reference to the imported copy. Upload
  shows a preview (detected source, page and attachment counts) before you
  commit, and you choose whether pages land as drafts to review or are
  published. The action is admin-only and recorded in the audit log.

## [0.60.0] - 2026-07-24

### Added
- **Space views.** Every space page now has a view switcher: the classic
  **Cards**, a sortable **Table** (title/type/status/author/updated, grouped
  category column, review-overdue flags), a **Tree** outline (when nested
  pages are enabled), a **Board** grouped by status or type (including a
  "Review overdue" column), a **Timeline** of freshness buckets with overdue
  reviews surfaced on top, and a **By tag** grouping. Your choice is
  remembered per space per browser, and admins can set each space's default
  view under Settings → Spaces.
- **Table of contents on documents.** Docs with two or more H1–H3 headings
  get a collapsible TOC at the top (collapsed by default) whose links jump
  to the section — no markdown changes needed, heading anchors are added
  automatically.
- **Quick print directory.** Press Print / PDF on the Directory (any view)
  and what prints isn't the screen — it's a compact phone list with exactly
  the columns an admin configured (built-in fields and custom directory
  fields, in order) under Settings → Directory → Quick print directory.
  Hidden entries are never printed.

## [0.59.5] - 2026-07-24

### Changed
- **Dependency refresh** (from the weekly Dependabot sweep): React 19.2.7,
  lucide-react 1.26, AWS S3 SDK, Aileron fonts, PostCSS/Autoprefixer, and
  CI action updates (setup-node v7, buildx v4, login-action v4,
  build-push-action v7, download-artifact v8). Two 0.x packages where a
  "minor" bump can break — `@anthropic-ai/sdk` and `tiptap-markdown` — are
  deliberately held back for a planned migration, and Dependabot is now
  configured to propose only patches for them (Tiptap v3 majors likewise
  excluded until the editor migrates as a whole).

## [0.59.4] - 2026-07-23

### Fixed
- **The sidebar no longer crowds out the spaces list on short screens.**
  Everyday items (Dashboard, Ask, Directory, Links, Review queue) stay
  visible; the less-used, role-gated items (Newsletter, Analytics,
  Announcements, Compliance, Trash, Settings) now sit behind a **"More"**
  fold — folded by default, one click to expand, remembered per browser.
  The Trash count surfaces on the More row while folded so nothing hides.
  The nav and spaces list also share one scroll region now, so on a very
  short window everything stays reachable instead of the spaces list
  absorbing all the squeeze.

## [0.59.3] - 2026-07-21

### Fixed
- **Space-subscription emails sent for MCP-connector edits had relative
  links** (a bare `/doc/…` path, which mail clients render as a dead link)
  instead of the full `https://your-domain/doc/…` URL. Documents created or
  updated through the Claude connector now resolve the public origin the same
  way the web app does — and `notifySpaceSubscribers` additionally falls back
  to the configured custom domain whenever a caller can't supply an origin,
  so subscriber email links are always absolute on any install with a domain
  set. Webhook notifications for connector-driven publishes and change
  requests now include the document/review link too, matching the web paths.

## [0.59.2] - 2026-07-21

### Fixed
- **Actionable errors when the encryption master key is unavailable.** If the
  key file (`/uploads/.secret.key`) can't be read — most commonly because the
  uploads volume is still root-owned after the 0.59 non-root upgrade and the
  one-time `chown` was missed — saving any encrypted credential (SSO client
  secret, SMTP password, backup credentials, AI/embeddings API keys, custom
  TLS key) used to fail with a generic "could not save", and the log blamed a
  key *mismatch*. Now: the settings APIs return an error naming the key file,
  the cause, and the exact fix command; the startup log prints the same
  actionable line once at boot; and decrypt failures distinguish "key file
  unreadable" (fixable, key intact) from a genuine key mismatch.
- The upgrade notes' volume `chown` example targeted unprefixed volume names,
  which on a default install silently created fresh empty volumes instead of
  fixing the real ones (Compose prefixes volume names with the project name).
  The [Updating guide](https://docs.compassdocs.io/self-hosting/updating/) now
  uses `docker compose run --rm --no-deps --user 0 app chown -R 1001:1001
  /uploads /backups`, which always operates on the service's real volumes.

## [0.59.1] - 2026-07-21

### Fixed
- **MCP connector authorization behind a reverse proxy that doesn't forward
  `X-Forwarded-Proto`.** The OAuth discovery documents
  (`/.well-known/oauth-authorization-server`,
  `/.well-known/oauth-protected-resource`) and the MCP `401` challenge now
  build their issuer and endpoint URLs from the **configured custom domain**
  (Settings → Domain & HTTPS) when one is set, instead of trusting the
  request's forwarded headers. A proxy (commonly hand-rolled nginx) that
  forgets `proxy_set_header X-Forwarded-Proto $scheme;` previously made the
  server advertise `http://` URLs, which every OAuth client rejects — the
  connector failed with a generic "Authorization failed" for no visible
  reason. With a custom domain configured, the metadata is always advertised
  over HTTPS. Installs without a custom domain (dev, or reached by IP) are
  unaffected and still use the request headers.

## [0.59.0] - 2026-07-20

### Security
- **The container now runs as a non-root user** (uid/gid 1001). The three
  writable data directories (`/uploads`, `/backups`, and the optional
  custom-TLS cert dir) are created and owned by that user in the image.

  **Upgrading from 0.58.x or earlier requires a one-time `chown`** of your
  existing volumes so the non-root process can write to data created by the
  old root container — see the
  [Updating guide](https://docs.compassdocs.io/self-hosting/updating/).
  Fresh installs need no action.

## [0.58.0] - 2026-07-20

### Security
- **CSRF protection** on cookie-authenticated API requests: a browser
  presenting a cross-origin `Origin` header is rejected (a second layer on
  top of the existing `SameSite=Lax` session cookies), including on login.
- **SSRF protection** for server-side fetches of admin-supplied URLs (quick
  link icons, workspace logos, outgoing webhooks): cloud metadata,
  loopback, and link-local targets are refused and every redirect hop is
  re-validated. Intranet (RFC1918) hosts stay reachable by default;
  `COMPASSDOCS_FETCH_BLOCK_PRIVATE=1` locks those down too.
- **Supply-chain scanning in CI**: npm audit (high+), Trivy
  (vulnerabilities, secrets, misconfig), and Dependabot update PRs.

## [0.57.1] - 2026-07-20

### Fixed
- **Side panel no longer slides under the sticky title bar.** When
  scrolling a long document, the sticky panel's top offset now clears the
  floating title bar, so the first section header (Sub-pages, Related
  documents, …) stays fully visible.
- **Consistent side-panel headers.** Sub-pages and Attachments gained
  their icons (matching Share link, Review schedule, and Linked from), and
  Related documents now uses the same text weight as the rest instead of
  a lighter shade.

## [0.57.0] - 2026-07-20

### Added
- **Public share links** (off by default — Settings → Public site). Create
  a tokenized read-only link to a single published document and hand it to
  anyone — no account, no exposing the whole space. Links are unguessable,
  always `noindex`, optionally expiring (7/30/90 days), revocable or
  regenerable from a Share link card in the doc's side panel (which also
  counts opens), and audited. Inline images and attachments work through
  the link, scoped to exactly that document. Unpublishing the document —
  or turning the master switch off — disables every link instantly.

## [0.56.0] - 2026-07-20

### Added
- **Content review reminders.** Give any document a review cadence
  (monthly to yearly) from a new Review schedule card in its side panel,
  and CompassDocs keeps it honest: when the review comes due, the document
  shows an overdue notice with one-click "Mark as reviewed", due documents
  surface in an amber block on the dashboard for editors, and approvers
  get an email (an editable template like every other alert, sent once per
  due date). Marking a document reviewed — or simply editing its content —
  pushes the next review a full interval out, and every review action
  lands in the audit log.

## [0.55.0] - 2026-07-20

### Added
- **Nested pages** (off by default — Settings → Workspace → Document
  organization). Documents can have sub-pages up to 3 levels deep: a
  Sub-pages panel with manual ordering and a "New sub-page" shortcut, a
  parent selector in the editor, ancestor breadcrumbs, tree views on space
  pages and in the sidebar, and hierarchy-aware search results. Sub-pages
  stay in their parent's space; moving a document to another space detaches
  it and promotes its children — nothing is ever orphaned or deleted.
- **Backlinks & `[[` link autocomplete** (off by default, same settings
  card). Type `[[` in the rich editor to search and link any document
  inline, and every document shows a "Linked from" panel listing the
  documents whose content links to it — extracted automatically on every
  save, with existing content indexed the moment the toggle turns on.
- **Claude connector**: `create_doc`/`update_doc` accept a `parent`, and
  `read_doc` reports a document's path, sub-pages, and backlinks — so
  "add a sub-page under the incident runbook" lands in the right place.

## [0.54.1] - 2026-07-20

### Fixed
- **Attachments fit the side panel.** The attachment list still used its
  old two-column card grid from when it lived below the document, so in the
  narrow side panel the Copy link/Delete buttons overlapped the file size
  and forced the panel to scroll. It's now a compact single-column list —
  thumbnail, truncating filename, size, and icon actions (with tooltips) on
  one line.
- **Small screens get a usable layout.** The sidebar previously kept its
  full width on phones, crushing the content to a sliver. It now starts as
  the icon rail on small screens, and expanding it floats the full sidebar
  over the page with a backdrop instead of squeezing the layout. Desktop
  behavior (and the remembered collapse preference) is unchanged.
- The "Suggest an edit" button uses a proper icon instead of an emoji.

## [0.54.0] - 2026-07-20

### Changed
- **Cleaner document pages.** The header is now pure typography: title, one
  compact meta line, and the summary as a plain lede paragraph instead of a
  colored box — content stops competing with chrome.
- **One notice strip instead of stacked banners.** Read-confirmation
  (reader prompt and approver progress), draft status, draft branches in
  progress, and pending changes now share a single quiet container with one
  row each, right above the content.
- **Read-confirmation toggle moved into the action row.** The approver-side
  "Require read confirmation" checkbox box is gone; it's now a shield icon
  next to Print/History/Edit that highlights when active, with progress and
  the record link in the notice strip.
- **Sticky title bar.** In long documents, a compact bar with the title,
  status, and actions fades in at the top once the header scrolls away.
- Icon-only buttons throughout the app now consistently carry tooltips.

## [0.53.0] - 2026-07-20

### Added
- **Document templates.** Creating a document now starts from a template
  picker: six built-ins ship out of the box (SOP, Runbook, Policy, Meeting
  notes, Incident postmortem, Decision record), each a full scaffold using
  rich blocks — callouts, Mermaid triage flows, severity tables,
  checklists. Placeholders fill in automatically ({{title}}, {{date}},
  {{author}}, {{space}}); anything else, like {{owner}}, stays visible as a
  prompt for the writer. A blank page is always one click away.
- **Template management (Settings → Templates).** Admins can edit any
  template's name, type, tags, title pattern, and body in the rich editor
  (with an insert-placeholder menu), hide templates from the picker, reset
  built-ins to their shipped content, create new ones from scratch — or
  save any existing document as a template straight from its page actions.
- **Per-space default templates.** Each space can name a default template
  (Settings → Spaces): creating a document from that space pre-fills it
  automatically, and the writer can still switch templates or start blank.
- **Templates over the Claude connector.** A new `list_templates` MCP tool
  exposes each template's structure, and `create_doc` accepts a `template`
  parameter — ask Claude to "draft a runbook for X" and the document lands
  in your team's standard runbook shape, with type, tags, and title pattern
  applied.

## [0.52.0] - 2026-07-19

### Added
- **Related documents.** Link documents to each other with typed
  relationships — **Related**, **Procedure for ↔ Procedures** (connect a
  policy to its accompanying procedures), and **Supersedes ↔ Superseded
  by**. Links are stored once and shown on both documents with the right
  label for each side, respect permissions (a related document you can't
  open isn't listed; drafts stay hidden from viewers), and anyone with edit
  rights on the space manages them inline — search, pick a relationship,
  done.

### Changed
- **Document pages get a right-hand panel.** Related documents,
  attachments, and suggestions now live in a sticky side panel next to the
  content instead of stacking below it — the reading flow stays clean, and
  the metadata is visible without scrolling. Comments remain below the
  document. On smaller screens the panel stacks under the content.

## [0.51.0] - 2026-07-19

### Changed
- **Compact sidebar footer.** The theme switcher, Manage account, and Sign
  out are now icon buttons with tooltips on a single row beside your name —
  half the vertical space of the old two-row footer. The theme button cycles
  Light → Dark → Auto (the icon shows the current mode, the tooltip says
  what's next). The collapsed sidebar keeps all three controls as a stacked
  icon column instead of hiding them.

## [0.50.2] - 2026-07-19

### Fixed
- **Announcements and Compliance use the standard page shell.** When they
  moved to the main navigation in 0.50 they lost the app's page container,
  so they rendered edge-to-edge while Analytics sat in the centered,
  width-preference-aware layout. Both pages now use the same container, and
  all three operational pages share one header pattern (icon + title +
  subtitle at the same size and position).

## [0.50.1] - 2026-07-19

### Fixed
- **Consistent tags and headings on the operational pages.** Compliance's
  page title now matches Announcements' size, and the "Enterprise" tag uses
  the same chip style as every other status tag (the app-standard size,
  weight, and casing) — the same normalization applied to the one-off
  Enterprise chip variants on the SCIM, Groups, and Directory settings
  panels.

## [0.50.0] - 2026-07-19

### Changed
- **Announcements and Compliance moved to the main navigation.** Settings
  stays focused on management and configuration; day-to-day operations now
  live in the sidebar at `/announcements` and `/compliance` (old Settings
  URLs redirect). The sidebar shows each entry only to people who can use
  it.

### Added
- **Delegated section access** (Settings → **Section access**). Grant
  individual users or groups access to Announcements and Compliance
  independently — a comms lead can run announcements, an HR manager can run
  the compliance program, neither needs the admin role. Admins always have
  access; grants apply immediately to the sidebar, pages, and APIs, and
  changes are audited (`settings.section_access`).
- **Settings search.** A search box above the Settings navigation filters
  sections by name and by what's inside them — typing "smtp" finds
  Notifications, "logo" finds Workspace, "api key" finds AI.
- **Scalable people & group pickers.** Settings pages that assign users or
  groups (space visibility, edit rights, subscriptions, group members,
  section access) now use a searchable multi-select with keyboard support
  and capped dropdowns instead of long checkbox walls and giant selects —
  fast and uncluttered even with thousands of accounts. The Users & roles
  and Newsletter people tables gained search filters too.

## [0.49.0] - 2026-07-19

### Added
- **Semantic search.** Search now understands meaning, not just keywords —
  "how do we handle refunds?" finds the reimbursement policy even when no
  word matches:
  - Documents are chunked and embedded into **pgvector**; results are
    fused with the existing full-text search (reciprocal-rank fusion), so
    keyword precision and semantic recall work together. Semantic-only
    hits carry a subtle **"related"** badge.
  - **Ask AI** and the **Claude connector's `search_docs`** use the same
    hybrid retrieval, so AI answers can cite documents that share no
    keywords with the question.
  - **Bring your own embeddings** (Settings → AI → Semantic search):
    Voyage AI, OpenAI, or any OpenAI-compatible endpoint — including
    fully local engines like **Ollama** and LM Studio via a custom URL.
    Write-only API key, connection test, and a one-click **Rebuild
    index** with live progress; documents re-embed automatically as
    they're created and edited.
  - **Respects every permission**: space visibility, private-space
    groups, and draft access are enforced on semantic hits exactly like
    keyword hits. The public site stays keyword-only by design (no
    per-query provider cost from anonymous traffic).
  - **Degrades gracefully**: no pgvector, no provider, or a provider
    outage all leave keyword search working exactly as before.
- The bundled docker-compose files now use the `pgvector/pgvector:pg16`
  PostgreSQL image (a drop-in superset of `postgres:16` — existing data
  volumes upgrade in place).

## [0.48.0] - 2026-07-19

### Added
- **Claude connector: the full editing toolbox.** The MCP API now knows —
  and grants access to — everything the in-app editor can do:
  - New **`writing_guide` tool**: the complete authoring reference for
    every rich block (callouts, tabs, accordions, interactive checklists,
    Mermaid and PlantUML diagrams, decision trees, video and website
    embeds, auto-filterable tables) with exact markdown syntax. The server
    instructions tell Claude to consult it before writing, so connector-
    authored documents use the same block vocabulary as the editor.
  - **`update_doc` can now publish** a draft (approval-aware: approvers
    and admins publish immediately; an editor's publish attempt queues a
    `publish` change request for review in strict mode, exactly like the
    app), **change the document type**, and **move a document to another
    space** (edit access required on both sides).
  - Publishing via the connector fires the same webhooks and subscriber
    emails as publishing in the app, and audit entries distinguish
    publish from edit.

## [0.47.0] - 2026-07-19

### Added
- **Editable email templates** (Settings → Notifications → **Email
  templates**). Every alert email CompassDocs sends is now a template an
  admin can customize:
  - Five templates: document published/updated (space subscribers),
    announcement blasts, comment @mentions, acknowledgement requests and
    reminders, and workflow-event email channels.
  - **Edit in the doc editor** — the same rich text editor used for
    documents, with a live **preview** that renders your draft with
    realistic sample values as you type.
  - **Dynamic tags** like `{{doc_title}}`, `{{actor_name}}`, and
    `{{doc_url}}` are replaced with the real values when each email is
    sent. An **Insert tag** menu in the editor toolbar drops them at the
    cursor, and each template lists exactly which tags it supports;
    unknown tags are left visible so typos are easy to spot.
  - **Reset to default** restores the built-in copy with one click, and a
    "Customized" badge shows at a glance which templates have been
    changed. Saving a template that matches the default simply clears the
    override.
  - Custom bodies are markdown, rendered through the same sanitized,
    brand-accented HTML pipeline as newsletters — plain-text parts are
    generated automatically, and untouched installs keep sending exactly
    what they always have.
  - Template edits and resets are audited (`settings.email_template`,
    `settings.email_template_reset`).

### Changed
- Announcement, mention, subscriber, acknowledgement, and workflow-event
  emails now render markdown (bold, links, quotes) in their HTML parts
  instead of fixed hand-built markup.

## [0.46.0] - 2026-07-19

### Added
- **Central compliance portal** *(enterprise, Settings → Compliance)*. One
  place to run the whole policy-acknowledgement program:
  - **KPIs**: policies requiring acknowledgement, overall compliance %,
    fully-compliant people, and outstanding acknowledgements.
  - **Policy progress** — every ack-required document with its progress bar,
    revision date, and last-reminder time; expand any row to see exactly
    **who has acknowledged and who's pending**, and download the per-policy
    CSV record.
  - **Request acknowledgement** — pick any published document and click one
    button: it starts requiring acknowledgement, and everyone who can see it
    gets a **targeted dashboard notice and an email** with a direct link.
    Compliance emails are sent regardless of personal notification settings.
  - **Remind** — one click notifies only the people who still haven't
    acknowledged (with an hourly cooldown so nobody gets spammed), stamped on
    the policy row.
  - **People view** — each person's required/acknowledged counts with a
    Compliant / outstanding badge.
  - **Export CSV** — the full portal-wide compliance matrix (policy × person
    with timestamps) for auditors.
  - Everything is audited (`ack.requested`, `ack.reminder_sent`).

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
