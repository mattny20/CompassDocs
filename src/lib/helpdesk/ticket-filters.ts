// Helpdesk 1.19.1: the desk queue's filter parameters, parsed and checked in
// one place (agent V4). The tickets list route (GET /api/helpdesk/tickets)
// and saved views (lib/helpdesk/saved-views) share it, so a saved view can
// hold exactly what a queue address can, and nothing else.
//
// Parameters (all strings, as in a query string):
//   view        mine|unassigned|open|overdue|workflow|waiting|solved_week|team:<id>|all
//   team        <team id> · priority · status · status_group=open
//   assignee    <user id>|me|none · requester <user id> · requester_email
//   request_type <id> · channel <channel or source> · mailbox <a help
//               address, 1.20.2> · tag · category · subcategory <1.20.6> ·
//   department · office ('none' = empty) · origin people|automated ·
//   vip yes|no · integration <id>|none · breached 1|now
//   created_from/created_to/solved_from/solved_to  YYYY-MM-DD, inclusive
//   created_within  1–366: created in the last N days, today included
//               (saved views' "Created in the last 7 days"; 1.19.1)
//   q           search text · sort updated|created|due|priority|number
// Server-only.

import "server-only";
import { channelSources, helpdeskTimezone, isPriorityValue, isStatus, parseView, TICKET_LIMITS } from "./tickets";
import type { TicketListFilters } from "./tickets";
import { cleanMailboxAddress } from "./mailboxes-shared";
import { splitCategoryLabel } from "./categories-shared";
import type { HdTicketSort } from "./types";

export const TICKET_SORTS: HdTicketSort[] = ["updated", "created", "due", "priority", "number"];

/** Every filter parameter the queue understands (not paging: limit, offset). */
export const TICKET_FILTER_KEYS = [
  "view",
  "team",
  "priority",
  "status",
  "status_group",
  "assignee",
  "requester",
  "requester_email",
  "request_type",
  "channel",
  "mailbox",
  "tag",
  "category",
  // 1.20.6 (lib/helpdesk/categories): a sub-category's name, or "Category › Sub-category" (Reports' drill-down).
  "subcategory",
  "department",
  "office",
  "origin",
  "vip",
  "integration",
  "breached",
  "created_from",
  "created_to",
  "solved_from",
  "solved_to",
  "created_within",
  "q",
  "sort",
] as const;
export type TicketFilterKey = (typeof TICKET_FILTER_KEYS)[number];

export type ParsedTicketFilters = { ok: true; filters: TicketListFilters } | { ok: false; error: string };

/** "YYYY-MM-DD" for `daysAgo` days before today in `tz`. */
function dayIn(tz: string, daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** The queue's filters out of query parameters, or the 400 sentence. Paging (limit, offset) is the caller's. */
export async function parseTicketFilters(p: URLSearchParams): Promise<ParsedTicketFilters> {
  const bad = (error: string): ParsedTicketFilters => ({ ok: false, error });
  const f: TicketListFilters = {};
  const view = parseView(p.get("view"));
  if (p.get("view") && !view) return bad("Unknown view.");
  if (view) f.view = view;
  const team = Number(p.get("team"));
  if (p.get("team")) {
    if (!Number.isInteger(team) || team <= 0) return bad("Unknown team.");
    f.team_id = team;
  }
  const pri = p.get("priority");
  if (pri) {
    if (!isPriorityValue(pri)) return bad("Unknown priority.");
    f.priority = pri;
  }
  const st = p.get("status");
  if (st) {
    if (!isStatus(st)) return bad("Unknown status.");
    f.status = st;
  }
  const a = p.get("assignee");
  if (a) {
    if (a === "me" || a === "none") f.assignee = a;
    else if (Number.isInteger(Number(a)) && Number(a) > 0) f.assignee = Number(a);
    else return bad("Unknown assignee.");
  }
  const rq = p.get("requester");
  if (rq) {
    if (!Number.isInteger(Number(rq)) || Number(rq) <= 0) return bad("Unknown requester.");
    f.requester_id = Number(rq);
  }
  const rem = p.get("requester_email");
  if (rem) {
    if (rem.length > 320 || !rem.includes("@")) return bad("Unknown requester.");
    f.requester_email = rem;
  }
  const rt = p.get("request_type");
  if (rt) {
    if (!Number.isInteger(Number(rt)) || Number(rt) <= 0) return bad("Unknown request type.");
    f.request_type_id = Number(rt);
  }
  const ch = p.get("channel");
  if (ch) {
    const sources = channelSources(ch);
    if (!sources) return bad("Unknown channel.");
    f.sources = sources;
  }
  const mb = p.get("mailbox");
  if (mb) {
    // 1.20.2 (lib/helpdesk/mailboxes): by address, so a queue link and a saved view read as words.
    const address = cleanMailboxAddress(mb);
    if (!address) return bad("Unknown address.");
    f.mailbox = address;
  }
  for (const k of ["tag", "category", "department", "office"] as const) {
    const v = p.get(k);
    if (v === null) continue;
    if (v.length > 80) return bad(`The ${k} is too long.`);
    // "none" is Reports' key for an empty value.
    if (k === "tag") {
      if (v && v !== "none") f.tag = v;
    } else f[k] = v === "none" ? "" : v;
  }
  // 1.20.6: a sub-category, by name; "Category › Sub-category" names its category too.
  const sub = p.get("subcategory");
  if (sub !== null) {
    if (sub.length > 170) return bad("The subcategory is too long.");
    if (sub === "none") f.subcategory = "";
    else if (sub) {
      const pair = splitCategoryLabel(sub);
      if (pair.subcategory) {
        f.category = pair.category;
        f.subcategory = pair.subcategory;
      } else f.subcategory = pair.category;
    }
  }
  const origin = p.get("origin");
  if (origin) {
    if (origin !== "people" && origin !== "automated") return bad("Unknown origin.");
    f.origin = origin;
  }
  const vip = p.get("vip");
  if (vip) {
    if (vip !== "yes" && vip !== "no") return bad("vip is yes or no.");
    f.vip = vip;
  }
  const integ = p.get("integration");
  if (integ) {
    if (integ === "none") f.integration_id = "none";
    else if (Number.isInteger(Number(integ)) && Number(integ) > 0) f.integration_id = Number(integ);
    else return bad("Unknown integration.");
  }
  const sg = p.get("status_group");
  if (sg) {
    if (sg !== "open") return bad("Unknown status group.");
    f.status_group = "open";
  }
  const br = p.get("breached");
  if (br) {
    if (br !== "1" && br !== "now") return bad("breached is 1 or now.");
    f.breached = br === "now" ? "now" : "ever";
  }
  for (const k of ["created_from", "created_to", "solved_from", "solved_to"] as const) {
    const v = p.get(k);
    if (!v) continue;
    const t = /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) : NaN;
    // A real calendar day (2026-02-31 does not round-trip), so Postgres never sees a bad date.
    if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== v) return bad(`${k} is a date (YYYY-MM-DD).`);
    f[k] = v;
  }
  const within = p.get("created_within");
  if (within) {
    const n = Number(within);
    if (!/^\d{1,3}$/.test(within) || n < 1 || n > 366) return bad("created_within is a number of days (1 to 366).");
    // Today counts: 1 = created today, 7 = today and the six days before.
    const from = dayIn(await helpdeskTimezone(), n - 1);
    if (!f.created_from || from > f.created_from) f.created_from = from;
  }
  const sort = p.get("sort") as HdTicketSort | null;
  if (sort) {
    if (!TICKET_SORTS.includes(sort)) return bad("Unknown sort.");
    f.sort = sort;
  }
  const q = p.get("q");
  if (q !== null) f.q = q.slice(0, TICKET_LIMITS.q);
  return { ok: true, filters: f };
}
