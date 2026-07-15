import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { getPublicSiteConfig, setPublicSiteConfig } from "@/lib/public-site";
import { listPublicSpaces } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  const [config, spaces] = await Promise.all([getPublicSiteConfig(), listPublicSpaces()]);
  return NextResponse.json({ config, publicSpaces: spaces.map((s) => ({ id: s.id, name: s.name, slug: s.slug, doc_count: s.doc_count })) });
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

  const patch: { enabled?: boolean; indexing?: boolean } = {};
  if (typeof body?.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body?.indexing === "boolean") patch.indexing = body.indexing;
  await setPublicSiteConfig(patch);

  await audit({
    actor: actorFrom(gate),
    action: "settings.public_site",
    details: patch,
    ip: ipFrom(req),
  });
  return NextResponse.json({ config: await getPublicSiteConfig() });
}
