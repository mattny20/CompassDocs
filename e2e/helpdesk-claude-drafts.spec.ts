import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// 1.19.1 Helpdesk, the Claude connector's reply drafts (agent V1): a draft
// saved through POST /api/mcp (hd_draft_reply) shows in the desk as the
// dashed "Draft from Claude" card above the composer; "Use as reply" moves
// the text into the reply box (nothing is sent), "Discard" removes it. Then
// Desk settings → Claude connector lists the write under "Recent activity
// via Claude". Licensed builds only: the API answers 402 on the community
// build and the spec skips.
//
// Global state: the connector level is read first; if it is "read only" it
// is set to the default for the test and put back.

/** UI expectations: a dev server compiles routes on first use, so allow longer than the default. */
const look = expect.configure({ timeout: 30_000 });

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

async function mcp(request: APIRequestContext, token: string, tool: string, args: Record<string, unknown>) {
  const res = await request.post("/api/mcp", {
    headers: { authorization: `Bearer ${token}` },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  const text = body.result?.content?.[0]?.text ?? "";
  return { isError: body.result?.isError === true, text };
}

async function licensed(page: Page): Promise<boolean> {
  const res = await api(page, "/api/helpdesk/admin/claude");
  if (res.status === 402) return false;
  expect(res.status, "the admin reads the Claude connector settings").toBe(200);
  return true;
}

test.describe("Helpdesk: drafts from Claude", () => {
  test("a draft saved through the connector shows in the desk; Use as reply fills the composer; Discard hides it", async ({ page, request }) => {
    // Several routes compile on first use on a dev server.
    test.setTimeout(300_000);
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "community build: the helpdesk answers 402");
    const before = (await api(page, "/api/helpdesk/admin/claude")).body.level as string;
    if (before === "read") expect((await api(page, "/api/helpdesk/admin/claude", { method: "PUT", body: { level: "notes" } })).status).toBe(200);
    let tokenId: number | null = null;
    let number = 0;
    try {
      const minted = await api(page, "/api/account/tokens", { method: "POST", body: { name: `e2e-claude-drafts-${stamp()}`, scopes: ["read", "write"] } });
      expect(minted.status).toBe(201);
      const token = minted.body.token as string;
      tokenId = minted.body.record?.id ?? null;

      const s = stamp();
      const made = await api(page, "/api/helpdesk/requests", { method: "POST", body: { subject: `VPN drops at home ${s}`, body: "Authentication failed since the phone swap." } });
      expect(made.status).toBe(201);
      number = made.body.ticket.number as number;

      // Claude drafts a reply: saved, not sent.
      const draftText = `Hi, please re-pair the VPN client ${s}.`;
      const saved = await mcp(request, token, "hd_draft_reply", { number, body: draftText });
      expect(saved.isError, saved.text).toBe(false);
      expect(JSON.parse(saved.text).sent).toBe(false);
      const thread = await api(page, `/api/helpdesk/tickets/${number}`);
      expect(JSON.stringify(thread.body.messages)).not.toContain(draftText);

      // The desk shows it above the composer.
      await page.goto(`/desk/tickets/${number}`);
      const card = page.getByRole("region", { name: "Draft from Claude" });
      // The first open compiles the drafts route on a dev server: allow for it.
      await look(card).toBeVisible();
      await look(card.getByText(draftText)).toBeVisible();
      await look(card.getByText("Claude can only draft. A person sends.")).toBeVisible();

      // Use as reply: the text moves into the reply box; nothing is sent.
      await card.getByRole("button", { name: "Use as reply" }).click();
      await look(page.getByRole("textbox", { name: "Reply" })).toHaveValue(draftText);
      await look(card).toBeHidden();
      expect((await api(page, `/api/helpdesk/tickets/${number}/drafts`)).body.drafts).toHaveLength(0);
      const after = await api(page, `/api/helpdesk/tickets/${number}`);
      expect(JSON.stringify(after.body.messages)).not.toContain(draftText);
      await page.getByRole("textbox", { name: "Reply" }).fill("");

      // A second draft, discarded.
      const second = `Second draft ${s}`;
      expect((await mcp(request, token, "hd_draft_reply", { number, body: second })).isError).toBe(false);
      await page.reload();
      await look(card.getByText(second)).toBeVisible();
      await card.getByRole("button", { name: "Discard" }).click();
      await look(card).toBeHidden();
      expect((await api(page, `/api/helpdesk/tickets/${number}/drafts`)).body.drafts).toHaveLength(0);
      await look(page.getByRole("textbox", { name: "Reply" })).toHaveValue("");

      // Desk settings → Claude connector lists the write.
      // A dev server's first compile of the page can abort the first navigation.
      await page.goto("/desk/settings/claude").catch(() => page.goto("/desk/settings/claude"));
      await look(page.locator("h1")).toHaveText("Claude connector");
      await look(page.getByRole("radiogroup", { name: "Claude can" })).toBeVisible();
      await look(page.getByText(`Saved a reply draft on #${number}`).first()).toBeVisible();
    } finally {
      // The ticket (its drafts go with it) and the token are this test's own.
      if (number) await api(page, `/api/helpdesk/tickets/${number}`, { method: "DELETE" });
      if (tokenId) await api(page, `/api/account/tokens/${tokenId}`, { method: "DELETE" });
      if (before === "read") await api(page, "/api/helpdesk/admin/claude", { method: "PUT", body: { level: "read" } });
    }
  });
});
