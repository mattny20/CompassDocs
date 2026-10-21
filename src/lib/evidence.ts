// Shared evidence helpers (F2, 1.14.0): the hash both audit packages use,
// the CSV line writer over lib/csv's cell escaper, the hash manifest a ZIP
// ends with, and the streamed ZIP entry that lets a ledger of any size go
// out in batches without ever being built in memory. training-audit.ts
// re-exports sha256Hex from here; compliance-audit.ts builds on the rest.
// Pure Node (crypto, stream, jszip): no database, no server-only marker, so
// lib/db can import the snapshot rewrite below.

import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type JSZip from "jszip";
import { csvCell } from "./csv";

export { csvCell };

/** SHA-256 of a text (UTF-8) or a buffer, as lowercase hex. */
export const sha256Hex = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

/** One CSV line: every cell through csvCell (quotes doubled, formula-leading values quoted), joined with commas, no newline. */
export function csvLine(cells: readonly unknown[]): string {
  return cells.map(csvCell).join(",");
}

/** What the manifest records about one file of a package. */
export interface ManifestFile {
  name: string;
  sha256: string;
}

export interface Manifest {
  generated_at: string;
  app_version: string;
  workspace: string;
  /** Who asked for the package; absent on a scheduled one. */
  generated_by?: string;
  files: ManifestFile[];
}

/**
 * The manifest of a package: one {name, sha256} per file, in the order the
 * files were added, so `sha256sum -c` can be run against it. A file given
 * as text or bytes is hashed here; one that was streamed passes the hash
 * its stream computed.
 */
export function manifestFor(
  files: readonly { name: string; bytes?: string | Buffer; sha256?: string }[],
  meta: { app_version: string; workspace: string; generated_at?: string; generated_by?: string }
): Manifest {
  const out: Manifest = {
    generated_at: meta.generated_at ?? new Date().toISOString(),
    app_version: meta.app_version,
    workspace: meta.workspace,
    files: files.map((f) => ({
      name: f.name,
      sha256: f.sha256 ?? sha256Hex(f.bytes ?? ""),
    })),
  };
  if (meta.generated_by) out.generated_by = meta.generated_by;
  return out;
}

/** What a streamed entry answers once the ZIP has consumed it. */
export interface StreamedFile {
  name: string;
  sha256: string;
  bytes: number;
  /** Lines written after the header (a CSV), or chunks for a plain stream. */
  rows: number;
}

/**
 * A page of a keyset cursor: the rows after `afterId`, at most `limit`,
 * in id order. The producer stops at the first short page.
 */
export type BatchCursor<T extends { id: number | string }> = (afterId: number | string, limit: number) => Promise<T[]>;

/** The default page size of a streamed CSV: the ledger goes out 500 rows at a time. */
export const STREAM_BATCH = 500;

/**
 * Add one entry whose bytes are produced lazily by `source` (an async
 * generator of strings or buffers). jszip pulls a Node stream only when
 * the archive reaches that entry, so nothing runs before then and nothing
 * is held in memory beyond the chunk in flight; the SHA-256 is computed
 * over exactly the bytes handed to the archive. The returned promise
 * settles when the entry has been fully consumed (or the source failed,
 * which also fails the archive's output stream).
 */
export function addStreamed(zip: JSZip, name: string, source: () => AsyncIterable<string | Buffer>): Promise<StreamedFile> {
  return new Promise<StreamedFile>((resolve, reject) => {
    async function* hashed(): AsyncGenerator<Buffer> {
      const h = createHash("sha256");
      let bytes = 0;
      let rows = 0;
      try {
        for await (const chunk of source()) {
          const b = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
          if (b.length === 0) continue;
          h.update(b);
          bytes += b.length;
          rows += 1;
          yield b;
        }
      } catch (e) {
        reject(e);
        throw e;
      }
      resolve({ name, sha256: h.digest("hex"), bytes, rows });
    }
    zip.file(name, Readable.from(hashed(), { objectMode: false }));
  });
}

/**
 * A CSV entry streamed from a keyset cursor in batches (STREAM_BATCH rows
 * each): the header line first, then one line per row through `cells`,
 * every cell escaped by csvCell. `rows` on the answer is the number of
 * data lines. The acknowledgements ledger, the notice log and the audit
 * extract of the compliance package all go out this way.
 */
export function addStreamedCsv<T extends { id: number | string }>(
  zip: JSZip,
  name: string,
  header: string,
  cursor: BatchCursor<T>,
  cells: (row: T) => readonly unknown[],
  batch = STREAM_BATCH
): Promise<StreamedFile> {
  let rows = 0;
  const done = addStreamed(zip, name, async function* () {
    yield `${header}\n`;
    for await (const page of csvPages(cursor, cells, batch)) {
      rows += page.rows;
      yield page.text;
    }
  });
  return done.then((f) => ({ ...f, rows }));
}

/**
 * The pages of a cursor as CSV text (no header): shared by the streamed
 * entry above and by the snapshot's ledger hash, so the hash a snapshot
 * stores is the hash of the file a package ships.
 */
export async function* csvPages<T extends { id: number | string }>(
  cursor: BatchCursor<T>,
  cells: (row: T) => readonly unknown[],
  batch = STREAM_BATCH
): AsyncGenerator<{ text: string; rows: number }> {
  let after: number | string = 0;
  for (;;) {
    const page = await cursor(after, batch);
    if (page.length === 0) return;
    yield { text: page.map((r) => `${csvLine(cells(r))}\n`).join(""), rows: page.length };
    if (page.length < batch) return;
    after = page[page.length - 1].id;
  }
}

/** The SHA-256 and row count of a whole CSV (header + every page of the cursor), without keeping it. */
export async function hashCsv<T extends { id: number | string }>(
  header: string,
  cursor: BatchCursor<T>,
  cells: (row: T) => readonly unknown[],
  batch = STREAM_BATCH
): Promise<{ sha256: string; rows: number }> {
  const h = createHash("sha256");
  h.update(`${header}\n`);
  let rows = 0;
  for await (const page of csvPages(cursor, cells, batch)) {
    h.update(page.text);
    rows += page.rows;
  }
  return { sha256: h.digest("hex"), rows };
}

/** Collect a jszip Node output stream into one Buffer (tests, and the one-shot callers). */
export function collectZip(out: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    out.on("data", (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    out.on("end", () => resolve(Buffer.concat(chunks)));
    out.on("error", reject);
  });
}

// --- The erasure rewrite of a stored snapshot (C5 + F2) ----------------------

/** Who is being erased from a snapshot, and the alias their names become. */
export interface SnapshotErasure {
  userId: number;
  alias: string;
  /** Names the person went by (name, username); an exact string value equal to one is replaced by the alias. */
  names: string[];
  /** The address; an exact string value equal to it is blanked. */
  email: string;
}

/** Keys that identify a person on a snapshot object, and the name key each one governs. */
const ID_KEYS: readonly [idKey: string, nameKeys: readonly string[]][] = [
  ["user_id", ["name", "user_name", "username", "signed_name"]],
  ["decided_by", ["decided_by_name"]],
  ["submitted_by", ["submitted_by_name"]],
  ["by_user_id", ["by_name"]],
  ["owner_user_id", ["owner_name", "owner"]],
  ["taken_by", ["taken_by_name"]],
];
/** Keys blanked on an object that is the person's own row (the C5 rule for ip; the user agent follows it). */
const BLANK_ON_OWN_ROW = ["email", "user_email", "ip", "user_agent"] as const;

/**
 * Rewrite one stored snapshot's canonical text for an erasure (C5): on
 * every object that names the person by id, the name keys that id governs
 * become the alias and the address and access fields are blanked; and
 * anywhere in the tree, a string value equal to one of the person's names
 * becomes the alias and one equal to their address becomes ''. The text is
 * re-serialised the way buildComplianceSnapshot serialises (two-space JSON
 * plus a newline), so the new hash is over a text of the same shape.
 * Answers the text unchanged when nothing in it named the person. A text
 * that is not JSON (never written by this build) is rewritten by exact
 * string replacement of the quoted values instead.
 */
export function rewriteSnapshotText(text: string, who: SnapshotErasure): { text: string; changed: boolean } {
  const names = new Set(who.names.filter((n) => n.trim() !== ""));
  const email = who.email.trim();
  let changed = false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    let out = text;
    for (const n of names) {
      const from = JSON.stringify(n);
      if (out.includes(from)) {
        out = out.split(from).join(JSON.stringify(who.alias));
        changed = true;
      }
    }
    if (email) {
      const from = JSON.stringify(email);
      if (out.includes(from)) {
        out = out.split(from).join('""');
        changed = true;
      }
    }
    return { text: out, changed };
  }

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const own = new Set<string>();
      let ownRow = false;
      for (const [idKey, nameKeys] of ID_KEYS) {
        if (obj[idKey] === who.userId) {
          for (const k of nameKeys) own.add(k);
          if (idKey === "user_id") ownRow = true;
        }
      }
      for (const [k, v] of Object.entries(obj)) {
        if (own.has(k) && typeof v === "string" && v !== "" && v !== who.alias) {
          out[k] = who.alias;
          changed = true;
        } else if (ownRow && (BLANK_ON_OWN_ROW as readonly string[]).includes(k) && typeof v === "string" && v !== "") {
          out[k] = "";
          changed = true;
        } else {
          out[k] = walk(v);
        }
      }
      return out;
    }
    if (typeof node === "string") {
      if (names.has(node)) {
        changed = true;
        return who.alias;
      }
      if (email && node === email) {
        changed = true;
        return "";
      }
    }
    return node;
  };
  const rewritten = walk(parsed);
  if (!changed) return { text, changed: false };
  return { text: JSON.stringify(rewritten, null, 2) + "\n", changed: true };
}
