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
import { safeFetch } from "./safe-fetch";

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

// --- Provider abstraction ----------------------------------------------------
//
// Ask, writing assist, and proofreading all speak through chatComplete(),
// which dispatches to the configured provider:
//   - "anthropic" (default): the Anthropic Messages API, as always.
//   - "openai": any OpenAI-compatible /v1/chat/completions endpoint — OpenAI
//     itself, an Azure gateway, or a local engine (Ollama, LM Studio, vLLM)
//     via a custom base URL. The API key is optional for local engines.
// Mirrors the provider pattern semantic search already uses (embeddings.ts).

export type AiProvider = "anthropic" | "openai";

const PROVIDER_SETTING = "ai_provider";
const OPENAI_URL_SETTING = "ai_openai_base_url";
const OPENAI_KEY_SETTING = "ai_openai_api_key"; // sealed (SENSITIVE_SETTINGS)
const OPENAI_MODEL_SETTING = "ai_openai_model";

export const OPENAI_DEFAULT_URL = "https://api.openai.com/v1/chat/completions";

export interface AiProviderConfig {
  provider: AiProvider;
  /** OpenAI-compatible endpoint (full URL to /v1/chat/completions). */
  openaiBaseUrl: string;
  openaiKeySet: boolean;
  openaiModel: string;
}

export async function getAiProvider(): Promise<AiProvider> {
  return (await getSetting(PROVIDER_SETTING)) === "openai" ? "openai" : "anthropic";
}

/** The stored OpenAI-compatible key (server-side only — for calls/validation). */
export async function getOpenAiKey(): Promise<string> {
  return (await getSetting(OPENAI_KEY_SETTING))?.trim() || "";
}

export async function getAiProviderConfig(): Promise<AiProviderConfig> {
  const [provider, url, key, model] = await Promise.all([
    getAiProvider(),
    getSetting(OPENAI_URL_SETTING),
    getSetting(OPENAI_KEY_SETTING),
    getSetting(OPENAI_MODEL_SETTING),
  ]);
  return {
    provider,
    openaiBaseUrl: url?.trim() || OPENAI_DEFAULT_URL,
    openaiKeySet: Boolean(key?.trim()),
    openaiModel: model?.trim() || "",
  };
}

export async function saveAiProviderConfig(patch: {
  provider?: string;
  openaiBaseUrl?: string;
  openaiApiKey?: string; // "" clears
  openaiModel?: string;
}): Promise<void> {
  if (patch.provider !== undefined) {
    await setSetting(PROVIDER_SETTING, patch.provider === "openai" ? "openai" : "anthropic");
  }
  if (patch.openaiBaseUrl !== undefined) await setSetting(OPENAI_URL_SETTING, patch.openaiBaseUrl.trim());
  if (patch.openaiApiKey !== undefined) await setSetting(OPENAI_KEY_SETTING, patch.openaiApiKey.trim());
  if (patch.openaiModel !== undefined) await setSetting(OPENAI_MODEL_SETTING, patch.openaiModel.trim());
}

/** Whether the configured provider is ready to answer. */
export async function aiAvailable(): Promise<boolean> {
  const provider = await getAiProvider();
  if (provider === "anthropic") return Boolean(await getAnthropicKey());
  const cfg = await getAiProviderConfig();
  // Local engines need no key — a base URL and model are enough.
  return Boolean(cfg.openaiBaseUrl && cfg.openaiModel);
}

/**
 * One chat turn through the configured provider. Returns the assistant's
 * text; throws on transport/provider errors (callers degrade gracefully).
 */
export async function chatComplete(input: {
  system: string;
  user: string;
  maxTokens: number;
}): Promise<string> {
  const provider = await getAiProvider();

  if (provider === "anthropic") {
    const apiKey = await getAnthropicKey();
    if (!apiKey) throw new Error("No Anthropic API key configured.");
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: await getAiModel(),
      max_tokens: input.maxTokens,
      system: input.system,
      messages: [{ role: "user", content: input.user }],
    });
    return response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
  }

  // OpenAI-compatible chat completions.
  const cfg = await getAiProviderConfig();
  if (!cfg.openaiModel) throw new Error("No model configured for the OpenAI-compatible provider.");
  const key = (await getSetting(OPENAI_KEY_SETTING))?.trim();
  // safeFetch blocks SSRF targets (loopback, link-local/cloud-metadata,
  // private ranges per policy) and re-checks redirects — the endpoint URL is
  // admin-set but this call fires for lower-privilege users.
  const res = await safeFetch(cfg.openaiBaseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      model: cfg.openaiModel,
      max_tokens: input.maxTokens,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`Chat endpoint returned ${res.status}: ${detail}`);
  }
  const data: any = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error("Chat endpoint returned no message content.");
  return text.trim();
}

/**
 * Verify an OpenAI-compatible endpoint with a tiny request, using the given
 * values (not yet saved). Friendly errors for the GUI.
 */
export async function validateOpenAiEndpoint(input: {
  baseUrl: string;
  apiKey?: string;
  model: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (!/^https?:\/\//.test(input.baseUrl)) {
    return { ok: false, error: "The base URL must start with http:// or https://." };
  }
  if (!input.model.trim()) return { ok: false, error: "A model name is required." };
  try {
    const res = await safeFetch(input.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: input.model.trim(),
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401) return { ok: false, error: "The endpoint rejected the key (401 unauthorized)." };
    if (res.status === 404)
      return { ok: false, error: "404 from the endpoint — check the URL includes the full path (…/v1/chat/completions) and the model name exists." };
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      return { ok: false, error: `The endpoint returned ${res.status}. ${detail}` };
    }
    const data: any = await res.json().catch(() => null);
    if (typeof data?.choices?.[0]?.message?.content !== "string") {
      return { ok: false, error: "The endpoint responded but not in OpenAI chat-completions format." };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: `Could not reach the endpoint: ${e?.message || "network error"}` };
  }
}
