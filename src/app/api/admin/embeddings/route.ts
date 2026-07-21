import { NextResponse } from "next/server";
import { apiGuard, credentialSaveError } from "@/lib/api-auth";
import {
  embeddingsStatus,
  getEmbeddingsConfig,
  saveEmbeddingsConfig,
  reindexAll,
  testEmbeddings,
  PROVIDER_DEFAULTS,
} from "@/lib/embeddings";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Semantic-search configuration (Settings → AI). The API key is write-only.

export async function GET() {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({
    ...(await embeddingsStatus()),
    defaults: PROVIDER_DEFAULTS,
  });
}

export async function PATCH(req: Request) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  // Kick a full rebuild (runs in the background; GET reports progress).
  if (body?.action === "reindex") {
    const cfg = await getEmbeddingsConfig();
    if (cfg.provider === "off" || !cfg.apiKey) {
      return NextResponse.json({ error: "Configure a provider and API key first." }, { status: 400 });
    }
    void reindexAll(true);
    await audit({
      actor: actorFrom(user),
      action: "settings.semantic_reindex",
      ip: ipFrom(req),
    });
    return NextResponse.json({ ok: true, started: true });
  }

  const keyErr = await credentialSaveError(() => saveEmbeddingsConfig({
    ...(body?.provider !== undefined ? { provider: String(body.provider) } : {}),
    ...(typeof body?.api_key === "string" && body.api_key !== "" ? { apiKey: body.api_key } : {}),
    ...(body?.clear_key === true ? { apiKey: "" } : {}),
    ...(body?.model !== undefined ? { model: String(body.model) } : {}),
    ...(body?.base_url !== undefined ? { baseUrl: String(body.base_url) } : {}),
  }));
  if (keyErr) return keyErr;

  // Optional round-trip test with the SAVED configuration.
  let test: { ok: boolean; dims?: number; error?: string } | undefined;
  if (body?.action === "test") test = await testEmbeddings();

  await audit({
    actor: actorFrom(user),
    action: "settings.semantic_search",
    details: { key_changed: Boolean(body?.api_key) || body?.clear_key === true },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true, state: await embeddingsStatus(), test });
}
