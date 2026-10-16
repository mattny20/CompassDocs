// One CSV cell, for every cell both compliance exports write (1.10.1).
//
// Two rules, applied to every value whatever its source: quotes are doubled
// inside a quoted field (RFC 4180), and a value that starts with a formula
// trigger (= + - @, or a tab / carriage return that spreadsheets strip
// before looking) gets a leading single quote so Excel, LibreOffice and
// Numbers show it as text instead of running it. A person's name, a
// document title, a change note, a version's publisher name or a former
// staff member's email all reach the sheet an auditor opens; none of them
// may become a formula there. The header lines are literals the callers
// own and never pass through here.

export function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}
