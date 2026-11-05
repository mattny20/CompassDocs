// The printed handbook's page boxes (1.18.0). Chromium prints @page margin
// boxes, so the footer on every page — "Title · Company" | "Printed … by …
// · uncontrolled when printed" | "Page N" — and the running header of each
// policy ("1 · Working here" | "Policy 2 of 8") are page furniture rather
// than elements in the flow: they repeat on every page a long policy runs
// to, and the page number is the printer's own counter.
//
// The running header rides on CSS named pages: each policy sheet carries
// `page: hb-p-{n}` and gets an @page rule of its own. A change of named page
// also forces the page break, so each policy starts on a new page.
//
// The strings are handbook titles and people's names, so they are escaped
// for a CSS string AND for the <style> element they are inlined into.

import { PAPER_CSS, sectionLabel, type PrintHandbook } from "./print-model";

/** A CSS string literal: quotes, backslashes, newlines and `<`/`>`/`&`
 *  become hex escapes, so a title cannot end the string or the <style>. */
export function cssString(value: string): string {
  const escaped = value.replace(/[\\"<>&\u0000-\u001f\u007f\u2028\u2029]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `);
  return `"${escaped}"`;
}

/** The named page of policy n. */
export function policyPageName(n: number): string {
  return `hb-p-${n}`;
}

const FURNITURE = `font-family: "Aileron", ui-sans-serif, system-ui, sans-serif; font-size: 7.5pt; color: #5a6980;`;

export function handbookPageCss(hb: PrintHandbook): string {
  const paper = PAPER_CSS[hb.paper];
  const left = cssString(`${hb.title} · ${hb.company}`);
  const middle = cssString(`${hb.status === "draft" ? "Draft · " : ""}Printed ${hb.printedOn} by ${hb.printedBy} · uncontrolled when printed`);
  const bottom = `vertical-align: top; padding-top: 2.5mm; border-top: 0.5pt solid #e2e8f0; ${FURNITURE}`;
  const top = `vertical-align: bottom; padding-bottom: 2.5mm; border-bottom: 0.5pt solid #e2e8f0; ${FURNITURE}`;

  const rules: string[] = [
    `@page {
  size: ${paper.size};
  margin: 20mm 18mm 22mm;
  @bottom-left { content: ${left}; text-align: left; ${bottom} }
  @bottom-center { content: ${middle}; text-align: center; width: 48%; ${bottom} }
  @bottom-right { content: "Page " counter(page); text-align: right; ${bottom} }
}`,
    // The cover bleeds to the edge and carries no furniture.
    `@page hb-cover {
  margin: 0;
  @bottom-left { content: none; border: 0 }
  @bottom-center { content: none; border: 0 }
  @bottom-right { content: none; border: 0 }
}`,
  ];

  for (const section of hb.sections) {
    const head = section.title ? cssString(sectionLabel(section)) : cssString(hb.title);
    for (const p of section.policies) {
      rules.push(`@page ${policyPageName(p.number)} {
  @top-left { content: ${head}; text-align: left; ${top} }
  @top-right { content: ${cssString(`Policy ${p.number} of ${hb.policyCount}`)}; text-align: right; ${top} }
}`);
    }
  }

  // Paper type: 10.5pt body. The app's sizes are rem, so the root carries it
  // (globals.css resets the root to 1rem for print; this page comes later).
  rules.push(`@media print {
  html { font-size: 10.5pt; }
}`);
  // The cover's sheet is exactly one page of the chosen paper.
  rules.push(`:root { --hb-paper-height: ${paper.height}; }`);
  return rules.join("\n");
}
