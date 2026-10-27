// Where an identifier signs in (1.16.0): the sign-in page's first step when
// single sign-on is set up. POST { identifier, next } → the next step:
//
//   200 { step: "password" }
//   200 { step: "sso", providers: [{ id, label, mark, start }] }
//   429 { error, retry_after }            the lookup's own limit
//
// An unknown identifier and a password account get byte-identical answers;
// nothing about the account (name, status, whether it exists) is returned.
// `start` is a same-origin path built here, so the client never assembles a
// URL from what was typed. POST only and JSON only: the lookup carries the
// identifier only in its body, and a cross-site form cannot spend the limit.
// The `start` path it returns may carry an email as `login_hint` (OIDC only),
// so the address that starts sign-in can. lib/sign-in-routing holds the rules.

import { NextResponse } from "next/server";
import { crossOriginRejection } from "@/lib/api-auth";
import { audit, ipFrom } from "@/lib/audit";
import { IDENTIFIER_MAX } from "@/lib/auth";
import { signInLookupRetryAfter } from "@/lib/rate-limit";
import { safeReturnPath } from "@/lib/return-to";
import { providerStart, providersOf, routeByAccount, routeByConfig, signInSetup } from "@/lib/sign-in-routing";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

// One audit row per address per window when the limit engages, not one per refused lookup.
const throttledAudited = new Map<string, number>();

export async function POST(req: Request) {
  const cross = await crossOriginRejection();
  if (cross) return cross;
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return NextResponse.json({ error: "Invalid request." }, { status: 415, headers: NO_STORE });
  }
  let body: { identifier?: unknown; next?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400, headers: NO_STORE });
  }
  const identifier = String(body?.identifier ?? "").trim();
  // eslint-disable-next-line no-control-regex
  if (!identifier || identifier.length > IDENTIFIER_MAX || /[\u0000-\u001f\u007f]/.test(identifier)) {
    return NextResponse.json({ error: "Enter your email or username." }, { status: 400, headers: NO_STORE });
  }
  const next = safeReturnPath(typeof body?.next === "string" ? body.next : "/");

  const setup = await signInSetup();
  const ip = ipFrom(req) || "unknown";
  // Configuration decides most lookups and reveals nothing about accounts;
  // only a lookup that must read an account counts against the limit, which
  // is checked before the read.
  let route = routeByConfig(identifier, setup);
  if (!route) {
    const wait = signInLookupRetryAfter(ip);
    if (wait > 0) {
      const now = Date.now();
      if ((throttledAudited.get(ip) ?? 0) < now) {
        throttledAudited.set(ip, now + wait * 1000);
        if (throttledAudited.size > 5_000) for (const [k, until] of throttledAudited) if (until < now) throttledAudited.delete(k);
        await audit({ action: "auth.lookup_throttled", details: { seconds: wait }, ip });
      }
      return NextResponse.json(
        { error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute${wait > 60 ? "s" : ""}.`, retry_after: wait },
        { status: 429, headers: { ...NO_STORE, "Retry-After": String(wait) } }
      );
    }
    route = await routeByAccount(identifier, setup);
  }

  if (route.step === "password") return NextResponse.json({ step: "password" }, { headers: NO_STORE });
  const all = providersOf(setup);
  const providers = route.providers
    .map((id) => all.find((p) => p.id === id))
    .filter((p): p is NonNullable<typeof p> => Boolean(p))
    .map((p) => ({ ...p, start: providerStart(p.id, next, identifier) }));
  return NextResponse.json({ step: "sso", providers }, { headers: NO_STORE });
}
