// POST /support/api/link  { email, next? }   ask for a one-time sign-in link.
// Customer portal (Helpdesk 1.19.1). Public. Always the same answer for a
// well-formed address, whatever happens next (allowed, blocked, unknown,
// limited): the decision and the mail run after the response
// (lib/helpdesk/portal deliverSignInLink), so neither the words nor the
// timing say whether an address has requests. 10 a minute and 30 an hour
// per network address (429); per email address, the portal's own limit,
// silently.

import { after } from "next/server";
import { ipFrom } from "@/lib/audit";
import { logEvent } from "@/lib/log";
import { originOf } from "@/lib/helpdesk/routes";
import { PORTAL_LINK_SENT, cleanEmail, deliverSignInLink, getPortalSettings, linkIpLimited, portalHumanCheck, portalNotFound, portalOpen, portalOriginRejection } from "@/lib/helpdesk/portal";
import { portalJson, readSmallJson } from "@/lib/helpdesk/portal-http";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const settings = await getPortalSettings();
  if (!(await portalOpen(settings))) return portalNotFound();
  const cross = portalOriginRejection(req);
  if (cross) return cross;
  const ip = ipFrom(req) ?? "unknown";
  if (linkIpLimited(ip)) return portalJson({ error: "Too many tries. Wait a few minutes and try again." }, 429);
  const b = await readSmallJson(req);
  const email = cleanEmail(b?.email);
  if (!email) return portalJson({ error: "Enter your email address, like name@example.com." }, 400);
  if (!(await portalHumanCheck(req, "link", typeof b?.human_token === "string" ? b.human_token : undefined))) {
    return portalJson({ error: "Please complete the check and try again." }, 403);
  }
  const work = () =>
    deliverSignInLink(email, { origin: originOf(req), next: typeof b?.next === "string" ? b.next : "", ip, settings, journey: b?.j })
      .then((outcome) => logEvent("info", "helpdesk.portal_link", { outcome }))
      .catch((e) => logEvent("error", "helpdesk.portal_link_failed", { error: e instanceof Error ? e.message : String(e) }));
  try {
    after(work);
  } catch {
    // Outside a request scope (tests): run it detached all the same.
    void work();
  }
  return portalJson({ ok: true, message: PORTAL_LINK_SENT });
}
