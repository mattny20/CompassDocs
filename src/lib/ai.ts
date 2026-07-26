import Anthropic from "@anthropic-ai/sdk";
import { hybridRetrieveForAnswer } from "./embeddings";
import { searchPeopleForAnswer } from "./directory";
import type { DirectoryPerson } from "./directory";
import { getAnthropicKey, getAiModel } from "./ai-config";
import type { Document } from "./types";

export interface AiSource {
  id: number;
  title: string;
  type: string;
  space_id: number;
}

export interface AiPerson {
  id: number;
  name: string;
  title: string;
  department: string;
  email: string;
  phone: string;
  office: string;
  photo: string;
}

export interface AiAnswer {
  answer: string;
  sources: AiSource[];
  /** People-directory matches relevant to the question (may be empty). */
  people: AiPerson[];
  /** "ai" when synthesized by Claude, "fallback" when no API key is configured. */
  mode: "ai" | "fallback";
}

function toSources(docs: Document[]): AiSource[] {
  return docs.map((d) => ({ id: d.id, title: d.title, type: d.type, space_id: d.space_id }));
}

/** Build the grounded context block handed to the model. */
function toPeople(rows: DirectoryPerson[]): AiPerson[] {
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    title: p.title ?? "",
    department: p.department ?? "",
    email: p.email ?? "",
    phone: p.phone || p.mobile || "",
    office: p.office ?? "",
    photo: p.photo ?? "",
  }));
}

function peopleContext(people: AiPerson[]): string {
  if (people.length === 0) return "";
  const lines = people
    .map(
      (p) =>
        `- ${p.name}${p.title ? ` — ${p.title}` : ""}${p.department ? ` (${p.department})` : ""}${p.email ? `, ${p.email}` : ""}${p.phone ? `, ${p.phone}` : ""}${p.office ? `, office: ${p.office}` : ""}`
    )
    .join("\n");
  return `\n\nPeople directory matches:\n${lines}`;
}

function buildContext(docs: Document[]): string {
  return docs
    .map(
      (d, i) =>
        `[Doc ${i + 1}] "${d.title}" (id=${d.id}, type=${d.type})\n${d.content.slice(0, 3500)}`
    )
    .join("\n\n---\n\n");
}

/** Fallback answer when no ANTHROPIC_API_KEY is set: return the best snippets. */
function fallbackAnswer(question: string, docs: Document[], people: AiPerson[] = []): AiAnswer {
  if (docs.length === 0) {
    return {
      answer:
        people.length > 0
          ? "No documents matched, but the people below (from the directory) look relevant."
          : "I couldn't find anything in the knowledge base matching that question. Try different keywords, or browse the spaces from the sidebar.",
      sources: [],
      people,
      mode: "fallback",
    };
  }
  const bullets = docs
    .slice(0, 3)
    .map((d) => {
      const line = (d.summary || d.content.replace(/[#>*`_-]/g, " ")).trim().replace(/\s+/g, " ");
      return `- **${d.title}** — ${line.slice(0, 180)}`;
    })
    .join("\n");
  return {
    answer:
      `AI synthesis is off (no API key configured), so here are the most relevant documents for _"${question}"_:\n\n` +
      bullets +
      `\n\nOpen a source below to read the full document.`,
    sources: toSources(docs),
    people,
    mode: "fallback",
  };
}

// --- Proofreading ------------------------------------------------------------

export interface ProofChange {
  /** Category of the fix: "spelling" | "grammar" | "punctuation" | "clarity". */
  type: string;
  /** A short snippet of the original text. */
  before: string;
  /** What it was changed to. */
  after: string;
  /** A brief, plain-language reason. */
  note: string;
}

export interface ProofResult {
  /** "ai" when Claude reviewed it; "unavailable" when no API key is configured. */
  mode: "ai" | "unavailable";
  /** The full corrected document (Markdown), when mode is "ai". */
  revised?: string;
  /** Notable changes, for a human to skim before applying. */
  changes?: ProofChange[];
  /** True if the input was too long and only the start was proofread. */
  truncated?: boolean;
  /** Human-readable status (e.g. why it's unavailable, or "no changes needed"). */
  message?: string;
}

const PROOF_MAX_CHARS = 12_000;

/** Extract the first top-level JSON object from a model response. */
function extractJson(text: string): any | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Grammar, spelling, and clarity proofreading of a document. Preserves meaning
 * and Markdown structure; returns a corrected version plus a list of notable
 * changes. Degrades to `mode: "unavailable"` when no ANTHROPIC_API_KEY is set.
 */
export async function proofread(content: string): Promise<ProofResult> {
  const text = content ?? "";
  if (!text.trim()) {
    return { mode: "ai", revised: text, changes: [], message: "Nothing to proofread yet." };
  }
  const apiKey = await getAnthropicKey();
  if (!apiKey) {
    return {
      mode: "unavailable",
      message:
        "AI proofreading needs an Anthropic API key. An admin can add one in Settings → AI.",
    };
  }

  const truncated = text.length > PROOF_MAX_CHARS;
  const input = truncated ? text.slice(0, PROOF_MAX_CHARS) : text;

  try {
    const client = new Anthropic({ apiKey });
    const system = `You are a meticulous copy editor for a team's internal documentation.
Fix spelling, grammar, punctuation, and awkward or unclear phrasing.
Strict rules:
- PRESERVE the original meaning. Do not add, remove, or invent facts, steps, numbers, or links.
- PRESERVE all Markdown structure and syntax: headings, lists, tables, links, and especially fenced code blocks and inline code — never alter text inside code.
- Keep the author's voice; make the smallest edits that fix real problems. If the text is already clean, return it unchanged with an empty changes list.
- Respond with ONLY a JSON object, no prose before or after, in this exact shape:
{"revised": "<the full corrected Markdown>", "changes": [{"type": "spelling|grammar|punctuation|clarity", "before": "<short original snippet>", "after": "<corrected snippet>", "note": "<brief reason>"}]}`;

    const response = await client.messages.create({
      model: await getAiModel(),
      max_tokens: 8192,
      system,
      messages: [{ role: "user", content: `Proofread this document:\n\n${input}` }],
    });

    const raw = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    const parsed = extractJson(raw);
    if (!parsed || typeof parsed.revised !== "string") {
      return { mode: "unavailable", message: "The proofreader returned an unexpected response. Try again." };
    }

    // If we truncated, stitch the untouched remainder back on.
    const revised = truncated ? parsed.revised + text.slice(PROOF_MAX_CHARS) : parsed.revised;
    const changes: ProofChange[] = Array.isArray(parsed.changes)
      ? parsed.changes
          .filter((c: any) => c && typeof c.before === "string" && typeof c.after === "string")
          .slice(0, 50)
          .map((c: any) => ({
            type: String(c.type || "clarity"),
            before: String(c.before).slice(0, 200),
            after: String(c.after).slice(0, 200),
            note: String(c.note || "").slice(0, 200),
          }))
      : [];

    return {
      mode: "ai",
      revised,
      changes,
      truncated,
      message: changes.length === 0 ? "Looks clean — no changes suggested." : undefined,
    };
  } catch (err) {
    console.error("Proofread failed:", err);
    return { mode: "unavailable", message: "Proofreading failed (API error). Please try again." };
  }
}

// --- Writing assist ----------------------------------------------------------

export type WriteAction =
  | "draft"
  | "improve"
  | "expand"
  | "shorten"
  | "summarize"
  | "tone";

export type WriteTone = "professional" | "friendly" | "concise" | "confident";

export interface WriteResult {
  /** "ai" when Claude produced it; "unavailable" when no API key is configured. */
  mode: "ai" | "unavailable";
  /** The generated Markdown (or, for "summarize", a plain summary). */
  text?: string;
  /** True when the input was too long and only the beginning was processed. */
  truncated?: boolean;
  /** Human-readable status (e.g. why it's unavailable). */
  message?: string;
}

const WRITE_MAX_CHARS = 12_000;

const RULES = `Strict rules:
- Do NOT invent facts, figures, names, steps, dates, or links. Only work with what the author provided; where a specific detail is unknown, leave a short [placeholder] rather than making one up.
- Preserve Markdown structure and syntax: headings, lists, tables, links, and especially fenced code blocks and inline code — never alter text inside code.
- Keep the author's voice and intent. Return ONLY the resulting Markdown, with no preamble, explanation, or surrounding quotes.`;

const TONE_WORDS: Record<WriteTone, string> = {
  professional: "polished and professional",
  friendly: "warm, friendly, and approachable",
  concise: "concise and direct, trimming filler",
  confident: "confident and assertive",
};

function writeSystem(action: WriteAction, tone: WriteTone, docType: string): string {
  const kind = docType ? `The document is a ${docType}. ` : "";
  switch (action) {
    case "draft":
      return `You are a writing assistant for a team's internal documentation. ${kind}From the title alone, produce a well-structured STARTER DRAFT in Markdown: sensible headings and a few bullet points or short sentences the author can fill in. Use [placeholders] for anything specific you can't know (numbers, names, systems). Do not fabricate real details.\n${RULES}`;
    case "improve":
      return `You are an expert editor for a team's internal documentation. ${kind}Rewrite the author's text to improve clarity, flow, and structure while preserving every fact and its meaning. Tighten wording and fix awkward phrasing; do not add new information.\n${RULES}`;
    case "expand":
      return `You are a writing assistant for a team's internal documentation. ${kind}Expand the author's text with more detail, useful structure, and helpful elaboration that is clearly implied by what's already there. Do not invent specifics — use [placeholders] where a real detail would be needed.\n${RULES}`;
    case "shorten":
      return `You are an editor for a team's internal documentation. ${kind}Make the author's text significantly shorter and punchier while keeping all essential information and meaning. Remove redundancy and filler.\n${RULES}`;
    case "tone":
      return `You are an editor for a team's internal documentation. ${kind}Rewrite the author's text to be ${TONE_WORDS[tone]}, keeping all facts and meaning intact.\n${RULES}`;
    case "summarize":
      return `You are a writing assistant for a team's internal documentation. ${kind}Write a concise 1–3 sentence summary of the document, capturing what it is and its key point. Plain prose, no Markdown headings or bullets. Return ONLY the summary text.`;
  }
}

/**
 * AI writing helpers for the editor: draft from a title, improve/expand/shorten,
 * change tone, or summarize. Preserves meaning and Markdown; never invents
 * facts. Degrades to `mode: "unavailable"` when no ANTHROPIC_API_KEY is set.
 */
export async function writeAssist(input: {
  action: WriteAction;
  tone?: WriteTone;
  title?: string;
  docType?: string;
  content?: string;
}): Promise<WriteResult> {
  const action = input.action;
  const tone: WriteTone = input.tone ?? "professional";
  const title = (input.title ?? "").trim();
  const docType = (input.docType ?? "").trim();
  const rawContent = input.content ?? "";

  if (action === "draft") {
    if (!title) return { mode: "ai", message: "Add a title first, then draft from it." };
  } else if (!rawContent.trim()) {
    return { mode: "ai", message: "There's nothing to work with yet." };
  }

  const apiKey = await getAnthropicKey();
  if (!apiKey) {
    return {
      mode: "unavailable",
      message: "AI writing assist needs an Anthropic API key. An admin can add one in Settings → AI.",
    };
  }

  const truncated = rawContent.length > WRITE_MAX_CHARS;
  const content = truncated ? rawContent.slice(0, WRITE_MAX_CHARS) : rawContent;

  const userMessage =
    action === "draft"
      ? `Title: ${title}\n\nWrite the starter draft.`
      : `${title ? `Title: ${title}\n\n` : ""}Document:\n\n${content}`;

  const maxTokens = action === "summarize" ? 400 : action === "shorten" ? 2048 : 4096;

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: await getAiModel(),
      max_tokens: maxTokens,
      system: writeSystem(action, tone, docType),
      messages: [{ role: "user", content: userMessage }],
    });
    let text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (!text) {
      return { mode: "unavailable", message: "The assistant returned an empty response. Try again." };
    }

    // If a whole-document rewrite was truncated, keep the untouched remainder.
    if (truncated && action !== "summarize" && action !== "draft") {
      text = text + rawContent.slice(WRITE_MAX_CHARS);
    }

    return { mode: "ai", text, truncated: truncated && action !== "draft" };
  } catch (err) {
    console.error("Writing assist failed:", err);
    return { mode: "unavailable", message: "Writing assist failed (API error). Please try again." };
  }
}

export async function answerQuestion(
  question: string,
  includeDrafts = false,
  scope?: number[] | "all"
): Promise<AiAnswer> {
  const docs = await hybridRetrieveForAnswer(question, 6, includeDrafts, scope);
  // The people directory is workspace-wide for signed-in users, so "who"
  // questions can be answered even when no document matches.
  let people: AiPerson[] = [];
  try {
    people = toPeople(await searchPeopleForAnswer(question, 4));
  } catch {
    /* directory unavailable — answer from docs alone */
  }

  const apiKey = await getAnthropicKey();
  if (!apiKey) {
    return fallbackAnswer(question, docs, people);
  }

  if (docs.length === 0 && people.length === 0) {
    return {
      answer:
        "I searched the knowledge base but found no documents related to that question. Try rephrasing, or add a document covering this topic.",
      sources: [],
      people: [],
      mode: "ai",
    };
  }

  try {
    const client = new Anthropic({ apiKey });
    const system = `You are CompassDocs, an assistant that answers questions strictly from a team's internal knowledge base.
Rules:
- Answer ONLY from the provided documents and the people-directory matches. If they don't contain the answer, say so plainly.
- Be concise and practical. Use short paragraphs or bullet points.
- Cite the documents you used inline like [Doc 1], [Doc 2]. Cite directory facts as [Directory].
- For "who"-questions, prefer the people directory: give the person's name, title, and contact info from it.
- Never invent policies, numbers, steps, names, or contact details that aren't in the sources.`;

    const response = await client.messages.create({
      model: await getAiModel(),
      max_tokens: 1024,
      system,
      messages: [
        {
          role: "user",
          content: `Question: ${question}\n\nKnowledge base excerpts:\n\n${buildContext(docs) || "(no matching documents)"}${peopleContext(people)}`,
        },
      ],
    });

    const answer = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    return {
      answer: answer || "I wasn't able to produce an answer from the available documents.",
      sources: toSources(docs),
      people,
      mode: "ai",
    };
  } catch (err) {
    // Any API failure (bad key, rate limit, network) degrades gracefully.
    console.error("AI answer failed, falling back to snippets:", err);
    return fallbackAnswer(question, docs, people);
  }
}
