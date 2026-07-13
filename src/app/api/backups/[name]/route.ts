import { NextResponse } from "next/server";
import { Readable } from "stream";
import { apiGuard } from "@/lib/api-auth";
import { audit, actorFrom } from "@/lib/audit";
import { backupReadStream, deleteBackup, isValidBackupName } from "@/lib/backup";

export const dynamic = "force-dynamic";

// Download a backup file.
export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  const { name } = await params;
  if (!isValidBackupName(name)) {
    return NextResponse.json({ error: "Invalid backup." }, { status: 400 });
  }
  const stream = backupReadStream(name);
  if (!stream) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}

// Delete a backup (local + best-effort remote).
export async function DELETE(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  const { name } = await params;
  const ok = await deleteBackup(name);
  if (!ok) return NextResponse.json({ error: "Not found." }, { status: 404 });
  await audit({ actor: actorFrom(gate), action: "backup.delete", targetType: "backup", targetLabel: name });
  return NextResponse.json({ ok: true });
}
