// Helpdesk 1.19.1 import: a streaming CSV reader (RFC 4180) for exports too
// big to hold in memory. Pure: no database, no Next. It takes chunks as they
// come off the disk or out of a zip entry and yields one record at a time.
//
//   - UTF-8 (a BOM is dropped), split across chunk boundaries safely;
//   - comma, semicolon or tab, decided from the header line;
//   - quoted fields with "" escapes and line breaks inside them;
//   - CRLF, LF or a lone CR between records;
//   - a record over IMPORT_CSV_LIMITS.recordChars is refused (CsvError),
//     so a missing closing quote can't swallow the whole file into memory.

export const IMPORT_CSV_LIMITS = {
  /** One record, all fields together, in characters. */
  recordChars: 4_000_000,
  /** Columns in one record. */
  columns: 500,
} as const;

export class CsvError extends Error {
  constructor(message: string, public line: number) {
    super(message);
  }
}

export interface CsvRecord {
  /** The 1-based line the record starts on (the header is line 1). */
  line: number;
  fields: string[];
}

/** The delimiter of a header line: the one of , ; tab that occurs most outside quotes. */
export function detectDelimiter(headerLine: string): string {
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (const c of headerLine) {
    if (c === '"') quoted = !quoted;
    else if (!quoted && c in counts) counts[c]++;
  }
  let best = ",";
  for (const d of [";", "\t"]) if (counts[d] > counts[best]) best = d;
  return best;
}

/**
 * Records out of a stream of chunks. The delimiter is detected from the
 * first line unless given.
 */
export async function* csvRecords(chunks: AsyncIterable<Buffer | string>, opts: { delimiter?: string } = {}): AsyncGenerator<CsvRecord> {
  const decoder = new TextDecoder("utf-8");
  let delimiter = opts.delimiter ?? "";
  let pending = "";
  let first = true;
  // Parser state, kept across chunks.
  let field = "";
  let fields: string[] = [];
  let quoted = false;
  let afterQuote = false;
  let line = 1;
  let recordLine = 1;
  let recordChars = 0;
  let sawAny = false;
  let lastWasCr = false;

  const endField = () => {
    fields.push(field);
    if (fields.length > IMPORT_CSV_LIMITS.columns) throw new CsvError(`More than ${IMPORT_CSV_LIMITS.columns} columns in one row.`, recordLine);
    field = "";
    afterQuote = false;
  };

  function* feed(text: string): Generator<CsvRecord> {
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (lastWasCr) {
        lastWasCr = false;
        if (c === "\n" && !quoted) continue;
      }
      recordChars++;
      if (recordChars > IMPORT_CSV_LIMITS.recordChars) throw new CsvError("A row is too long (is a closing quote missing?).", recordLine);
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else if (i + 1 >= text.length) {
            // The next chunk decides whether this is "" or the closing quote:
            // keep it pending by stepping back (the caller re-feeds the tail).
            throw new NeedMore(i);
          } else {
            quoted = false;
            afterQuote = true;
          }
        } else {
          if (c === "\n" || (c === "\r" && text[i + 1] !== "\n")) line++;
          field += c;
        }
        continue;
      }
      if (c === '"' && field === "" && !afterQuote) {
        quoted = true;
        sawAny = true;
        continue;
      }
      if (c === delimiter) {
        sawAny = true;
        endField();
        continue;
      }
      if (c === "\n" || c === "\r") {
        if (c === "\r") lastWasCr = true;
        line++;
        if (sawAny || field !== "" || fields.length > 0) {
          endField();
          const rec = { line: recordLine, fields };
          fields = [];
          yield rec;
        }
        sawAny = false;
        recordChars = 0;
        recordLine = line;
        continue;
      }
      // Text after a closing quote ("a"b) is kept, as most readers do.
      sawAny = true;
      field += c;
    }
  }

  class NeedMore {
    constructor(public at: number) {}
  }

  function* run(text: string): Generator<CsvRecord> {
    let input = pending + text;
    pending = "";
    for (;;) {
      try {
        yield* feed(input);
        return;
      } catch (e) {
        if (e instanceof NeedMore) {
          // Re-feed from the quote once more text arrives: undo the char count for it.
          recordChars--;
          pending = input.slice(e.at);
          return;
        }
        throw e;
      }
    }
  }

  for await (const chunk of chunks) {
    let text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    if (first) {
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      if (!text) continue;
      first = false;
      if (!delimiter) {
        const nl = text.search(/[\r\n]/);
        delimiter = detectDelimiter(nl >= 0 ? text.slice(0, nl) : text);
      }
    }
    yield* run(text);
  }
  const tail = decoder.decode();
  if (tail || pending) {
    if (first && !delimiter) delimiter = detectDelimiter(pending + tail);
    const text = pending + tail;
    pending = "";
    if (text) {
      // A lone pending closing quote at the very end: it closes the field.
      if (text === '"' && quoted) {
        quoted = false;
        afterQuote = true;
      } else yield* feed(text);
    }
  }
  if (quoted) throw new CsvError("The file ends inside a quoted field.", recordLine);
  if (sawAny || field !== "" || fields.length > 0) {
    endField();
    yield { line: recordLine, fields };
  }
}

/** Header names as keys: trimmed, BOM-free, a repeated name gets " (2)". */
export function cleanHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, i) => {
    let name = h.replace(/^﻿/, "").trim() || `Column ${i + 1}`;
    const n = (seen.get(name.toLowerCase()) ?? 0) + 1;
    seen.set(name.toLowerCase(), n);
    if (n > 1) name = `${name} (${n})`;
    return name;
  });
}

export interface CsvRow {
  line: number;
  /** Header → value ('' when the row is short). */
  values: Record<string, string>;
}

/** Rows keyed by the header line's names. A completely empty row is skipped. */
export async function* csvRows(chunks: AsyncIterable<Buffer | string>, onHeaders?: (headers: string[]) => void): AsyncGenerator<CsvRow> {
  let headers: string[] | null = null;
  for await (const rec of csvRecords(chunks)) {
    if (!headers) {
      headers = cleanHeaders(rec.fields);
      onHeaders?.(headers);
      continue;
    }
    if (rec.fields.every((f) => f.trim() === "")) continue;
    const values: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) values[headers[i]] = rec.fields[i] ?? "";
    yield { line: rec.line, values };
  }
  if (!headers) onHeaders?.([]);
}

/** One CSV cell: quoted when it needs to be; a leading = + - @ is prefixed with ' (spreadsheet formulas). */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(cells: unknown[]): string {
  return cells.map(csvCell).join(",") + "\r\n";
}
