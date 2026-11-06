// Helpdesk 1.19.1: the Claude connector's workspace level (agent V1), and
// "Recent activity via Claude" for Desk settings. The level is stored under
// its own settings key; the MCP tools (lib/mcp/helpdesk-tools) read it on
// every call and refuse what it does not allow. Server-only.

import "server-only";
import { getSetting, setSetting } from "../db";
import { hq } from "./db-core";
import {
  HD_CLAUDE_AUDIT_ACTIONS,
  HD_CLAUDE_DEFAULT_LEVEL,
  HD_CLAUDE_KEY,
  claudeActivitySummary,
  isClaudeLevel,
  type HdClaudeActivity,
  type HdClaudeLevel,
} from "./claude-connector-shared";

export * from "./claude-connector-shared";

let testLevel: HdClaudeLevel | null = null;
/** Tests: answer this level in this process instead of the stored one (null = the stored one). */
export function setClaudeLevelForTests(level: HdClaudeLevel | null): void {
  testLevel = level;
}

/** The workspace level; the default (notes) when unset or unreadable. */
export async function getClaudeLevel(): Promise<HdClaudeLevel> {
  if (testLevel) return testLevel;
  const raw = await getSetting(HD_CLAUDE_KEY);
  if (!raw) return HD_CLAUDE_DEFAULT_LEVEL;
  try {
    const v = JSON.parse(raw) as { level?: unknown };
    return isClaudeLevel(v?.level) ? v.level : HD_CLAUDE_DEFAULT_LEVEL;
  } catch {
    return HD_CLAUDE_DEFAULT_LEVEL;
  }
}

/** Store the level; returns the level it replaced. */
export async function saveClaudeLevel(level: HdClaudeLevel): Promise<HdClaudeLevel> {
  const before = await getClaudeLevel();
  if (before !== level) await setSetting(HD_CLAUDE_KEY, JSON.stringify({ level }));
  return before;
}

/** The latest helpdesk writes made through the connector (audit rows with via "mcp"). */
export async function recentClaudeActivity(limit = 20): Promise<HdClaudeActivity[]> {
  const rows = await hq<{
    id: string | number;
    at: string;
    actor_id: number | null;
    actor_name: string;
    action: string;
    details: Record<string, unknown> | null;
    target_label: string | null;
  }>(
    `SELECT id, at, actor_id, actor_name, action, details, target_label
       FROM audit_log
      WHERE action = ANY($1::text[]) AND details->>'via' = 'mcp'
      ORDER BY at DESC, id DESC
      LIMIT $2`,
    [[...HD_CLAUDE_AUDIT_ACTIONS], Math.min(Math.max(1, limit), 100)]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    at: r.at,
    actor_id: r.actor_id,
    actor_name: r.actor_name,
    action: r.action,
    summary: claudeActivitySummary(r.action, r.details, r.target_label),
  }));
}
