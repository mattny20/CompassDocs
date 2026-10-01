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

  test("primary-button recipes live in components/Button only (§Buttons)", () => {
    // A class string that paints the accent and its hover is a button being
    // written by hand; buttonClass()/<Button> is the recipe.
    const hits = offenders(
      /bg-compass-600[^"'`\n]*hover:bg-compass-700|hover:bg-compass-700[^"'`\n]*bg-compass-600/,
      (file) => !file.endsWith("components/Button.tsx")
    );
    assert.deepEqual(hits, [], `hand-written primary button — use buttonClass()/<Button>:\n${hits.join("\n")}`);
  });

  test("page titles come from PageHeader (§Page skeleton heading ladder)", () => {
    const ALLOW = [
      "components/PageHeader.tsx",
      // Document titles (text-3xl): the document is the thing itself.
      "app/(app)/doc/[id]/page.tsx",
      "app/(public)/share/[token]/page.tsx",
      "app/(public)/public/[space]/[doc]/page.tsx",
      "components/NewsletterWorkspace.tsx", // the newsletter's subject in preview
      // Mastheads whose 48px icon tile or photo replaces the 24px lucide icon.
      "app/(app)/directory/[id]/page.tsx",
      "app/(app)/spaces/[slug]/page.tsx",
      // Documented exceptions and standalone surfaces outside the shell.
      "components/DashboardGreeting.tsx",
      "components/DocEditor.tsx",
      "components/TrainingPlayer.tsx",
      "components/UploadDrop.tsx",
      "app/(public)/public/page.tsx",
      "app/(public)/public/[space]/page.tsx",
      "app/(public)/public/search/page.tsx",
      "app/(public)/upload/[token]/page.tsx",
      "app/oauth/authorize/page.tsx",
      "app/account/password/page.tsx",
      "app/setup/page.tsx",
      "app/not-found.tsx",
      "app/(app)/not-found.tsx",
      "app/(app)/error.tsx",
      "app/global-error.tsx",
    ];
    // .tsx only: email HTML templates in lib/ carry their own <h1>.
    const hits = offenders(/<h1\b/, (file) => file.endsWith(".tsx") && !ALLOW.some((a) => file.endsWith(a)));
    assert.deepEqual(hits, [], `hand-written page title — use <PageHeader>:\n${hits.join("\n")}`);
  });

  test("emerald is the single success hue (§Status chips)", () => {
    const hits = offenders(/\b(?:bg|text|border|ring|from|to|divide|decoration|fill|stroke)-green-\d+/);
    assert.deepEqual(hits, [], `green-* — use emerald:\n${hits.join("\n")}`);
  });

  test("uppercase labels are the eyebrow tiers only (§Sections and cards)", () => {
    // text-sm/text-lg uppercase is body-sized shouting; tracking-wide (not
    // -wider) and font-medium are the retired recipes.
    const re = /\buppercase\b/;
    const bad = (line: string) =>
      /\btext-(?:sm|base|lg)\b/.test(line) || /\btracking-wide\b/.test(line) || /\bfont-medium\b[^"'`\n]*\buppercase\b|\buppercase\b[^"'`\n]*\bfont-medium\b/.test(line);
    // tracking-widest is the certificate's letterpress heading, a print document.
    const hits = offenders(
      re,
      (file, line) => file.endsWith(".tsx") && !/rounded-full|tracking-widest/.test(line) && bad(line)
    );
    assert.deepEqual(hits, [], `uppercase label outside the eyebrow tiers — use Eyebrow / EYEBROW_TEXT / RAIL_GROUP_TEXT:\n${hits.join("\n")}`);
  });

  test("hue pairs on pills live in components/Chip only (§Status chips)", () => {
    const hits = offenders(
      /rounded-full[^"'`\n]*\b(?:bg-(?:emerald|amber|red|sky|violet|purple|blue|teal|rose|orange|yellow)-(?:50|100))\b/,
      (file) => !file.endsWith("components/Chip.tsx") && !file.endsWith("lib/directory-display.ts")
    );
    assert.deepEqual(hits, [], `hand-written chip — use <Chip tone> / chipClass():\n${hits.join("\n")}`);
  });

  test("no typed glyphs where an icon belongs (§Icons)", () => {
    // ＋ ✓ ✨ ⬇ 📋 ○ as control text sit off the baseline, ignore the
    // accent and vary by OS. Emoji that are content (space icons chosen by
    // people) and the keycap map are the exceptions.
    const ALLOW = ["components/SpaceIconPicker.tsx", "components/palette/Kbd.tsx"];
    // The u flag keeps the astral 📋 from matching every emoji sharing its
    // high surrogate.
    const hits = offenders(/[＋✓✨⬇📋○]/u, (file) => file.endsWith(".tsx") && !ALLOW.some((a) => file.endsWith(a)));
    assert.deepEqual(hits, [], `typed glyph — use a lucide icon (Plus, Check, Sparkles, …):\n${hits.join("\n")}`);
  });

  test("floating panels use the float tier, not an ad-hoc shadow (§Overlays)", () => {
    const hits = offenders(/\babsolute\b[^"'`\n]*\bshadow-(?:lg|xl|md)\b|\bshadow-(?:lg|xl|md)\b[^"'`\n]*\babsolute\b/, (file) =>
      file.endsWith(".tsx") && !file.endsWith("components/Popover.tsx")
    );
    assert.deepEqual(hits, [], `hand-written floating panel — use <Popover> (shadow-float):\n${hits.join("\n")}`);
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
