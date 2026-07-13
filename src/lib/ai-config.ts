// Resolution and storage of AI credentials/model. The Anthropic API key can be
// set from the admin GUI (stored in the settings table) or via the
// ANTHROPIC_API_KEY environment variable; the GUI value takes precedence. The
// key is a secret — it is never returned to the client, only whether one is set
// and where it came from.
//
// Server-only: imports the Postgres data layer. Never import from a client
// component.

import Anthropic from "@anthropic-ai/sdk";
import { getSetting, setSetting } from "./db";

const KEY_SETTING = "anthropic_api_key";
const MODEL_SETTING = "ai_model";

export const DEFAULT_AI_MODEL = process.env.COMPASSDOCS_AI_MODEL || "claude-opus-4-8";

// Models offered in the settings dropdown. Admins can still store any id via the
// COMPASSDOCS_AI_MODEL env var; an unknown stored value is preserved and shown.
export const AI_MODELS: { value: string; label: string }[] = [
  { value: "claude-opus-4-8", label: "Claude Opus 4.8 — most capable" },
  { value: "claude-sonnet-5", label: "Claude Sonnet 5 — balanced" },
  { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 — fastest" },
];

export type AiKeySource = "settings" | "env" | "none";

async function storedKey(): Promise<string> {
  return (await getSetting(KEY_SETTING))?.trim() || "";
}

/** The effective API key: the GUI-stored one, else the environment variable. */
export async function getAnthropicKey(): Promise<string | undefined> {
  return (await storedKey()) || process.env.ANTHROPIC_API_KEY || undefined;
}

/** Where the effective key comes from (for showing status in the GUI). */
export async function getAiKeySource(): Promise<AiKeySource> {
  if (await storedKey()) return "settings";
  if (process.env.ANTHROPIC_API_KEY) return "env";
  return "none";
}

export async function setAnthropicKey(key: string): Promise<void> {
  await setSetting(KEY_SETTING, key.trim());
}

/** Remove the GUI-stored key (falls back to the env var, if any). */
export async function clearAnthropicKey(): Promise<void> {
  await setSetting(KEY_SETTING, "");
}

/** The model id to use for AI requests. */
export async function getAiModel(): Promise<string> {
  return (await getSetting(MODEL_SETTING))?.trim() || DEFAULT_AI_MODEL;
}

export async function setAiModel(model: string): Promise<void> {
  await setSetting(MODEL_SETTING, model.trim());
}

/**
 * Verify a key works by making a minimal (1-token) request. Returns a friendly
 * error rather than throwing, so the GUI can reject an invalid key on save.
 */
export async function validateAnthropicKey(
  key: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = new Anthropic({ apiKey: key });
    await client.messages.create({
      model: await getAiModel(),
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    });
    return { ok: true };
  } catch (e: any) {
    const status = e?.status;
    if (status === 401) return { ok: false, error: "That key was rejected (401 unauthorized)." };
    if (status === 404)
      return { ok: false, error: "The key is valid but the selected model isn't available to it." };
    return { ok: false, error: e?.message ? `Key test failed: ${e.message}` : "Key test failed." };
  }
}
