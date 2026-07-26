import { NextResponse } from "next/server";
import {
  getAiKeySource,
  getAiModel,
  setAnthropicKey,
  clearAnthropicKey,
  setAiModel,
  validateAnthropicKey,
  DEFAULT_AI_MODEL,
  getAiProviderConfig,
  saveAiProviderConfig,
  validateOpenAiEndpoint,
  getOpenAiKey,
  OPENAI_DEFAULT_URL,
} from "@/lib/ai-config";
import { apiGuard, credentialSaveError } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

async function state() {
  const [source, providerCfg] = await Promise.all([getAiKeySource(), getAiProviderConfig()]);
  return {
    source, // "settings" | "env" | "none"  (Anthropic key)
    has_key: source !== "none",
    model: await getAiModel(),
    default_model: DEFAULT_AI_MODEL,
    provider: providerCfg.provider, // "anthropic" | "openai"
    openai_base_url: providerCfg.openaiBaseUrl,
    openai_key_set: providerCfg.openaiKeySet,
    openai_model: providerCfg.openaiModel,
    openai_default_url: OPENAI_DEFAULT_URL,
  };
}

export async function GET() {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await state());
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

  // Model first (cheap, no external call).
  if (body?.model !== undefined) {
    await setAiModel(String(body.model).trim());
    await audit({
      actor: actorFrom(gate),
      action: "settings.ai_model",
      details: { model: String(body.model).trim() },
      ip: ipFrom(req),
    });
  }

  // Provider switch and OpenAI-compatible endpoint settings. Saving OpenAI
  // endpoint details validates them with a tiny live request first, so a bad
  // URL/model/key fails loudly now instead of silently at answer time.
  const openaiTouched =
    body?.openai_base_url !== undefined ||
    body?.openai_model !== undefined ||
    typeof body?.openai_api_key === "string";

  if (openaiTouched || body?.provider !== undefined) {
    if (openaiTouched) {
      const current = await getAiProviderConfig();
      const baseUrl =
        (typeof body?.openai_base_url === "string" ? body.openai_base_url.trim() : current.openaiBaseUrl) ||
        OPENAI_DEFAULT_URL;
      const model =
        typeof body?.openai_model === "string" ? body.openai_model.trim() : current.openaiModel;
      // Validate with the new key when one is supplied, else the stored one.
      const newKey = typeof body?.openai_api_key === "string" ? body.openai_api_key.trim() : undefined;
      const effectiveKey = newKey !== undefined ? newKey : await getOpenAiKey();
      if (model) {
        const check = await validateOpenAiEndpoint({
          baseUrl,
          apiKey: effectiveKey || undefined,
          model,
        });
        if (!check.ok) {
          return NextResponse.json(
            { error: check.error || "Endpoint validation failed." },
            { status: 400 }
          );
        }
      }
    }
    const err = await credentialSaveError(() =>
      saveAiProviderConfig({
        provider: body?.provider !== undefined ? String(body.provider) : undefined,
        openaiBaseUrl: body?.openai_base_url !== undefined ? String(body.openai_base_url) : undefined,
        openaiApiKey: typeof body?.openai_api_key === "string" ? body.openai_api_key : undefined,
        openaiModel: body?.openai_model !== undefined ? String(body.openai_model) : undefined,
      })
    );
    if (err) return err;
    await audit({
      actor: actorFrom(gate),
      action: "settings.ai_provider",
      details: {
        fields: ["provider", "openai_base_url", "openai_api_key", "openai_model"].filter(
          (k) => body?.[k] !== undefined
        ),
      },
      ip: ipFrom(req),
    });
  }

  // Remove a stored Anthropic key.
  if (body?.clear === true) {
    await clearAnthropicKey();
    await audit({ actor: actorFrom(gate), action: "settings.ai_key_removed", ip: ipFrom(req) });
    return NextResponse.json({ ok: true, state: await state() });
  }

  // Set a new Anthropic key — validate it against the API before saving so a
  // bad paste is rejected with a clear message instead of silently failing
  // later. The key itself is never recorded in the audit log.
  const apiKey = typeof body?.api_key === "string" ? body.api_key.trim() : "";
  if (apiKey) {
    const check = await validateAnthropicKey(apiKey);
    if (!check.ok) {
      return NextResponse.json({ error: check.error || "Key validation failed." }, { status: 400 });
    }
    const keyErr = await credentialSaveError(() => setAnthropicKey(apiKey));
    if (keyErr) return keyErr;
    await audit({ actor: actorFrom(gate), action: "settings.ai_key_set", ip: ipFrom(req) });
  }

  return NextResponse.json({ ok: true, state: await state() });
}
