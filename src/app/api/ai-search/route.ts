import { NextResponse } from "next/server";
import { answerQuestion } from "@/lib/ai";
import { spaceScopeFor } from "@/lib/access";
import { getCurrentUser } from "@/lib/auth";
import { roleAtLeast } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

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

  const includeDrafts = roleAtLeast(user.role, "editor");
  const result = await answerQuestion(question, includeDrafts, await spaceScopeFor(user));
  return NextResponse.json(result);
}
