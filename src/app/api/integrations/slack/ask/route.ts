import { NextResponse } from "next/server";
import {
  getChatAskConfig,
  verifySlackSignature,
  chatAnswer,
  chatBaseUrl,
  formatSlack,
} from "@/lib/chat-ask";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Slack slash command (e.g. /askdocs). Slack expects a response within 3
// seconds, so we ACK immediately with an ephemeral note and deliver the real
// answer asynchronously to the command's response_url (valid for 30 minutes).
export async function POST(req: Request) {
  const cfg = await getChatAskConfig();
  if (!cfg.slack_enabled || !cfg.slack_secret_set) {
    return new Response("Slack integration is not enabled.", { status: 404 });
  }

  const raw = await req.text();
  const ok = await verifySlackSignature(
    raw,
    req.headers.get("x-slack-request-timestamp"),
    req.headers.get("x-slack-signature")
  );
  if (!ok) return new Response("invalid signature", { status: 401 });

  const params = new URLSearchParams(raw);
  const question = (params.get("text") || "").trim();
  const responseUrl = params.get("response_url") || "";

  if (!question) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: "Ask me something — e.g. `/askdocs how do we roll back a deploy?`",
    });
  }
  if (!responseUrl.startsWith("https://hooks.slack.com/")) {
    return new Response("bad response_url", { status: 400 });
  }

  const base = await chatBaseUrl(req);

  // Answer out-of-band; the runtime keeps the promise alive after we respond.
  void (async () => {
    try {
      const answer = await chatAnswer(question);
      await fetch(responseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          response_type: "in_channel",
          text: formatSlack(answer, base),
        }),
      });
    } catch (err) {
      console.error("slack ask failed:", err);
      await fetch(responseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          response_type: "ephemeral",
          text: "Sorry — I couldn't get an answer just now. Please try again.",
        }),
      }).catch(() => {});
    }
  })();

  return NextResponse.json({
    response_type: "ephemeral",
    text: `Searching the knowledge base for “${question.slice(0, 120)}”…`,
  });
}
