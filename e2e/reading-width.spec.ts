import { test, expect } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// The reading measure caps the TEXT, not the column (1.0.1).
//
// Until 1.0.1 the 60ch measure was on `.doc-prose` itself, so it capped
// everything inside: a ten-column table or a long command line was squeezed
// into 60ch and left to scroll sideways while the content column beside it sat
// empty. It also made Wide and Full render the document body identically —
// both hit the same ceiling — so choosing Full moved nothing the reader was
// looking at.
//
// Two assertions, because the fix has to hold in both directions: prose must
// STILL be capped (or we're back to ~98-character lines), and wide blocks must
// NOT be (or Full is decorative again).

const WIDE_TABLE = `Body text long enough to reach the measure. ${"Lorem ipsum dolor sit amet consectetur. ".repeat(10)}

| Region | Owner | Q1 | Q2 | Q3 | Q4 | Target | Variance | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| EMEA North | A. Rahman | 1,240 | 1,380 | 1,410 | 1,502 | 5,400 | +132 | On track | Renewal cycle shifted |
| APAC South | J. Okafor | 980 | 1,020 | 1,190 | 1,240 | 4,600 | -170 | At risk | Two churns in Q3 |
`;

test("the reading measure caps prose, and wide blocks use the full column", async ({ browser }) => {
  // Wide enough that Full is meaningfully wider than the 60ch measure —
  // at a narrow viewport every setting collapses to the same column and the
  // test would pass without proving anything.
  const ctx = await browser.newContext({ viewport: { width: 1680, height: 1000 } });
  const page = await ctx.newPage();
  await login(page, ADMIN);

  const stamp = Date.now();
  let docId: number | undefined;

  try {
    const made = await api(page, "/api/documents", {
      method: "POST",
      body: {
        space_id: 1,
        title: `E2E reading width ${stamp}`,
        type: "technical",
        status: "published",
        content: WIDE_TABLE,
        tags: [],
      },
    });
    expect(made.status, "probe document created").toBe(201);
    docId = made.body?.doc?.id;
    expect(docId).toBeTruthy();

    const measure = async (width: "normal" | "wide" | "full") => {
      await api(page, "/api/account/preferences", {
        method: "PATCH",
        body: { page_width: width },
      });
      await page.goto(`/doc/${docId}`);
      await page.waitForLoadState("networkidle");
      return page.evaluate(() => {
        const para = document.querySelector(".doc-read .doc-prose > p");
        const table = document.querySelector(".doc-read .doc-prose > .md-filter-table");
        const scroller = document.querySelector(".doc-read .md-filter-table .overflow-x-auto");
        return {
          para: Math.round(para!.getBoundingClientRect().width),
          table: Math.round(table!.getBoundingClientRect().width),
          // How much of the table is parked behind a horizontal scroll.
          hidden: scroller ? scroller.scrollWidth - scroller.clientWidth : -1,
        };
      });
    };

    const wide = await measure("wide");
    const full = await measure("full");

    // The measure still holds: prose does not grow between Wide and Full.
    expect(wide.para, "prose is capped at the measure").toBeLessThanOrEqual(600);
    expect(full.para, "prose does not grow past the measure at Full").toBe(wide.para);

    // The column does grow, and the table grows with it — this is the part
    // that was broken: the table used to be pinned to the prose measure.
    expect(full.table, "the table uses the wider column at Full").toBeGreaterThan(wide.table);
    expect(full.table, "the table is wider than the prose measure").toBeGreaterThan(full.para);

    // And at Full this table fits outright, rather than hiding columns behind
    // a scrollbar with empty page sitting next to it.
    expect(full.hidden, "no columns are parked off-screen at Full").toBe(0);
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
    await ctx.close();
  }
});

// 1.0.1 tagged four block types and missed five (1.0.2). Every panel and every
// piece of media has to be in the set, or the page renders ragged: a callout at
// the measure directly above a table at the column, an accordion at half the
// width of the code block above it. Containers are the worst of it — a table
// inside a narrow tab is capped twice.
//
// Asserting on the whole set rather than a sample, because "some fixed, others
// not" is exactly the failure this replaces.

const ALL_BLOCKS = `Prose that must stay at the reading measure.

:::danger[A callout]
Callouts are panels, not paragraphs.
:::

| A | B | C |
| - | - | - |
| 1 | 2 | 3 |

\`\`\`bash
echo "fenced code"
\`\`\`

:::details[An accordion]
| D | E |
| - | - |
| 4 | 5 |
:::

::::tabs
:::tab[One]
| F | G |
| - | - |
| 6 | 7 |
:::
:::tab[Two]
Second panel.
:::
::::
`;

test("every panel and media block follows the column, not the measure", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1680, height: 1200 } });
  const page = await ctx.newPage();
  await login(page, ADMIN);

  let docId: number | undefined;
  try {
    const made = await api(page, "/api/documents", {
      method: "POST",
      body: {
        space_id: 1,
        title: `E2E all blocks ${Date.now()}`,
        type: "technical",
        status: "published",
        content: ALL_BLOCKS,
        tags: [],
      },
    });
    expect(made.status).toBe(201);
    docId = made.body?.doc?.id;

    await api(page, "/api/account/preferences", {
      method: "PATCH",
      body: { page_width: "full" },
    });
    await page.goto(`/doc/${docId}`);
    await page.waitForLoadState("networkidle");

    const m = await page.evaluate(() => {
      const prose = document.querySelector(".doc-read .doc-prose")!;
      const column = Math.round(prose.parentElement!.getBoundingClientRect().width);
      const width = (sel: string) => {
        const el = prose.querySelector(sel);
        return el ? Math.round(el.getBoundingClientRect().width) : null;
      };
      return {
        column,
        para: width(":scope > p"),
        callout: width(".md-callout-box"),
        table: width(":scope > .md-filter-table"),
        code: width(".code-block"),
        accordion: width("details"),
        tabs: width(":scope > div.doc-wide:has(.md-tab)"),
        // A table nested inside a tab: capped by its ancestor, so this is the
        // number that exposes a narrow container.
        tableInTab: width(".md-tab table"),
      };
    });

    expect(m.para, "prose keeps the measure").toBeLessThanOrEqual(600);
    for (const [name, w] of [
      ["callout", m.callout],
      ["table", m.table],
      ["code block", m.code],
      ["accordion", m.accordion],
      ["tabs", m.tabs],
    ] as const) {
      expect(w, `${name} follows the content column`).toBe(m.column);
    }
    // Not exact — the tab has padding — but it must be far wider than the
    // measure, which is what a narrow container would have left it at.
    expect(m.tableInTab, "a table inside a tab is not double-capped").toBeGreaterThan(m.para! + 200);
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
    await ctx.close();
  }
});
