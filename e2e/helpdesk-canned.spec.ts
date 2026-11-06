import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// 1.19.2 Helpdesk canned responses (agent W4, designs d1 and d2).
//
//   library   Desk settings → Canned responses: create one with a
//             placeholder chip, see it in the table (Only me, its folder).
//   composer  ";" at the start of a word opens the picker; typing filters;
//             ↓ + Enter inserts the filled text in place of ";query";
//             "a;b" never opens it; Escape closes and keeps the text; the
//             Canned response button opens it with its own search and works
//             in an internal note too. Nothing is sent and the ticket is
//             unchanged; the inserts are counted (Used, 30 days).
//
// Parallel-safe: every response here is personal ("Only me", the admin's
// own) and stamped; the ticket is this test's own; both are deleted at the
// end. Licensed builds only (402 → skip).

const look = expect.configure({ timeout: 30_000 });
const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

async function licensed(page: Page): Promise<boolean> {
  const res = await api(page, "/api/helpdesk/admin/canned");
  if (res.status === 402) return false;
  expect(res.status, "the admin reads the canned response library").toBe(200);
  return true;
}

test.describe("Helpdesk: canned responses", () => {
  test("library, ; picker and button insert filled text and never change the ticket", async ({ page }) => {
    test.setTimeout(300_000);
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "community build: the helpdesk answers 402");
    const s = stamp();
    const tag = `zq${s}`;
    const ids: number[] = [];
    let number = 0;
    try {
      // Two of the admin's own responses, by API.
      for (const [title, body, folder] of [
        [`${tag} VPN logs, how to send them`, "Open the VPN client, choose Help, then Export logs, {{requester.first_name}}.", "VPN"],
        [`${tag} Known outage`, "We know the VPN isn't working from home right now (#{{ticket.number}}).", ""],
      ]) {
        const r = await api(page, "/api/helpdesk/admin/canned", { method: "POST", body: { title, body, folder, share: "me" } });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        ids.push(r.body.canned.id);
      }

      // --- The library (d2) ------------------------------------------------------
      await page.goto("/desk/settings/canned").catch(() => page.goto("/desk/settings/canned"));
      await look(page.locator("h1")).toHaveText("Canned responses");
      await look(page.getByText("Type ; in the reply box to insert one at the cursor.", { exact: false })).toBeVisible();
      await look(page.getByRole("radiogroup", { name: "Show" }).or(page.getByRole("combobox", { name: "Show" }))).toBeVisible();
      await page.getByRole("searchbox", { name: "Search canned responses" }).fill(tag);
      const row = page.getByRole("row", { name: new RegExp(`${tag} VPN logs`) });
      await look(row).toBeVisible();
      await look(row.getByText("Only me")).toBeVisible();
      await look(row.getByText("VPN", { exact: true })).toBeVisible();

      // New, with a placeholder chip.
      await page.getByRole("button", { name: "New", exact: true }).click();
      const editor = page.getByRole("region", { name: "New canned response" });
      await look(editor).toBeVisible();
      await editor.getByLabel("Name").fill(`${tag} Thanks, closing this one`);
      await editor.getByLabel("Folder").fill("General");
      const box = editor.getByRole("textbox", { name: "Text" });
      await box.click();
      await box.pressSequentially("Thanks ");
      await editor.getByRole("button", { name: "requester first name" }).click();
      await box.pressSequentially(", I'll close this one.");
      await look(box.locator("[data-ph='requester.first_name']")).toHaveText("requester first name");
      await editor.getByRole("button", { name: "Create" }).click();
      await look(page.getByRole("row", { name: new RegExp(`${tag} Thanks, closing this one`) })).toBeVisible();
      const lib = await api(page, "/api/helpdesk/admin/canned");
      const created = (lib.body.canned as { id: number; title: string; body: string; folder: string }[]).find((c) => c.title === `${tag} Thanks, closing this one`)!;
      expect(created.body).toBe("Thanks {{requester.first_name}}, I'll close this one.");
      expect(created.folder).toBe("General");
      ids.push(created.id);

      // --- The composer (d1) ----------------------------------------------------------
      const made = await api(page, "/api/helpdesk/requests", { method: "POST", body: { subject: `VPN from home ${s}`, body: "Authentication failed since this morning." } });
      expect(made.status).toBe(201);
      number = made.body.ticket.number as number;
      const t0 = (await api(page, `/api/helpdesk/tickets/${number}`)).body;
      const requesterFirst = String(t0.ticket.requester_name ?? "").trim().split(/\s+/)[0] || "there";
      const messages0 = (t0.messages ?? []).length;

      await page.goto(`/desk/tickets/${number}`);
      const reply = page.getByRole("textbox", { name: "Reply" });
      await look(reply).toBeVisible();
      await look(page.getByRole("button", { name: "Canned response" })).toBeVisible();

      // Mid-word ";" never opens it.
      await reply.click();
      await reply.pressSequentially("a;b");
      await expect(page.getByRole("dialog", { name: "Canned responses" })).toHaveCount(0);
      await reply.fill("");

      // " ;" then Enter is a line break, ";D" stays a wink, and a word only in a response's text shows nothing.
      await reply.pressSequentially("Voici les étapes ;");
      await reply.press("Enter");
      await expect(reply).toHaveValue("Voici les étapes ;\n");
      await reply.pressSequentially("Thanks ;D");
      await reply.press("Enter");
      await expect(reply).toHaveValue("Voici les étapes ;\nThanks ;D\n");
      await reply.pressSequentially(`;${tag} choose`);
      await page.waitForTimeout(1500);
      await expect(page.getByRole("dialog", { name: "Canned responses" })).toHaveCount(0);
      await reply.press("Enter");
      await expect(reply).toHaveValue(`Voici les étapes ;\nThanks ;D\n;${tag} choose\n`);
      await reply.fill("");

      // ";" + letters: opens and filters while typing in the box.
      await reply.pressSequentially(`Hi,\n\nThanks for letting us know. ;${tag} logs`);
      const picker = page.getByRole("dialog", { name: "Canned responses" });
      await look(picker).toBeVisible();
      await look(picker.getByRole("option", { name: new RegExp(`${tag} VPN logs`) })).toBeVisible();
      await expect(picker.getByRole("option", { name: new RegExp(`${tag} Known outage`) })).toHaveCount(0);
      await look(picker.getByText("Canned responses never change the ticket; use a macro for that.")).toBeVisible();
      await expect(reply).toHaveAttribute("aria-activedescendant", /.+/);
      // Escape closes and keeps the text; typing on does not reopen it.
      await reply.press("Escape");
      await look(picker).toBeHidden();
      await expect(reply).toHaveValue(`Hi,\n\nThanks for letting us know. ;${tag} logs`);
      await reply.pressSequentially("x");
      await expect(picker).toHaveCount(0);
      // A fresh ";" does; Enter inserts the filled text in place of ";query".
      await reply.fill("Thanks. ");
      await reply.pressSequentially(`;${tag}`);
      await look(picker.getByRole("option")).toHaveCount(3);
      await reply.press("ArrowDown");
      const activeId = await reply.getAttribute("aria-activedescendant");
      const activeTitle = (await page.locator(`[id="${activeId}"]`).innerText()).split("\n")[0];
      await reply.press("Enter");
      await look(picker).toBeHidden();
      const expected: Record<string, string> = {
        [`${tag} VPN logs, how to send them`]: `Open the VPN client, choose Help, then Export logs, ${requesterFirst}.`,
        [`${tag} Known outage`]: `We know the VPN isn't working from home right now (#${number}).`,
        [`${tag} Thanks, closing this one`]: `Thanks ${requesterFirst}, I'll close this one.`,
      };
      await look(reply).toHaveValue(`Thanks. ${expected[activeTitle]}`);
      expect(await reply.inputValue()).not.toContain("{{");

      // The button, in an internal note: its own search box; a click inserts at the caret.
      await page.getByRole("radio", { name: "Internal note" }).click();
      const note = page.getByRole("textbox", { name: "Internal note" });
      await note.fill("Note: ");
      await page.getByRole("button", { name: "Canned response" }).click();
      const search = picker.getByRole("combobox", { name: "Search canned responses" });
      await look(search).toBeFocused();
      await search.fill(`${tag} outage`);
      await picker.getByRole("option", { name: new RegExp(`${tag} Known outage`) }).click();
      await look(note).toHaveValue(`Note: We know the VPN isn't working from home right now (#${number}).`);

      // A response deleted since the list loaded: nothing is inserted, and the server's sentence shows.
      const doomed = await api(page, "/api/helpdesk/admin/canned", { method: "POST", body: { title: `${tag} Doomed`, body: "Should never appear", share: "me" } });
      expect(doomed.status).toBe(201);
      ids.push(doomed.body.canned.id);
      await note.fill("Note: ");
      await page.getByRole("button", { name: "Canned response" }).click();
      await search.fill(`${tag} doomed`);
      const doomedOption = picker.getByRole("option", { name: new RegExp(`${tag} Doomed`) });
      await look(doomedOption).toBeVisible();
      expect((await api(page, `/api/helpdesk/admin/canned/${doomed.body.canned.id}`, { method: "DELETE" })).status).toBe(200);
      await doomedOption.click();
      await look(page.getByText("Canned response not found.")).toBeVisible();
      await expect(note).toHaveValue("Note: ");

      // Nothing was sent; the ticket is unchanged; the inserts were counted.
      const t1 = (await api(page, `/api/helpdesk/tickets/${number}`)).body;
      expect((t1.messages ?? []).length).toBe(messages0);
      expect(t1.ticket.status).toBe(t0.ticket.status);
      expect(t1.ticket.updated_at).toBe(t0.ticket.updated_at);
      const counted = (await api(page, "/api/helpdesk/admin/canned")).body.canned as { id: number; uses_30d: number }[];
      expect(counted.filter((c) => ids.includes(c.id)).reduce((n, c) => n + c.uses_30d, 0)).toBe(2);
      await note.fill("");
      await page.getByRole("radio", { name: /^Reply/ }).click();
      await reply.fill("");
    } finally {
      for (const id of ids) await api(page, `/api/helpdesk/admin/canned/${id}`, { method: "DELETE" });
      if (number) await api(page, `/api/helpdesk/tickets/${number}`, { method: "DELETE" });
    }
  });
});
