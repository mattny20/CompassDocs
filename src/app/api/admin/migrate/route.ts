import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { previewExport, migrate, type ImportSource } from "@/lib/importers";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

const MAX_BYTES = 200 * 1024 * 1024; // 200 MB — vendor exports carry attachments.
const SOURCES = new Set(["notion", "confluence"]);

// Migrate a Confluence (HTML) or Notion (Markdown & CSV) export into a space.
// mode=preview inspects the zip; mode=commit imports it.
export async function POST(req: Request) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected a file upload." }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "File is too large (max 200 MB)." }, { status: 413 });
  }

  const mode = String(form.get("mode") || "preview");
  const sourceRaw = String(form.get("source") || "");
  const override = SOURCES.has(sourceRaw) ? (sourceRaw as ImportSource) : undefined;
  const buf = Buffer.from(await file.arrayBuffer());

  try {
    if (mode === "preview") {
      const preview = await previewExport(buf, override);
      return NextResponse.json(preview);
    }

    // Commit.
    const targetSpaceIdRaw = form.get("targetSpaceId");
    const targetSpaceId =
      targetSpaceIdRaw && String(targetSpaceIdRaw) !== ""
        ? Number(targetSpaceIdRaw)
        : undefined;
    if (targetSpaceId !== undefined && !Number.isInteger(targetSpaceId)) {
      return NextResponse.json({ error: "Invalid destination space." }, { status: 400 });
    }
    const newSpaceName = String(form.get("newSpaceName") || "").trim() || undefined;
    const publish = String(form.get("publish") || "") === "true";

    const result = await migrate(
      buf,
      { targetSpaceId, newSpaceName, publish },
      { id: user.id, name: user.name || user.username },
      override
    );

    await audit({
      actor: actorFrom(gate),
      action: "content.migrate",
      targetType: "space",
      targetId: result.spaceId,
      targetLabel: result.spaceName,
      details: {
        source: result.source,
        pages: result.pagesCreated,
        attachments: result.attachmentsCreated,
        spaceCreated: result.spaceCreated,
      },
      ip: ipFrom(req),
    });

    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "The import could not be completed." },
      { status: 400 }
    );
  }
}
