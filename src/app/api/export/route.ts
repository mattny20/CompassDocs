import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { buildExportZip } from "@/lib/transfer";

export const dynamic = "force-dynamic";

// Download the whole knowledge base as a zip of front-matter Markdown files.
export async function GET() {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  const buf = await buildExportZip();
  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="compassdocs-export-${date}.zip"`,
      "Cache-Control": "no-store",
    },
  });
}
