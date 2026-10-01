// Scaling guard (STYLEGUIDE §Scaling): the interface is sized in rem so one
// root rule can scale it with the monitor. A px literal in a Tailwind class
// stays frozen while everything around it grows, so none may be added.
//
// Run: npm run test:integration (this file needs no DATABASE_URL).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|ts|css)$/.test(name)) out.push(p);
  }
  return out;
}

// A px literal inside a Tailwind arbitrary value: `text-[11px]`, `h-[420px]`,
// `min-w-[720px]`, `left-[18px]`, `max-h-[540px]` … 1px/2px hairlines
// (`border-[1px]`, `ring-[2px]`, `translate-y-[1px]`) are allowed.
const PX_CLASS = /\b[a-z-]+-\[(\d+)px\]/g;

// Hand-written CSS: font-size/padding/width/height/radius in px. Hairlines
// (1–2px), `box-shadow`, `outline`, `backdrop-filter: blur(2px)` and the
// print block are allowed.
const PX_CSS = /^\s*(font-size|padding|margin|width|height|min-width|max-width|min-height|max-height|border-radius|top|bottom|left|right|gap)\s*:[^;]*\b(\d+)px/gm;

const files = walk(ROOT);

describe("style scale guard", () => {
  test("no px literals in Tailwind classes (hairlines excepted)", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (!/\.tsx?$/.test(file)) continue;
      const src = readFileSync(file, "utf8");
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        // SVG text sizes live in chart space, not interface space.
        if (/<text\b/.test(line)) return;
        for (const m of line.matchAll(PX_CLASS)) {
          if (Number(m[1]) <= 2) continue;
          offenders.push(`${relative(ROOT, file)}:${i + 1}: ${m[0]}`);
        }
      });
    }
    assert.deepEqual(offenders, [], `px literals in classes (use rem / the spacing scale):\n${offenders.join("\n")}`);
  });

  test("no px sizes in hand-written CSS (hairlines excepted)", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (!file.endsWith(".css")) continue;
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(PX_CSS)) {
        if (Number(m[2]) <= 2) continue;
        const line = src.slice(0, m.index).split("\n").length;
        offenders.push(`${relative(ROOT, file)}:${line}: ${m[0].trim()}`);
      }
    }
    assert.deepEqual(offenders, [], `px sizes in CSS (use rem):\n${offenders.join("\n")}`);
  });
});
