import { NextResponse } from "next/server";
import {
  getAiKeySource,
  getAiModel,
  setAnthropicKey,
  clearAnthropicKey,
  setAiModel,
  validateAnthropicKey,
  DEFAULT_AI_MODEL,
} from "@/lib/ai-config";
import { apiGuard } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

async function state() {
  const source = await getAiKeySource();
  return {
    source, // "settings" | "env" | "none"
    has_key: source !== "none",
    model: await getAiModel(),
    default_model: DEFAULT_AI_MODEL,
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
  }

  // Remove a stored key.
  if (body?.clear === true) {
    await clearAnthropicKey();
    return NextResponse.json({ ok: true, state: await state() });
  }

  // Set a new key — validate it against the API before saving so a bad paste
  // is rejected with a clear message instead of silently failing later.
  const apiKey = typeof body?.api_key === "string" ? body.api_key.trim() : "";
  if (apiKey) {
    const check = await validateAnthropicKey(apiKey);
    if (!check.ok) {
      return NextResponse.json({ error: check.error || "Key validation failed." }, { status: 400 });
    }
    await setAnthropicKey(apiKey);
  }

  return NextResponse.json({ ok: true, state: await state() });
}
