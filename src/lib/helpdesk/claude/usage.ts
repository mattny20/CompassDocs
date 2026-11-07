// Helpdesk 1.20.0: what Claude in the desk spends. One hd_claude_usage row
// per turn (tokens, web searches, the model, an estimated cost from
// shared.CLAUDE_PRICES; never content). The month is the workspace's
// calendar month in the helpdesk timezone. The monthly workspace and
// per-agent limits refuse a new turn once reached: a turn reserves its cost
// at admission under an advisory lock (reserveTurn), so turns running at
// once count against the limit together; the turn that crosses a limit
// finishes. Server-only.

import "server-only";
import { hq, hqOne, withTx } from "../db-core";
import { getHelpdeskSettings } from "../settings";
import { dollars, estimateCostUsd, type ClaudeDeskConfig, type ClaudeDeskUsage, type ClaudeTokens } from "./shared";

export interface TurnUsage extends ClaudeTokens {
  model: string;
  webSearches: number;
  requests: number;
  costUsd: number;
}

export function emptyUsage(model: string): TurnUsage {
  return { model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0, requests: 0, costUsd: 0 };
}

interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
  iterations?: unknown[] | null;
}

/**
 * Add one API response's usage to the turn. With server-side fallbacks the
 * top-level usage covers only the attempt that answered; `iterations` lists
 * every attempt, so it is summed when present (each priced as `model`).
 */
export function addUsage(turn: TurnUsage, model: string, u: UsageLike | null | undefined): void {
  if (!u) return;
  const parts: UsageLike[] = Array.isArray(u.iterations) && u.iterations.length ? (u.iterations as UsageLike[]) : [u];
  for (const p of parts) {
    const t: ClaudeTokens = {
      input: Number(p.input_tokens ?? 0) || 0,
      output: Number(p.output_tokens ?? 0) || 0,
      cacheRead: Number(p.cache_read_input_tokens ?? 0) || 0,
      cacheWrite: Number(p.cache_creation_input_tokens ?? 0) || 0,
    };
    turn.input += t.input;
    turn.output += t.output;
    turn.cacheRead += t.cacheRead;
    turn.cacheWrite += t.cacheWrite;
    turn.costUsd = Math.round((turn.costUsd + estimateCostUsd(model, t)) * 1_000_000) / 1_000_000;
  }
  turn.webSearches += Number(u.server_tool_use?.web_search_requests ?? 0) || 0;
  turn.requests += 1;
}

/** At most this many turns in flight per agent at once (each chat also takes one turn at a time). */
export const MAX_TURNS_IN_FLIGHT = 2;

/**
 * Admit a turn: in one transaction under the spending lock, check the
 * per-agent turns in flight and the monthly limits (reservations of turns
 * still running count), then write the turn's usage row with a reservation
 * as its cost. Concurrent turns therefore see each other and cannot together
 * run past a limit. The row is finished by finishUsage on every path.
 */
export async function reserveTurn(
  cfg: ClaudeDeskConfig,
  row: { userId: number; chatId: number; ticketNumber: number | null; model: string; reserveUsd: number }
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const tz = await zone();
  return withTx(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('hd_claude_spend'))");
    const running = await client.query<{ n: string }>(
      "SELECT count(*) AS n FROM hd_claude_usage WHERE user_id = $1 AND stop_reason = 'running' AND at > now() - interval '10 minutes'",
      [row.userId]
    );
    if (Number(running.rows[0].n) >= MAX_TURNS_IN_FLIGHT) {
      return { ok: false as const, error: "Claude is already answering you in other tabs. Wait for those answers, then ask again." };
    }
    const r = await client.query<{ workspace: string; agent: string }>(
      `SELECT coalesce(sum(cost_usd), 0) AS workspace, coalesce(sum(cost_usd) FILTER (WHERE user_id = $2), 0) AS agent
         FROM hd_claude_usage WHERE at >= ${MONTH_START}`,
      [tz, row.userId]
    );
    const refusal = limitSentence(cfg, { workspace: Number(r.rows[0].workspace), agent: Number(r.rows[0].agent) });
    if (refusal) return { ok: false as const, error: refusal };
    const ins = await client.query<{ id: string }>(
      `INSERT INTO hd_claude_usage (user_id, chat_id, ticket_number, model, cost_usd, requests, stop_reason)
       VALUES ($1, $2, $3, $4, $5, 0, 'running') RETURNING id`,
      [row.userId, row.chatId, row.ticketNumber, row.model, Math.round(row.reserveUsd * 1_000_000) / 1_000_000]
    );
    return { ok: true as const, id: Number(ins.rows[0].id) };
  });
}

/** Replace a turn's reservation with what it really used (stopped, failed and retried steps included). */
export async function finishUsage(id: number, usage: TurnUsage, stopReason: string): Promise<void> {
  await hq(
    `UPDATE hd_claude_usage SET model = $2, input_tokens = $3, output_tokens = $4, cache_read_tokens = $5, cache_write_tokens = $6,
            web_searches = $7, requests = $8, cost_usd = $9, stop_reason = $10
      WHERE id = $1`,
    [id, usage.model, usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.webSearches, usage.requests, usage.costUsd, (stopReason || "end_turn").slice(0, 40)]
  );
}

/** What a turn reserves at admission: one step's worth at the model's prices (a large prompt and a full reply). */
export function reservationUsd(model: string, maxOutputTokens: number): number {
  return estimateCostUsd(model, { input: 30_000, output: maxOutputTokens, cacheRead: 0, cacheWrite: 0 });
}

/** SQL for the start of the current month in the helpdesk timezone ($1 = the zone). */
const MONTH_START = "(date_trunc('month', now() AT TIME ZONE $1) AT TIME ZONE $1)";

async function zone(): Promise<string> {
  try {
    return (await getHelpdeskSettings()).timezone || "UTC";
  } catch {
    return "UTC";
  }
}

/** This month's estimated spend: the workspace's, and one agent's when given. */
export async function monthSpend(userId?: number): Promise<{ workspace: number; agent: number }> {
  const tz = await zone();
  const r = await hqOne<{ workspace: string | null; agent: string | null }>(
    `SELECT coalesce(sum(cost_usd), 0) AS workspace,
            coalesce(sum(cost_usd) FILTER (WHERE user_id = $2), 0) AS agent
       FROM hd_claude_usage WHERE at >= ${MONTH_START}`,
    [tz, userId ?? null]
  );
  return { workspace: Number(r?.workspace ?? 0), agent: Number(r?.agent ?? 0) };
}

function limitSentence(cfg: ClaudeDeskConfig, s: { workspace: number; agent: number }): string | null {
  if (cfg.limit_workspace_usd !== null && s.workspace >= cfg.limit_workspace_usd) {
    return `This workspace has used its monthly limit for Claude in the desk (${dollars(cfg.limit_workspace_usd)}). It starts again next month, or an admin can raise it in Desk settings → Claude in the desk.`;
  }
  if (cfg.limit_agent_usd !== null && s.agent >= cfg.limit_agent_usd) {
    return `You've used your monthly limit for Claude in the desk (${dollars(cfg.limit_agent_usd)}). It starts again next month, or an admin can raise it in Desk settings → Claude in the desk.`;
  }
  return null;
}

/** Why a new turn is refused by the limits, or null (a read; reserveTurn is the check that counts). */
export async function limitRefusal(cfg: ClaudeDeskConfig, userId: number): Promise<string | null> {
  if (cfg.limit_workspace_usd === null && cfg.limit_agent_usd === null) return null;
  return limitSentence(cfg, await monthSpend(userId));
}

/** The c3 figures for this month. */
export async function usageSummary(): Promise<ClaudeDeskUsage> {
  const tz = await zone();
  const [total, top, drafts] = await Promise.all([
    hqOne<{ usd: string; turns: string }>(`SELECT coalesce(sum(cost_usd), 0) AS usd, count(*) AS turns FROM hd_claude_usage WHERE at >= ${MONTH_START}`, [tz]),
    hqOne<{ name: string; usd: string }>(
      `SELECT coalesce(nullif(u.name, ''), u.username) AS name, sum(x.cost_usd) AS usd
         FROM hd_claude_usage x JOIN users u ON u.id = x.user_id
        WHERE x.at >= ${MONTH_START}
        GROUP BY u.id, u.name, u.username ORDER BY sum(x.cost_usd) DESC, u.id LIMIT 1`,
      [tz]
    ),
    // A draft counts as used when its agent then wrote a message of the same kind on that ticket within a day.
    hqOne<{ offered: string; used: string }>(
      `SELECT count(*) AS offered,
              count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM hd_messages m
                 WHERE m.ticket_id = c.ticket_id AND m.author_id = c.user_id
                   AND m.kind = CASE c.kind WHEN 'reply' THEN 'public' ELSE 'internal' END
                   AND m.created_at > c.created_at AND m.created_at < c.created_at + interval '1 day')) AS used
         FROM hd_claude_cards c
        WHERE c.kind IN ('reply', 'note') AND c.created_at >= ${MONTH_START}`,
      [tz]
    ),
  ]);
  const offered = Number(drafts?.offered ?? 0);
  return {
    month_usd: Math.round(Number(total?.usd ?? 0) * 100) / 100,
    turns: Number(total?.turns ?? 0),
    drafts_used_percent: offered ? Math.round((Number(drafts?.used ?? 0) / offered) * 100) : null,
    top_user: top ? { name: top.name, usd: Math.round(Number(top.usd) * 100) / 100 } : null,
  };
}
