// POST   /support/api/session  { token }   spend a one-time link: sets the
//        portal cookie (compass_portal, Path=/support, HttpOnly, Lax, Secure
//        as the app's is) → { ok, next }. A link that is unknown, spent or
//        expired, or whose contact can no longer sign in: 400, one sentence.
// DELETE /support/api/session             sign out (this browser).
// Customer portal (Helpdesk 1.19.1). Same-origin writes only; 20 tries a
// minute per network address.

import { cookies } from "next/headers";
import { ipFrom } from "@/lib/audit";
import { secureCookie } from "@/lib/auth";
import {
  PORTAL_COOKIE,
  consumeSignInLink,
  getPortalSettings,
  portalCookieOptions,
  portalNotFound,
  portalOpen,
  portalOriginRejection,
  revokePortalSession,
  sessionIpLimited,
} from "@/lib/helpdesk/portal";
import { portalJson, readSmallJson } from "@/lib/helpdesk/portal-http";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const settings = await getPortalSettings();
  if (!(await portalOpen(settings))) return portalNotFound();
  const cross = portalOriginRejection(req);
  if (cross) return cross;
  const ip = ipFrom(req) ?? "unknown";
  if (sessionIpLimited(ip)) return portalJson({ error: "Too many tries. Wait a minute and try again." }, 429);
  const b = await readSmallJson(req, 2048);
  const token = typeof b?.token === "string" ? b.token : "";
  const done = await consumeSignInLink(token, { ip, userAgent: req.headers.get("user-agent"), settings });
  if (!done) return portalJson({ error: "This link has expired or was already used. Ask for a new one." }, 400);
  // journey (1.19.4 C3): the help centre journey of the tab that asked for the link, for this browser to keep.
  const res = portalJson({ ok: true, next: done.next, ...(done.journey ? { journey: done.journey } : {}) });
  res.cookies.set(PORTAL_COOKIE, done.sessionToken, portalCookieOptions(await secureCookie(req)));
  return res;
}

export async function DELETE(req: Request) {
  const cross = portalOriginRejection(req);
  if (cross) return cross;
  await revokePortalSession((await cookies()).get(PORTAL_COOKIE)?.value);
  const res = portalJson({ ok: true });
  res.cookies.set(PORTAL_COOKIE, "", portalCookieOptions(await secureCookie(req), 0));
  return res;
}
