// Search snippets come from Postgres `ts_headline`, which copies document text
// VERBATIM (no HTML escaping) and wraps matches in literal <mark>…</mark>.
// Rendering it raw is stored XSS — a doc author could plant <img onerror=…>.
// Escape everything, then restore only our own <mark> highlight tokens, before
// it reaches any dangerouslySetInnerHTML sink.
export function safeSnippet(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/&lt;mark&gt;/g, "<mark>")
    .replace(/&lt;\/mark&gt;/g, "</mark>");
}
