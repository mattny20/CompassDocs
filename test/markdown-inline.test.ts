// The inline-only Markdown (1.12.0): the confirmation statement on the read
// confirmation card renders through MarkdownView's `inline` prop, whose
// sanitize schema keeps p, em, strong, a, code and br and nothing else. A
// statement set by a document.ack_require holder (who need not be an author)
// can carry emphasis and a link, never an embed's iframe, an image, a task
// list or an inline style; the document view, for contrast, renders all of
// those. The component is rendered to static markup the way a server
// render does, so the test sees what a reader's page would carry.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/markdown-inline.test.ts

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownView, MD_INLINE_SANITIZE_SCHEMA } from "../src/components/MarkdownView";

const render = (content: string, inline: boolean) =>
  renderToStaticMarkup(createElement(MarkdownView, { content, inline }));

/** A statement with everything a sentence may carry, then everything it may not. */
const STATEMENT = [
  "I have **read** the _handbook_ and will `comply` with [the policy](/doc/12).",
  "",
  '::embed{src="https://evil.example/frame" height="500"}',
  "",
  '::video[Watch this]{src="https://www.youtube.com/watch?v=dQw4w9WgXcQ"}',
  "",
  "![pixel](https://tracker.example/pixel.gif)",
  "",
  "- [ ] I agree to everything",
  "",
  "# Not a heading",
  "",
  '<iframe src="https://evil.example/raw"></iframe>',
  "",
  '<span style="color: #ff0000">red</span> and <u>underlined</u>',
].join("\n");

describe("MarkdownView inline", () => {
  test("the inline schema is p, em, strong, a, code and br, with attributes on a only", () => {
    assert.deepEqual(MD_INLINE_SANITIZE_SCHEMA.tagNames, ["p", "em", "strong", "a", "code", "br"]);
    assert.deepEqual(Object.keys(MD_INLINE_SANITIZE_SCHEMA.attributes ?? {}), ["a"]);
    assert.ok(MD_INLINE_SANITIZE_SCHEMA.attributes?.a.includes("href"), "a link keeps its href");
    assert.ok(MD_INLINE_SANITIZE_SCHEMA.protocols?.href?.includes("https"), "under the default protocols");
  });

  test("inline keeps emphasis, code and a link and drops an iframe directive, a video, an image, a task list, a heading, raw HTML and styles", () => {
    const html = render(STATEMENT, true);
    assert.match(html, /<strong>read<\/strong>/);
    assert.match(html, /<em>handbook<\/em>/);
    assert.match(html, /<code>comply<\/code>/);
    assert.match(html, /<a href="\/doc\/12">the policy<\/a>/);
    assert.match(html, /<p>/);
    for (const forbidden of [
      "<iframe",
      "evil.example",
      "md-embed",
      "md-video",
      "youtube.com",
      "<img",
      "tracker.example",
      "<input",
      "checkbox",
      "<ul",
      "<li",
      "<h1",
      "style=",
      "<u>",
      "<span",
      "<div class=\"md-",
    ]) {
      assert.ok(!html.includes(forbidden), `inline markup must not carry ${JSON.stringify(forbidden)}:\n${html}`);
    }
    // The text of what was dropped is not what matters; the markup is. The
    // underlined word stays as plain text, the heading as a sentence.
    assert.match(html, /underlined/);
  });

  test("a javascript: link loses its href in both modes, and an external link still opens in a new tab", () => {
    const html = render("[click](javascript:alert(1)) and [docs](https://docs.example.com/policy)", true);
    assert.ok(!html.includes("javascript:"), html);
    assert.match(html, /<a>click<\/a>/);
    assert.match(html, /<a href="https:\/\/docs\.example\.com\/policy" target="_blank" rel="noopener noreferrer"/);
    assert.ok(!render("[click](javascript:alert(1))", false).includes("javascript:"));
  });

  test("the document view, for contrast, still renders the image, the task list and the embed", () => {
    const html = render(STATEMENT, false);
    assert.ok(html.includes("tracker.example"), "the document view keeps the image");
    assert.match(html, /type="checkbox"/);
    assert.match(html, /<h1/);
  });
});
