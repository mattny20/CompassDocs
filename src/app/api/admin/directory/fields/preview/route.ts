import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { previewMapping, recordProperties } from "@/lib/directory";
import { parseMapping } from "@/lib/directory-mapping";

export const dynamic = "force-dynamic";

/**
 * What the stored records actually contain — property paths with how many
 * records fill them and a sample — so the mapping editor offers what a
 * tenant has rather than what Graph documents.
 */
export async function GET(req: Request) {
  const gate = await apiGuard("admin", "directory.field_manage");
  if (gate instanceof NextResponse) return gate;
  const provider = new URL(req.url).searchParams.get("provider") === "google" ? "google" : "microsoft";
  return NextResponse.json({ provider, properties: await recordProperties(provider) });
}

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
