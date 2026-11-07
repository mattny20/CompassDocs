// Helpdesk 1.19.4: text from outside (an asset source's device name, a
// source's error sentence, a checklist or person's name) put into a
// system-written Markdown line, such as an internal timeline note. Escaped
// so the desk's Markdown (GFM with literal autolinks, remark-directive and
// remarkDocBlocks, raw HTML through the sanitiser) shows it as the
// characters it is, on one line, wherever in the line it lands:
//   - nothing in it becomes a link, an image, emphasis, code, HTML, an
//     entity, a table, a footnote or a directive (the characters that start
//     one are backslash-escaped, every ":" included, so no directive name of
//     any kind, digits, letters of any script or emoji, can follow one);
//   - literal autolinks ("https://", "www.", an address) get an invisible
//     word joiner (U+2060) between their parts, since GFM finds them in the
//     text after escapes are undone;
//   - placed at the start of a line (or of a list item), it can't become a
//     heading, list, quote, setext underline, rule or indented code: leading
//     spaces and tabs are dropped and a leading marker is escaped.
// The desk shows exactly the value's characters (less leading and trailing
// spaces). The stored text is Markdown: a reader that shows a body as plain
// text has to render it as Markdown, or undo the escapes, as the
// notification emails do (inbound-parse markdownToPlain). Client-safe and
// dependency-free.

/** One value escaped for anywhere in a Markdown line (see the header). */
export function mdInline(s: string | null | undefined): string {
  return (
    String(s ?? "")
      .replace(/[\r\n\u2028\u2029]+/g, " ")
      // Control characters, and the byte-order mark: micromark drops a leading
      // U+FEFF, so a marker behind it would still start a block.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f﻿]/g, "")
      // Leading spaces or tabs make indented code at a line start (or code in a
      // list item); trailing ones a hard break before a newline.
      .replace(/^[ \t]+|[ \t]+$/g, "")
      // Links, images and footnotes ([ ]), emphasis and strike (* _ ~), code (`),
      // HTML, entities and angle autolinks (< > &), tables (|), attributes ({ }),
      // quotes (>), directives of any name (every ":"), the escape itself.
      .replace(/[\\`*_[\]<>~&|{}:]/g, "\\$&")
      // Literal autolinks are found in the parsed text, after escapes are undone,
      // so a backslash can't stop them: an invisible word joiner (U+2060) does.
      // No \b before "www": GFM links "_www." too ("_" is punctuation to it).
      .replace(/\\:\/\//g, "\\:\u2060//")
      // ...and a trailing "www", since the template's own "." may follow it.
      .replace(/(www)(?=\.|$)/gi, "$1\u2060")
      .replace(/@/g, "@\u2060")
      // Line-start block markers: a heading (#), a list item or rule (- +), a
      // setext underline (= -) and an ordered list ("1." "1)"). Quotes (>), fences
      // (` ~), "*" and "_" rules, tables (|) and HTML blocks (<) are escaped above.
      .replace(/^[#+=-]/, "\\$&")
      .replace(/^(\d+)([.)])/, "$1\\$2")
  );
}
