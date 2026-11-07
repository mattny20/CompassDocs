// Helpdesk 1.20.0: Claude in the desk, the client-safe part. The settings
// shape and its copy (Desk settings → Claude in the desk, mock c3), the
// launcher's quick prompts (c2), the panel's fixed lines (c1), the price
// table the usage estimate reads, and the events the chat route streams.
// The page, the panel, the server and the tests read the same words here.

// --- Settings -----------------------------------------------------------------------

export const HD_CLAUDE_DESK_KEY = "hd_claude_desk";

export type ClaudeDeskCap = "read" | "search" | "web" | "changes" | "drafts";

export interface ClaudeDeskConfig {
  /** The whole feature (off until an admin turns it on). */
  enabled: boolean;
  /** Teams Claude is switched off for (every other team has it). */
  teams_off: number[];
  /** What Claude can do (c3 "What Claude can do"). */
  caps: Record<ClaudeDeskCap, boolean>;
  /** Web search: only these sites (allowed_domains), at most this many searches a turn. */
  web_domains: string[];
  web_max_uses: number;
  /** Monthly limits in US dollars (estimated cost); null = no limit. */
  limit_workspace_usd: number | null;
  limit_agent_usd: number | null;
}

export const CLAUDE_DESK_DEFAULTS: ClaudeDeskConfig = {
  enabled: false,
  teams_off: [],
  caps: { read: true, search: true, web: false, changes: true, drafts: true },
  web_domains: [],
  web_max_uses: 3,
  limit_workspace_usd: null,
  limit_agent_usd: null,
};

export const CLAUDE_DESK_CAPS: ClaudeDeskCap[] = ["read", "search", "web", "changes", "drafts"];

/** c3, exactly as drawn. The web row's hint is built from the allowed sites. */
export const CLAUDE_DESK_CAP_LABEL: Record<ClaudeDeskCap, string> = {
  read: "Read tickets, notes and your articles",
  search: "Search past solved tickets and assets",
  web: "Search the web",
  changes: "Suggest ticket changes",
  drafts: "Draft replies and internal notes",
};
export const CLAUDE_DESK_CAP_HINT: Record<ClaudeDeskCap, string> = {
  read: "Only what the agent can see, with their desk role and teams.",
  search: "To find what fixed the same problem before.",
  web: "Only the sites you list.",
  changes: "Status, priority, tags and team, applied only when the agent clicks Apply.",
  drafts: "Put in the agent's reply box. A person always sends.",
};

export function webHint(domains: readonly string[]): string {
  return domains.length ? `Only these sites: ${domains.join(", ")}` : "Add the sites Claude may search. With none listed, web search stays off.";
}

export const CLAUDE_DESK_LIMITS = {
  /** Allowed sites, each a plain hostname (1 to 64, as the web search tool takes). */
  domains: 64,
  domain: 253,
  maxUses: 10,
  /** Dollars. */
  limit: 100_000,
  /** Characters of one question. */
  question: 4_000,
};

/** A plain hostname as allowed_domains takes it (no scheme, path, port, IP, wildcard or single label). */
export function cleanDomain(raw: string): string | null {
  const d = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (!d || d.length > CLAUDE_DESK_LIMITS.domain) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(d)) return null;
  if (/^\d+(\.\d+)+$/.test(d)) return null;
  return d;
}

/** Validate a settings patch from the page; the error is the page's sentence. */
export function validateClaudeDeskPatch(raw: unknown): { ok: true; value: Partial<ClaudeDeskConfig> } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Send the settings as JSON." };
  const b = raw as Record<string, unknown>;
  const out: Partial<ClaudeDeskConfig> = {};
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") return { ok: false, error: "enabled is true or false." };
    out.enabled = b.enabled;
  }
  if (b.teams_off !== undefined) {
    if (!Array.isArray(b.teams_off) || b.teams_off.length > 500 || !b.teams_off.every((n) => Number.isInteger(n) && (n as number) > 0)) {
      return { ok: false, error: "teams_off is a list of team ids." };
    }
    out.teams_off = [...new Set(b.teams_off as number[])].sort((x, y) => x - y);
  }
  if (b.caps !== undefined) {
    if (!b.caps || typeof b.caps !== "object" || Array.isArray(b.caps)) return { ok: false, error: "caps is an object of switches." };
    const c = b.caps as Record<string, unknown>;
    const caps = {} as Record<ClaudeDeskCap, boolean>;
    for (const k of CLAUDE_DESK_CAPS) {
      if (c[k] === undefined) continue;
      if (typeof c[k] !== "boolean") return { ok: false, error: `caps.${k} is true or false.` };
      caps[k] = c[k] as boolean;
    }
    out.caps = caps;
  }
  if (b.web_domains !== undefined) {
    if (!Array.isArray(b.web_domains) || b.web_domains.length > CLAUDE_DESK_LIMITS.domains) {
      return { ok: false, error: `List up to ${CLAUDE_DESK_LIMITS.domains} sites.` };
    }
    const list: string[] = [];
    for (const d of b.web_domains) {
      const clean = typeof d === "string" ? cleanDomain(d) : null;
      if (!clean) return { ok: false, error: `"${String(d).slice(0, 80)}" isn't a site name. Use names like support.microsoft.com.` };
      if (!list.includes(clean)) list.push(clean);
    }
    out.web_domains = list;
  }
  if (b.web_max_uses !== undefined) {
    const n = Number(b.web_max_uses);
    if (!Number.isInteger(n) || n < 1 || n > CLAUDE_DESK_LIMITS.maxUses) return { ok: false, error: `Searches per answer: 1 to ${CLAUDE_DESK_LIMITS.maxUses}.` };
    out.web_max_uses = n;
  }
  for (const k of ["limit_workspace_usd", "limit_agent_usd"] as const) {
    if (b[k] === undefined) continue;
    if (b[k] === null || b[k] === "") {
      out[k] = null;
      continue;
    }
    const n = Number(b[k]);
    if (!Number.isFinite(n) || n < 0 || n > CLAUDE_DESK_LIMITS.limit) return { ok: false, error: "A limit is a dollar amount, or empty for none." };
    out[k] = Math.round(n * 100) / 100;
  }
  return { ok: true, value: out };
}

// --- The launcher and the panel ------------------------------------------------------

export type ClaudeIntent = "summary" | "draft" | "research";

/** c2's quick prompts, each with the effort its task needs (lib/helpdesk/claude/turn effortFor). */
export const CLAUDE_QUICK_PROMPTS: { text: string; intent: ClaudeIntent }[] = [
  { text: "Summarise this ticket", intent: "summary" },
  { text: "Has this happened before?", intent: "research" },
  { text: "Draft a reply", intent: "draft" },
  { text: "Translate my reply into French", intent: "draft" },
  { text: "What should I do next?", intent: "summary" },
];

export const CLAUDE_FOOTER_NOTE = "Claude works as you, with your desk role. It drafts and suggests; you send and apply.";
export const CLAUDE_INPUT_PLACEHOLDER = "Ask Claude about this ticket, or ask it to do something…";
export const CLAUDE_INPUT_PLACEHOLDER_NO_TICKET = "Ask Claude about your tickets or articles…";
export const CLAUDE_DATA_NOTICE = "Ticket text is sent to Anthropic to answer each request. Every chat and every change Claude suggests is in the audit log.";
export const CLAUDE_ESTIMATE_NOTE = "Costs are estimates from token counts at Anthropic's list prices.";
export const CLAUDE_REFUSAL_MESSAGE = "Claude can't help with this request. Try asking in a different way, or carry on without Claude.";

// --- Prices (an estimate; US dollars per million tokens) -------------------------------

export interface ClaudePrice {
  input: number;
  output: number;
  /** Cache reads (Opus 5.5 and Sonnet 5.5: $0.20; otherwise 0.1x input). */
  cacheRead: number;
  /** 5-minute cache writes: 1.25x input. */
  cacheWrite: number;
  /** Haiku 5.5: prompts over this many tokens bill at the long-prompt rates. */
  longPrompt?: { over: number; input: number; output: number; cacheRead: number; cacheWrite: number };
}

export const CLAUDE_PRICES: Record<string, ClaudePrice> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    longPrompt: { over: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
  },
};

export interface ClaudeTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * The estimated cost of one request's tokens. A model outside the table
 * (an older stored id, or a refusal fallback's model) is priced as Opus 5.5,
 * the dearest of the three, so a limit is never reached late.
 */
export function estimateCostUsd(model: string, t: ClaudeTokens): number {
  let p: ClaudePrice | ClaudePrice["longPrompt"] = CLAUDE_PRICES[model] ?? CLAUDE_PRICES["claude-opus-5-5"];
  const prompt = t.input + t.cacheRead + t.cacheWrite;
  if (p && "longPrompt" in p && p.longPrompt && prompt > p.longPrompt.over) p = p.longPrompt;
  const q = p as Omit<ClaudePrice, "longPrompt">;
  const usd = (t.input * q.input + t.output * q.output + t.cacheRead * q.cacheRead + t.cacheWrite * q.cacheWrite) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

export function dollars(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// --- What the page shows -----------------------------------------------------------------

export interface ClaudeDeskUsage {
  month_usd: number;
  turns: number;
  /** Drafts the agent then sent (a reply or note of the same kind on that ticket within a day), as a share; null with no drafts. */
  drafts_used_percent: number | null;
  top_user: { name: string; usd: number } | null;
}

export interface ClaudeDeskAdminView {
  config: ClaudeDeskConfig;
  teams: { id: number; name: string }[];
  usage: ClaudeDeskUsage;
  /** Settings → AI: the model and whether a usable key is there. */
  model: string;
  model_label: string;
  key_ready: boolean;
  /** "anthropic" or another provider (Claude in the desk needs the Anthropic key). */
  provider: string;
  /** Web search is offered for this model and provider (platform availability). */
  web_available: boolean;
}

// --- The chat stream ---------------------------------------------------------------------

export interface ClaudeSource {
  kind: "ticket" | "article" | "web";
  label: string;
  href: string;
}

export interface ClaudeDraftCard {
  id: number;
  kind: "reply" | "note";
  number: number;
  /** "Reply draft for Daniel" / "Internal note draft". */
  title: string;
  body: string;
  /** Written while other tickets were in view, or names one: never put in the box without a click. */
  cites_other?: boolean;
  state: "offered" | "applied" | "skipped";
}

export interface ClaudeChangeCard {
  id: number;
  kind: "change";
  number: number;
  /** The desk PATCH body (status, priority, tags, team_id, assignee_id). */
  patch: Record<string, unknown>;
  /** "Set status to Waiting on requester". */
  title: string;
  /** "After you send the reply." */
  hint: string;
  state: "offered" | "applied" | "skipped";
}

export interface ClaudeChecklistCard {
  id: number;
  kind: "checklist";
  number: number;
  template_id: number;
  title: string;
  hint: string;
  state: "offered" | "applied" | "skipped";
}

export type ClaudeCard = ClaudeDraftCard | ClaudeChangeCard | ClaudeChecklistCard;

/** One server-sent event of a chat turn (data: JSON). */
export type ClaudeStreamEvent =
  | { type: "start"; chat_id: number; model: string }
  | { type: "text"; delta: string }
  /** A step is re-run: keep only the first `keep` characters of the answer so far. */
  | { type: "rewind"; keep: number }
  | { type: "activity"; label: string; icon: "search" | "book" | "package" | "ticket" | "list" | "globe" | "message" }
  | { type: "card"; card: ClaudeCard }
  | { type: "sources"; sources: ClaudeSource[] }
  | { type: "notice"; tone: "warn" | "error"; message: string }
  | { type: "refusal"; message: string }
  | { type: "done"; stop_reason: string };

/** A turn as the history shows it. */
export interface ClaudeChatTurn {
  id: number;
  role: "user" | "assistant";
  text: string;
  activity: { label: string; icon: string }[];
  sources: ClaudeSource[];
  cards: ClaudeCard[];
  notice?: { tone: "warn" | "error"; message: string } | null;
  at: string;
}

export interface ClaudeChatHistory {
  chat_id: number | null;
  turns: ClaudeChatTurn[];
  /** Earlier chats on this ticket (newest first), for the history menu. */
  chats: { id: number; title: string; at: string }[];
}
