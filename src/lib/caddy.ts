// Runtime control of the bundled Caddy reverse proxy.
//
// When CompassDocs runs behind the HTTPS compose profile, Caddy exposes its
// admin API on the internal Docker network (COMPASSDOCS_CADDY_ADMIN, e.g.
// http://caddy:2019). We translate the domain/TLS settings the admin picks in
// the GUI into a Caddyfile and POST it to `/load`, which Caddy applies with no
// downtime. The database is the source of truth: the same config is re-pushed
// on server boot, so a restart (or a config drift) heals itself.
//
// This module is server-only (fs + admin-API fetch); never import it from a
// client component.

import { promises as fs } from "fs";
import path from "path";
import { getSetting, setSetting } from "./db";
import { getAppSettings } from "./settings-store";
import type { TlsMode } from "./settings";

// Base URL of Caddy's admin API. Empty → no managed proxy is attached, so the
// GUI shows the domain settings as informational only.
const CADDY_ADMIN = (process.env.COMPASSDOCS_CADDY_ADMIN || "").replace(/\/+$/, "");

// Where the app writes bring-your-own cert files. This directory is a volume
// shared with the Caddy container, which reads it at CADDY_CERT_PATH.
const CERT_DIR = process.env.COMPASSDOCS_CADDY_CERT_DIR || "/caddy-certs";
// The same files as Caddy sees them (fixed mount point inside the caddy image).
const CADDY_CERT_PATH = "/etc/caddy/certs";

const CERT_KEY = "tls_cert_pem";
const KEY_KEY = "tls_key_pem";

/** True when a reconfigurable reverse proxy is attached to this deployment. */
export function proxyManaged(): boolean {
  return !!CADDY_ADMIN;
}

export interface ProxyStatus {
  /** Whether a manageable proxy (Caddy admin API) is configured at all. */
  managed: boolean;
  /** Whether the admin API responded to a health probe just now. */
  reachable: boolean;
}

/** Probe the proxy admin API so the GUI can show a live connection state. */
export async function proxyStatus(): Promise<ProxyStatus> {
  if (!CADDY_ADMIN) return { managed: false, reachable: false };
  try {
    const res = await fetch(`${CADDY_ADMIN}/config/`, {
      method: "GET",
      signal: AbortSignal.timeout(3000),
    });
    return { managed: true, reachable: res.ok };
  } catch {
    return { managed: true, reachable: false };
  }
}

/** Whether a bring-your-own certificate + key are stored. */
export async function hasCustomCert(): Promise<boolean> {
  const [cert, key] = await Promise.all([getSetting(CERT_KEY), getSetting(KEY_KEY)]);
  return !!(cert && cert.includes("BEGIN") && key && key.includes("BEGIN"));
}

/** Persist a pasted certificate + private key (PEM). Both must look like PEM. */
export async function storeCustomCert(cert: string, key: string): Promise<void> {
  const c = cert.trim();
  const k = key.trim();
  if (!c.includes("BEGIN CERTIFICATE")) throw new Error("Certificate is not valid PEM.");
  if (!k.includes("BEGIN")) throw new Error("Private key is not valid PEM.");
  await setSetting(CERT_KEY, c);
  await setSetting(KEY_KEY, k);
}

// Build a Caddyfile from the saved settings. Every config keeps the admin API
// listening on the Docker network so we never lock ourselves out on reload.
function buildCaddyfile(domain: string, mode: TlsMode, email: string): string {
  const globals = "{\n\tadmin 0.0.0.0:2019\n}\n\n";

  // No custom domain configured — serve the app over plain HTTP on any host so
  // the site stays reachable (e.g. by IP) until a domain is set.
  if (!domain) {
    return `${globals}:80 {\n\treverse_proxy app:3000\n}\n`;
  }

  const site = mode === "off" ? `http://${domain}` : domain;
  const body = ["\tencode zstd gzip", "\treverse_proxy app:3000"];
  if (mode === "auto") {
    if (email) body.push(`\ttls ${email}`); // else fully automatic
  } else if (mode === "internal") {
    body.push("\ttls internal");
  } else if (mode === "custom") {
    body.push(`\ttls ${CADDY_CERT_PATH}/cert.pem ${CADDY_CERT_PATH}/key.pem`);
  }
  return `${globals}${site} {\n${body.join("\n")}\n}\n`;
}

async function writeCertFiles(cert: string, key: string): Promise<void> {
  await fs.mkdir(CERT_DIR, { recursive: true });
  await fs.writeFile(path.join(CERT_DIR, "cert.pem"), cert.trim() + "\n", { mode: 0o600 });
  await fs.writeFile(path.join(CERT_DIR, "key.pem"), key.trim() + "\n", { mode: 0o600 });
}

export interface ApplyResult {
  ok: boolean;
  error?: string;
}

/**
 * Render the current settings to a Caddyfile and push it to the live proxy.
 * Returns `{ ok: false, error }` (never throws) so callers can surface a
 * friendly message; a persisted setting is still saved even if the push fails.
 */
export async function applyProxyConfig(): Promise<ApplyResult> {
  if (!CADDY_ADMIN) {
    return { ok: false, error: "No managed reverse proxy is attached to this deployment." };
  }

  const s = await getAppSettings();

  if (s.custom_domain && s.tls_mode === "custom") {
    const [cert, key] = await Promise.all([getSetting(CERT_KEY), getSetting(KEY_KEY)]);
    if (!cert || !key) {
      return { ok: false, error: "Custom TLS mode needs a certificate and key — add them first." };
    }
    try {
      await writeCertFiles(cert, key);
    } catch (e: any) {
      return { ok: false, error: `Could not write certificate files: ${e?.message || e}` };
    }
  }

  const caddyfile = buildCaddyfile(s.custom_domain, s.tls_mode, s.tls_email);
  try {
    const res = await fetch(`${CADDY_ADMIN}/load`, {
      method: "POST",
      headers: { "Content-Type": "text/caddyfile" },
      body: caddyfile,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 400);
      return { ok: false, error: `Proxy rejected the configuration (${res.status}). ${text}`.trim() };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: `Could not reach the reverse proxy: ${e?.message || e}` };
  }
}

/**
 * Best-effort re-apply of the saved proxy config at server startup, with a few
 * retries to let Caddy finish booting. No-op when no proxy is attached.
 */
export async function applyProxyConfigOnBoot(): Promise<void> {
  if (!CADDY_ADMIN) return;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await applyProxyConfig();
    if (res.ok) {
      console.log("[proxy] applied saved domain/TLS configuration");
      return;
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 10_000));
    else console.warn("[proxy] could not apply configuration on boot:", res.error);
  }
}
