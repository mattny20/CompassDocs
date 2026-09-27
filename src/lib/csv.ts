// A small RFC 4180 reader: quoted fields, doubled quotes, embedded newlines,
// CRLF or LF, a leading BOM, and a comma, semicolon or tab delimiter picked
// from the first line. Rows are arrays; the caller decides what a header is.

export interface ParsedCsv {
  header: string[];
  rows: string[][];
  delimiter: string;
}

export function detectDelimiter(firstLine: string): string {
  const counts = [",", ";", "\t"].map((d) => ({ d, n: firstLine.split(d).length - 1 }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0].n > 0 ? counts[0].d : ",";
}

export function parseCsv(text: string, delimiter?: string): ParsedCsv {
  let s = String(text ?? "");
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const firstLine = s.split(/\r?\n/, 1)[0] ?? "";
  const d = delimiter || detectDelimiter(firstLine);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    // Skip rows that are entirely empty (a trailing newline, blank lines).
    if (row.length > 1 || (row.length === 1 && row[0].trim() !== "")) rows.push(row);
    row = [];
  };
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      quoted = true;
      i++;
      continue;
    }
    if (c === d) {
      pushField();
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      pushField();
      pushRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== "" || row.length) {
    pushField();
    pushRow();
  }
  const header = (rows.shift() ?? []).map((h) => h.trim());
  return { header, rows, delimiter: d };
}
