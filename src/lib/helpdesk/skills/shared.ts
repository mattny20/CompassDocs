// Helpdesk 1.19.2: skills and languages (agent W2), the pure half. The
// language catalogue (ISO 639-1 codes and English names), reading a
// language out of whatever a directory holds ("fr-CA", "French",
// "Français"), the rule action's criteria ("speaks French and knows Mac"),
// their checks and the matching of one agent's tags against them. No
// database and no server-only imports, so the settings screens, the rule
// editor and the tests import it too.

// --- Languages ---------------------------------------------------------------------

/** Every language a workspace can add, by ISO 639-1 code, with its English name. */
export const HD_LANGUAGE_NAMES: Record<string, string> = {
  af: "Afrikaans",
  ar: "Arabic",
  bg: "Bulgarian",
  bn: "Bengali",
  ca: "Catalan",
  cs: "Czech",
  cy: "Welsh",
  da: "Danish",
  de: "German",
  el: "Greek",
  en: "English",
  es: "Spanish",
  et: "Estonian",
  eu: "Basque",
  fa: "Persian",
  fi: "Finnish",
  fr: "French",
  ga: "Irish",
  gl: "Galician",
  he: "Hebrew",
  hi: "Hindi",
  hr: "Croatian",
  hu: "Hungarian",
  id: "Indonesian",
  is: "Icelandic",
  it: "Italian",
  ja: "Japanese",
  ko: "Korean",
  lt: "Lithuanian",
  lv: "Latvian",
  ms: "Malay",
  mt: "Maltese",
  nl: "Dutch",
  no: "Norwegian",
  pl: "Polish",
  pt: "Portuguese",
  ro: "Romanian",
  ru: "Russian",
  sk: "Slovak",
  sl: "Slovenian",
  sq: "Albanian",
  sr: "Serbian",
  sv: "Swedish",
  sw: "Swahili",
  ta: "Tamil",
  th: "Thai",
  tl: "Filipino",
  tr: "Turkish",
  uk: "Ukrainian",
  ur: "Urdu",
  vi: "Vietnamese",
  zh: "Chinese",
};

/** The languages the first-message detector knows (lib/helpdesk/skills/detect). */
export const HD_DETECTABLE_LANGUAGES = ["en", "fr", "de", "es", "it", "pt", "nl"] as const;

/** Names people write in a directory field besides the English one. */
const NATIVE_NAMES: Record<string, string> = {
  english: "en",
  français: "fr",
  francais: "fr",
  deutsch: "de",
  español: "es",
  espanol: "es",
  castellano: "es",
  italiano: "it",
  português: "pt",
  portugues: "pt",
  nederlands: "nl",
  vlaams: "nl",
  flemish: "nl",
  svenska: "sv",
  dansk: "da",
  norsk: "no",
  bokmål: "no",
  suomi: "fi",
  polski: "pl",
  čeština: "cs",
  magyar: "hu",
  română: "ro",
  türkçe: "tr",
  русский: "ru",
  українська: "uk",
  català: "ca",
  ελληνικά: "el",
  日本語: "ja",
  中文: "zh",
  한국어: "ko",
  mandarin: "zh",
  cantonese: "zh",
  "brazilian portuguese": "pt",
};

/** Old or alternative codes for the catalogue's. */
const CODE_ALIASES: Record<string, string> = {
  nb: "no",
  nn: "no",
  iw: "he",
  in: "id",
  fil: "tl",
  // ISO 639-2 for the common ones.
  eng: "en",
  fra: "fr",
  fre: "fr",
  deu: "de",
  ger: "de",
  spa: "es",
  ita: "it",
  por: "pt",
  nld: "nl",
  dut: "nl",
};

export function isLanguageCode(v: unknown): v is string {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(HD_LANGUAGE_NAMES, v);
}

export function languageName(code: string | null | undefined): string {
  if (!code) return "";
  return HD_LANGUAGE_NAMES[code] ?? code;
}

/**
 * A catalogue code out of what a directory or a person wrote: a BCP 47 tag
 * ("fr-CA", "pt_BR", "en"), the English name ("French") or the language's
 * own name ("Français"). null when it isn't a language the catalogue knows.
 */
export function normalizeLanguage(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (!s || s.length > 60) return null;
  const tag = /^([a-z]{2,3})(?:[-_][a-z0-9]{1,8})*$/.exec(s);
  if (tag) {
    const primary = CODE_ALIASES[tag[1]] ?? tag[1];
    if (isLanguageCode(primary)) return primary;
  }
  if (NATIVE_NAMES[s]) return NATIVE_NAMES[s];
  for (const [code, name] of Object.entries(HD_LANGUAGE_NAMES)) if (name.toLowerCase() === s) return code;
  // "French (Canada)", "English - UK": the first word.
  const first = s.split(/[\s(,/-]+/)[0];
  if (first && first !== s) return normalizeLanguage(first);
  return null;
}

/** The catalogue as picker options, by name. */
export function languageOptions(codes?: readonly string[]): { value: string; label: string }[] {
  const list = codes ?? Object.keys(HD_LANGUAGE_NAMES);
  return list
    .filter(isLanguageCode)
    .map((c) => ({ value: c, label: HD_LANGUAGE_NAMES[c] }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export const HD_LANGUAGE_SOURCES = ["directory", "detected", "agent"] as const;
export type HdLanguageSource = (typeof HD_LANGUAGE_SOURCES)[number];

export const HD_LANGUAGE_SOURCE_LABEL: Record<HdLanguageSource, string> = {
  directory: "From the requester's directory entry",
  detected: "Detected from the first message",
  agent: "Set by an agent",
};

// --- Skills ------------------------------------------------------------------------

export const SKILL_LIMITS = {
  skills: 200,
  name: 60,
  languages: 60,
  /** Skills one rule may require. */
  ruleSkills: 10,
  /** Tags on one agent. */
  agentSkills: 100,
} as const;

export interface HdSkill {
  id: number;
  name: string;
  position: number;
  agent_count: number;
}

export interface HdWorkspaceLanguage {
  code: string;
  name: string;
  agent_count: number;
}

/** One agent's tags. */
export interface HdAgentTags {
  skill_ids: number[];
  languages: string[];
}

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

export function validateSkillName(raw: unknown): Checked<string> {
  const name = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!name) return { ok: false, error: "Name the skill." };
  if (name.length > SKILL_LIMITS.name) return { ok: false, error: `Skill names are up to ${SKILL_LIMITS.name} characters.` };
  return { ok: true, value: name };
}

/** PUT body for one agent's tags: { skill_ids, languages }. Language codes must be in the catalogue; existence is the store's check. */
export function validateAgentTags(raw: Record<string, unknown>): Checked<HdAgentTags> {
  const ids = Array.isArray(raw.skill_ids) ? raw.skill_ids.map((v) => (typeof v === "string" ? Number(v) : v)) : raw.skill_ids === undefined ? [] : null;
  if (!ids || !ids.every((i) => typeof i === "number" && Number.isInteger(i) && i > 0 && i < 2 ** 31)) return { ok: false, error: "skill_ids is a list of skill ids." };
  const langs = Array.isArray(raw.languages) ? raw.languages : raw.languages === undefined ? [] : null;
  if (!langs || !langs.every(isLanguageCode)) return { ok: false, error: "languages is a list of language codes." };
  const skill_ids = [...new Set(ids as number[])];
  const languages = [...new Set(langs as string[])];
  if (skill_ids.length > SKILL_LIMITS.agentSkills || languages.length > SKILL_LIMITS.languages) return { ok: false, error: "That is too many tags for one agent." };
  return { ok: true, value: { skill_ids, languages } };
}

// --- The rule action's criteria ------------------------------------------------------

/** "ticket" = whatever language the ticket is in. */
export const TICKET_LANGUAGE = "ticket";

export interface HdSkillCriteria {
  /** A catalogue code, "ticket" (the ticket's own language) or null (any language). */
  language: string | null;
  /** Every one of these skills (ids). */
  skill_ids: number[];
  /** Nobody matching can take it: the team's turn decides, or it waits in the queue for a match. */
  fallback: "team" | "queue";
}

export const HD_SKILL_FALLBACK_LABEL: Record<HdSkillCriteria["fallback"], string> = {
  team: "Fall back to the team's turn",
  queue: "Wait in the queue for a match",
};

export function validateSkillCriteria(raw: unknown): Checked<HdSkillCriteria> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Say which skills or language the agent needs." };
  const r = raw as Record<string, unknown>;
  let language: string | null = null;
  if (r.language !== undefined && r.language !== null && r.language !== "") {
    if (r.language !== TICKET_LANGUAGE && !isLanguageCode(r.language)) return { ok: false, error: "Unknown language." };
    language = r.language as string;
  }
  const rawIds = r.skill_ids === undefined || r.skill_ids === null ? [] : r.skill_ids;
  if (!Array.isArray(rawIds)) return { ok: false, error: "skill_ids is a list of skill ids." };
  const ids = rawIds.map((v) => (typeof v === "string" ? Number(v) : v));
  if (!ids.every((i) => typeof i === "number" && Number.isInteger(i) && i > 0 && i < 2 ** 31)) return { ok: false, error: "skill_ids is a list of skill ids." };
  const skill_ids = [...new Set(ids as number[])];
  if (skill_ids.length > SKILL_LIMITS.ruleSkills) return { ok: false, error: `A rule can ask for up to ${SKILL_LIMITS.ruleSkills} skills.` };
  if (!language && !skill_ids.length) return { ok: false, error: "Choose a language or at least one skill the agent needs." };
  const fallback = r.fallback === "queue" ? "queue" : "team";
  return { ok: true, value: { language, skill_ids, fallback } };
}

/** The language a rule needs for this ticket: its own code, the ticket's language, or null (none needed). */
export function requiredLanguage(c: Pick<HdSkillCriteria, "language">, ticketLanguage: string | null): string | null {
  if (!c.language) return null;
  if (c.language === TICKET_LANGUAGE) return ticketLanguage || null;
  return c.language;
}

/** Does an agent with these tags meet the criteria for a ticket in `ticketLanguage`? */
export function agentMatches(tags: HdAgentTags | undefined, c: HdSkillCriteria, ticketLanguage: string | null): boolean {
  const t = tags ?? { skill_ids: [], languages: [] };
  const lang = requiredLanguage(c, ticketLanguage);
  if (lang && !t.languages.includes(lang)) return false;
  return c.skill_ids.every((id) => t.skill_ids.includes(id));
}

function joinAnd(list: string[]): string {
  if (list.length <= 1) return list[0] ?? "";
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/**
 * "speaks French and knows Mac", "knows Mac and Networking", "speaks the
 * ticket's language". `ticketLanguage` resolves "ticket" when known.
 */
export function criteriaText(c: Pick<HdSkillCriteria, "language" | "skill_ids">, skillName: (id: number) => string, ticketLanguage?: string | null): string {
  const parts: string[] = [];
  if (c.language === TICKET_LANGUAGE) parts.push(ticketLanguage ? `speaks ${languageName(ticketLanguage)}` : "speaks the ticket's language");
  else if (c.language) parts.push(`speaks ${languageName(c.language)}`);
  if (c.skill_ids.length) parts.push(`knows ${joinAnd(c.skill_ids.map(skillName))}`);
  return parts.join(" and ");
}

/** "2 agents match today: Ana Kowalski, Marie Bernard." */
export function matchTodayText(names: string[]): string {
  if (!names.length) return "No agent matches today.";
  const shown = names.slice(0, 6).join(", ");
  const more = names.length > 6 ? ` and ${names.length - 6} more` : "";
  return `${names.length} ${names.length === 1 ? "agent matches" : "agents match"} today: ${shown}${more}.`;
}

/**
 * The skills pick: among the matching people, whoever has waited longest
 * since their last assignment (never assigned = longest), then the lowest
 * id. "In turn" among the matches without the team's round-robin cursor,
 * which stays the team's own (a narrowed pick moving it would make the
 * team's turn skip people).
 */
export function pickLongestWaiting(candidates: { user_id: number; last_assigned_at: string | null }[]): number | null {
  if (!candidates.length) return null;
  const at = (c: { last_assigned_at: string | null }) => (c.last_assigned_at ? Date.parse(c.last_assigned_at) : -Infinity);
  return [...candidates].sort((a, b) => at(a) - at(b) || a.user_id - b.user_id)[0].user_id;
}
