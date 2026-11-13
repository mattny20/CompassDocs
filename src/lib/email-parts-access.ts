// Who may do what with the composable email templates (1.19.0), for the
// routes under /api/admin/email-templates/**:
//
//   read     integration.email_template_read (or _manage): list parts and
//            compositions, preview
//   manage   integration.email_template_manage: everything (parts CRUD,
//            defaults, every composition, test sends)
//   helpdesk helpdesk.admin on a licensed helpdesk: read the parts, and
//            read, preview, test-send and save the compositions of hd_*
//            events, for everyone or for one team (hd_team:<id>). Creating
//            and editing parts stays with template managers: a part is a
//            library item every email may use.
//
// The break-glass (COMPASSDOCS_AUTHZ_LEGACY) keeps all of it at admin, as
// the 1.18 route had it. Server-only.

import "server-only";
import { NextResponse } from "next/server";
import { apiSession, crossOriginRejection } from "./api-auth";
import { userHolds } from "./access";
import { featureEnabled } from "./ee";
import type { SessionUser } from "./types";
import { isHelpdeskEvent } from "./email-parts";

export interface EmailTemplatesAccess {
  user: SessionUser;
  read: boolean;
  manage: boolean;
  helpdesk: boolean;
}

/** May this caller manage the composition of `eventKey` (and its team variants)? */
export function canComposeEvent(a: EmailTemplatesAccess, eventKey: string): boolean {
  return a.manage || (a.helpdesk && isHelpdeskEvent(eventKey));
}

/** May this caller see / preview `eventKey`'s composition? */
export function canSeeEvent(a: EmailTemplatesAccess, eventKey: string): boolean {
  return a.read || a.manage || (a.helpdesk && isHelpdeskEvent(eventKey));
}

export const FORBIDDEN = () => NextResponse.json({ error: "You don't have permission for that." }, { status: 403 });

/**
 * Same-origin, signed in (401), then any of the three standings (403 when
 * none). `need: "manage"` asks for the template-manager key itself.
 */
export async function emailTemplatesGate(need: "any" | "manage" = "any"): Promise<EmailTemplatesAccess | NextResponse> {
  const cross = await crossOriginRejection();
  if (cross) return cross;
  const user = await apiSession();
  if (user instanceof NextResponse) return user;
  let access: EmailTemplatesAccess;
  try {
    const manage = await userHolds(user, "integration.email_template_manage", { legacyMin: "admin" });
    const read = manage || (await userHolds(user, "integration.email_template_read", { legacyMin: "admin" }));
    // The helpdesk standing: workspace helpdesk.admin, or a desk role with
    // templates.manage (lib/helpdesk/roles, the desk role ladder).
    const helpdesk =
      (await featureEnabled("helpdesk")) &&
      ((await userHolds(user, "helpdesk.admin", { legacyMin: "admin" })) ||
        (await (await import("./helpdesk/roles")).hdCan(user, "templates.manage")));
    access = { user, read, manage, helpdesk };
  } catch {
    return NextResponse.json({ error: "Could not evaluate permissions. Try again shortly." }, { status: 503 });
  }
  if (need === "manage" ? !access.manage : !(access.read || access.manage || access.helpdesk)) return FORBIDDEN();
  return access;
}

/** The JSON object body, or null (bad JSON, not an object, over `maxBytes`). */
export async function readJsonBody(req: Request, maxBytes = 128 * 1024): Promise<Record<string, unknown> | null> {
  const text = await req.text().catch(() => "");
  if (text.length > maxBytes) return null;
  try {
    const v = JSON.parse(text || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const BAD_JSON = () => NextResponse.json({ error: "Invalid JSON." }, { status: 400 });

// Test sends: at most 5 per person in 10 minutes (in-process; a test mail is a
// convenience, not a channel).
const TEST_WINDOW_MS = 10 * 60_000;
const TEST_MAX = 5;
const testSends = new Map<number, number[]>();

/** Records a test send; false when the person is over the limit. */
export function allowTestSend(userId: number, now = Date.now()): boolean {
  const recent = (testSends.get(userId) ?? []).filter((t) => now - t < TEST_WINDOW_MS);
  if (recent.length >= TEST_MAX) {
    testSends.set(userId, recent);
    return false;
  }
  recent.push(now);
  testSends.set(userId, recent);
  return true;
}
