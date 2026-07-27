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

/** Run every check in parallel. Never throws. */
export async function runDiagnostics(): Promise<DiagnosticCheck[]> {
  return Promise.all([
    checkDatabase(),
    checkUploads(),
    checkSmtp(),
    checkAi(),
    checkSemantic(),
    checkLicense(),
    Promise.resolve(checkMetrics()),
  ]);
}
