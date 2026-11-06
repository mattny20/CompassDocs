// Helpdesk 1.19.2: skills and languages (agent W2), what the assignment
// engine asks. Which of a team's people meet a rule's "agent with the right
// skills or language" criteria for one ticket, and the words for it ("speaks
// French and knows Mac"); and the "N agents match today" preview for the
// rule editor. The engine (lib/helpdesk/assignment/engine) still decides
// who is available, under their cap and in the team, exactly as for round
// robin: this only narrows its pool. Server-only.

import "server-only";
import { hq } from "../db-core";
import { agentTagsFor } from "./store";
import { agentMatches, criteriaText, languageName, requiredLanguage, type HdSkillCriteria } from "./shared";

export interface SkillMatch {
  /** The people (of those asked about) who meet the criteria. */
  ids: Set<number>;
  /** "speaks French and knows Mac". */
  text: string;
  /** The language actually required for this ticket (null: none). */
  language: string | null;
  criteria: HdSkillCriteria;
  /** What the criteria name that no longer exists ("the skill 12", "French"): '' when all is there. A queued decision or a rule saved while it was deleted; the engine falls back to the team's turn, never waits for it. */
  missing: string;
}

/** Skill names by id (deleted skills read "a deleted skill"). */
export async function skillNames(ids: number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const rows = await hq<{ id: number; name: string }>("SELECT id, name FROM hd_skills WHERE id = ANY($1::int[])", [ids]);
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Who among `userIds` meets the criteria for a ticket in `ticketLanguage`. */
export async function skillMatch(userIds: number[], criteria: HdSkillCriteria, ticketLanguage: string | null): Promise<SkillMatch> {
  const [tags, names] = await Promise.all([agentTagsFor(userIds), skillNames(criteria.skill_ids)]);
  const ids = new Set(userIds.filter((id) => agentMatches(tags.get(id), criteria, ticketLanguage)));
  const language = requiredLanguage(criteria, ticketLanguage);
  const gone: string[] = [];
  if (criteria.skill_ids.some((id) => !names.has(id))) gone.push("a deleted skill");
  if (language && !(await hq("SELECT 1 FROM hd_languages WHERE code = $1", [language])).length) gone.push(`${languageName(language)}, which is no longer one of the workspace's languages`);
  return {
    ids,
    text: criteriaText(criteria, (id) => names.get(id) ?? "a deleted skill", ticketLanguage),
    language,
    criteria,
    missing: gone.join(" and "),
  };
}
