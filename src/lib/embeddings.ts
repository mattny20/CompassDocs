// Semantic search: pgvector embeddings alongside Postgres full-text search.
//
// Documents are chunked (by heading, size-capped), embedded through a
// configurable provider, and stored in doc_chunks with an untyped `vector`
// column — searched with exact cosine distance, which at knowledge-base scale
// (thousands of chunks) is milliseconds and has perfect recall, so no ANN
// index to tune. Visibility is enforced at query time by joining documents
// with the same status/space filters as full-text search.
//
// Providers speak two wire formats, both plain JSON POST:
//   - "voyage": Voyage AI (api.voyageai.com), supports input_type hints.
//   - "openai": any OpenAI-compatible /v1/embeddings — OpenAI itself, Azure
//     gateways, or local engines like Ollama / LM Studio via a custom base URL.
//
// Everything degrades gracefully: no pgvector extension, no provider, or a
// failed embed call all leave keyword search working exactly as before.

import "server-only";
import { createHash } from "crypto";
import { pool, getSetting, setSetting } from "./db";
import type { Document, SearchHit } from "./types";

async function q<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  return (await pool().query(sql, params)).rows as T[];
}

export type EmbeddingsProvider = "off" | "voyage" | "openai";

export interface EmbeddingsConfig {
  provider: EmbeddingsProvider;
  apiKey: string;
  model: string;
  baseUrl: string;
}

export const PROVIDER_DEFAULTS: Record<
  Exclude<EmbeddingsProvider, "off">,
  { model: string; baseUrl: string; label: string }
> = {
  voyage: {
    model: "voyage-3.5-lite",
    baseUrl: "https://api.voyageai.com/v1/embeddings",
    label: "Voyage AI",
  },
  openai: {
    model: "text-embedding-3-small",
    baseUrl: "https://api.openai.com/v1/embeddings",
    label: "OpenAI-compatible",
  },
};

const KEYS = {
  provider: "embeddings_provider",
  apiKey: "embeddings_api_key",
  model: "embeddings_model",
  baseUrl: "embeddings_base_url",
  indexModel: "embeddings_index_model", // model the current chunks were embedded with
};

export async function getEmbeddingsConfig(): Promise<EmbeddingsConfig> {
  const [provider, apiKey, model, baseUrl] = await Promise.all([
    getSetting(KEYS.provider),
    getSetting(KEYS.apiKey),
    getSetting(KEYS.model),
    getSetting(KEYS.baseUrl),
  ]);
  const p: EmbeddingsProvider =
    provider === "voyage" || provider === "openai" ? provider : "off";
  const defaults = p === "off" ? { model: "", baseUrl: "" } : PROVIDER_DEFAULTS[p];
  return {
    provider: p,
    apiKey: apiKey?.trim() || "",
    model: model?.trim() || defaults.model,
    // The env override exists for tests and outbound proxies.
    baseUrl:
      process.env.COMPASSDOCS_EMBEDDINGS_URL?.trim() ||
      baseUrl?.trim() ||
      defaults.baseUrl,
  };
}

export async function saveEmbeddingsConfig(patch: {
  provider?: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}): Promise<void> {
  if (patch.provider !== undefined) {
    const p = patch.provider === "voyage" || patch.provider === "openai" ? patch.provider : "off";
    await setSetting(KEYS.provider, p);
  }
  if (patch.apiKey !== undefined) await setSetting(KEYS.apiKey, patch.apiKey.trim());
  if (patch.model !== undefined) await setSetting(KEYS.model, patch.model.trim());
  if (patch.baseUrl !== undefined) await setSetting(KEYS.baseUrl, patch.baseUrl.trim());
}

// --- pgvector plumbing -------------------------------------------------------

let schemaReady = false;

/** True when the pgvector extension is (or can be) installed. */
export async function vectorAvailable(): Promise<boolean> {
  try {
    await q("CREATE EXTENSION IF NOT EXISTS vector");
    return true;
  } catch {
    // Not superuser — usable anyway if someone else installed it.
    const rows = await q<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname = 'vector'"
    );
    return rows.length > 0;
  }
}

async function ensureSchema(): Promise<boolean> {
  if (schemaReady) return true;
  if (!(await vectorAvailable())) return false;
  await q(`CREATE TABLE IF NOT EXISTS doc_chunks (
    id BIGSERIAL PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    heading TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    embedding vector NOT NULL,
    doc_hash TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (document_id, chunk_index)
  )`);
  await q("CREATE INDEX IF NOT EXISTS doc_chunks_doc ON doc_chunks (document_id)");
  schemaReady = true;
  return true;
}

// --- Provider client ---------------------------------------------------------

async function embedTexts(
  cfg: EmbeddingsConfig,
  texts: string[],
  inputType: "document" | "query"
): Promise<number[][]> {
  if (cfg.provider === "off" || !cfg.apiKey || texts.length === 0) {
    throw new Error("Embeddings are not configured.");
  }
  const body: Record<string, unknown> = { model: cfg.model, input: texts };
  if (cfg.provider === "voyage") body.input_type = inputType;
  const res = await fetch(cfg.baseUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`Embeddings API ${res.status}: ${detail}`);
  }
  const data = await res.json();
  const rows: { embedding: number[]; index?: number }[] = data?.data ?? [];
  if (rows.length !== texts.length) throw new Error("Embeddings API returned a partial batch.");
  // Both APIs include the input index; sort defensively.
  rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return rows.map((r) => r.embedding);
}

function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

/** One live round-trip against the configured provider (for the admin Test button). */
export async function testEmbeddings(): Promise<{ ok: boolean; dims?: number; error?: string }> {
  try {
    const cfg = await getEmbeddingsConfig();
    if (cfg.provider === "off") return { ok: false, error: "Semantic search is turned off." };
    if (!cfg.apiKey) return { ok: false, error: "No API key is set." };
    const [vec] = await embedTexts(cfg, ["connection test"], "query");
    return { ok: true, dims: vec.length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Test failed." };
  }
}

// --- Chunking ----------------------------------------------------------------

const CHUNK_TARGET = 1800; // characters — roughly 400 tokens
const MAX_CHUNKS = 80;

/**
 * Split markdown into heading-scoped chunks around CHUNK_TARGET characters.
 * Every chunk is prefixed with the document title (and its heading) so each
 * embedding carries document context.
 */
export function chunkMarkdown(title: string, markdown: string): { heading: string; text: string }[] {
  const sections: { heading: string; body: string[] }[] = [{ heading: "", body: [] }];
  for (const line of markdown.split(/\r?\n/)) {
    const h = /^#{1,3}\s+(.+)$/.exec(line);
    if (h) sections.push({ heading: h[1].trim(), body: [] });
    else sections[sections.length - 1].body.push(line);
  }

  const chunks: { heading: string; text: string }[] = [];
  for (const s of sections) {
    const body = s.body.join("\n").trim();
    if (!body && !s.heading) continue;
    const paragraphs = body.split(/\n{2,}/);
    let buf = "";
    const flush = () => {
      if (buf.trim()) chunks.push({ heading: s.heading, text: buf.trim() });
      buf = "";
    };
    for (const p of paragraphs) {
      if (buf && buf.length + p.length > CHUNK_TARGET) flush();
      buf += (buf ? "\n\n" : "") + p;
      // A single oversized paragraph (giant table/code block) gets hard-split.
      while (buf.length > CHUNK_TARGET * 2) {
        chunks.push({ heading: s.heading, text: buf.slice(0, CHUNK_TARGET * 2) });
        buf = buf.slice(CHUNK_TARGET * 2);
      }
    }
    flush();
    if (chunks.length >= MAX_CHUNKS) break;
  }

  return chunks.slice(0, MAX_CHUNKS).map((c) => ({
    heading: c.heading,
    text:
      `${title}${c.heading ? ` — ${c.heading}` : ""}\n\n` +
      c.text,
  }));
}

// --- Indexing ----------------------------------------------------------------

function docHash(model: string, title: string, content: string): string {
  return createHash("sha256").update(`${model}\n${title}\n${content}`).digest("hex");
}

/**
 * (Re)embed one document. Fire-and-forget from write paths — never throws.
 * Skips silently when embeddings are off/unready, and skips unchanged docs
 * via a content hash.
 */
export async function indexDocument(documentId: number): Promise<void> {
  try {
    const cfg = await getEmbeddingsConfig();
    if (cfg.provider === "off" || !cfg.apiKey) return;
    if (!(await ensureSchema())) return;

    const doc = (
      await q<{ id: number; title: string; content: string; deleted_at: string | null; branch_of: number | null }>(
        "SELECT id, title, content, deleted_at, branch_of FROM documents WHERE id = $1",
        [documentId]
      )
    )[0];
    if (!doc || doc.deleted_at || doc.branch_of) {
      await q("DELETE FROM doc_chunks WHERE document_id = $1", [documentId]);
      return;
    }

    const hash = docHash(cfg.model, doc.title, doc.content);
    const existing = await q<{ doc_hash: string }>(
      "SELECT doc_hash FROM doc_chunks WHERE document_id = $1 LIMIT 1",
      [documentId]
    );
    if (existing[0]?.doc_hash === hash) return;

    const chunks = chunkMarkdown(doc.title, doc.content);
    if (chunks.length === 0) {
      await q("DELETE FROM doc_chunks WHERE document_id = $1", [documentId]);
      return;
    }
    const vectors: number[][] = [];
    for (let i = 0; i < chunks.length; i += 64) {
      vectors.push(...(await embedTexts(cfg, chunks.slice(i, i + 64).map((c) => c.text), "document")));
    }

    await q("DELETE FROM doc_chunks WHERE document_id = $1", [documentId]);
    for (let i = 0; i < chunks.length; i++) {
      await q(
        `INSERT INTO doc_chunks (document_id, chunk_index, heading, content, embedding, doc_hash)
         VALUES ($1, $2, $3, $4, $5::vector, $6)`,
        [documentId, i, chunks[i].heading, chunks[i].text, toVectorLiteral(vectors[i]), hash]
      );
    }
    await setSetting(KEYS.indexModel, cfg.model);
  } catch (e) {
    console.warn(`[embeddings] index doc ${documentId} failed:`, e instanceof Error ? e.message : e);
  }
}

// Single-process app: reindex progress lives in module state, read by the
// admin status endpoint.
let reindexState: { running: boolean; done: number; total: number; error: string } = {
  running: false,
  done: 0,
  total: 0,
  error: "",
};

export function reindexProgress() {
  return { ...reindexState };
}

/** Rebuild the whole index in the background. Wipes first when the model changed (or force). */
export async function reindexAll(force = false): Promise<void> {
  if (reindexState.running) return;
  const cfg = await getEmbeddingsConfig();
  if (cfg.provider === "off" || !cfg.apiKey) return;
  if (!(await ensureSchema())) return;

  const indexModel = (await getSetting(KEYS.indexModel)) || "";
  if (force || (indexModel && indexModel !== cfg.model)) {
    await q("DELETE FROM doc_chunks");
  }
  const ids = await q<{ id: number }>(
    "SELECT id FROM documents WHERE deleted_at IS NULL AND branch_of IS NULL ORDER BY id"
  );
  reindexState = { running: true, done: 0, total: ids.length, error: "" };
  try {
    for (const row of ids) {
      await indexDocument(row.id);
      reindexState.done++;
    }
    await setSetting(KEYS.indexModel, cfg.model);
  } catch (e) {
    reindexState.error = e instanceof Error ? e.message : "Reindex failed.";
  } finally {
    reindexState.running = false;
  }
}

// --- Query -------------------------------------------------------------------

export interface SemanticHit {
  id: number;
  distance: number;
  heading: string;
  excerpt: string;
}

/**
 * Nearest document chunks for a query, deduped to one row per document
 * (best chunk wins), with the same visibility filters as full-text search.
 * Returns [] on any failure — callers fall back to keyword-only results.
 */
export async function semanticSearch(
  query: string,
  limit: number,
  includeDrafts: boolean,
  scope?: number[] | "all",
  spaceId?: number
): Promise<SemanticHit[]> {
  try {
    const cfg = await getEmbeddingsConfig();
    if (cfg.provider === "off" || !cfg.apiKey || !query.trim()) return [];
    if (!(await ensureSchema())) return [];

    const [vec] = await embedTexts(cfg, [query.trim().slice(0, 1000)], "query");
    const filter =
      (includeDrafts ? "" : " AND d.status = 'published'") +
      (Array.isArray(scope) ? " AND d.space_id = ANY($3)" : "") +
      (spaceId ? ` AND d.space_id = ${Number(spaceId)}` : "");
    const rows = await q<{ id: number; distance: number; heading: string; content: string }>(
      `SELECT d.id, c.heading, c.content, (c.embedding <=> $1::vector) AS distance
       FROM doc_chunks c
       JOIN documents d ON d.id = c.document_id
       WHERE d.deleted_at IS NULL AND d.branch_of IS NULL${filter}
       ORDER BY c.embedding <=> $1::vector
       LIMIT $2`,
      Array.isArray(scope)
        ? [toVectorLiteral(vec), limit * 4, scope]
        : [toVectorLiteral(vec), limit * 4]
    );

    const seen = new Map<number, SemanticHit>();
    for (const r of rows) {
      if (!seen.has(r.id)) {
        // Drop the "Title — Heading" context prefix from the stored text.
        const body = r.content.split("\n\n").slice(1).join(" ").replace(/\s+/g, " ").trim();
        seen.set(r.id, {
          id: r.id,
          distance: Number(r.distance),
          heading: r.heading,
          excerpt: body.slice(0, 180),
        });
      }
      if (seen.size >= limit) break;
    }
    return [...seen.values()];
  } catch (e) {
    console.warn("[embeddings] semantic search failed:", e instanceof Error ? e.message : e);
    return [];
  }
}

// --- Hybrid retrieval --------------------------------------------------------

/**
 * Keyword + semantic search merged with reciprocal-rank fusion. When
 * embeddings are off or fail, this is exactly the keyword result list.
 */
export async function hybridSearchDocuments(
  raw: string,
  limit = 25,
  includeDrafts = false,
  scope?: number[] | "all",
  spaceId?: number
): Promise<SearchHit[]> {
  const { searchDocuments, searchCardsByIds } = await import("./db");
  const [keyword, semantic] = await Promise.all([
    searchDocuments(raw, limit, includeDrafts, scope, spaceId),
    semanticSearch(raw, limit, includeDrafts, scope, spaceId),
  ]);
  if (semantic.length === 0) return keyword;

  const K = 60; // standard RRF constant
  const score = new Map<number, number>();
  keyword.forEach((h, i) => score.set(h.id, (score.get(h.id) ?? 0) + 1 / (K + i)));
  semantic.forEach((h, i) => score.set(h.id, (score.get(h.id) ?? 0) + 1 / (K + i)));

  const kwById = new Map(keyword.map((h) => [h.id, h]));
  const semById = new Map(semantic.map((h) => [h.id, h]));
  const semOnlyIds = semantic.filter((h) => !kwById.has(h.id)).map((h) => h.id);
  const cards = new Map((await searchCardsByIds(semOnlyIds)).map((c) => [c.id, c]));

  const merged: SearchHit[] = [];
  for (const [id] of [...score.entries()].sort((a, b) => b[1] - a[1])) {
    const kw = kwById.get(id);
    const sem = semById.get(id);
    if (kw) {
      merged.push({ ...kw, match: sem ? "both" : "keyword" });
    } else if (sem) {
      const card = cards.get(id);
      if (!card) continue; // scope raced away — skip rather than leak
      merged.push({ ...card, snippet: sem.excerpt, match: "semantic" });
    }
    if (merged.length >= limit) break;
  }
  return merged;
}

/**
 * Documents for AI answering: keyword retrieval fused with semantic
 * similarity, so "how do we handle refunds?" surfaces the policy even when
 * no word overlaps.
 */
export async function hybridRetrieveForAnswer(
  raw: string,
  limit = 6,
  includeDrafts = false,
  scope?: number[] | "all"
): Promise<Document[]> {
  const { retrieveForAnswer, getDocumentsByIds } = await import("./db");
  const [keyword, semantic] = await Promise.all([
    retrieveForAnswer(raw, limit, includeDrafts, scope),
    semanticSearch(raw, limit, includeDrafts, scope),
  ]);
  if (semantic.length === 0) return keyword;

  const K = 60;
  const score = new Map<number, number>();
  keyword.forEach((d, i) => score.set(d.id, (score.get(d.id) ?? 0) + 1 / (K + i)));
  semantic.forEach((h, i) => score.set(h.id, (score.get(h.id) ?? 0) + 1 / (K + i)));

  const byId = new Map(keyword.map((d) => [d.id, d]));
  const missing = semantic.filter((h) => !byId.has(h.id)).map((h) => h.id);
  for (const d of await getDocumentsByIds(missing)) byId.set(d.id, d);

  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => byId.get(id))
    .filter((d): d is Document => Boolean(d))
    .slice(0, limit);
}

/** Status block for the admin GUI. */
export async function embeddingsStatus() {
  const cfg = await getEmbeddingsConfig();
  const available = await vectorAvailable();
  let indexedDocs = 0;
  let chunks = 0;
  if (available) {
    try {
      const r = await q<{ docs: string; chunks: string }>(
        "SELECT COUNT(DISTINCT document_id) AS docs, COUNT(*) AS chunks FROM doc_chunks"
      );
      indexedDocs = Number(r[0]?.docs ?? 0);
      chunks = Number(r[0]?.chunks ?? 0);
    } catch {
      /* table not created yet */
    }
  }
  const total = await q<{ n: string }>(
    "SELECT COUNT(*) AS n FROM documents WHERE deleted_at IS NULL AND branch_of IS NULL"
  );
  return {
    pgvector: available,
    provider: cfg.provider,
    model: cfg.provider === "off" ? "" : cfg.model,
    base_url: cfg.provider === "off" ? "" : cfg.baseUrl,
    has_key: Boolean(cfg.apiKey),
    indexed_docs: indexedDocs,
    chunks,
    total_docs: Number(total[0]?.n ?? 0),
    index_model: (await getSetting(KEYS.indexModel)) || "",
    reindex: reindexProgress(),
  };
}
