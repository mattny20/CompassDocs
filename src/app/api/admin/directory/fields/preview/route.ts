import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { previewMapping } from "@/lib/directory";
import { parseMapping } from "@/lib/directory-mapping";

export const dynamic = "force-dynamic";

/**
 * Run a candidate mapping over the stored provider records — nothing is
 * written. This is what makes a mapping safe to save: the admin sees "fills
 * 84 of 96" and the actual values before anything changes.
 */
export async function POST(req: Request) {
  const gate = await apiGuard("admin", "directory.field_manage");
  if (gate instanceof NextResponse) return gate;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const provider = body?.provider === "google" ? "google" : "microsoft";
  const mapping = parseMapping(body?.mapping);
  if (!mapping) return NextResponse.json({ error: "That mapping isn't valid." }, { status: 400 });
  return NextResponse.json({ provider, preview: await previewMapping(provider, mapping) });
}
