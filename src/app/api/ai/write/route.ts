import { NextResponse } from "next/server";
import { writeAssist, type WriteAction, type WriteTone } from "@/lib/ai";
import { apiGuard } from "@/lib/api-auth";
import { aiRateLimited } from "@/lib/rate-limit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ACTIONS = new Set<WriteAction>(["draft", "improve", "expand", "shorten", "summarize", "tone"]);
const TONES = new Set<WriteTone>(["professional", "friendly", "concise", "confident"]);

// AI writing helpers for the document editor. Same gate as proofreading:
// available to anyone who can edit documents.
export async function POST(req: Request) {
  const gate = await apiGuard("editor");
  if (gate instanceof NextResponse) return gate;
  if (aiRateLimited(`write:${(gate as SessionUser).id}`)) {
    return NextResponse.json({ error: "Too many requests — slow down a moment." }, { status: 429 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const action = String(body?.action || "");
  if (!ACTIONS.has(action as WriteAction)) {
    return NextResponse.json({ error: "Unknown writing action." }, { status: 400 });
  }
  const tone = TONES.has(body?.tone) ? (body.tone as WriteTone) : undefined;

  return NextResponse.json(
    await writeAssist({
      action: action as WriteAction,
      tone,
      title: typeof body?.title === "string" ? body.title : "",
      docType: typeof body?.docType === "string" ? body.docType : "",
      content: typeof body?.content === "string" ? body.content : "",
    })
  );
}
