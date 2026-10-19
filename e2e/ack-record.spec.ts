import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// 1.12.0 (C4): the Record tab of the Read confirmation pages is the house
// Table with the house controls: a "Show" filter (All / Pending / Confirmed),
// a "Filter people" box with its live count, a pager, and a "View" switch
// between the current version (one row per person) and All confirmations
// (every ledger row, superseded ones included). The header's Export CSV
// became an Export menu: Export CSV, Ledger CSV (all confirmations) for
// compliance.export holders, and Print… last; a print-only title line names
// the policy and the date.
//
// Licensed builds only: the PATCH answers 402 on the community build and
// the test skips itself (as e2e/acknowledgements.spec.ts does).

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

const BODY = "## Policy\n\nShort policy text for the record page check. Read it and confirm at the end.";

const LEDGER_HEADER =
  "document,document_id,space,name,username,email,role,acknowledged_at,superseded,version,version_id,content_sha256,version_source,statement,signed_name,identity_proof,read_seconds,reached_end_self_reported,ip,user_agent,account_removed";

async function makePolicy(page: Page, title: string): Promise<number> {
  const made = await api(page, "/api/documents", {
    method: "POST",
    body: { space_id: 1, title, type: "policy", status: "published", content: BODY, tags: [] },
  });
  expect(made.status, "policy created").toBe(201);
  const id = made.body?.doc?.id;
  expect(id, "policy id").toBeTruthy();
  return id;
}

/** Turn the requirement on; 402 means the community build. */
async function requireConfirmation(page: Page, docId: number): Promise<"on" | "unlicensed"> {
  const res = await api(page, `/api/documents/${docId}/ack`, { method: "PATCH", body: { required: true } });
  if (res.status === 402) return "unlicensed";
  expect(res.status, "confirmation required").toBe(200);
  return "on";
}

/** The admin confirms the newest version through the API. */
async function confirmLatest(page: Page, docId: number): Promise<number> {
  const summary = await api(page, `/api/documents/${docId}/ack`);
  expect(summary.status).toBe(200);
  const versionId = summary.body?.latest_version_id;
  expect(versionId, "the newest version id").toBeTruthy();
  const confirmed = await api(page, `/api/documents/${docId}/ack`, { method: "POST", body: { version_id: versionId } });
  expect(confirmed.status, "confirmed").toBe(200);
  return versionId;
}

async function fetchText(page: Page, path: string): Promise<{ status: number; text: string; type: string }> {
  return page.evaluate(async (p) => {
    const res = await fetch(p);
    return { status: res.status, text: await res.text(), type: res.headers.get("content-type") || "" };
  }, path);
}

/** One CSV line into cells: quoted fields may hold commas and doubled quotes. */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

async function auditRows(page: Page, pick: (r: any) => boolean): Promise<{ details: any }[]> {
  const log = await api(page, "/api/admin/audit?limit=100");
  expect(log.status, "audit log readable").toBe(200);
  return (log.body?.rows ?? []).filter(pick);
}

test("the Record tab: Show filters, the people filter count, the All confirmations view with a superseded row, and the Export menu", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, ADMIN);
  const title = `E2E ack record ${stamp()}`;
  let docId: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(
      (await requireConfirmation(page, docId)) === "unlicensed",
      "policy_ack is not licensed in this build; the EE rig runs the flow"
    );

    // Two confirmations by the admin: v1, then everyone is asked again for
    // v2 (a material edit through the API) and the admin confirms that too.
    // The current view shows the v2 row; the ledger shows both.
    await confirmLatest(page, docId);
    const edited = await api(page, `/api/documents/${docId}`, {
      method: "PUT",
      body: {
        content: `${BODY}\n\nThe cap is now 75.`,
        status: "published",
        ack_policy: "reset",
        ack_reason: "Expense cap raised to 75; everyone must read the new figure",
        versionNote: "Cap raised",
      },
    });
    expect(edited.status, "the material edit saved").toBe(200);
    expect(edited.body?.ack_outcome?.reset, "and asked everyone again").toBe(true);
    await confirmLatest(page, docId);

    await page.goto(`/doc/${docId}/acknowledgements`);
    const main = page.locator("#main");
    await expect(main.getByRole("heading", { name: "Read confirmation" })).toBeVisible();

    // The Show control is a radiogroup of three; Confirmed leaves confirmed
    // rows only, Pending leaves none of them.
    const show = main.getByRole("radiogroup", { name: "Show" });
    await expect(show).toBeVisible();
    for (const name of ["All", "Pending", "Confirmed"]) {
      await expect(show.getByRole("radio", { name, exact: true })).toBeVisible();
    }
    await expect(show.getByRole("radio", { name: "All", exact: true })).toHaveAttribute("aria-checked", "true");
    const rows = main.locator("tbody tr");
    await show.getByRole("radio", { name: "Confirmed", exact: true }).click();
    await expect(rows.first()).toBeVisible();
    await expect(main.locator("tbody tr", { hasText: "Pending" })).toHaveCount(0);
    expect(await rows.count()).toBeGreaterThanOrEqual(1);
    await show.getByRole("radio", { name: "All", exact: true }).click();

    // The people filter narrows what is on the page and says so: the
    // username matches the admin's own row and nobody else's.
    const filter = main.getByRole("textbox", { name: "Filter people" });
    await expect(filter).toBeVisible();
    // The count is read from the control, not from the rows on the page:
    // the roster pages at 50 and a rig with leftover accounts outgrows it,
    // while the ListFilter counts the whole audience.
    const countText = (await main.getByText(/^\d+ people$/).textContent()) ?? "";
    const total = Number(countText.match(/^\d+/)![0]);
    expect(total).toBeGreaterThanOrEqual(1);
    expect(await rows.count()).toBeLessThanOrEqual(total);
    await filter.fill(ADMIN.username);
    await expect(main.getByText(new RegExp(`^1 of ${total} people$`))).toBeVisible();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Confirmed");
    await expect(rows.first(), "the current view cites the newest confirmation").toContainText("v2");
    await expect(main.locator("tbody tr", { hasText: /\bv1\b/ }), "and never the superseded one").toHaveCount(0);
    // The Signed column exists; this policy asks for no signature, so the cell is blank.
    await expect(main.getByRole("columnheader", { name: "Signed" })).toBeVisible();

    // The view switch: All confirmations lists both of the admin's rows,
    // the superseded v1 row included; the Show control does not apply to
    // the ledger and goes away; an exporter sees the IP column.
    const view = main.getByRole("radiogroup", { name: "View" });
    await expect(view).toBeVisible();
    await view.getByRole("radio", { name: "All confirmations" }).click();
    await expect(view.getByRole("radio", { name: "All confirmations" })).toHaveAttribute("aria-checked", "true");
    await expect(main.getByRole("radiogroup", { name: "Show" })).toHaveCount(0);
    await expect(rows).toHaveCount(2);
    await expect(main.locator("tbody tr", { hasText: /\bv2\b/ })).toHaveCount(1);
    await expect(main.locator("tbody tr", { hasText: /\bv1\b/ }), "the superseded confirmation is on the record").toHaveCount(1);
    await expect(main.getByRole("columnheader", { name: "IP" })).toBeVisible();
    await expect(main.getByText(new RegExp(`^2 of \\d+ people$`))).toBeVisible();
    // Escape clears the filter; the count agrees.
    await filter.press("Escape");
    await expect(filter).toHaveValue("");
    await expect(main.getByText(/^\d+ people$/)).toBeVisible();
    await view.getByRole("radio", { name: "Current version" }).click();
    await expect(main.getByRole("radiogroup", { name: "Show" })).toBeVisible();

    // The Export menu: a menu button with the three rows, Print… last; the
    // ledger row is a real download of text/csv with the documented header.
    const trigger = main.getByRole("button", { name: "Export" });
    await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    const menu = page.getByRole("menu", { name: "Export" });
    await expect(menu).toBeVisible();
    const items = menu.getByRole("menuitem");
    await expect(items).toHaveText(["Export CSV", "Ledger CSV (all confirmations)", "Print…"]);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      menu.getByRole("menuitem", { name: "Ledger CSV (all confirmations)" }).click(),
    ]);
    expect(download.suggestedFilename()).toBe(`acknowledgements-ledger-doc-${docId}.csv`);
    await expect(menu).toHaveCount(0);
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(page.url(), "a download does not leave the page").toContain(`/doc/${docId}/acknowledgements`);
    const ledger = await fetchText(page, `/api/documents/${docId}/acknowledgements?format=ledger`);
    expect(ledger.status).toBe(200);
    expect(ledger.type).toContain("text/csv");
    const lines = ledger.text.trim().split("\n");
    expect(lines[0]).toBe(LEDGER_HEADER);
    const header = cells(lines[0]);
    const mine = lines.slice(1).map(cells).filter((c) => c[header.indexOf("username")] === ADMIN.username);
    expect(mine.length, "both of the admin's confirmations").toBe(2);
    expect(mine.map((c) => c[header.indexOf("superseded")]).sort()).toEqual(["no", "yes"]);
    expect(mine.map((c) => c[header.indexOf("version")]).sort()).toEqual(["v1", "v2"]);
    expect(mine.every((c) => c[header.indexOf("account_removed")] === "no")).toBe(true);
    // Both downloads are on the record (the menu's and the fetch above).
    const exports = await auditRows(page, (r) => r.action === "ack.export" && Number(r.target_id) === docId && r.details?.format === "ledger");
    expect(exports.length).toBe(2);
    expect(exports[0].details).toMatchObject({ format: "ledger", doc_id: docId, with_ip: true, rows: 2 });

    // Escape closes a reopened menu and hands focus back to the trigger.
    await trigger.click();
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();

    // The print-only title line is in the page and off the screen.
    const printTitle = page.getByText(new RegExp(`^Read confirmations · ${title} · as of `));
    await expect(printTitle).toHaveCount(1);
    await expect(printTitle).toBeHidden();
    await page.emulateMedia({ media: "print" });
    await expect(printTitle).toBeVisible();
    await expect(trigger, "controls stay off paper").toBeHidden();
    await expect(main.getByRole("radiogroup", { name: "Show" })).toBeHidden();
    await page.emulateMedia({ media: "screen" });
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});
