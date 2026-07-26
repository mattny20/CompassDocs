// Ask CompassDocs from chat: inbound Slack slash-command and Microsoft Teams
// outgoing-webhook endpoints that answer questions with the same grounded AI
// (or keyword fallback) as in-app Ask.
//
// Access model: chat askers have no CompassDocs session, so answers draw ONLY
// from published documents in non-private spaces (visibility internal/public).
// Private-space content can never leak into a channel.
//
// Both integrations authenticate the platform, not the person: Slack requests
// are verified against the app's signing secret, Teams outgoing webhooks
// against their HMAC security token. Secrets are sealed at rest like every
// other credential (SENSITIVE_SETTINGS).

import "server-only";
import { createHmac, timingSafeEqual } from "crypto";
import { pool, getSetting, setSetting } from "./db";
import { answerQuestion, type AiAnswer } from "./ai";

async function q<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  return (await pool().query(sql, params)).rows as T[];
}

// --- Config ------------------------------------------------------------------

export interface ChatAskConfig {
  slack_enabled: boolean;
  slack_secret_set: boolean;
  teams_enabled: boolean;
  teams_secret_set: boolean;
}

export async function getChatAskConfig(): Promise<ChatAskConfig> {
  const [se, ss, te, ts] = await Promise.all([
    getSetting("chat_slack_enabled"),
    getSetting("chat_slack_signing_secret"),
    getSetting("chat_teams_enabled"),
    getSetting("chat_teams_hmac_secret"),
  ]);
  return {
    slack_enabled: se === "1",
    slack_secret_set: Boolean(ss),
    teams_enabled: te === "1",
    teams_secret_set: Boolean(ts),
  };
}

export async function setChatAskConfig(input: {
  slack_enabled?: boolean;
  slack_signing_secret?: string; // "" clears
  teams_enabled?: boolean;
  teams_hmac_secret?: string; // "" clears
}): Promise<void> {
  if (input.slack_enabled !== undefined)
    await setSetting("chat_slack_enabled", input.slack_enabled ? "1" : "0");
  if (input.slack_signing_secret !== undefined)
    await setSetting("chat_slack_signing_secret", input.slack_signing_secret.trim());
  if (input.teams_enabled !== undefined)
    await setSetting("chat_teams_enabled", input.teams_enabled ? "1" : "0");
  if (input.teams_hmac_secret !== undefined)
    await setSetting("chat_teams_hmac_secret", input.teams_hmac_secret.trim());
}

// --- Verification ------------------------------------------------------------

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Slack request signing: v0=HMAC_SHA256(`v0:{ts}:{raw}`) with the signing secret. */
export async function verifySlackSignature(
  rawBody: string,
  timestamp: string | null,
  signature: string | null
): Promise<boolean> {
  const secret = await getSetting("chat_slack_signing_secret");
  if (!secret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false; // replay window
  const expected =
    "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex");
  return safeEqual(Buffer.from(expected), Buffer.from(signature));
}

/** Teams outgoing webhook: Authorization "HMAC <base64(HMAC_SHA256(raw))>" keyed by the base64 security token. */
export async function verifyTeamsSignature(
  rawBody: Buffer,
  authHeader: string | null
): Promise<boolean> {
  const secret = await getSetting("chat_teams_hmac_secret");
  if (!secret || !authHeader?.startsWith("HMAC ")) return false;
  let key: Buffer;
  try {
    key = Buffer.from(secret, "base64");
  } catch {
    return false;
  }
  if (key.length === 0) return false;
  const expected = createHmac("sha256", key).update(rawBody).digest("base64");
  return safeEqual(Buffer.from(expected), Buffer.from(authHeader.slice(5).trim()));
}

// --- Answering ---------------------------------------------------------------

/** Space ids a chat asker may draw answers from: everything not private. */
export async function chatSpaceScope(): Promise<number[]> {
  const rows = await q<{ id: number }>(
    "SELECT id FROM spaces WHERE visibility IN ('internal', 'public')"
  );
  return rows.map((r) => r.id);
}

export async function chatAnswer(question: string): Promise<AiAnswer> {
  const scope = await chatSpaceScope();
  // An instance where every space is private has nothing to offer chat.
  if (scope.length === 0) {
    return {
      answer: "All spaces on this knowledge base are private, so I can't answer from chat.",
      sources: [],
      people: [],
      mode: "fallback",
    };
  }
  return answerQuestion(question, false, scope);
}

/** Absolute base URL for doc links in chat, from the configured domain. */
export async function chatBaseUrl(req: Request): Promise<string> {
  const { publicOrigin } = await import("./oauth");
  return publicOrigin(req);
}

/** Render an answer for Slack (mrkdwn) with source links. */
export function formatSlack(a: AiAnswer, base: string): string {
  // Slack mrkdwn: *bold*, <url|text>. Convert the answer's markdown citations
  // [Doc N] as-is (they're plain text) and append linked sources.
  let text = a.answer
    .replace(/\*\*([^*]+)\*\*/g, "*$1*") // markdown bold → mrkdwn bold
    .replace(/^#{1,6}\s+/gm, "*")
    .slice(0, 2900);
  if (a.sources.length > 0) {
    const links = a.sources
      .slice(0, 6)
      .map((s, i) => `<${base}/doc/${s.id}|[Doc ${i + 1}] ${s.title.replace(/[<>|]/g, "")}>`)
      .join("\n");
    text += `\n\n*Sources*\n${links}`;
  }
  return text;
}

/** Render an answer for Teams (simple markdown works in outgoing-webhook replies). */
export function formatTeams(a: AiAnswer, base: string): string {
  let text = a.answer.slice(0, 2900);
  if (a.sources.length > 0) {
    const links = a.sources
      .slice(0, 6)
      .map((s, i) => `[[Doc ${i + 1}] ${s.title.replace(/[[\]]/g, "")}](${base}/doc/${s.id})`)
      .join("  \n");
    text += `\n\n**Sources**  \n${links}`;
  }
  return text;
}
