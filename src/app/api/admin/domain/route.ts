import { NextResponse } from "next/server";
import { getAppSettings, updateAppSettings } from "@/lib/settings-store";
import { normalizeDomain, TLS_MODES } from "@/lib/settings";
import type { AppSettings, TlsMode } from "@/lib/settings";
import {
  applyProxyConfig,
  proxyStatus,
  hasCustomCert,
  storeCustomCert,
} from "@/lib/caddy";
import { apiGuard } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

// Shape returned to the GUI. Note the certificate/key are write-only — we never
// echo the private key back, only whether one is stored.
async function currentState() {
  const s = await getAppSettings();
  const [status, customCert] = await Promise.all([proxyStatus(), hasCustomCert()]);
  return {
    custom_domain: s.custom_domain,
    tls_mode: s.tls_mode,
    tls_email: s.tls_email,
    has_custom_cert: customCert,
    proxy: status,
  };
}

export async function GET() {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await currentState());
}

export async function PATCH(req: Request) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  // Validate up front so we don't half-save an invalid combination.
  const patch: Partial<AppSettings> = {};
  if (body?.custom_domain !== undefined) {
    const raw = String(body.custom_domain).trim();
    if (raw && !normalizeDomain(raw)) {
      return NextResponse.json(
        { error: "Enter a valid domain like docs.example.com (no http:// or path)." },
        { status: 400 }
      );
    }
    patch.custom_domain = raw;
  }
  if (body?.tls_mode !== undefined) {
    if (!TLS_MODES.includes(body.tls_mode as TlsMode)) {
      return NextResponse.json({ error: "Unknown TLS mode." }, { status: 400 });
    }
    patch.tls_mode = body.tls_mode as TlsMode;
  }
  if (body?.tls_email !== undefined) patch.tls_email = String(body.tls_email);

  // Store a newly-pasted cert/key pair (write-only) before applying.
  const wantsCustom = (patch.tls_mode ?? (await getAppSettings()).tls_mode) === "custom";
  if (body?.tls_cert || body?.tls_key) {
    try {
      await storeCustomCert(String(body.tls_cert || ""), String(body.tls_key || ""));
    } catch (e: any) {
      return NextResponse.json({ error: e?.message || "Invalid certificate." }, { status: 400 });
    }
  }
  if (wantsCustom && !(await hasCustomCert())) {
    return NextResponse.json(
      { error: "Bring-your-own TLS needs a certificate and private key." },
      { status: 400 }
    );
  }

  if (Object.keys(patch).length) await updateAppSettings(patch);

  // Push to the live proxy. The settings are already saved; a proxy failure is
  // surfaced as a warning rather than failing the whole save.
  const applied = await applyProxyConfig();

  return NextResponse.json({
    ok: true,
    applied: applied.ok,
    proxyError: applied.ok ? undefined : applied.error,
    state: await currentState(),
  });
}
