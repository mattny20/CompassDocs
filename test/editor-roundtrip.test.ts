// The rich editor's Markdown round-trip (1.18.4). Documents, templates and
// newsletters are stored as Markdown; the WYSIWYG editor parses that
// Markdown into its ProseMirror schema (tiptap-markdown: markdown-it, then
// the schema's parseHTML rules) and serializes it back on every edit. What
// it writes back is what lands in the database, so an editor upgrade must
// not change a byte of it.
//
// The corpus below covers everything the editor can hold. Its expected
// output lives in test/fixtures/editor-roundtrip.json and was captured from
// the Tiptap 2 editor (1.18.2) before the Tiptap 3 migration; the test
// asserts the current editor produces exactly the same text, both on first
// load (`content`) and through `setContent` (the mode switch / "Apply" path),
// and that a second round-trip of that output is unchanged too.
//
// The editor runs headless in jsdom with the very extension list the
// component uses (`richTextExtensions()`).
//
// Run:      npx tsx --tsconfig ./tsconfig.test.json --test test/editor-roundtrip.test.ts
// Refresh:  UPDATE_ROUNDTRIP_FIXTURES=1 (only when a format change is intended)
//
// Stored content: with ROUNDTRIP_DB=1 and DATABASE_URL set, every distinct
// Markdown body in documents, doc_versions, doc_templates and newsletters is
// round-tripped too (read-only SELECTs). With ROUNDTRIP_DB_SNAPSHOT=<file>
// the outputs are compared with (or, with UPDATE_ROUNDTRIP_FIXTURES=1,
// written to) a snapshot taken from another editor version; bodies whose
// output differs from what is stored are listed either way.

// The DOM must exist before Tiptap loads, so this import stays first.
import { dom } from "./support/dom";
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Editor } from "@tiptap/core";
import { Client } from "pg";
import { richTextExtensions } from "../src/components/RichTextEditor";

const UPDATE = process.env.UPDATE_ROUNDTRIP_FIXTURES === "1";
const FIXTURE = path.join(__dirname, "fixtures", "editor-roundtrip.json");

// --- Corpus --------------------------------------------------------------------

const md = (...lines: string[]) => lines.join("\n");

const CORPUS: Record<string, string> = {
  empty: "",
  "whitespace only": "   \n\n  ",
  headings: md("# One", "", "## Two", "", "### Three", "", "#### Four is not offered", "", "Body text."),
  "inline marks": md(
    "**bold** *italic* _also italic_ ~~strike~~ `code` <u>underline</u>",
    "",
    "***bold italic*** **bold with *nested italic* inside** <u>**bold underline**</u>",
    "",
    "Mid**word**bold and snake_case_word and 2*3*4."
  ),
  "escaping and literals": md(
    "\\*not italic\\* and \\# not a heading and \\[not a link\\]",
    "",
    "1\\. not a list",
    "",
    "Ampersand & less < greater > &amp; &copy; and a backslash \\\\ here.",
    "",
    "A {{first_name}} tag and a [[Wiki style]] mention left as text."
  ),
  links: md(
    "[Plain link](https://example.com) and [with title](https://example.com/a \"A title\")",
    "",
    "Internal [Leave policy](/doc/12) link and a bare https://example.org/path?q=1 URL.",
    "",
    "<https://angle.example.com> and mailto:someone@example.com and www.example.net",
    "",
    "**[bold link](https://example.com/b)** and [`code link`](https://example.com/c)"
  ),
  images: md(
    "![Logo](/api/attachments/1/logo.png)",
    "",
    "![Half width](/api/attachments/2/a.png \"w=50%\") ![Side by side](/api/attachments/3/b.png \"w=45%\")",
    "",
    "![](https://example.com/no-alt.jpg)",
    "",
    "Text with an inline ![icon](/i.png \"A plain title\") image."
  ),
  "hard breaks": md(
    "Line one",
    "line two (breaks: true)",
    "",
    "Trailing backslash\\",
    "next",
    "",
    "Two spaces  ",
    "next",
    "",
    "Explicit<br>break"
  ),
  "horizontal rules": md("Above", "", "---", "", "Between", "", "***", "", "Below"),
  "bullet and ordered lists": md(
    "- one",
    "- two",
    "  - nested a",
    "  - nested b",
    "    - deeper",
    "- three",
    "",
    "1. first",
    "2. second",
    "   1. sub one",
    "   2. sub two",
    "3. third",
    "",
    "3. starts at three",
    "4. four",
    "",
    "* star bullets",
    "+ plus bullets",
    "",
    "- item with",
    "",
    "  a second paragraph",
    "- **bold item** with [link](https://x.example)"
  ),
  "task lists": md(
    "- [ ] open task",
    "- [x] done task",
    "  - [ ] nested open",
    "  - [x] nested done",
    "- [ ] task with **bold** and `code`",
    "",
    "Paragraph between.",
    "",
    "- [X] capital X"
  ),
  "code blocks": md(
    "```js",
    "const a = 1;",
    "console.log(`template ${a}`);",
    "```",
    "",
    "```",
    "no language",
    "```",
    "",
    "~~~python",
    "def f():",
    "    return \"tilde fence\"",
    "~~~",
    "",
    "````md",
    "```inner",
    "nested fence",
    "```",
    "````",
    "",
    "    indented code block",
    "    second line",
    "",
    "```email",
    "Subject: Hello",
    "",
    "Hi ,",
    "",
    "Thanks,",
    "```",
    "",
    "```mermaid",
    "flowchart LR",
    "  A[Start] --> B{Decision?}",
    "```",
    "",
    "```plantuml",
    "Alice -> Bob: Request",
    "```",
    "",
    "```decision",
    "start: Is the service responding?",
    "- Yes -> Done.",
    "- No -> Escalate.",
    "```"
  ),
  blockquotes: md(
    "> A quote",
    "> over two lines",
    "",
    "> Outer",
    ">",
    "> > Nested quote",
    "",
    "> - list in a quote",
    "> - second",
    ">",
    "> **bold** in a quote"
  ),
  "pipe tables": md(
    "| Name | Role | Notes |",
    "| --- | --- | --- |",
    "| Ada | Engineer | **bold** and `code` |",
    "| Grace | Admiral | [link](https://example.com) |",
    "| | empty first | |"
  ),
  "table alignment": md(
    "| Left | Center | Right |",
    "| :--- | :---: | ---: |",
    "| a | b | c |",
    "| 1 | 2 | 3 |"
  ),
  "table html islands": md(
    "<table class=\"nl-borderless\"><tbody><tr><td><p>Photo one</p></td><td><p>Photo two</p></td></tr></tbody></table>",
    "",
    "<table><tbody><tr><th><p>Header</p></th><td><p>side header row</p></td></tr><tr><th><p>Second</p></th><td><p>value</p></td></tr></tbody></table>",
    "",
    "<table><tbody><tr><th colspan=\"2\"><p>Spanning header</p></th></tr><tr><td><p>a</p></td><td><p>b</p></td></tr></tbody></table>",
    "",
    "<table><tbody><tr><th><p>Two</p><p>paragraphs</p></th></tr><tr><td><p>cell</p></td></tr></tbody></table>"
  ),
  "styled blocks": md(
    "<p style=\"text-align: center\">Centered paragraph</p>",
    "",
    "<p style=\"text-align: right\">Right aligned</p>",
    "",
    "<p style=\"text-align: justify\">Justified</p>",
    "",
    "<p style=\"margin-left: 64px\">Indented twice</p>",
    "",
    "<p style=\"text-align: center; margin-left: 32px\">Both</p>",
    "",
    "<h2 style=\"text-align: center\">Centered heading</h2>",
    "",
    "<h2 style=\"background-color: #fef3c7\">Highlighted heading</h2>",
    "",
    "<h3 style=\"background-color: rgb(219, 234, 254)\">RGB highlight normalizes to hex</h3>",
    "",
    "<h1 style=\"text-align: right; margin-left: 32px; background-color: #dcfce7\">All three</h1>"
  ),
  "font family and text style": md(
    "Plain then <span style=\"font-family: Georgia, 'Times New Roman', serif\">serif text</span> then plain.",
    "",
    "<span style=\"font-family: 'Courier New', monospace\">**bold typewriter**</span>",
    "",
    "<span style=\"color: #ff0000\">red span</span> keeps or drops its color."
  ),
  "newsletter blocks": md(
    "Intro paragraph.",
    "",
    "<a class=\"email-btn\" href=\"https://example.com/read\">Read more</a>",
    "",
    "<div class=\"nl-spacer\" style=\"height:48px\"></div>",
    "",
    "<div class=\"nl-panel\" style=\"background-color: #1e3a5f; color: #ffffff\"><p>Dark panel with <strong>bold</strong></p></div>",
    "",
    "<div class=\"nl-panel\" style=\"background-color: #fef3c7; color: #0f172a\"><h2>Panel heading</h2><p>Auto text color</p></div>",
    "",
    "<div class=\"nl-panel\" style=\"background-color: #fef3c7; color: #ffffff\"><p>Overridden text color</p></div>"
  ),
  "callouts and containers": md(
    ":::note",
    "A note.",
    ":::",
    "",
    ":::info[Heads up]",
    "Info with a **title**.",
    ":::",
    "",
    ":::tip",
    "- tip list",
    "- second",
    ":::",
    "",
    ":::warning[Careful]",
    "Warning text.",
    ":::",
    "",
    ":::danger",
    "Danger text.",
    ":::",
    "",
    ":::details[More information]",
    "Hidden until expanded.",
    "",
    ":::note",
    "Nested callout inside an accordion.",
    ":::",
    ":::",
    "",
    "::::tabs",
    ":::tab[First]",
    "First tab content.",
    ":::",
    ":::tab[Second]",
    "Second tab with `code`.",
    ":::",
    "::::"
  ),
  "leaf directives": md(
    "::video{src=\"https://www.youtube.com/watch?v=dQw4w9WgXcQ\"}",
    "",
    "::video[Onboarding walkthrough]{src=\"https://vimeo.com/123456\" poster=\"/api/attachments/9/poster.jpg\"}",
    "",
    "::embed{src=\"https://example.com/dashboard\" height=\"600\"}",
    "",
    "::embed{src=\"https://example.com/no-height\"}"
  ),
  "embedded html": md(
    "<details><summary>Raw details</summary>",
    "",
    "Body of raw details.",
    "",
    "</details>",
    "",
    "<iframe src=\"https://example.com/frame\" width=\"600\" height=\"400\"></iframe>",
    "",
    "Press <kbd>Ctrl</kbd>+<kbd>S</kbd> to save.",
    "",
    "<!-- an html comment -->",
    "",
    "<div align=\"center\">A raw div</div>",
    "",
    "Text with <sup>sup</sup> and <sub>sub</sub> and <mark>mark</mark>."
  ),
  // Where Tiptap 3's own schema differs from Tiptap 2's (new attributes,
  // parse rules); the editor keeps the Tiptap 2 behaviour for each.
  "tiptap 3 schema edges": md(
    "<span style=\"font-family: Georgia, serif\">outer <span style=\"color: #ff0000\">nested</span> after</span>",
    "",
    "Raw <img src=\"/api/attachments/5/raw.png\" width=\"120\" height=\"80\" alt=\"Raw img\"> with size attributes.",
    "",
    "<table><colgroup><col style=\"width: 120px\"><col style=\"width: 200px\"></colgroup><tbody><tr><th style=\"text-align: center\"><p>Centered head</p></th><th colwidth=\"150\"><p>Width</p></th></tr><tr><td style=\"text-align: right\"><p>right</p></td><td></td></tr></tbody></table>",
    "",
    "[Titled](https://example.com/t \"Kept or dropped\") and [also](https://example.com/u 'single')"
  ),
  "realistic policy document": md(
    "# Remote Work Policy",
    "",
    "**Owner:** People Team · **Review:** yearly",
    "",
    ":::info[Scope]",
    "Applies to all employees and contractors.",
    ":::",
    "",
    "## 1. Eligibility",
    "",
    "Employees may work remotely when:",
    "",
    "1. their role allows it, and",
    "2. their manager has approved it in [the portal](https://portal.example.com).",
    "",
    "## 2. Equipment",
    "",
    "| Item | Provided | Notes |",
    "| --- | --- | --- |",
    "| Laptop | Yes | Encrypted |",
    "| Monitor | On request | *Up to 2* |",
    "",
    "## 3. Checklist",
    "",
    "- [x] Read this policy",
    "- [ ] Confirm your home office setup",
    "",
    "> Questions? Ask in #people or see [Leave policy](/doc/12).",
    "",
    "![Home office](/api/attachments/4/office.jpg \"w=60%\")",
    "",
    "<p style=\"text-align: center\"><em>Last reviewed 2026</em></p>",
    "",
    "```decision",
    "start: Is your manager OK with it?",
    "- Yes -> Go ahead.",
    "- No -> Discuss with People.",
    "```"
  ),
};

// --- Headless editor ---------------------------------------------------------

after(() => dom.window.close());
const extensions = richTextExtensions;

interface Result {
  /** First load (`content` option), as the editor writes it on any edit. */
  once: string;
  /** The same Markdown loaded through `setContent`. */
  viaSetContent: string;
  /** `once` loaded and serialized again. */
  twice: string;
}

function serialize(editor: any): string {
  return editor.storage.markdown.getMarkdown();
}

function roundTrip(markdown: string): Result {
  const editor = new Editor({ extensions: extensions(), content: markdown });
  const once = serialize(editor);
  editor.destroy();

  const viaSet = new Editor({ extensions: extensions(), content: "" });
  viaSet.commands.setContent(markdown);
  const viaSetContent = serialize(viaSet);
  viaSet.commands.setContent(once);
  const twice = serialize(viaSet);
  viaSet.destroy();
  return { once, viaSetContent, twice };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

// --- Corpus vs fixtures --------------------------------------------------------

describe("rich editor Markdown round-trip (corpus)", () => {
  test("every corpus document serializes exactly as the Tiptap 2 editor did", () => {
    const results: Record<string, Result & { input: string }> = {};
    for (const [name, input] of Object.entries(CORPUS)) results[name] = { input, ...roundTrip(input) };

    if (UPDATE) {
      writeFileSync(FIXTURE, JSON.stringify(results, null, 2) + "\n");
      return;
    }
    assert.ok(existsSync(FIXTURE), "fixture missing: run with UPDATE_ROUNDTRIP_FIXTURES=1");
    const expected = JSON.parse(readFileSync(FIXTURE, "utf8"));
    assert.deepEqual(Object.keys(results).sort(), Object.keys(expected).sort(), "corpus and fixture differ");
    const changed: string[] = [];
    for (const [name, got] of Object.entries(results)) {
      const want = expected[name];
      assert.equal(got.input, want.input, `${name}: corpus input changed; refresh the fixture deliberately`);
      for (const k of ["once", "viaSetContent", "twice"] as const) {
        if (got[k] !== want[k]) {
          changed.push(`${name} (${k}):\n--- expected\n${want[k]}\n+++ actual\n${got[k]}`);
        }
      }
    }
    assert.equal(changed.length, 0, `serialization changed:\n\n${changed.join("\n\n")}`);
  });
  // `twice` is pinned rather than required to equal `once`: the Tiptap 2
  // serializer was not a fixed point for every input (adjacent lists gain a
  // blank line per pass, for one), and the migration preserves that exactly.
});

// --- Stored content -----------------------------------------------------------

describe("rich editor Markdown round-trip (stored content)", { skip: process.env.ROUNDTRIP_DB !== "1" }, () => {
  test("stored Markdown serializes as the snapshot says", async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const sources: Record<string, string> = {
      documents: "SELECT id, content AS md FROM documents",
      doc_versions: "SELECT id, content AS md FROM doc_versions",
      doc_templates: "SELECT id, body AS md FROM doc_templates",
      newsletters: "SELECT id, body AS md FROM newsletters",
    };
    const bodies = new Map<string, { md: string; refs: string[] }>();
    try {
      for (const [table, sql] of Object.entries(sources)) {
        const { rows } = await client.query(sql);
        for (const r of rows) {
          if (typeof r.md !== "string") continue;
          const key = sha(r.md);
          const entry = bodies.get(key) ?? { md: r.md as string, refs: [] as string[] };
          entry.refs.push(`${table}#${r.id}`);
          bodies.set(key, entry);
        }
      }
    } finally {
      await client.end();
    }

    const outputs: Record<string, string> = {};
    const rewritten: string[] = [];
    for (const [key, { md: body, refs }] of bodies) {
      outputs[key] = roundTrip(body).once;
      if (outputs[key] !== body) rewritten.push(`${refs[0]}${refs.length > 1 ? ` (+${refs.length - 1})` : ""}`);
    }
    console.log(
      `# ${bodies.size} distinct stored bodies; ${rewritten.length} are normalized by the editor on first edit` +
        (rewritten.length ? `, e.g. ${rewritten.slice(0, 8).join(", ")}` : "")
    );

    const snapshot = process.env.ROUNDTRIP_DB_SNAPSHOT;
    if (!snapshot) return;
    if (UPDATE) {
      writeFileSync(snapshot, JSON.stringify(outputs, null, 2) + "\n");
      return;
    }
    const expected: Record<string, string> = JSON.parse(readFileSync(snapshot, "utf8"));
    const changed: string[] = [];
    const missing: string[] = [];
    for (const [key, out] of Object.entries(outputs)) {
      if (!(key in expected)) missing.push(bodies.get(key)!.refs[0]);
      else if (expected[key] !== out) changed.push(bodies.get(key)!.refs.join(", "));
    }
    console.log(`# compared with snapshot: ${changed.length} changed, ${missing.length} not in snapshot`);
    assert.deepEqual(changed, [], `round-trip changed for: ${changed.join("; ")}`);
  });
});
