// SMTP configuration for outgoing email alerts. Same pattern as the other
// config stores: settings-table keys, password write-only. Server-only.

import "server-only";
import { getSetting, setSetting } from "./db";

const KEYS = {
  host: "smtp_host",
  port: "smtp_port",
  secure: "smtp_secure", // "tls" (implicit TLS), "starttls", "none"
  user: "smtp_user",
  pass: "smtp_pass",
  from: "smtp_from",
} as const;

export interface SmtpConfig {
  host: string;
  port: number;
  secure: "tls" | "starttls" | "none";
  user: string;
  pass: string; // never sent to the client
  from: string;
}

export function smtpConfigured(cfg: SmtpConfig): boolean {
  return Boolean(cfg.host && cfg.port && cfg.from);
}

export async function getSmtpConfig(): Promise<SmtpConfig> {
  const [host, port, secure, user, pass, from] = await Promise.all([
    getSetting(KEYS.host),
    getSetting(KEYS.port),
    getSetting(KEYS.secure),
    getSetting(KEYS.user),
    getSetting(KEYS.pass),
    getSetting(KEYS.from),
  ]);
  return {
    host: host?.trim() || "",
    port: Number(port) || 587,
    secure: secure === "tls" || secure === "none" ? secure : "starttls",
    user: user?.trim() || "",
    pass: pass || "",
    from: from?.trim() || "",
  };
}

export async function updateSmtpConfig(patch: {
  host?: string;
  port?: number;
  secure?: string;
  user?: string;
  pass?: string;
  from?: string;
}): Promise<void> {
  const jobs: Promise<void>[] = [];
  if (patch.host !== undefined) jobs.push(setSetting(KEYS.host, patch.host.trim()));
  if (patch.port !== undefined) jobs.push(setSetting(KEYS.port, String(patch.port)));
  if (patch.secure !== undefined && ["tls", "starttls", "none"].includes(patch.secure))
    jobs.push(setSetting(KEYS.secure, patch.secure));
  if (patch.user !== undefined) jobs.push(setSetting(KEYS.user, patch.user.trim()));
  if (patch.pass !== undefined) jobs.push(setSetting(KEYS.pass, patch.pass));
  if (patch.from !== undefined) jobs.push(setSetting(KEYS.from, patch.from.trim()));
  await Promise.all(jobs);
}
