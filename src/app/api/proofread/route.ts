import { NextResponse } from "next/server";
import { proofread } from "@/lib/ai";
import { apiGuard } from "@/lib/api-auth";
import { aiRateLimited } from "@/lib/rate-limit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  // Only people who can edit documents can invoke the proofreader.
  const gate = await apiGuard("editor", "ai.proofread");
  if (gate instanceof NextResponse) return gate;
  if (aiRateLimited(`proofread:${(gate as SessionUser).id}`)) {
    return NextResponse.json({ error: "Too many requests — slow down a moment." }, { status: 429 });
  }

  let content = "";
  try {
    content = String((await req.json())?.content ?? "");
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  return NextResponse.json(await proofread(content));
}
