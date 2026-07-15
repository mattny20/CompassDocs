// Thin nodemailer wrapper over the stored SMTP settings. Server-only.

import "server-only";
import nodemailer from "nodemailer";
import { getSmtpConfig, smtpConfigured } from "./smtp-config";

/** Send one email to a list of recipients. Throws with a useful message. */
export async function sendMail(
  to: string[],
  subject: string,
  text: string,
  html?: string
): Promise<void> {
  const cfg = await getSmtpConfig();
  if (!smtpConfigured(cfg)) {
    throw new Error("SMTP isn't configured — set the server details under Settings → Notifications.");
  }
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure === "tls",
    ignoreTLS: cfg.secure === "none",
    requireTLS: cfg.secure === "starttls",
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    connectionTimeout: 8000,
    socketTimeout: 10000,
  });
  await transport.sendMail({ from: cfg.from, to: to.join(", "), subject, text, html });
}
