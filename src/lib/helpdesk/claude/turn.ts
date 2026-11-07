// Helpdesk 1.20.0: one chat turn of Claude in the desk. prepareTurn makes
// every check that can refuse before anything streams (licence, the switch,
// the key, the agent's ticket, the team switch, a team Claude is on for, the
// rate limit), claims the chat (one turn per chat at a time) and reserves
// the turn's cost under the spending lock with the monthly limits (at most
// two turns in flight per agent). runTurn then streams the turn to the
// browser and always finishes the usage row and releases the chat:
//
//   - a manual tool loop on the Messages API (client.beta.messages.stream):
//     adaptive thinking with an explicit effort per task (low for summaries
//     and quick prompts, medium for drafts, high for research), no sampling
//     parameters, no prefill, tool_choice auto with strict tools;
//   - the stop reason is checked before any output is used: refusal ends the
//     turn with a plain message and runs nothing, max_tokens never runs a
//     cut-off tool call, pause_turn (web search) is sent back to continue up
//     to a cap, past which the turn ends with a note and is not replayed;
//   - every parsed tool input is validated against its schema (eager input
//     streaming) before the tool runs, AS THE AGENT (tools.ts);
//   - usage comes from the stream as it arrives, so a stopped, failed or
//     re-run step is counted too;
//   - Opus 5.5 and Sonnet 5.5 ask for server-side refusal fallbacks
//     (fallbacks: "default", beta server-side-fallback-2026-07-01);
//   - prompt caching: frozen system prompt with a breakpoint, sorted tools,
//     automatic caching for the conversation tail, the ticket after them;
//     the history replays in epochs (chats.loadReplay), bounded in size.
//
// Each turn is audited as helpdesk.claude.chat with token counts, tools used
// and the ticket number, never content. Server-only.

import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { SessionUser, User } from "../../types";
import { audit, actorFrom } from "../../audit";
import { anthropicClient, FALLBACK_BETA, getAnthropicKey, getAiModel, modelProfile, thinkingHeadroom, type AiEffort } from "../../ai-config";
import { agentTeamIds, canWorkTicket, hdRateLimited, helpdeskLicensed, HD_LICENCE_ERROR, isAgent } from "../access";
import { getTicketByNumber, parseTicketNumber } from "../tickets";
import type { HdTicket } from "../types";
import { claudeKeyReady, getClaudeDeskConfig, teamAllowed, webSearchAvailable } from "./config";
import { appendTurn, attachCards, claimChat, createCard, linkTickets, loadReplay, openChat, releaseChat, type ChatRow, type TurnDisplay } from "./chats";
import { ticketForClaude } from "./context";
import { prefixHash, SYSTEM_PROMPT, TOOL_SPECS, ticketBlock, toolsFor, turnPreface, webSearchTool } from "./prompt";
import { runDeskTool, type ToolCtx } from "./tools";
import { addUsage, emptyUsage, finishUsage, reservationUsd, reserveTurn } from "./usage";
import { schemaError } from "./validate";
import { CLAUDE_DESK_LIMITS, CLAUDE_REFUSAL_MESSAGE, type ClaudeCard, type ClaudeDeskConfig, type ClaudeIntent, type ClaudeSource, type ClaudeStreamEvent } from "./shared";

type BetaContentBlock = Anthropic.Beta.BetaContentBlock;
type BetaToolResultBlockParam = Anthropic.Beta.BetaToolResultBlockParam;
type BetaMessageParam = Anthropic.Beta.BetaMessageParam;

export type Emit = (e: ClaudeStreamEvent) => void;

/** At most this many model requests in one turn (tool rounds plus pause_turn continuations). */
const MAX_STEPS = 8;
const MAX_CONTINUATIONS = 3;
/** The visible part of a reply; thinking headroom is added per effort. */
const REPLY_TOKENS = 16_000;

/** Turns per agent: 12 a minute, 120 an hour (per process, a cost backstop like the other helpdesk limits). */
const TURN_LIMITS = { minute: 12, hour: 120 };
/** Tests: other per-agent turn limits in this process (null = the defaults). */
export function setClaudeTurnLimitsForTests(v: { minute: number; hour: number } | null): void {
  TURN_LIMITS.minute = v?.minute ?? 12;
  TURN_LIMITS.hour = v?.hour ?? 120;
}

export function claudeTurnLimited(userId: number): boolean {
  return hdRateLimited(`hd-claude-m:${userId}`, TURN_LIMITS.minute, 60_000) || hdRateLimited(`hd-claude-h:${userId}`, TURN_LIMITS.hour, 3_600_000);
}

/** The effort a turn's task needs (set explicitly, never the model's default). */
export function effortFor(intent: ClaudeIntent | null, text: string): AiEffort {
  if (intent === "summary") return "low";
  if (intent === "draft") return "medium";
  if (intent === "research") return "high";
  const t = text.toLowerCase();
  if (/\b(happened before|similar|research|investigate|root cause|why does|why is|look into|find out|history of|seen this)\b/.test(t)) return "high";
  if (/\b(draft|reply|write|translate|rephrase|respond|answer him|answer her|note for|email)\b/.test(t)) return "medium";
  if (/\b(summar|tl;?dr|what should i|next step|triage|status of|where does)\b/.test(t)) return "low";
  return "medium";
}

export interface TurnInput {
  user: User;
  session: SessionUser;
  origin: string;
  ip: string | null;
  ticketNumber: number | null;
  chatId: number | null;
  fresh: boolean;
  text: string;
  intent: ClaudeIntent | null;
  /** The agent switched on "May quote internal notes" for this question. */
  includeNotes?: boolean;
}

export interface PreparedTurn extends TurnInput {
  cfg: ClaudeDeskConfig;
  ticket: HdTicket | null;
  apiKey: string;
  model: string;
  effort: AiEffort;
  tools: Anthropic.Beta.BetaToolUnion[];
  clientToolNames: string[];
  hash: string;
  chat: ChatRow;
  usageId: number;
}

type Refusal = { ok: false; status: number; error: string };

/** Does the agent work at least one team Claude is on for (or every team, or none at all)? */
async function hasClaudeTeam(user: User, cfg: ClaudeDeskConfig): Promise<boolean> {
  const scope = await agentTeamIds(user);
  if (scope === "all") return true;
  return scope.length === 0 || scope.some((t) => !cfg.teams_off.includes(t));
}

/** Every refusal that comes before streaming, as the route's status and sentence; on success the chat is claimed and the cost reserved. */
export async function prepareTurn(input: TurnInput): Promise<{ ok: true; turn: PreparedTurn } | Refusal> {
  if (!(await helpdeskLicensed())) return { ok: false, status: 402, error: HD_LICENCE_ERROR };
  if (!(await isAgent(input.user))) return { ok: false, status: 403, error: "Claude in the desk is for agents." };
  const cfg = await getClaudeDeskConfig();
  if (!cfg.enabled) return { ok: false, status: 409, error: "Claude in the desk is switched off. An admin can turn it on in Desk settings → Claude in the desk." };
  const apiKey = await getAnthropicKey();
  if (!apiKey || !(await claudeKeyReady())) return { ok: false, status: 409, error: "Claude in the desk needs the Anthropic API key in Settings → AI." };
  const text = input.text.trim();
  if (!text) return { ok: false, status: 400, error: "Ask Claude something." };
  if (text.length > CLAUDE_DESK_LIMITS.question) return { ok: false, status: 400, error: `Keep a question under ${CLAUDE_DESK_LIMITS.question.toLocaleString("en-US")} characters.` };
  // The same rule the desk uses to show the button: at least one of the agent's teams has Claude on.
  if (!(await hasClaudeTeam(input.user, cfg))) return { ok: false, status: 409, error: "Claude is switched off for your teams." };
  let ticket: HdTicket | null = null;
  if (input.ticketNumber !== null) {
    const n = parseTicketNumber(String(input.ticketNumber));
    const t = n ? await getTicketByNumber(n) : undefined;
    // A ticket outside the agent's queues answers like one that does not exist.
    if (!t || !(await canWorkTicket(input.user, t))) return { ok: false, status: 404, error: `No ticket #${input.ticketNumber} that you can see.` };
    if (!teamAllowed(cfg, t.team_id)) return { ok: false, status: 409, error: `Claude is switched off for this ticket's team.` };
    ticket = t;
  }
  if (claudeTurnLimited(input.user.id)) return { ok: false, status: 429, error: "You're asking Claude very quickly. Wait a moment and try again." };

  const model = await getAiModel();
  const profile = modelProfile(model);
  const effort = effortFor(input.intent, text);
  let assets = false;
  try {
    assets = await (await import("../assets")).assetsConnected();
  } catch {
    assets = false;
  }
  const clientTools = toolsFor(cfg, { assets });
  const web = webSearchAvailable(model) ? webSearchTool(cfg) : null;
  const tools: Anthropic.Beta.BetaToolUnion[] = [...clientTools, ...(web ? [web] : [])];
  const hash = prefixHash(model, tools);

  const chat = await openChat(input.user.id, ticket?.id ?? null, { chatId: input.chatId, fresh: input.fresh, title: ticket ? `#${ticket.number}: ${text}` : text });
  if (!(await claimChat(chat.id))) return { ok: false, status: 409, error: "Claude is still answering in this chat (perhaps in another tab). Wait for it, then ask again." };
  const maxTokens = REPLY_TOKENS + (profile.current ? thinkingHeadroom(effort) : 0);
  const reserved = await reserveTurn(cfg, { userId: input.user.id, chatId: chat.id, ticketNumber: ticket?.number ?? null, model, reserveUsd: reservationUsd(model, maxTokens) });
  if (!reserved.ok) {
    await releaseChat(chat.id);
    return { ok: false, status: 429, error: reserved.error };
  }
  return {
    ok: true,
    turn: { ...input, text, cfg, ticket, apiKey, model, effort, tools, clientToolNames: clientTools.map((t) => t.name), hash, chat, usageId: reserved.id },
  };
}

/** Undo a prepared turn that will not run (the route failed before streaming). */
export async function abandonTurn(turn: PreparedTurn): Promise<void> {
  await finishUsage(turn.usageId, emptyUsage(turn.model), "abandoned").catch(() => {});
  await releaseChat(turn.chat.id).catch(() => {});
}

// --- Context ------------------------------------------------------------------------------

async function teamNames(user: User): Promise<string> {
  const { hq } = await import("../db-core");
  const rows = await hq<{ name: string }>("SELECT t.name FROM hd_team_members m JOIN hd_teams t ON t.id = m.team_id WHERE m.user_id = $1 ORDER BY t.position, t.name", [user.id]);
  return rows.map((r) => r.name).join(", ");
}

async function todayIn(): Promise<string> {
  try {
    const tz = (await (await import("../settings")).getHelpdeskSettings()).timezone || "UTC";
    return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// --- The response -----------------------------------------------------------------------------

/**
 * Content to send back next time. After a mid-output refusal fallback, the
 * blocks the declined model produced before the last `fallback` marker that
 * are not plain text (thinking, tool calls, an unpaired server tool call) are
 * left out, as the fallback contract asks; everything else echoes unchanged.
 */
export function echoable(content: BetaContentBlock[]): BetaContentBlock[] {
  let last = -1;
  content.forEach((b, i) => {
    if (b.type === "fallback") last = i;
  });
  if (last < 0) return content;
  const paired = new Set(content.filter((b) => b.type === "web_search_tool_result").map((b) => (b as { tool_use_id: string }).tool_use_id));
  return content.filter((b, i) => {
    if (i >= last) return true;
    if (b.type === "thinking" || b.type === "redacted_thinking" || b.type === "tool_use") return false;
    if (b.type === "server_tool_use") return paired.has(b.id);
    return true;
  });
}

function friendlyError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "The Anthropic API key was rejected. An admin can check it in Settings → AI.";
  if (e instanceof Anthropic.PermissionDeniedError) return "The Anthropic API key can't use this model. An admin can check Settings → AI.";
  if (e instanceof Anthropic.NotFoundError) return "The model set in Settings → AI isn't available to this key.";
  if (e instanceof Anthropic.RateLimitError) return "Claude is busy for this workspace right now. Try again in a moment.";
  if (e instanceof Anthropic.BadRequestError) return "Claude couldn't take this request. Try a shorter question or a new chat.";
  if (e instanceof Anthropic.APIConnectionError) return "Couldn't reach Anthropic. Check the connection and try again.";
  if (e instanceof Anthropic.APIError) return "Claude had a problem answering. Try again in a moment.";
  return "Something went wrong while Claude was answering. Try again.";
}

const isAbort = (e: unknown, signal?: AbortSignal) => (e as Error)?.name === "AbortError" || e instanceof Anthropic.APIUserAbortError || !!signal?.aborted;

/** Run a prepared turn, streaming its events. Never throws: failures end in a notice. Always finishes the usage row and frees the chat. */
export async function runTurn(turn: PreparedTurn, emit: Emit, signal?: AbortSignal): Promise<void> {
  const usage = emptyUsage(turn.model);
  let stopReason = "";
  try {
    stopReason = await turnBody(turn, emit, usage, signal);
  } finally {
    await finishUsage(turn.usageId, usage, stopReason || "error").catch((e) => console.error("[claude-desk] recording usage failed:", e));
    await releaseChat(turn.chat.id).catch(() => {});
  }
}

async function turnBody(turn: PreparedTurn, emit: Emit, usage: ReturnType<typeof emptyUsage>, signal?: AbortSignal): Promise<string> {
  const { cfg, user, ticket, chat, model, effort, tools, hash } = turn;
  const profile = modelProfile(model);
  emit({ type: "start", chat_id: chat.id, model });

  const touched = new Set<number>(ticket ? [ticket.id] : []);
  const ctx: ToolCtx = { user, session: turn.session, origin: turn.origin, ip: turn.ip, cfg, chatId: chat.id, ticket, includeNotes: turn.includeNotes === true, touched, notesSeen: [] };

  // History: the current epoch replayed as it was sent; a new epoch carries a shortened transcript.
  const replay = await loadReplay(chat, hash);
  // The open ticket: in full at the start of an epoch, then only what changed since the last kept turn saw it.
  let ticketText: string | null = null;
  let ticketSeenAt: string | null = null;
  if (ticket && cfg.caps.read) {
    const full = replay.fresh || !chat.ticket_seen_at;
    const changed = !full && new Date(ticket.updated_at) > new Date(chat.ticket_seen_at!);
    if (full || changed) {
      const { ticket: view, notes } = await ticketForClaude(user, ticket);
      ctx.notesSeen.push(...notes);
      ticketText = full ? ticketBlock(view) : ticketBlock(view, { since: chat.ticket_seen_at });
      ticketSeenAt = ticket.updated_at;
    }
  }
  const preface = turnPreface({ agent: user.name || user.username, teams: await teamNames(user), today: await todayIn(), ticketNumber: ticket?.number ?? null, ticket: ticketText });
  const userContent: Anthropic.Beta.BetaTextBlockParam[] = [
    ...(replay.carry ? [{ type: "text" as const, text: replay.carry }] : []),
    { type: "text", text: preface },
    { type: "text", text: turn.text },
  ];
  const messages: BetaMessageParam[] = [...replay.messages, { role: "user", content: userContent }];
  const rows: { role: "user" | "assistant"; api: unknown | null; display: TurnDisplay }[] = [
    { role: "user", api: userContent, display: { text: turn.text, intent: turn.intent } },
  ];

  const specs = new Map(TOOL_SPECS.map((s) => [s.name, s.input_schema as Record<string, unknown>]));
  let text = "";
  const activity: { label: string; icon: string }[] = [];
  const candidates: ClaudeSource[] = [];
  const cited: ClaudeSource[] = [];
  const cardIds: number[] = [];
  const toolsUsed: string[] = [];
  let stopReason = "";
  let notice: TurnDisplay["notice"] = null;
  let keepApi = true;
  let continuations = 0;
  let jsonRetries = 0;

  const addActivity = (a: { label: string; icon: string }) => {
    if (activity.some((x) => x.label === a.label)) return;
    activity.push(a);
    emit({ type: "activity", label: a.label, icon: a.icon as never });
  };
  const warn = (message: string) => {
    notice = { tone: "warn", message };
    emit({ type: "notice", tone: "warn", message });
  };

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const params = {
        model,
        max_tokens: REPLY_TOKENS + (profile.current ? thinkingHeadroom(effort) : 0),
        system: [{ type: "text" as const, text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" as const } }],
        tools,
        tool_choice: { type: "auto" as const },
        messages,
        // Automatic caching moves a second breakpoint along the growing conversation.
        cache_control: { type: "ephemeral" as const },
        ...(profile.current ? { thinking: { type: "adaptive" as const }, output_config: { effort } } : {}),
        ...(profile.fallbacks ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
      };
      const stream = anthropicClient(turn.apiKey).beta.messages.stream(params, { signal });
      // The step's usage as it streams in, so a step that never finishes is still counted.
      let partial: Record<string, any> | null = null;
      const textAtStart = text.length;
      let message: Anthropic.Beta.BetaMessage;
      try {
        for await (const ev of stream) {
          if (ev.type === "message_start") partial = { ...(ev.message.usage as object) };
          else if (ev.type === "message_delta" && ev.usage) {
            partial = { ...(partial ?? {}) };
            for (const [k, v] of Object.entries(ev.usage)) if (v !== null && v !== undefined) partial[k] = v;
          } else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
            text += ev.delta.text;
            emit({ type: "text", delta: ev.delta.text });
          } else if (ev.type === "content_block_start" && ev.content_block.type === "server_tool_use" && ev.content_block.name === "web_search") {
            addActivity({ label: "Searched the web", icon: "globe" });
          }
        }
        message = await stream.finalMessage();
        jsonRetries = 0;
      } catch (e) {
        // What the step used before it broke off counts (an abort before any usage arrived: the prompt, estimated).
        if (partial) addUsage(usage, model, partial);
        else if (isAbort(e, signal)) addUsage(usage, model, { input_tokens: Math.ceil(JSON.stringify(params.messages).length / 4) });
        // A tool input the SDK could not parse at all: re-issue the step (capped). API errors and aborts end the turn.
        if (e instanceof Anthropic.APIError || isAbort(e, signal) || jsonRetries++ >= 2) throw e;
        if (text.length > textAtStart) {
          text = text.slice(0, textAtStart);
          emit({ type: "rewind", keep: textAtStart });
        }
        continue;
      }
      addUsage(usage, message.model || model, message.usage as never);
      stopReason = message.stop_reason ?? "";

      // A refusal can cut a tool call off mid-input: never run that turn's tools or keep its output.
      if (stopReason === "refusal") {
        keepApi = false;
        text = "";
        emit({ type: "refusal", message: CLAUDE_REFUSAL_MESSAGE });
        notice = { tone: "warn", message: CLAUDE_REFUSAL_MESSAGE };
        break;
      }
      const content = echoable(message.content);
      // Web search results: an error is an object, results a list (never thrown).
      for (const b of content) {
        if (b.type === "web_search_tool_result") {
          const c = b.content as unknown;
          if (Array.isArray(c)) {
            for (const r of c as { url: string; title: string }[]) candidates.push({ kind: "web", label: r.title || r.url, href: r.url });
          } else {
            const code = (c as { error_code?: string })?.error_code ?? "error";
            addActivity({ label: code === "max_uses_exceeded" ? "Web search limit reached" : "Web search didn't answer", icon: "globe" });
          }
        } else if (b.type === "text" && Array.isArray(b.citations)) {
          for (const ci of b.citations as { type: string; url?: string; title?: string }[]) {
            if (ci.type === "web_search_result_location" && ci.url && !cited.some((x) => x.href === ci.url)) cited.push({ kind: "web", label: ci.title || ci.url, href: ci.url });
          }
        }
      }
      if (stopReason === "pause_turn") {
        if (++continuations > MAX_CONTINUATIONS) {
          // Past the cap the turn ends unfinished: said plainly, and never replayed half-paused.
          keepApi = false;
          warn("Claude stopped searching before it finished. Ask it to go on, or ask something narrower.");
          break;
        }
        messages.push({ role: "assistant", content: content as never });
        rows.push({ role: "assistant", api: content, display: { text: "" } });
        continue;
      }
      const toolUses = content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (stopReason === "max_tokens") {
        if (toolUses.length) {
          // A cut-off tool input can still parse; never run it. The turn is not kept for the model.
          keepApi = false;
          warn("Claude's answer was cut off before it finished. Try asking for less at once.");
        } else {
          messages.push({ role: "assistant", content: content as never });
          rows.push({ role: "assistant", api: content, display: { text: "" } });
          warn("Claude's answer was cut off. Ask it to go on, or for something shorter.");
        }
        break;
      }
      messages.push({ role: "assistant", content: content as never });
      rows.push({ role: "assistant", api: content, display: { text: "" } });
      if (!toolUses.length) break;

      // Run every tool call of this response, then answer them all in one message.
      const results: BetaToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        toolsUsed.push(tu.name);
        const schema = specs.get(tu.name);
        if (!schema || !turn.clientToolNames.includes(tu.name)) {
          results.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: `Unknown tool: ${tu.name}` });
          continue;
        }
        const bad = schemaError(schema, tu.input);
        if (bad) {
          results.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: JSON.stringify({ INVALID_JSON: JSON.stringify(tu.input ?? null), problem: bad }) });
          continue;
        }
        const out = await runDeskTool(tu.name, tu.input as Record<string, unknown>, ctx);
        if (out.activity) addActivity(out.activity);
        if (out.sources) candidates.push(...out.sources);
        if (out.card) {
          touched.add(out.card.ticketId);
          const id = await createCard({ chatId: chat.id, userId: user.id, ticketId: out.card.ticketId, kind: out.card.kind, payload: out.card.payload });
          cardIds.push(id);
          emit({ type: "card", card: { ...(out.card.payload as object), id, kind: out.card.kind, state: "offered" } as ClaudeCard });
        }
        results.push({ type: "tool_result", tool_use_id: tu.id, content: out.content, ...(out.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: "user", content: results });
      rows.push({ role: "user", api: results, display: { text: "" } });
      if (step === MAX_STEPS - 1) warn("Claude stopped after several steps. Ask it to go on if you need more.");
    }
  } catch (e) {
    keepApi = false;
    const aborted = isAbort(e, signal);
    stopReason = aborted ? "aborted" : "error";
    if (!aborted) console.error("[claude-desk] turn failed:", e instanceof Anthropic.APIError ? `${e.status} ${e.message}` : e);
    notice = { tone: aborted ? "warn" : "error", message: aborted ? "Stopped." : friendlyError(e) };
    if (!aborted) emit({ type: "notice", tone: "error", message: notice.message });
  }

  // Source chips: what the answer names (tickets by number, articles by title), plus web citations.
  const sources = pickSources(text, candidates, cited);
  if (sources.length) emit({ type: "sources", sources });

  // Persist: the API rows only when the turn finished cleanly (the history stays a valid, append-only conversation).
  const persisted = keepApi ? rows : [{ ...rows[0], api: null, display: { ...rows[0].display, excluded: true } }];
  persisted.push({ role: "assistant", api: null, display: { text, activity, sources, notice, ...(keepApi ? {} : { excluded: true }) } });
  try {
    // Every ticket this turn touched is linked first, whatever happens to the rows (erasure finds the chat by them).
    await linkTickets(chat.id, touched);
    const ids = await appendTurn(chat, { epoch: replay.epoch, hash, kept: keepApi, ticketSeenAt: keepApi ? ticketSeenAt : null }, persisted);
    await attachCards(cardIds, ids[ids.length - 1]);
  } catch (e) {
    console.error("[claude-desk] saving the chat failed:", e);
  }
  try {
    await audit({
      actor: actorFrom(turn.session),
      action: "helpdesk.claude.chat",
      targetType: ticket ? "helpdesk_ticket" : "helpdesk_claude",
      targetId: ticket?.id ?? null,
      targetLabel: ticket ? `#${ticket.number}` : "Claude in the desk",
      details: {
        number: ticket?.number ?? null,
        chat_id: chat.id,
        model: usage.model,
        effort,
        input_tokens: usage.input,
        output_tokens: usage.output,
        cache_read_tokens: usage.cacheRead,
        cache_write_tokens: usage.cacheWrite,
        web_searches: usage.webSearches,
        requests: usage.requests,
        cost_estimate_usd: usage.costUsd,
        tools: [...new Set(toolsUsed)],
        cards: cardIds.length,
        stop_reason: stopReason,
      },
      ip: turn.ip,
    });
  } catch (e) {
    console.error("[claude-desk] auditing the turn failed:", e);
  }
  emit({ type: "done", stop_reason: stopReason });
  return stopReason;
}

function pickSources(text: string, candidates: ClaudeSource[], cited: ClaudeSource[]): ClaudeSource[] {
  const out: ClaudeSource[] = [];
  const seen = new Set<string>();
  const add = (s: ClaudeSource) => {
    if (seen.has(s.href)) return;
    seen.add(s.href);
    out.push(s);
  };
  for (const s of candidates) {
    if (s.kind === "ticket" && new RegExp(`#0*${s.label.slice(1)}\\b`).test(text)) add(s);
    if (s.kind === "article" && text.toLowerCase().includes(s.label.toLowerCase())) add(s);
  }
  for (const s of cited) add(s);
  return out.slice(0, 10);
}
