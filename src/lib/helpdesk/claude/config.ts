// Helpdesk 1.20.0: Claude in the desk, its settings and who may use it.
// Stored as one JSON value under settings key "hd_claude_desk"; the API key
// and the model are Settings → AI's (lib/ai-config), never stored here.
// Server-only.

import "server-only";
import { getSetting, setSetting } from "../../db";
import { aiAvailable, getAiModel, getAiProvider, modelProfile } from "../../ai-config";
import { agentTeamIds, helpdeskLicensed, isAgent } from "../access";
import {
  CLAUDE_DESK_CAPS,
  CLAUDE_DESK_DEFAULTS,
  HD_CLAUDE_DESK_KEY,
  validateClaudeDeskPatch,
  type ClaudeDeskConfig,
} from "./shared";

let testConfig: ClaudeDeskConfig | null = null;
/** Tests: answer this configuration in this process instead of the stored one (null = the stored one). */
export function setClaudeDeskConfigForTests(c: ClaudeDeskConfig | null): void {
  testConfig = c;
}

function normalise(raw: unknown): ClaudeDeskConfig {
  const v = validateClaudeDeskPatch(raw);
  const p = v.ok ? v.value : {};
  return {
    ...CLAUDE_DESK_DEFAULTS,
    ...p,
    caps: { ...CLAUDE_DESK_DEFAULTS.caps, ...(p.caps ?? {}) },
  };
}

export async function getClaudeDeskConfig(): Promise<ClaudeDeskConfig> {
  if (testConfig) return testConfig;
  const raw = await getSetting(HD_CLAUDE_DESK_KEY);
  if (!raw) return { ...CLAUDE_DESK_DEFAULTS, caps: { ...CLAUDE_DESK_DEFAULTS.caps } };
  try {
    return normalise(JSON.parse(raw));
  } catch {
    return { ...CLAUDE_DESK_DEFAULTS, caps: { ...CLAUDE_DESK_DEFAULTS.caps } };
  }
}

/** Merge a validated patch into the stored settings; returns before, after and the changed keys (for the audit). */
export async function saveClaudeDeskConfig(patch: Partial<ClaudeDeskConfig>): Promise<{ before: ClaudeDeskConfig; after: ClaudeDeskConfig; changed: string[] }> {
  const before = await getClaudeDeskConfig();
  const after: ClaudeDeskConfig = { ...before, ...patch, caps: { ...before.caps, ...(patch.caps ?? {}) } };
  const changed: string[] = [];
  for (const k of Object.keys(after) as (keyof ClaudeDeskConfig)[]) {
    if (k === "caps") {
      for (const c of CLAUDE_DESK_CAPS) if (before.caps[c] !== after.caps[c]) changed.push(`caps.${c}`);
    } else if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) changed.push(k);
  }
  if (changed.length) await setSetting(HD_CLAUDE_DESK_KEY, JSON.stringify(after));
  return { before, after, changed };
}

/**
 * Web search is offered where the platform and model have it: the
 * first-party API (the only client Claude in the desk makes today; Bedrock
 * has no web search, and Vertex only the basic version) with a model the
 * dynamic-filtering tool is documented for.
 */
export function webSearchAvailable(model: string, platform: "anthropic" | "bedrock" | "vertex" | "foundry" = "anthropic"): boolean {
  if (platform !== "anthropic" && platform !== "foundry") return false;
  return modelProfile(model).webSearch;
}

/** Settings → AI can serve Claude in the desk: the Anthropic provider with a key. */
export async function claudeKeyReady(): Promise<boolean> {
  return (await getAiProvider()) === "anthropic" && (await aiAvailable());
}

type U = { id: number; role: import("../../types").Role };

/** May this team's tickets be worked with Claude? */
export function teamAllowed(cfg: ClaudeDeskConfig, teamId: number | null): boolean {
  return teamId === null || !cfg.teams_off.includes(teamId);
}

/**
 * Does the desk show the Claude button to this person? Licensed (the
 * Enterprise helpdesk), switched on, a key in Settings → AI, an agent, and
 * at least one of their teams not switched off (every team for someone who
 * sees every team's tickets).
 */
export async function claudeDeskAvailableFor(user: U): Promise<boolean> {
  try {
    if (!(await helpdeskLicensed())) return false;
    const cfg = await getClaudeDeskConfig();
    if (!cfg.enabled) return false;
    if (!(await claudeKeyReady())) return false;
    if (!(await isAgent(user))) return false;
    const scope = await agentTeamIds(user);
    if (scope === "all") return true;
    return scope.length === 0 || scope.some((t) => !cfg.teams_off.includes(t));
  } catch {
    return false;
  }
}

/** The model a chat turn runs on (Settings → AI). */
export function deskModel(): Promise<string> {
  return getAiModel();
}
