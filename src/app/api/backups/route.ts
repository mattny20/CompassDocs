import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { audit, actorFrom } from "@/lib/audit";
import { listBackups, createBackup, pruneBackups } from "@/lib/backup";
import { destinationStatus } from "@/lib/backup-destinations";
import { getAppSettings } from "@/lib/settings-store";

export const dynamic = "force-dynamic";

// List backups + which destinations are configured.
export async function GET() {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({
    backups: await listBackups(),
    destinations: await destinationStatus(),
  });
}

// Create a backup now (and prune to the retention count).
export async function POST() {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  try {
    const result = await createBackup();
    const { backup_keep } = await getAppSettings();
    await pruneBackups(backup_keep);
    await audit({
      actor: actorFrom(gate),
      action: "backup.create",
      targetType: "backup",
      targetLabel: (result as any)?.name,
    });
    return NextResponse.json({ ok: true, backup: result });
  } catch (e: any) {
    return NextResponse.json(
      { error: `Backup failed: ${e?.message || "pg_dump error"}` },
      { status: 500 }
    );
  }
}
