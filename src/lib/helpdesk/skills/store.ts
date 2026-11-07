// Helpdesk 1.19.2: skills and languages (agent W2), the tables. The
// workspace's skills and languages, each agent's tags, and the ticket's
// language (hd_tickets.language / language_source): from the requester's
// directory entry when it has one, else detected from the first message on
// this server (./detect), else unknown; agents can change it. Every query
// waits for lib/db's boot (its SCHEMA applies HD_SKILLS_SCHEMA). Server-only.

import "server-only";
import { dbReady } from "../../db";
import { hq, withTx, type HdQueryable } from "../db-core";
import { detectLanguage } from "./detect";
import { mdInline } from "../md-inline";
import {
  SKILL_LIMITS,
  isLanguageCode,
  languageName,
  normalizeLanguage,
  type HdAgentTags,
  type HdLanguageSource,
  type HdSkill,
  type HdWorkspaceLanguage,
} from "./shared";

/** A refused change, with the HTTP status the route answers. */
export class SkillsError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = [], client?: HdQueryable): Promise<T[]> {
  if (!client) await dbReady();
  return hq<T>(sql, params, client);
}

// --- Skills ---------------------------------------------------------------------------

/** The workspace's skills, in order, with how many active agents have each. */
export async function listSkills(): Promise<HdSkill[]> {
  return q<HdSkill>(
    `SELECT s.id, s.name, s.position,
            (SELECT count(*)::int FROM hd_agent_skills a JOIN users u ON u.id = a.user_id AND u.status = 'active' WHERE a.skill_id = s.id) AS agent_count
       FROM hd_skills s ORDER BY s.position, lower(s.name), s.id`
  );
}

export async function getSkill(id: number): Promise<{ id: number; name: string } | undefined> {
  return (await q<{ id: number; name: string }>("SELECT id, name FROM hd_skills WHERE id = $1", [id]))[0];
}

export async function createSkill(name: string, byId: number | null): Promise<{ id: number; name: string }> {
  await dbReady();
  return withTx(async (client) => {
    await client.query("LOCK TABLE hd_skills IN SHARE ROW EXCLUSIVE MODE");
    const n = (await client.query<{ n: number }>("SELECT count(*)::int AS n FROM hd_skills")).rows[0].n;
    if (n >= SKILL_LIMITS.skills) throw new SkillsError(`Up to ${SKILL_LIMITS.skills} skills.`, 409);
    const dupe = (await client.query("SELECT 1 FROM hd_skills WHERE lower(name) = lower($1)", [name])).rows[0];
    if (dupe) throw new SkillsError(`There is already a skill called ${name}.`, 409);
    return (
      await client.query<{ id: number; name: string }>(
        `INSERT INTO hd_skills (name, position, created_by) VALUES ($1, (SELECT COALESCE(max(position), -1) + 1 FROM hd_skills), $2) RETURNING id, name`,
        [name, byId]
      )
    ).rows[0];
  });
}

export async function renameSkill(id: number, name: string): Promise<{ id: number; name: string; before: string } | undefined> {
  const before = await getSkill(id);
  if (!before) return undefined;
  const dupe = await q("SELECT 1 FROM hd_skills WHERE lower(name) = lower($1) AND id <> $2", [name, id]);
  if (dupe.length) throw new SkillsError(`There is already a skill called ${name}.`, 409);
  try {
    const row = (await q<{ id: number; name: string }>("UPDATE hd_skills SET name = $2 WHERE id = $1 RETURNING id, name", [id, name]))[0];
    return row ? { ...row, before: before.name } : undefined;
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new SkillsError(`There is already a skill called ${name}.`, 409);
    throw e;
  }
}

/** Assignment rules whose "agent with the right skills" action needs this skill or language. */
async function rulesNeeding(kind: "skill" | "language", value: number | string): Promise<string[]> {
  const rows = await q<{ name: string }>(
    kind === "skill"
      ? `SELECT name FROM hd_assignment_rules WHERE action ->> 'assign' = 'skills' AND (action -> 'skills' -> 'skill_ids') @> to_jsonb(ARRAY[$1::int]) ORDER BY position, id`
      : `SELECT name FROM hd_assignment_rules WHERE action ->> 'assign' = 'skills' AND action -> 'skills' ->> 'language' = $1 ORDER BY position, id`,
    [value]
  ).catch(() => []);
  return rows.map((r) => r.name);
}

function inUseError(what: string, rules: string[]): SkillsError {
  const names = rules.slice(0, 3).map((r) => `“${r}”`).join(", ");
  const more = rules.length > 3 ? ` and ${rules.length - 3} more` : "";
  return new SkillsError(`${rules.length === 1 ? "The assignment rule" : "The assignment rules"} ${names}${more} ${rules.length === 1 ? "needs" : "need"} ${what}. Change ${rules.length === 1 ? "it" : "them"} first.`, 409);
}

/** Delete a skill (and every agent's tag for it). Refused while an assignment rule needs it. */
export async function deleteSkill(id: number): Promise<{ id: number; name: string; agents: number; tickets: number } | undefined> {
  const s = await getSkill(id);
  if (!s) return undefined;
  const rules = await rulesNeeding("skill", id);
  if (rules.length) throw inUseError(`the skill ${s.name}`, rules);
  await dbReady();
  return withTx(async (client) => {
    const row = (await client.query<{ id: number; name: string }>("SELECT id, name FROM hd_skills WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!row) return undefined;
    const agents = (await client.query<{ n: number }>("SELECT count(*)::int AS n FROM hd_agent_skills WHERE skill_id = $1", [id])).rows[0]?.n ?? 0;
    const tickets = await forgetInQueuedDecisions(client, { skillId: id }, `the skill ${mdInline(row.name)}`);
    await client.query("DELETE FROM hd_skills WHERE id = $1", [id]);
    return { ...row, agents, tickets };
  });
}

const NOTE_AUTHOR = "Assignment";

/**
 * Tickets waiting in the assignment queue for "an agent with the right
 * skills or language" stop needing a deleted skill or a removed language,
 * in the caller's transaction: the skill or language leaves the waiting
 * decision, and a decision left needing nothing becomes the team's turn.
 * One internal note per ticket says so. Returns how many tickets changed.
 */
async function forgetInQueuedDecisions(client: import("pg").PoolClient, what: { skillId?: number; language?: string }, label: string): Promise<number> {
  const rows = (
    await client.query<{ ticket_id: number; decision: Record<string, unknown> }>(
      `SELECT ticket_id, decision FROM hd_assignment_ticket
        WHERE queued_since IS NOT NULL AND decision ->> 'kind' = 'skills'
          AND ${what.skillId !== undefined ? "(decision -> 'skills' -> 'skill_ids') @> to_jsonb(ARRAY[$1::int])" : "decision -> 'skills' ->> 'language' = $1"}
        FOR UPDATE`,
      [what.skillId ?? what.language]
    )
  ).rows;
  for (const r of rows) {
    const c = (r.decision.skills ?? {}) as { language?: string | null; skill_ids?: number[]; fallback?: string };
    const skill_ids = (c.skill_ids ?? []).filter((x) => x !== what.skillId);
    const language = what.language !== undefined && c.language === what.language ? null : c.language ?? null;
    const left = Boolean(language) || skill_ids.length > 0;
    const decision = left ? { ...r.decision, skills: { ...c, language, skill_ids } } : { ...r.decision, kind: "team_mode", skills: undefined };
    await client.query("UPDATE hd_assignment_ticket SET decision = $2, updated_at = now() WHERE ticket_id = $1", [r.ticket_id, JSON.stringify(decision)]);
    await client.query(
      `INSERT INTO hd_messages (ticket_id, author_name, kind, body, via, created_at) VALUES ($1, $2, 'internal', $3, 'system', now())`,
      [r.ticket_id, NOTE_AUTHOR, left ? `${cap(label)} was removed, so this ticket no longer needs it while it waits.` : `${cap(label)} was removed, so this ticket now waits for the team's turn.`]
    );
  }
  return rows.length;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// --- Languages --------------------------------------------------------------------------

export async function listWorkspaceLanguages(): Promise<HdWorkspaceLanguage[]> {
  const rows = await q<{ code: string; agent_count: number }>(
    `SELECT l.code,
            (SELECT count(*)::int FROM hd_agent_languages a JOIN users u ON u.id = a.user_id AND u.status = 'active' WHERE a.code = l.code) AS agent_count
       FROM hd_languages l`
  );
  return rows.map((r) => ({ ...r, name: languageName(r.code) })).sort((a, b) => b.agent_count - a.agent_count || a.name.localeCompare(b.name));
}

export async function addLanguage(code: string, byId: number | null): Promise<boolean> {
  if (!isLanguageCode(code)) throw new SkillsError("Unknown language.");
  const n = (await q<{ n: number }>("SELECT count(*)::int AS n FROM hd_languages"))[0]?.n ?? 0;
  if (n >= SKILL_LIMITS.languages) throw new SkillsError(`Up to ${SKILL_LIMITS.languages} languages.`, 409);
  const row = await q("INSERT INTO hd_languages (code, created_by) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING RETURNING code", [code, byId]);
  return row.length > 0;
}

/** Remove a language from the workspace (and from every agent). Refused while an assignment rule needs it. */
export async function removeLanguage(code: string): Promise<{ code: string; agents: number; tickets: number } | undefined> {
  const exists = await q("SELECT 1 FROM hd_languages WHERE code = $1", [code]);
  if (!exists.length) return undefined;
  const rules = await rulesNeeding("language", code);
  if (rules.length) throw inUseError(`agents who speak ${languageName(code)}`, rules);
  await dbReady();
  return withTx(async (client) => {
    const row = (await client.query("SELECT code FROM hd_languages WHERE code = $1 FOR UPDATE", [code])).rows[0];
    if (!row) return undefined;
    const agents = (await client.query<{ n: number }>("SELECT count(*)::int AS n FROM hd_agent_languages WHERE code = $1", [code])).rows[0]?.n ?? 0;
    const tickets = await forgetInQueuedDecisions(client, { language: code }, `the language ${languageName(code)}`);
    await client.query("DELETE FROM hd_languages WHERE code = $1", [code]);
    return { code, agents, tickets };
  });
}

// --- Agents' tags --------------------------------------------------------------------------

/** Each person's skills and languages (people without tags are absent). */
export async function agentTagsFor(userIds: number[], client?: HdQueryable): Promise<Map<number, HdAgentTags>> {
  const out = new Map<number, HdAgentTags>();
  if (!userIds.length) return out;
  const [skills, langs] = await Promise.all([
    q<{ user_id: number; skill_id: number }>("SELECT user_id, skill_id FROM hd_agent_skills WHERE user_id = ANY($1::int[]) ORDER BY skill_id", [userIds], client),
    q<{ user_id: number; code: string }>("SELECT user_id, code FROM hd_agent_languages WHERE user_id = ANY($1::int[]) ORDER BY code", [userIds], client),
  ]);
  const get = (id: number) => {
    let t = out.get(id);
    if (!t) out.set(id, (t = { skill_ids: [], languages: [] }));
    return t;
  };
  for (const s of skills) get(s.user_id).skill_ids.push(s.skill_id);
  for (const l of langs) get(l.user_id).languages.push(l.code);
  return out;
}

/** Replace one person's tags. Skills must exist and languages must be the workspace's. Returns before and after. */
export async function setAgentTags(userId: number, tags: HdAgentTags): Promise<{ before: HdAgentTags; after: HdAgentTags }> {
  await dbReady();
  return withTx(async (client) => {
    if (tags.skill_ids.length) {
      const found = (await client.query<{ id: number }>("SELECT id FROM hd_skills WHERE id = ANY($1::int[])", [tags.skill_ids])).rows;
      if (found.length !== tags.skill_ids.length) throw new SkillsError("That skill no longer exists. Reload and try again.", 409);
    }
    if (tags.languages.length) {
      const found = (await client.query<{ code: string }>("SELECT code FROM hd_languages WHERE code = ANY($1::text[])", [tags.languages])).rows;
      if (found.length !== tags.languages.length) throw new SkillsError("Add the language to the workspace first.", 409);
    }
    // One change per person at a time: their users row, locked without blocking the foreign keys that point at it.
    const person = (await client.query("SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE", [userId])).rows[0];
    if (!person) throw new SkillsError("No such person.", 404);
    const before = (await agentTagsFor([userId], client)).get(userId) ?? { skill_ids: [], languages: [] };
    await client.query("DELETE FROM hd_agent_skills WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM hd_agent_languages WHERE user_id = $1", [userId]);
    if (tags.skill_ids.length) {
      await client.query("INSERT INTO hd_agent_skills (user_id, skill_id) SELECT $1, unnest($2::int[])", [userId, tags.skill_ids]);
    }
    if (tags.languages.length) {
      await client.query("INSERT INTO hd_agent_languages (user_id, code) SELECT $1, unnest($2::text[])", [userId, tags.languages]);
    }
    const after = (await agentTagsFor([userId], client)).get(userId) ?? { skill_ids: [], languages: [] };
    return { before, after };
  });
}

// --- The ticket's language --------------------------------------------------------------------

/** The directory fields that hold a person's language (Microsoft Graph preferredLanguage, or a field named so). */
const LANGUAGE_FIELD_KEYS = ["language", "preferred_language", "preferredlanguage", "locale", "lang", "languages"];

/**
 * The requester's language from their directory entry: a custom directory
 * field mapped to Graph's preferredLanguage, or keyed language / locale,
 * read as the directory shows it (an admin's value over the synced one,
 * lib/directory). Hidden entries and admins-only fields are never read:
 * the language is shown to every agent on the ticket. null when there is no entry, no such
 * field, or a value the catalogue doesn't know.
 */
export async function directoryLanguage(requesterId: number | null, email: string): Promise<string | null> {
  if (requesterId === null && !email) return null;
  const rows = await q<{ value: string | null }>(
    `SELECT (p.synced || p.custom) ->> f.key AS value
       FROM directory_people p
       JOIN directory_fields f ON (lower(f.key) = ANY($3::text[]) OR f.graph_path = 'preferredLanguage') AND f.visibility <> 'admins'
      WHERE p.hidden = 0
        AND (p.id = (SELECT directory_person_id FROM users WHERE id = $1)
             OR ($1::int IS NULL AND $2 <> '' AND lower(p.email) = lower($2)))
      ORDER BY (f.graph_path = 'preferredLanguage') DESC, f.sort, f.id
      LIMIT 5`,
    [requesterId, email, LANGUAGE_FIELD_KEYS]
  ).catch(() => []);
  for (const r of rows) {
    // A tag field ("French, English") lists the first language first.
    const first = (r.value ?? "").split(/[,;]/)[0];
    const code = normalizeLanguage(first);
    if (code) return code;
  }
  return null;
}

export interface TicketLanguage {
  language: string | null;
  source: HdLanguageSource | "";
}

export async function getTicketLanguage(ticketId: number): Promise<TicketLanguage> {
  const row = (await q<{ language: string | null; language_source: string }>("SELECT language, language_source FROM hd_tickets WHERE id = $1", [ticketId]))[0];
  return { language: row?.language ?? null, source: (row?.language_source || "") as TicketLanguage["source"] };
}

/**
 * Work out a new ticket's language, once: the requester's directory entry,
 * else the subject and first message (detected here; the text never leaves
 * the server), else it stays unknown. Leaves a language that is already set
 * alone. lib/helpdesk/events afterTicketCreated calls it before assignment,
 * so the rules see it. Never throws.
 */
export async function assignLanguageOnCreate(ticketId: number): Promise<TicketLanguage> {
  try {
    await dbReady();
    const t = (
      await q<{ language: string | null; requester_id: number | null; requester_email: string; subject: string; body: string; automated: number }>(
        `SELECT t.language, t.requester_id, t.requester_email, t.subject,
                COALESCE((to_jsonb(t) ->> 'automated')::int, 0) AS automated,
                COALESCE((SELECT m.body FROM hd_messages m WHERE m.ticket_id = t.id AND m.kind = 'public'
                           ORDER BY m.created_at, m.id LIMIT 1), '') AS body
           FROM hd_tickets t WHERE t.id = $1`,
        [ticketId]
      )
    )[0];
    if (!t) return { language: null, source: "" };
    if (t.language) return getTicketLanguage(ticketId);
    let code: string | null = null;
    let source: HdLanguageSource | "" = "";
    if (!t.automated) {
      code = await directoryLanguage(t.requester_id, t.requester_email ?? "");
      if (code) source = "directory";
    }
    if (!code) {
      const guess = detectLanguage(`${t.subject ?? ""}\n${t.body ?? ""}`);
      if (guess) {
        code = guess.code;
        source = "detected";
      }
    }
    if (!code) return { language: null, source: "" };
    await q("UPDATE hd_tickets SET language = $2, language_source = $3 WHERE id = $1 AND language IS NULL", [ticketId, code, source]);
    return getTicketLanguage(ticketId);
  } catch {
    return { language: null, source: "" };
  }
}

/**
 * An agent sets (or clears) the ticket's language: one internal line on the
 * timeline ("Sam changed the language from English to French"), never seen
 * by the requester. Returns the language before, or undefined when nothing
 * changed.
 */
export async function setTicketLanguage(
  ticketId: number,
  code: string | null,
  actor: { id: number; name: string }
): Promise<{ before: string | null; after: string | null } | undefined> {
  if (code !== null && !isLanguageCode(code)) throw new SkillsError("Unknown language.");
  await dbReady();
  return withTx(async (client) => {
    const row = (await client.query<{ language: string | null }>("SELECT language FROM hd_tickets WHERE id = $1 FOR UPDATE", [ticketId])).rows[0];
    if (!row) return undefined;
    if ((row.language ?? null) === code) return undefined;
    await client.query("UPDATE hd_tickets SET language = $2, language_source = $3, updated_at = now() WHERE id = $1", [ticketId, code, code ? "agent" : ""]);
    const from = row.language ? mdInline(languageName(row.language)) : "";
    const who = mdInline(actor.name);
    const body = code
      ? from
        ? `${who} changed the language from ${from} to ${mdInline(languageName(code))}`
        : `${who} set the language to ${mdInline(languageName(code))}`
      : `${who} cleared the language (it was ${from})`;
    await client.query(
      `INSERT INTO hd_messages (ticket_id, author_id, author_name, kind, body, via, created_at) VALUES ($1, $2, $3, 'internal', $4, 'system', now())`,
      [ticketId, actor.id, actor.name, body]
    );
    return { before: row.language ?? null, after: code };
  });
}
