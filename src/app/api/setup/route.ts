import { NextResponse } from "next/server";
import { needsSetup, createUser, createSession, markLogin, setSetting } from "@/lib/db";
import { hashPassword, newToken } from "@/lib/password";
import { getSessionTimeoutMinutes, updateAppSettings } from "@/lib/settings-store";
import { SESSION_COOKIE, cookieOptions, SESSION_MAX_AGE, secureCookie } from "@/lib/auth";
import { SECURE_COOKIE_MODES, type SecureCookieMode } from "@/lib/settings";
import type { AppSettings, TlsMode } from "@/lib/settings";
import { parseLicense } from "@/lib/license";
import { applyProxyConfig } from "@/lib/caddy";

export const dynamic = "force-dynamic";

// First-run setup: create the initial admin account. Only works while the
// instance has no users; once set up, it refuses (409).
export async function POST(req: Request) {
  if (!(await needsSetup())) {
    return NextResponse.json({ error: "Setup has already been completed." }, { status: 409 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const username = String(body?.username ?? "").trim();
  const name = String(body?.name ?? "").trim();
  const email = String(body?.email ?? "").trim();
  const password = String(body?.password ?? "");
  const companyName = String(body?.company_name ?? "").trim();

  if (!username || !password) {
    return NextResponse.json({ error: "Username and password are required." }, { status: 400 });
  }
  if (!/^[a-zA-Z0-9._-]{2,40}$/.test(username)) {
    return NextResponse.json(
      { error: "Username must be 2–40 characters (letters, numbers, . _ -)." },
      { status: 400 }
    );
  }
  if (password.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters." },
      { status: 400 }
    );
  }

  // Validate the optional license key BEFORE creating the admin, so a bad key
  // doesn't half-complete setup (the admin exists but the request errored).
  const licenseRaw = String(body?.license_key ?? "").trim();
  if (licenseRaw) {
    const { error: licErr } = parseLicense(licenseRaw);
    if (licErr) {
      return NextResponse.json({ error: `License key rejected: ${licErr}` }, { status: 400 });
    }
  }

  // Re-check inside the write to narrow the race window.
  if (!(await needsSetup())) {
    return NextResponse.json({ error: "Setup has already been completed." }, { status: 409 });
  }

  const { hash, salt } = hashPassword(password);
  let user;
  try {
    user = await createUser({
      username,
      name: name || username,
      email,
      role: "admin",
      passwordHash: hash,
      passwordSalt: salt,
      mustChange: false,
    });
  } catch {
    return NextResponse.json({ error: "Could not create the account." }, { status: 400 });
  }

  if (companyName) await setSetting("company_name", companyName.slice(0, 80));

  // Cookie-security choice from the wizard (defaults to "auto", which matches
  // the request protocol — so plain-HTTP setups don't hit a login loop).
  const secureMode = String(body?.secure_cookies ?? "auto") as SecureCookieMode;
  if (SECURE_COOKIE_MODES.includes(secureMode)) {
    await setSetting("secure_cookies", secureMode);
  }

  // Store the (already-validated) license key, if one was entered.
  if (licenseRaw) await setSetting("license_key", licenseRaw);

  // Optional domain + HTTPS from the wizard. Stored (normalized/validated by
  // updateAppSettings) and pushed to the reverse proxy if one is attached; a
  // proxy failure is non-fatal so it never blocks finishing setup.
  const domainPatch: Partial<AppSettings> = {};
  if (body?.custom_domain !== undefined) domainPatch.custom_domain = String(body.custom_domain);
  if (body?.tls_mode !== undefined) domainPatch.tls_mode = body.tls_mode as TlsMode;
  if (body?.tls_email !== undefined) domainPatch.tls_email = String(body.tls_email);
  if (Object.keys(domainPatch).length) {
    await updateAppSettings(domainPatch);
    try {
      await applyProxyConfig();
    } catch {
      /* proxy may be unreachable during first-run; settings are saved regardless */
    }
  }

  // Sign the new admin in immediately.
  const token = newToken();
  const expires = new Date(
    Date.now() + (await getSessionTimeoutMinutes()) * 60_000
  ).toISOString();
  await createSession(token, user.id, expires);
  await markLogin(user.id);

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, cookieOptions(SESSION_MAX_AGE, await secureCookie(req)));
  return res;
}
