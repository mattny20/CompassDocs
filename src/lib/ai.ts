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
