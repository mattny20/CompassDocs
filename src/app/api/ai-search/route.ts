import { NextResponse } from "next/server";
import { answerQuestion } from "@/lib/ai";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
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
  const result = await answerQuestion(question);
  return NextResponse.json(result);
}
