import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { importFromZip } from "@/lib/transfer";
import { requestOrigin } from "@/lib/oauth";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

const MAX_BYTES = 50 * 1024 * 1024; // 50 MB

// Import documents from an export zip (or any zip of front-matter Markdown).
//
// Multipart fields: `file` (the zip) and, from 1.11.0 (H2), the optional
// `overwrite_policies` ('1' to also overwrite published documents that
// require read confirmation; anything else, or absent, leaves them unchanged
// and lists them in the result). The answer is the ImportResult, with
// `reconfirm_requested` (policies whose readers will be asked again) and
// `policies_skipped`.
export async function POST(req: Request) {
  const gate = await apiGuard("admin", "system.import");
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

  const overwritePolicies = form.get("overwrite_policies") === "1";

  const buf = Buffer.from(await file.arrayBuffer());
  try {
    const result = await importFromZip(
      buf,
      { id: user.id, name: user.name || user.username },
      { overwritePolicies, origin: requestOrigin(req) }
    );
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json(
      { error: `Could not read the zip: ${e?.message || "invalid archive"}` },
      { status: 400 }
    );
  }
}
