// Style-drift guard (STYLEGUIDE §Color and theming, §Accessibility). The
// rules below each shipped as a regression at least once; the UX review of
// 1.3.x measured 516 slate-400 text sites, five dark: slate overrides and
// eleven compass-950 no-ops. Each rule names the guide section it enforces.
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
    else if (/\.(tsx|ts)$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(ROOT).filter((f) => !f.includes("/__tests__/"));

function offenders(re: RegExp, filter?: (file: string, line: string) => boolean): string[] {
  const out: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!re.test(line)) return;
      if (filter && !filter(file, line)) return;
      out.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  return out;
}

describe("style drift guard", () => {
  test("no dark: variant on a slate token (the slate ramp already inverts; §Color and theming)", () => {
    const hits = offenders(/dark:(?:hover:|focus:|group-hover:)?(?:bg|text|border|ring|divide|placeholder|from|to)-slate-/);
    assert.deepEqual(hits, [], `dark: on slate paints a light slab in dark mode:\n${hits.join("\n")}`);
  });

  test("no compass-950 (not a token; the class generates nothing)", () => {
    const hits = offenders(/compass-950/);
    assert.deepEqual(hits, [], `compass-950 is not in @theme:\n${hits.join("\n")}`);
  });

  test("slate-400 never carries text (2.5:1 fails AA; §Accessibility)", () => {
    // A className that sets a text size AND slate-400 ink is a run of words.
    // Icons (h-4 w-4 text-slate-400), dividers and placeholder: are fine.
    const size = /\btext-(?:xs|sm|base|lg|xl|2xl|2xs|3xs|\[[0-9.]+rem\])\b/;
    const hits = offenders(/(?<![:\w-])text-slate-400\b/, (_f, line) => size.test(line));
    assert.deepEqual(hits, [], `text in slate-400 — use slate-500 or darker:\n${hits.join("\n")}`);
  });

  test("bg-white only where white is literal (brand tiles, QR, media stages, email previews)", () => {
    const ALLOW = [
      "components/Brand.tsx",
      "components/Lightbox.tsx",
      "components/DocBlocks.tsx",
      "components/DocBlocksStatic.tsx",
      "components/VideoPlayer.tsx",
      "components/directory/ProfileActions.tsx",
      "components/form.tsx",
      "components/LinksAdmin.tsx",
      "app/(app)/links/page.tsx",
      "components/NewsletterPeople.tsx",
      "components/EmailTemplatesPanel.tsx",
      "components/EmailTemplate.tsx",
    ];
    const hits = offenders(/\bbg-white\b(?!\/)/, (file) => !ALLOW.some((a) => file.endsWith(a)));
    assert.deepEqual(hits, [], `bg-white on a themed surface half-flips in dark mode — use bg-surface:\n${hits.join("\n")}`);
  });
});
