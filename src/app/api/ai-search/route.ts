import { NextResponse } from "next/server";
import { answerQuestion } from "@/lib/ai";
import { recordSearch } from "@/lib/analytics";
import { canSeeDrafts, spaceScopeFor } from "@/lib/access";
import { crossOriginRejection } from "@/lib/api-auth";
import { getCurrentUser } from "@/lib/auth";
import { aiRateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const xo = await crossOriginRejection();
  if (xo) return xo;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  if (aiRateLimited(`ai-search:${user.id}`)) {
    return NextResponse.json({ error: "Too many requests — slow down a moment." }, { status: 429 });
  }

  let question = "";
  try {
    const body = await req.json();
    question = String(body?.question ?? "").trim();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (!question) {
    return NextResponse.json({ error: "Question is required." }, { status: 400 });
  }

  const includeDrafts = await canSeeDrafts(user);
  const result = await answerQuestion(question, includeDrafts, await spaceScopeFor(user));
  void recordSearch(user.id, question, result.sources.length, "ask").catch(() => {});
  return NextResponse.json(result);
}
