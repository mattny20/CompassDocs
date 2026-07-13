import { NextResponse } from "next/server";
import { proofread } from "@/lib/ai";
import { apiGuard } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  // Only people who can edit documents can invoke the proofreader.
  const gate = await apiGuard("editor");
  if (gate instanceof NextResponse) return gate;

  let content = "";
  try {
    content = String((await req.json())?.content ?? "");
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  return NextResponse.json(await proofread(content));
}
