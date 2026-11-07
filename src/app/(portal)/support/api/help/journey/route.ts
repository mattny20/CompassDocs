// POST /support/api/help/journey  { id, event: "open" | "submit" }  → { ok }
// Customer portal help centre (Helpdesk 1.19.4, C3): best-effort steps
// for "answered without a request". The page keeps a random id per
// browser tab (sessionStorage) and says when an article was opened from a
// search or a suggestion, and when a request was then raised. No personal
// data: no contact, no account, no network address is stored. Same-origin
// only (portalOriginRejection), 60 a minute per network address, 404
// while the help centre is off.

import { ipFrom } from "@/lib/audit";
import { helpCentreOpen, helpJourneyLimited, recordJourney } from "@/lib/helpdesk/help-centre";
import { portalNotFound, portalOriginRejection } from "@/lib/helpdesk/portal";
import { portalJson, readSmallJson } from "@/lib/helpdesk/portal-http";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!(await helpCentreOpen())) return portalNotFound();
  const cross = portalOriginRejection(req);
  if (cross) return cross;
  if (helpJourneyLimited(ipFrom(req) ?? "unknown")) return portalJson({ error: "Too many requests. Wait a moment and try again." }, 429);
  const b = await readSmallJson(req, 1024);
  const event = b?.event === "open" || b?.event === "submit" ? b.event : null;
  if (!b || !event) return portalJson({ error: "Say what happened." }, 400);
  const ok = await recordJourney(b.id, event);
  return portalJson({ ok });
}
