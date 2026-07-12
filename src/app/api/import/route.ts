import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { importFromZip } from "@/lib/transfer";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

const MAX_BYTES = 50 * 1024 * 1024; // 50 MB

// Import documents from an export zip (or any zip of front-matter Markdown).
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
    return NextResponse.json({ error: "File is too large (max 50 MB)." }, { status: 413 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  try {
    const result = await importFromZip(buf, user.name || user.username);
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json(
      { error: `Could not read the zip: ${e?.message || "invalid archive"}` },
      { status: 400 }
    );
  }
}
