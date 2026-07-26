import { NextResponse } from "next/server";
import {
  getChatAskConfig,
  verifyTeamsSignature,
  chatAnswer,
  chatBaseUrl,
  formatTeams,
} from "@/lib/chat-ask";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Microsoft Teams outgoing webhook (@mention the webhook in a channel).
// Teams waits for the HTTP response, so the answer is returned synchronously.
export async function POST(req: Request) {
  const cfg = await getChatAskConfig();
  if (!cfg.teams_enabled || !cfg.teams_secret_set) {
    return new Response("Teams integration is not enabled.", { status: 404 });
  }

  const raw = Buffer.from(await req.arrayBuffer());
  const ok = await verifyTeamsSignature(raw, req.headers.get("authorization"));
  if (!ok) return new Response("invalid signature", { status: 401 });

  let body: any;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return NextResponse.json({ type: "message", text: "I couldn't read that message." });
  }

  // Strip the <at>webhook name</at> mention Teams prepends, plus any HTML tags.
  const question = String(body?.text || "")
    .replace(/<at>.*?<\/at>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!question) {
    return NextResponse.json({
      type: "message",
      text: "Ask me something — e.g. *how do we roll back a deploy?*",
    });
  }

  try {
    const base = await chatBaseUrl(req);
    const answer = await chatAnswer(question);
    return NextResponse.json({ type: "message", text: formatTeams(answer, base) });
  } catch (err) {
    console.error("teams ask failed:", err);
    return NextResponse.json({
      type: "message",
      text: "Sorry — I couldn't get an answer just now. Please try again.",
    });
  }
}
