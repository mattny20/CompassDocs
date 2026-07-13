import Anthropic from "@anthropic-ai/sdk";
import { retrieveForAnswer } from "./db";
import type { Document } from "./types";

const MODEL = process.env.COMPASSDOCS_AI_MODEL || "claude-opus-4-8";

export interface AiSource {
  id: number;
  title: string;
  type: string;
  space_id: number;
}

export interface AiAnswer {
  answer: string;
  sources: AiSource[];
  /** "ai" when synthesized by Claude, "fallback" when no API key is configured. */
  mode: "ai" | "fallback";
}

function toSources(docs: Document[]): AiSource[] {
  return docs.map((d) => ({ id: d.id, title: d.title, type: d.type, space_id: d.space_id }));
}

/** Build the grounded context block handed to the model. */
function buildContext(docs: Document[]): string {
  return docs
    .map(
      (d, i) =>
        `[Doc ${i + 1}] "${d.title}" (id=${d.id}, type=${d.type})\n${d.content.slice(0, 3500)}`
    )
    .join("\n\n---\n\n");
}

/** Fallback answer when no ANTHROPIC_API_KEY is set: return the best snippets. */
function fallbackAnswer(question: string, docs: Document[]): AiAnswer {
  if (docs.length === 0) {
    return {
      answer:
        "I couldn't find anything in the knowledge base matching that question. Try different keywords, or browse the spaces from the sidebar.",
      sources: [],
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
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      mode: "unavailable",
      message:
        "AI proofreading needs an ANTHROPIC_API_KEY. Ask your admin to configure it to enable this.",
    };
  }

  const truncated = text.length > PROOF_MAX_CHARS;
  const input = truncated ? text.slice(0, PROOF_MAX_CHARS) : text;

  try {
    const client = new Anthropic();
    const system = `You are a meticulous copy editor for a team's internal documentation.
Fix spelling, grammar, punctuation, and awkward or unclear phrasing.
Strict rules:
- PRESERVE the original meaning. Do not add, remove, or invent facts, steps, numbers, or links.
- PRESERVE all Markdown structure and syntax: headings, lists, tables, links, and especially fenced code blocks and inline code — never alter text inside code.
- Keep the author's voice; make the smallest edits that fix real problems. If the text is already clean, return it unchanged with an empty changes list.
- Respond with ONLY a JSON object, no prose before or after, in this exact shape:
{"revised": "<the full corrected Markdown>", "changes": [{"type": "spelling|grammar|punctuation|clarity", "before": "<short original snippet>", "after": "<corrected snippet>", "note": "<brief reason>"}]}`;

    const response = await client.messages.create({
      model: MODEL,
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

export async function answerQuestion(
  question: string,
  includeDrafts = false
): Promise<AiAnswer> {
  const docs = await retrieveForAnswer(question, 6, includeDrafts);

  if (!process.env.ANTHROPIC_API_KEY) {
    return fallbackAnswer(question, docs);
  }

  if (docs.length === 0) {
    return {
      answer:
        "I searched the knowledge base but found no documents related to that question. Try rephrasing, or add a document covering this topic.",
      sources: [],
      mode: "ai",
    };
  }

  try {
    const client = new Anthropic();
    const system = `You are CompassDocs, an assistant that answers questions strictly from a team's internal knowledge base.
Rules:
- Answer ONLY from the provided documents. If they don't contain the answer, say so plainly.
- Be concise and practical. Use short paragraphs or bullet points.
- Cite the documents you used inline like [Doc 1], [Doc 2].
- Never invent policies, numbers, or steps that aren't in the sources.`;

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system,
      messages: [
        {
          role: "user",
          content: `Question: ${question}\n\nKnowledge base excerpts:\n\n${buildContext(docs)}`,
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
      mode: "ai",
    };
  } catch (err) {
    // Any API failure (bad key, rate limit, network) degrades gracefully.
    console.error("AI answer failed, falling back to snippets:", err);
    return fallbackAnswer(question, docs);
  }
}
