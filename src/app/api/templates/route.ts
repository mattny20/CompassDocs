import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { listTemplates } from "@/lib/doc-templates";

export const dynamic = "force-dynamic";

// Visible templates for pickers (editors and up — the people who create docs).
export async function GET() {
  const gate = await apiGuard("editor");
  if (gate instanceof NextResponse) return gate;
  const templates = await listTemplates(false);
  return NextResponse.json({
    templates: templates.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      doc_type: t.doc_type,
      builtin: Boolean(t.builtin_key),
    })),
  });
}
