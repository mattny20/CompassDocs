// A fake Anthropic Messages API for tests and the e2e rig (1.20.0, Claude in
// the desk). Never calls the real API. It speaks POST /v1/messages, streamed
// (server-sent events, the shape the SDK's stream helper reads) or not, and
// records every request (headers and body) so tests can check what was sent.
//
// Replies come from a responder: tests set their own per case
// (fake.respond(...)); without one, the "desk" scenario below answers the way
// the c1 mock-up shows (tool calls for "has this happened before", a reply
// draft and a status proposal for "draft a reply", a summary otherwise).
//
// Prompt caching is simulated: a request whose system prompt carries a
// cache_control breakpoint caches the bytes of {model, tools, system}; the
// first request with those bytes reports cache_creation_input_tokens, every
// later one cache_read_input_tokens. A non-deterministic prefix (a timestamp
// in the system prompt, an unsorted tool list) therefore never reads.
//
// Standalone, for the e2e rig:
//   npx tsx test/support/fake-anthropic.ts --port 4917
// then start the app with COMPASSDOCS_ANTHROPIC_BASE_URL=http://127.0.0.1:4917
// (and any non-empty Anthropic key in Settings → AI or ANTHROPIC_API_KEY).

import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export type FakeBlock =
  | { type: "text"; text: string; citations?: unknown[] | null }
  | { type: "thinking"; thinking?: string; signature?: string }
  | { type: "tool_use"; id?: string; name: string; input: Record<string, unknown>; raw?: string }
  | { type: "server_tool_use"; id?: string; name: string; input: Record<string, unknown> }
  | { type: "web_search_tool_result"; tool_use_id: string; content: unknown }
  | { type: "fallback"; from: { model: string }; to: { model: string } };

export interface FakeReply {
  content: FakeBlock[];
  stop_reason?: "end_turn" | "tool_use" | "max_tokens" | "pause_turn" | "refusal";
  stop_details?: Record<string, unknown> | null;
  model?: string;
  output_tokens?: number;
  web_searches?: number;
  /** Wait this long between streamed events (to stop a turn mid-stream in a test). */
  delayMs?: number;
  /** Answer with an HTTP error instead. */
  error?: { status: number; type: string; message: string };
}

export interface RecordedRequest {
  path: string;
  headers: Record<string, string>;
  body: any;
}

export type Responder = (body: any, n: number) => FakeReply;

export interface FakeAnthropic {
  url: string;
  requests: RecordedRequest[];
  /** Answer the next requests with this (until reset). */
  respond(r: Responder | null): void;
  /** Queue one-shot replies, used in order before the responder. */
  queue(...replies: FakeReply[]): void;
  reset(): void;
  close(): Promise<void>;
}

const tokens = (s: string) => Math.max(1, Math.ceil(s.length / 4));

function lastUserText(body: any): { text: string; toolResults: any[]; allText: string } {
  const msgs: any[] = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return { text: m.content, toolResults: [], allText: m.content };
    const blocks: any[] = m.content ?? [];
    const texts = blocks.filter((b) => b.type === "text").map((b) => b.text as string);
    return { text: texts[texts.length - 1] ?? "", toolResults: blocks.filter((b) => b.type === "tool_result"), allText: texts.join("\n") };
  }
  return { text: "", toolResults: [], allText: "" };
}

function allPrompt(body: any): string {
  return JSON.stringify(body?.messages ?? []);
}

/** The c1 scenario: what the desk's quick prompts get from "Claude". */
export const deskScenario: Responder = (body) => {
  const tools: string[] = (body?.tools ?? []).map((t: any) => t.name);
  const { text, toolResults } = lastUserText(body);
  const prompt = allPrompt(body);
  const num = Number(/ticket number=\\"(\d+)\\"/.exec(prompt)?.[1] ?? /has ticket #(\d+) open/.exec(prompt)?.[1] ?? 0);
  const subject = /subject=\\"([^\\]*)\\"/.exec(prompt)?.[1] ?? "";
  if (toolResults.length) {
    const results = toolResults.map((r) => String(typeof r.content === "string" ? r.content : JSON.stringify(r.content)));
    const joined = results.join("\n");
    if (/"drafted":true/.test(joined) || /"proposed":true/.test(joined)) {
      return { content: [{ type: "text", text: "Here's a draft. I've put it in your reply box so you can edit it before you send." }] };
    }
    const found = [...new Set([...joined.matchAll(/result number="(\d+)"/g)].map((m) => Number(m[1])).filter((n) => n !== num))].slice(0, 3);
    const article = /<article id="\d+" title="([^"]+)"/.exec(joined)?.[1];
    const lines = [
      found.length
        ? `Yes, **${found.length} ${found.length === 1 ? "time" : "times"} in the last month**, all after a phone change. Each was the old MFA token cached by the VPN client, and re-pairing fixed it: ${found.map((n) => `#${n}`).join(", ")}.`
        : "I couldn't find an earlier ticket like this one in your queues.",
      article ? `The article "${article}" has the steps.` : "",
      /"assets": \[\s*\{/.test(joined) ? "The laptop is compliant and was seen recently, so it isn't a device problem. The internal note says MFA was re-enrolled yesterday, which fits." : "",
    ].filter(Boolean);
    return { content: [{ type: "text", text: lines.join("\n\n") }] };
  }
  const q = text.toLowerCase();
  if (/happened before/.test(q) && tools.includes("search_tickets")) {
    const words = subject.split(/\s+/).filter((w) => w.length > 3).slice(0, 2).join(" ") || "VPN";
    const content: FakeBlock[] = [
      { type: "thinking", thinking: "", signature: "sig-1" },
      { type: "tool_use", name: "search_tickets", input: { query: words, status: "solved" } },
    ];
    if (tools.includes("search_articles")) content.push({ type: "tool_use", name: "search_articles", input: { query: `${words} phone change` } });
    if (tools.includes("asset_lookup")) content.push({ type: "tool_use", name: "asset_lookup", input: { query: "ASSET-00421" } });
    return { content, stop_reason: "tool_use" };
  }
  if (/draft a reply/.test(q) && tools.includes("draft_reply") && num) {
    const content: FakeBlock[] = [
      {
        type: "tool_use",
        name: "draft_reply",
        input: {
          number: num,
          body: "Hi Daniel, this usually happens after a phone change: the VPN client keeps your old sign-in token. Could you try these 3 steps?\n\n1. Quit the VPN client.\n2. Remove the saved account.\n3. Sign in again and approve the new MFA prompt.",
        },
      },
    ];
    if (tools.includes("propose_ticket_change")) {
      content.push({ type: "tool_use", name: "propose_ticket_change", input: { number: num, status: "pending", priority: null, tags: null, team_id: null, assignee_id: null, when: "After you send the reply." } });
    }
    return { content, stop_reason: "tool_use" };
  }
  if (/summar/.test(q)) {
    return { content: [{ type: "text", text: `**#${num || "?"}** ${subject || "This ticket"}: the requester can't connect to the VPN from home since a phone change. An internal note says MFA was re-enrolled yesterday. Next step: ask them to re-pair the VPN client.` }] };
  }
  return { content: [{ type: "text", text: `You asked: ${text.slice(0, 200)}` }] };
};

export async function startFakeAnthropic(opts: { port?: number; host?: string } = {}): Promise<FakeAnthropic> {
  const requests: RecordedRequest[] = [];
  const cache = new Set<string>();
  let responder: Responder | null = null;
  const queued: FakeReply[] = [];
  let n = 0;
  let ids = 0;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body: any = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
      } catch {
        body = null;
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
      requests.push({ path: req.url ?? "", headers, body });
      if (req.method !== "POST" || !(req.url ?? "").startsWith("/v1/messages")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "Not found" } }));
        return;
      }
      const reply = queued.shift() ?? (responder ?? deskScenario)(body, n++);
      if (reply.error) {
        res.writeHead(reply.error.status, { "content-type": "application/json", "request-id": `req_fake_${++ids}` });
        res.end(JSON.stringify({ type: "error", error: { type: reply.error.type, message: reply.error.message } }));
        return;
      }
      // Usage, with the simulated prompt cache.
      const system = body?.system;
      const sysText = typeof system === "string" ? system : JSON.stringify(system ?? "");
      const breakpoint = Array.isArray(system) && system.some((b: any) => b?.cache_control);
      const prefix = JSON.stringify({ model: body?.model, tools: body?.tools ?? [], system: system ?? "" });
      const prefixTokens = tokens(prefix) + 600; // past the 512-token minimum
      let cacheRead = 0;
      let cacheWrite = 0;
      if (breakpoint) {
        const key = createHash("sha256").update(prefix).digest("hex");
        if (cache.has(key)) cacheRead = prefixTokens;
        else {
          cache.add(key);
          cacheWrite = prefixTokens;
        }
      }
      const input = tokens(JSON.stringify(body?.messages ?? [])) + (breakpoint ? 0 : tokens(sysText));
      const model = reply.model ?? body?.model ?? "claude-opus-5-5";
      const content = reply.content.map((b) => (b.type === "tool_use" || b.type === "server_tool_use" ? { ...b, id: b.id ?? `toolu_fake_${++ids}` } : b));
      const stop = reply.stop_reason ?? (content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn");
      const output = reply.output_tokens ?? Math.max(1, tokens(JSON.stringify(content)));
      const usage = {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: cacheWrite,
        cache_read_input_tokens: cacheRead,
        server_tool_use: { web_search_requests: reply.web_searches ?? 0, web_fetch_requests: 0 },
      };
      const msgId = `msg_fake_${++ids}`;
      const stopDetails = stop === "refusal" ? reply.stop_details ?? { type: "refusal", category: "cyber", explanation: null } : null;

      if (!body?.stream) {
        res.writeHead(200, { "content-type": "application/json", "request-id": `req_fake_${ids}` });
        res.end(
          JSON.stringify({
            id: msgId,
            type: "message",
            role: "assistant",
            model,
            content: content.map(finalBlock),
            stop_reason: stop,
            stop_sequence: null,
            stop_details: stopDetails,
            usage,
          })
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "request-id": `req_fake_${ids}` });
      const events: [string, unknown][] = [];
      const send = (event: string, data: unknown) => events.push([event, data]);
      send("message_start", {
        type: "message_start",
        message: { id: msgId, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } },
      });
      content.forEach((b, index) => {
        if (b.type === "text") {
          send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "", citations: null } });
          for (let i = 0; i < b.text.length; i += 24) {
            send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: b.text.slice(i, i + 24) } });
          }
          for (const c of b.citations ?? []) send("content_block_delta", { type: "content_block_delta", index, delta: { type: "citations_delta", citation: c } });
        } else if (b.type === "thinking") {
          send("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
          if (b.thinking) send("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: b.thinking } });
          send("content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: b.signature ?? "sig" } });
        } else if (b.type === "tool_use") {
          send("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
          const json = b.raw ?? JSON.stringify(b.input);
          for (let i = 0; i < json.length; i += 16) {
            send("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(i, i + 16) } });
          }
        } else {
          send("content_block_start", { type: "content_block_start", index, content_block: finalBlock(b) });
        }
        send("content_block_stop", { type: "content_block_stop", index });
      });
      send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stop, stop_sequence: null, stop_details: stopDetails },
        usage: { output_tokens: output, input_tokens: input, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead, server_tool_use: usage.server_tool_use },
      });
      send("message_stop", { type: "message_stop" });
      void (async () => {
        for (const [event, data] of events) {
          if (res.destroyed) return;
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
        }
        res.end();
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://${opts.host ?? "127.0.0.1"}:${addr.port}`,
    requests,
    respond(r) {
      responder = r;
    },
    queue(...replies) {
      queued.push(...replies);
    },
    reset() {
      requests.length = 0;
      queued.length = 0;
      responder = null;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function finalBlock(b: FakeBlock): Record<string, unknown> {
  if (b.type === "text") return { type: "text", text: b.text, citations: b.citations ?? null };
  if (b.type === "thinking") return { type: "thinking", thinking: b.thinking ?? "", signature: b.signature ?? "sig" };
  if (b.type === "tool_use") return { type: "tool_use", id: b.id, name: b.name, input: b.input };
  return b as unknown as Record<string, unknown>;
}

// Standalone: npx tsx test/support/fake-anthropic.ts --port 4917
if (require.main === module) {
  const i = process.argv.indexOf("--port");
  const port = i > 0 ? Number(process.argv[i + 1]) : 4917;
  void startFakeAnthropic({ port }).then((f) => {
    console.log(`Fake Anthropic Messages API on ${f.url} (COMPASSDOCS_ANTHROPIC_BASE_URL=${f.url})`);
  });
}
