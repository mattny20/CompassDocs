// On-demand self-diagnostics for the admin System page: is each subsystem
// healthy, degraded, or unconfigured? Every check is defensive — a failing
// subsystem yields a "fail" result, never an exception. Server-only.

import "server-only";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { pool } from "./db";
import { uploadDir } from "./uploads";
import { getSmtpConfig, smtpConfigured } from "./smtp-config";
import { aiAvailable, getAiProvider } from "./ai-config";
import { getEmbeddingsConfig, vectorAvailable } from "./embeddings";
import { licenseState } from "./license";

export type CheckStatus = "pass" | "warn" | "fail";

export interface DiagnosticCheck {
  key: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

async function checkDatabase(): Promise<DiagnosticCheck> {
  const started = Date.now();
  try {
    await pool().query("SELECT 1");
    const ms = Date.now() - started;
    return {
      key: "database",
      label: "Database",
      status: ms > 250 ? "warn" : "pass",
      detail: `Reachable, ${ms} ms round-trip.${ms > 250 ? " Slow — check network or load." : ""}`,
    };
  } catch (e) {
    return {
      key: "database",
      label: "Database",
      status: "fail",
      detail: e instanceof Error ? e.message : "Unreachable.",
    };
  }
}

async function checkUploads(): Promise<DiagnosticCheck> {
  const dir = uploadDir();
  const probe = join(dir, `.diag-${process.pid}-${Date.now()}`);
  try {
    await writeFile(probe, "ok");
    await unlink(probe);
    return { key: "uploads", label: "Upload storage", status: "pass", detail: `Writable at ${dir}.` };
  } catch (e) {
    return {
      key: "uploads",
      label: "Upload storage",
      status: "fail",
      detail: `Cannot write to ${dir}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

async function checkSmtp(): Promise<DiagnosticCheck> {
  try {
    const cfg = await getSmtpConfig();
    if (!smtpConfigured(cfg)) {
      return {
        key: "smtp",
        label: "Email (SMTP)",
        status: "warn",
        detail: "Not configured — subscriptions, reminders, and newsletters can't send.",
      };
    }
    return {
      key: "smtp",
      label: "Email (SMTP)",
      status: "pass",
      detail: `Configured for ${cfg.host}:${cfg.port}.`,
    };
  } catch (e) {
    return {
      key: "smtp",
      label: "Email (SMTP)",
      status: "fail",
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

async function checkAi(): Promise<DiagnosticCheck> {
  try {
    const [ok, provider] = await Promise.all([aiAvailable(), getAiProvider()]);
    return ok
      ? { key: "ai", label: "AI assistant", status: "pass", detail: `Ready (${provider}).` }
      : {
          key: "ai",
          label: "AI assistant",
          status: "warn",
          detail: "Not configured — Ask, proofreading, and writing help are off.",
        };
  } catch (e) {
    return { key: "ai", label: "AI assistant", status: "fail", detail: e instanceof Error ? e.message : String(e) };
  }
}

async function checkSemantic(): Promise<DiagnosticCheck> {
  try {
    const cfg = await getEmbeddingsConfig();
    if (cfg.provider === "off") {
      return {
        key: "semantic",
        label: "Semantic search",
        status: "warn",
        detail: "Disabled — search is keyword-only.",
      };
    }
    const vector = await vectorAvailable();
    return vector
      ? { key: "semantic", label: "Semantic search", status: "pass", detail: "Enabled, pgvector available." }
      : {
          key: "semantic",
          label: "Semantic search",
          status: "fail",
          detail: "Enabled but the pgvector extension is unavailable in this database.",
        };
  } catch (e) {
    return {
      key: "semantic",
      label: "Semantic search",
      status: "fail",
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

async function checkLicense(): Promise<DiagnosticCheck> {
  try {
    const s = await licenseState();
    switch (s.status) {
      case "active":
        return {
          key: "license",
          label: "License",
          status: "pass",
          detail: `${s.license.plan} — ${s.daysLeft} days remaining.`,
        };
      case "grace":
        return {
          key: "license",
          label: "License",
          status: "warn",
          detail: `Expired — in grace period, ${s.daysLeft} days left to renew.`,
        };
      case "expired":
        return { key: "license", label: "License", status: "warn", detail: "Expired — enterprise features are off." };
      case "invalid":
        return { key: "license", label: "License", status: "fail", detail: `Invalid: ${s.reason}` };
      default:
        return { key: "license", label: "License", status: "pass", detail: "Community edition (no license needed)." };
    }
  } catch (e) {
    return { key: "license", label: "License", status: "fail", detail: e instanceof Error ? e.message : String(e) };
  }
}

function checkMetrics(): DiagnosticCheck {
  const token = process.env.COMPASSDOCS_METRICS_TOKEN?.trim();
  return {
    key: "metrics",
    label: "Metrics endpoint",
    status: "pass",
    detail: token
      ? "/metrics is scrapeable with the configured bearer token."
      : "/metrics is admin-session-only (set COMPASSDOCS_METRICS_TOKEN to allow a Prometheus scraper).",
  };
}

/** The Claude/MCP connector is only as healthy as the OAuth endpoints the
 * discovery document advertises — and a bad advertisement (plain-http issuer,
 * stale custom domain, proxy that forgot X-Forwarded-Proto) is invisible from
 * inside the app: everything works in the browser while every OAuth client
 * gets "unable to connect". This check surfaces exactly what we advertise
 * and probes it from the server. */
async function checkMcpConnector(req: Request): Promise<DiagnosticCheck> {
  const key = "mcp";
  const label = "Claude connector (MCP)";
  try {
    const { publicOrigin, requestOrigin } = await import("./oauth");
    const { getAppSettings } = await import("./settings-store");
    const customDomain = (await getAppSettings()).custom_domain?.trim() ?? "";
    const issuer = await publicOrigin(req);
    const fromRequest = requestOrigin(req);
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(issuer);
    const problems: string[] = [];
    let status: CheckStatus = "pass";

    if (issuer.startsWith("http://") && !isLocal) {
      status = "fail";
      problems.push(
        customDomain
          ? "The custom domain resolves to a plain-http issuer — that shouldn't happen; re-save Settings → Domain & HTTPS."
          : "Endpoints are advertised as plain http:// — OAuth clients refuse them. Set the custom domain under Settings → Domain & HTTPS, or make the reverse proxy forward X-Forwarded-Proto: https."
      );
    }

    if (customDomain) {
      let reqHost = "";
      try {
        reqHost = new URL(fromRequest).host;
      } catch {}
      if (reqHost && reqHost !== customDomain && !/^(localhost|127\.0\.0\.1)(:|$)/.test(reqHost)) {
        if (status === "pass") status = "warn";
        problems.push(
          `You're browsing on ${reqHost} but the connector advertises ${customDomain} — if that domain is stale, Claude can't reach the sign-in service. Update Settings → Domain & HTTPS.`
        );
      }
    } else if (!isLocal && !req.headers.get("x-forwarded-proto")) {
      if (status === "pass") status = "warn";
      problems.push(
        "No custom domain is set and the proxy isn't sending X-Forwarded-Proto, so advertised URLs depend on request headers. Setting the custom domain makes the connector immune to proxy misconfiguration."
      );
    }

    // Probe the advertised discovery URL from the server. Reachability from
    // here isn't proof Claude can reach it — but unreachable from here (DNS,
    // TLS, wrong host) almost always means unreachable from everywhere.
    if (!isLocal && issuer.startsWith("https://")) {
      try {
        const { safeFetch } = await import("./safe-fetch");
        const res = await safeFetch(`${issuer}/.well-known/oauth-authorization-server`, {
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) {
          status = "fail";
          problems.push(
            `The advertised discovery URL returned HTTP ${res.status} — the sign-in service isn't being served at ${issuer}.`
          );
        } else {
          const body = (await res.json().catch(() => null)) as { issuer?: string } | null;
          if (body?.issuer && body.issuer !== issuer) {
            if (status === "pass") status = "warn";
            problems.push(
              `${issuer} answers, but advertises a different issuer (${body.issuer}) — two installs or a proxy rewrite?`
            );
          }
        }
      } catch (e) {
        status = "fail";
        problems.push(
          `Couldn't reach the advertised discovery URL from the server (${
            e instanceof Error ? e.message : String(e)
          }) — check DNS and the TLS certificate for ${issuer}.`
        );
      }
    }

    const summary = `Sign-in advertised at ${issuer}/oauth/authorize${
      customDomain ? " (from the custom domain setting)" : " (derived from request headers)"
    }.`;
    return {
      key,
      label,
      status,
      detail: problems.length ? `${summary} ${problems.join(" ")}` : `${summary} Discovery, authorize, and token endpoints all line up.`,
    };
  } catch (e) {
    return { key, label, status: "fail", detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Run every check in parallel. Never throws. */
/** Outbound HTTPS: can this server reach vendor status pages (and webhooks,
 * AI providers, …)? Locked-down VMs — Azure NSGs, forced proxies — fail here
 * while everything inbound works, which is otherwise invisible. */
async function checkOutboundHttps(): Promise<DiagnosticCheck> {
  const proxy = (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    ""
  ).trim();
  const via = proxy ? " via the configured proxy (HTTPS_PROXY)" : "";
  const started = Date.now();
  try {
    const { safeFetch } = await import("./safe-fetch");
    const res = await safeFetch("https://www.githubstatus.com/api/v2/status.json", {
      signal: AbortSignal.timeout(8_000),
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await res.json();
    return {
      key: "outbound",
      label: "Outbound HTTPS (status polls, webhooks, AI)",
      status: "pass",
      detail: `Vendor status pages reachable${via}, ${Date.now() - started} ms.`,
    };
  } catch (e) {
    // "fetch failed" hides the real reason (DNS, tunnel refused, TLS) in the
    // cause chain — walk it so the admin sees something actionable.
    const parts: string[] = [];
    for (let err: unknown = e; err instanceof Error && parts.length < 4; err = err.cause) {
      if (err.message && err.message !== parts[parts.length - 1]) parts.push(err.message);
    }
    const msg = parts.join(" — ") || String(e);
    return {
      key: "outbound",
      label: "Outbound HTTPS (status polls, webhooks, AI)",
      status: "fail",
      detail:
        `Could not reach a public status page${via}: ${msg}. ` +
        (proxy
          ? "Check the proxy address and that it allows this destination."
          : "If this network blocks direct egress, allow outbound 443 — or set HTTPS_PROXY (and NO_PROXY) on the container; CompassDocs routes its outbound requests through it."),
    };
  }
}

export async function runDiagnostics(req?: Request): Promise<DiagnosticCheck[]> {
  return Promise.all([
    checkDatabase(),
    checkUploads(),
    checkSmtp(),
    checkAi(),
    checkSemantic(),
    checkLicense(),
    Promise.resolve(checkMetrics()),
    checkOutboundHttps(),
    ...(req ? [checkMcpConnector(req)] : []),
  ]);
}
