// A click on a curated link (1.17.0): POST /api/links/{id}/click, sent by
// lib/link-beacon as the browser follows the link's real href. No body.
//
//   signed in   recorded against the person when the link is visible to them
//               (admins: every link); a link they cannot see answers 204 and
//               records nothing, so the beacon learns nothing either way
//   signed out  only for a link on the sign-in page (flagged and
//               unrestricted), recorded with no user; anything else is 401
//
// Same-origin only (the CSRF shape a beacon could be forged in), and
// rate-limited per person and per IP so a script cannot inflate the counts
// the dashboard ranks by. Over the limit is a quiet 204 too: the click was
// real enough for the browser, it just is not counted.

import { NextResponse } from "next/server";
import { crossOriginRejection } from "@/lib/api-auth";
import { getCurrentUser } from "@/lib/auth";
import { userHolds } from "@/lib/access";
import { getLink, linkIsPublicSignIn, linkVisibleTo, recordLinkClick } from "@/lib/db";
import { ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

const NO_CONTENT = () => new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });

// Per-process windows, like lib/rate-limit's: a backstop against one client
// hammering the counter, not a security boundary.
const windows = new Map<string, { count: number; resetAt: number }>();
function overLimit(key: string, max: number, windowMs = 60_000): boolean {
  const now = Date.now();
  let w = windows.get(key);
  if (!w || now >= w.resetAt) {
    w = { count: 0, resetAt: now + windowMs };
    windows.set(key, w);
  }
  w.count++;
  if (windows.size > 10_000) for (const [k, v] of windows) if (now >= v.resetAt) windows.delete(k);
  return w.count > max;
}

/** Clicks counted a minute: a person (any IP), and sign-in page clicks per IP. */
const PER_USER_PER_MINUTE = 30;
const PER_IP_SIGNED_OUT_PER_MINUTE = 20;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const cross = await crossOriginRejection();
  if (cross) return cross;

  const { id } = await params;
  const linkId = Number(id);
  if (!Number.isInteger(linkId) || linkId <= 0) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const user = await getCurrentUser();
  if (!user) {
    if (!(await linkIsPublicSignIn(linkId))) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }
    if (overLimit(`ip:${ipFrom(req) || "unknown"}`, PER_IP_SIGNED_OUT_PER_MINUTE)) return NO_CONTENT();
    await recordLinkClick(linkId, null);
    return NO_CONTENT();
  }

  if (!(await userHolds(user, "link.read", { legacyMin: "viewer" }))) return NO_CONTENT();
  const link = await getLink(linkId);
  if (!link) return NO_CONTENT();
  if (user.role !== "admin" && !(await linkVisibleTo(link.id, user.id))) return NO_CONTENT();
  if (overLimit(`user:${user.id}`, PER_USER_PER_MINUTE)) return NO_CONTENT();
  await recordLinkClick(link.id, user.id);
  return NO_CONTENT();
}
