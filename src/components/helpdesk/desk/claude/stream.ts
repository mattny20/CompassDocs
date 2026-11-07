// Claude in the desk (1.20.0): the browser side of a chat turn. POSTs the
// question and reads the server-sent events of POST /api/helpdesk/claude/chat
// as they arrive (a streamed fetch, so the request can carry JSON and be
// stopped). A refusal before streaming (limits, switched off, 404) comes
// back as JSON and is thrown as an ApiError with the server's sentence.

import type { ClaudeIntent, ClaudeStreamEvent } from "@/lib/helpdesk/claude/shared";
import { ApiError } from "../api";

export interface AskInput {
  ticket: number | null;
  text: string;
  intent: ClaudeIntent | null;
  chat_id: number | null;
  new_chat: boolean;
  /** The agent switched on "May quote internal notes" for this question. */
  include_notes: boolean;
}

export async function askClaude(input: AskInput, onEvent: (e: ClaudeStreamEvent) => void, signal: AbortSignal): Promise<void> {
  const res = await fetch("/api/helpdesk/claude/chat", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(input),
    signal,
  });
  if (!res.ok || !res.body || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(data.error || "Claude couldn't answer that.", res.status);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = chunk
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        onEvent(JSON.parse(data) as ClaudeStreamEvent);
      } catch {
        /* a broken event: skip it */
      }
    }
  }
}
