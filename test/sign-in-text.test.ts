// The sign-in page's admin text (1.16.0, lib/sign-in-text): what the save
// route stores, what the preview lays over the stored look, and the small
// maps the cover reads. Text is normalised (NFC, no control characters or
// line breaks, one space, trimmed) and an over-long value is refused with a
// sentence, never cut; a help link is https: or mailto: only. Pure, so no
// database.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/sign-in-text.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  ART_SIZES,
  FOCUS_LABEL,
  FOCUS_POINTS,
  FOCUS_POSITION,
  SIGN_IN_FIELD_LABEL,
  SIGN_IN_LIMITS,
  SIGN_IN_TEXT_DEFAULTS,
  asFocus,
  asSide,
  helpUrlProblem,
  lengthProblem,
  lenTier,
  normalizeSignInText,
  parseSignInText,
  type SignInTextKey,
} from "../src/lib/sign-in-text";

const KEYS = Object.keys(SIGN_IN_LIMITS) as SignInTextKey[];
const BAD_URL = "Use an address that starts with https:// or mailto:.";

describe("normalizeSignInText", () => {
  test("composes to NFC, so a decomposed accent is one character and counts once", () => {
    const decomposed = "Café Ltd";
    const out = normalizeSignInText(decomposed);
    assert.equal(out, "Café Ltd");
    assert.equal([...out].length, 8);
  });

  test("control characters, C1 controls and line breaks become one space", () => {
    assert.equal(normalizeSignInText("Acme\u0000Docs"), "Acme Docs");
    assert.equal(normalizeSignInText("Acme\u0007\u001fDocs"), "Acme Docs");
    assert.equal(normalizeSignInText("Acme\u007fDocs"), "Acme Docs");
    assert.equal(normalizeSignInText("Acme\u0085\u009fDocs"), "Acme Docs");
    assert.equal(normalizeSignInText("Line one\r\nLine two\nLine three"), "Line one Line two Line three");
    assert.equal(normalizeSignInText("Para graph break"), "Para graph break");
  });

  test("runs of whitespace collapse to one space and the ends are trimmed", () => {
    assert.equal(normalizeSignInText("  Policies,\t\t runbooks   and how-tos  "), "Policies, runbooks and how-tos");
    assert.equal(normalizeSignInText(" Acme  Docs "), "Acme Docs", "a no-break space is whitespace too");
    assert.equal(normalizeSignInText(" \n\t "), "");
  });

  test("anything that is not a string reads as text, and nothing as empty", () => {
    assert.equal(normalizeSignInText(undefined), "");
    assert.equal(normalizeSignInText(null), "");
    assert.equal(normalizeSignInText(42), "42");
  });

  test("ordinary text, emoji and other scripts are kept as typed", () => {
    for (const s of ["Acme", "Policies, runbooks & how-tos.", "Ångström Øresund", "東京オフィス", "Team 🚀 docs"]) {
      assert.equal(normalizeSignInText(s), s);
    }
  });
});

describe("limits", () => {
  test("the limits are the spec's", () => {
    assert.deepEqual(SIGN_IN_LIMITS, { headline: 60, tagline: 140, caption: 80, help: 160, help_url: 500, example: 64 });
  });

  for (const key of KEYS) {
    test(`${key}: ${SIGN_IN_LIMITS[key]} characters fit, one more is refused with a sentence`, () => {
      const max = SIGN_IN_LIMITS[key];
      assert.equal(lengthProblem(key, "a".repeat(max)), null);
      assert.equal(lengthProblem(key, "a".repeat(max + 1)), `${SIGN_IN_FIELD_LABEL[key]} is limited to ${max} characters.`);
    });
  }

  test("characters are counted, not UTF-16 units: an emoji is one", () => {
    assert.equal(lengthProblem("headline", "🚀".repeat(60)), null);
    assert.equal(lengthProblem("headline", "🚀".repeat(61)), "Headline is limited to 60 characters.");
  });

  test("the sentences name the field as the form labels it", () => {
    assert.equal(lengthProblem("help", "x".repeat(161)), "Help text is limited to 160 characters.");
    assert.equal(lengthProblem("help_url", "x".repeat(501)), "Help link is limited to 500 characters.");
    assert.equal(lengthProblem("example", "x".repeat(65)), "Example email is limited to 64 characters.");
  });
});

describe("help links", () => {
  test("https with a host and mailto with an address are fine; empty is fine", () => {
    assert.equal(helpUrlProblem(""), null);
    assert.equal(helpUrlProblem("https://help.acme.example/sign-in"), null);
    assert.equal(helpUrlProblem("https://acme.example"), null);
    assert.equal(helpUrlProblem("mailto:it@acme.example"), null);
    assert.equal(helpUrlProblem("mailto:it@acme.example?subject=Sign%20in"), null);
  });

  test("every other scheme, a bare host and a mailto with no address are refused", () => {
    for (const url of [
      "http://help.acme.example",
      "javascript:alert(1)",
      "data:text/html,<p>hi</p>",
      "ftp://acme.example/help",
      "file:///etc/passwd",
      "tel:+15550100",
      "help.acme.example",
      "/help",
      "//acme.example/help",
      "mailto:",
      "mailto:helpdesk",
      "https://",
      "not a url",
    ]) {
      assert.equal(helpUrlProblem(url), BAD_URL, url);
    }
  });
});

describe("lenTier", () => {
  test("up to 18 characters is s, up to 36 is m, longer is l", () => {
    assert.equal(lenTier(""), "s");
    assert.equal(lenTier("a".repeat(18)), "s");
    assert.equal(lenTier("a".repeat(19)), "m");
    assert.equal(lenTier("a".repeat(36)), "m");
    assert.equal(lenTier("a".repeat(37)), "l");
    assert.equal(lenTier("a".repeat(80)), "l");
  });

  test("counts characters, so 18 emoji are still short", () => {
    assert.equal(lenTier("🚀".repeat(18)), "s");
    assert.equal(lenTier("🚀".repeat(19)), "m");
  });
});

describe("focus and side", () => {
  test("nine focus points, each with an object-position and a label", () => {
    assert.deepEqual([...FOCUS_POINTS], ["tl", "t", "tr", "l", "c", "r", "bl", "b", "br"]);
    assert.deepEqual(FOCUS_POSITION, {
      tl: "0% 0%",
      t: "50% 0%",
      tr: "100% 0%",
      l: "0% 50%",
      c: "50% 50%",
      r: "100% 50%",
      bl: "0% 100%",
      b: "50% 100%",
      br: "100% 100%",
    });
    assert.deepEqual(FOCUS_LABEL, {
      tl: "Top left",
      t: "Top",
      tr: "Top right",
      l: "Left",
      c: "Center",
      r: "Right",
      bl: "Bottom left",
      b: "Bottom",
      br: "Bottom right",
    });
  });

  test("the positions read in grid order: x steps across a row, y steps down the rows", () => {
    FOCUS_POINTS.forEach((f, i) => {
      const [x, y] = FOCUS_POSITION[f].split(" ");
      assert.equal(x, `${(i % 3) * 50}%`, f);
      assert.equal(y, `${Math.floor(i / 3) * 50}%`, f);
    });
  });

  test("an unknown focus is the centre; an unknown side is the start (art on the left)", () => {
    for (const f of FOCUS_POINTS) assert.equal(asFocus(f), f);
    for (const bad of ["", "center", "TL", "x", null, undefined, 3]) assert.equal(asFocus(bad), "c", String(bad));
    assert.equal(asSide("end"), "end");
    for (const bad of ["start", "left", "right", "END", "", null, undefined]) assert.equal(asSide(bad), "start", String(bad));
  });

  test("ART_SIZES is a media list (no clamp(), which sizes cannot take)", () => {
    assert.equal(ART_SIZES, "(min-width: 120rem) 80vw, (min-width: 64rem) 66vw, 100vw");
    assert.doesNotMatch(ART_SIZES, /clamp\(/);
  });
});

describe("parseSignInText (the save route's body)", () => {
  test("an empty body is the defaults, with no refusals", () => {
    assert.deepEqual(parseSignInText({}), { value: SIGN_IN_TEXT_DEFAULTS, fields: {} });
  });

  test("text is normalised and kept; focus, side and the text toggle are read", () => {
    const { value, fields } = parseSignInText({
      headline: "  Acme\n Docs ",
      tagline: "Policies,\u0000 runbooks",
      caption: "Photo: Harbour office, 2024",
      help: "Ask   IT",
      help_url: " https://help.acme.example ",
      example: "name@acme.example",
      focus: "tr",
      side: "end",
      show_text: false,
    });
    assert.deepEqual(fields, {});
    assert.deepEqual(value, {
      headline: "Acme Docs",
      tagline: "Policies, runbooks",
      caption: "Photo: Harbour office, 2024",
      help: "Ask IT",
      help_url: "https://help.acme.example",
      example: "name@acme.example",
      focus: "tr",
      side: "end",
      show_text: false,
    });
  });

  test("the text toggle is on unless it is false or \"0\"", () => {
    assert.equal(parseSignInText({ show_text: true }).value.show_text, true);
    assert.equal(parseSignInText({ show_text: "1" }).value.show_text, true);
    assert.equal(parseSignInText({}).value.show_text, true);
    assert.equal(parseSignInText({ show_text: false }).value.show_text, false);
    assert.equal(parseSignInText({ show_text: "0" }).value.show_text, false);
  });

  test("every over-long field is refused at once, and keeps its (normalised) value for the form", () => {
    const body: Record<string, string> = {};
    for (const key of KEYS) body[key] = key === "help_url" ? `https://acme.example/${"a".repeat(500)}` : "a".repeat(SIGN_IN_LIMITS[key] + 1);
    const { value, fields } = parseSignInText(body);
    for (const key of KEYS) {
      assert.equal(fields[key], `${SIGN_IN_FIELD_LABEL[key]} is limited to ${SIGN_IN_LIMITS[key]} characters.`, key);
      assert.equal(value[key], body[key], `${key} is not cut`);
    }
  });

  test("the limit applies after normalisation: padding and line breaks do not count", () => {
    const { fields } = parseSignInText({ headline: `   ${"a".repeat(30)}\n\n${"b".repeat(29)}   ` });
    assert.equal(fields.headline, undefined, "60 characters once the break is one space");
  });

  test("a help link with the wrong scheme is refused with the link sentence", () => {
    assert.equal(parseSignInText({ help_url: "http://help.acme.example" }).fields.help_url, BAD_URL);
    assert.equal(parseSignInText({ help_url: "javascript:alert(1)" }).fields.help_url, BAD_URL);
    assert.equal(parseSignInText({ help_url: "mailto:it@acme.example" }).fields.help_url, undefined);
  });

  test("an over-long link gets the length sentence, not the scheme one", () => {
    const { fields } = parseSignInText({ help_url: `ftp://${"a".repeat(600)}` });
    assert.equal(fields.help_url, "Help link is limited to 500 characters.");
  });

  test("an unknown focus or side falls back instead of being refused", () => {
    const { value, fields } = parseSignInText({ focus: "middle", side: "left" });
    assert.deepEqual(fields, {});
    assert.equal(value.focus, "c");
    assert.equal(value.side, "start");
  });
});
