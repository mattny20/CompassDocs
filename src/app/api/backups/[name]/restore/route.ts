import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { restoreBackup, isValidBackupName } from "@/lib/backup";

export const dynamic = "force-dynamic";

// Restore the database from a backup. DESTRUCTIVE — replaces all data.
export async function POST(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  const { name } = await params;
  if (!isValidBackupName(name)) {
    return NextResponse.json({ error: "Invalid backup." }, { status: 400 });
  }
  try {
    await restoreBackup(name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json(
      { error: `Restore failed: ${e?.message || "pg_restore error"}` },
      { status: 500 }
    );
  }
}
