import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login, api, ensureUser } from "./helpers";

// 1.19.0 Helpdesk, multi-team workflows (agent M): build a workflow in the
// builder with an Only if, a route by answer and a required hand-off
// field; a test run shows the skipped step; a request runs it; the task
// team can't finish without the hand-off field and marks the task Can't
// be done; the coordinating team sees the stopped workflow and skips the
// step; a "Carry on" task's Can't be done says the workflow carries on (and
// it does); and the task team's read-only view of the request hides
// internal notes.
//
// Licensed builds only: the helpdesk API answers 402 on the community
// build, where the spec skips like the other licensed specs. Everything it
// creates carries a unique stamp and is deleted at the end.

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

async function helpdeskLicensed(page: Page): Promise<boolean> {
  const res = await api(page, "/api/helpdesk/request-types");
  if (res.status === 402) return false;
  expect(res.status, "the admin reads the request types").toBe(200);
  return true;
}

const idOf = (b: any, key: string) => Number(b?.[key]?.id ?? b?.id);

test.describe("Multi-team workflows", () => {
  // The dev server compiles routes on first use; fail a stuck step instead of hanging the test.
  test.use({ actionTimeout: 60_000 });

  test("condition, route and hand-off; can't be done; skip; read-only view", async ({ page, browser }) => {
    test.setTimeout(420_000);
    await login(page, ADMIN);
    test.skip(!(await helpdeskLicensed(page)), "community build: the helpdesk answers 402");

    const s = stamp();
    const made: { teams: number[]; type?: number; workflow?: number; tickets: number[]; user?: number } = { teams: [], tickets: [] };
    const FAC_USER = { username: `e2e_fac_${s}`, password: "E2eFac!12345abc" };

    try {
      // --- Fixtures: two teams, a Facilities agent, a request type -----------------
      await ensureUser(page, FAC_USER, "viewer", `Fac Agent ${s}`);
      const people = await api(page, "/api/users/mentionable");
      const fac = (people.body?.users ?? people.body ?? []).find((u: { username: string }) => u.username === FAC_USER.username);
      expect(fac, "the Facilities agent exists").toBeTruthy();
      made.user = fac.id;
      const roles = await api(page, "/api/admin/rbac/roles");
      const agentRole = (roles.body?.roles ?? []).find((r: { key: string }) => r.key === "helpdesk-agent");
      expect(agentRole, "the built-in helpdesk agent role").toBeTruthy();
      const assigned = await api(page, "/api/admin/rbac/assignments", { method: "POST", body: { role_id: agentRole.id, user_id: fac.id } });
      expect([200, 201]).toContain(assigned.status);

      const coord = await api(page, "/api/helpdesk/admin/teams", { method: "POST", body: { name: `Service Desk ${s}` } });
      expect([200, 201]).toContain(coord.status);
      made.teams.push(idOf(coord.body, "team"));
      const facilities = await api(page, "/api/helpdesk/admin/teams", {
        method: "POST",
        body: { name: `Facilities ${s}`, members: [{ user_id: fac.id, role: "agent" }] },
      });
      expect([200, 201]).toContain(facilities.status);
      made.teams.push(idOf(facilities.body, "team"));
      const [coordId, facId] = made.teams;

      const rt = await api(page, "/api/helpdesk/admin/request-types", {
        method: "POST",
        body: {
          title: `New starter ${s}`,
          description: "Multi-team spec",
          icon: "user-plus",
          team_id: coordId,
          form: [
            { key: "name", label: "Who is starting?", type: "text", required: true },
            { key: "office", label: "Office", type: "select", required: true, options: [{ value: "london", label: "London" }, { value: "paris", label: "Paris" }] },
            { key: "needs_laptop", label: "Needs a laptop", type: "checkbox" },
          ],
        },
      });
      expect([200, 201]).toContain(rt.status);
      made.type = idOf(rt.body, "request_type");

      const wf = await api(page, "/api/helpdesk/admin/workflows", {
        method: "POST",
        body: {
          title: `New starter flow ${s}`,
          definition: {
            trigger: { request_type_id: made.type },
            steps: [
              { key: "t1", kind: "task", title: "Laptop and accounts", team_id: coordId },
              { key: "t2", kind: "task", title: "Desk and badge", team_id: coordId },
              { key: "t3", kind: "task", title: "Welcome pack", team_id: coordId, on_cant_do: "continue" },
              { key: "f1", kind: "finish", title: "Solve the request", csat: false },
            ],
          },
        },
      });
      expect([200, 201]).toContain(wf.status);
      made.workflow = idOf(wf.body, "workflow");
      const slug = wf.body?.workflow?.slug ?? wf.body?.slug ?? String(made.workflow);
      expect((await api(page, `/api/helpdesk/admin/request-types/${made.type}`, { method: "PATCH", body: { workflow_id: made.workflow } })).status).toBe(200);

      // --- Builder: Only if, route, required hand-off field ----------------------
      await page.goto(`/desk/workflows/${slug}`);
      await page.getByRole("button", { name: "Laptop and accounts", exact: true }).click();
      const panel = page.getByRole("complementary", { name: "Step settings" });
      await panel.getByRole("button", { name: "Add a rule" }).click();
      await panel.getByLabel("Rule 1: what to check").selectOption({ label: "Needs a laptop" });
      await panel.getByLabel("Rule 1: how to compare").selectOption({ label: "is Yes" });
      await expect(panel.getByText("Only if Needs a laptop is Yes.")).toBeVisible();

      await page.getByRole("button", { name: "Desk and badge", exact: true }).click();
      await panel.getByRole("switch", { name: "Choose the team from an answer" }).click();
      await panel.getByLabel("Sort by").selectOption({ label: "Office" });
      await panel.getByLabel("Row 1: answer").selectOption({ label: "London" });
      await panel.getByLabel("Row 1: team").selectOption({ label: `Facilities ${s}` });
      await expect(panel.getByText(/By Office: London → Facilities/)).toBeVisible();
      await panel.getByRole("button", { name: "Add a field" }).click();
      await panel.getByLabel("Label").fill("Badge number");
      await panel.getByLabel("Required").check();
      await expect(panel.getByText("{{outputs.t2.badge_number}}")).toBeVisible();
      // The canvas carries the chips.
      const chips = page.getByRole("list", { name: "Step rules" });
      await expect(chips.filter({ hasText: "Only if: Needs a laptop is Yes" })).toHaveCount(1);
      await expect(chips.filter({ hasText: "1 hand-off field" })).toContainText("By office");

      // Test run: no laptop, so the laptop step is skipped; London goes to Facilities.
      await page.getByRole("button", { name: "Test run" }).click();
      const trial = page.getByRole("dialog", { name: "Test run" });
      await trial.getByLabel("Office (sample)").selectOption({ label: "London" });
      await trial.getByLabel("Needs a laptop (sample)").selectOption({ label: "No" });
      await trial.getByRole("button", { name: "Run test" }).click();
      await expect(trial.getByText("Skipped", { exact: true })).toBeVisible({ timeout: 60_000 });
      await expect(trial.getByText(`Facilities ${s}`).first()).toBeVisible();
      await trial.getByRole("button", { name: "Close" }).click();

      await page.getByRole("button", { name: /^Publish/ }).click();
      const confirm = page.getByRole("dialog").filter({ hasText: "Publish" });
      await confirm.getByRole("button", { name: "Publish changes" }).click();
      await expect(page.getByText(/Published/)).toBeVisible({ timeout: 60_000 });

      // --- A request runs it ---------------------------------------------------------
      const req = await api(page, "/api/helpdesk/requests", {
        method: "POST",
        body: { request_type_id: made.type, subject: `New starter: Sam Lee ${s}`, body: "Starts Monday.", answers: { name: "Sam Lee", office: "london", needs_laptop: false } },
      });
      expect([200, 201]).toContain(req.status);
      const parentNo = Number(req.body?.ticket?.number ?? req.body?.number);
      made.tickets.push(parentNo);
      const secret = `internal-${s}`;
      await api(page, `/api/helpdesk/tickets/${parentNo}/messages`, { method: "POST", body: { kind: "internal", body: `Do not show: ${secret}` } });

      let taskNo = 0;
      await expect
        .poll(async () => {
          const d = await api(page, `/api/helpdesk/tickets/${parentNo}`);
          const child = (d.body?.children ?? []).find((c: { subject: string }) => c.subject.startsWith("Desk and badge"));
          taskNo = child?.number ?? 0;
          return taskNo;
        })
        .toBeGreaterThan(0);
      made.tickets.push(taskNo);
      const parent = await api(page, `/api/helpdesk/tickets/${parentNo}`);
      const laptop = (parent.body?.workflow?.steps ?? []).find((x: { key: string }) => x.key === "t1");
      expect(laptop?.state, "no laptop: the laptop step is skipped").toBe("skipped");
      const task = await api(page, `/api/helpdesk/tickets/${taskNo}`);
      expect(task.body?.ticket?.team_id, "London routes to Facilities").toBe(facId);

      // --- The task team: required hand-off, then Can't be done ------------------------
      await page.goto(`/desk/tickets/${taskNo}`);
      const bar = page.getByRole("region", { name: "Workflow task" });
      await bar.getByRole("button", { name: "Mark done" }).click();
      const done = page.getByRole("dialog", { name: /Mark .Desk and badge. done/ });
      // The task's own step (the context's `task`) puts its hand-off field up front, and the page checks it first.
      await expect(done.getByLabel("Badge number")).toBeVisible({ timeout: 60_000 });
      await done.getByRole("button", { name: "Mark done" }).click();
      await expect(done.getByText("Fill in badge number.")).toBeVisible({ timeout: 60_000 });
      await done.getByRole("button", { name: "Cancel" }).click();
      // The plain Solve is refused and opens the same dialog.
      await page.getByRole("button", { name: "Solve" }).click();
      await expect(page.getByRole("dialog", { name: /Mark .Desk and badge. done/ })).toBeVisible({ timeout: 60_000 });
      await page.getByRole("dialog", { name: /Mark .Desk and badge. done/ }).getByRole("button", { name: "Cancel" }).click();

      await bar.getByRole("button", { name: "Can't be done" }).click();
      const cant = page.getByRole("dialog", { name: /Can't do .Desk and badge./ });
      await expect(cant.getByText(new RegExp(`The workflow stops and Service Desk ${s} takes it back`))).toBeVisible();
      await cant.getByRole("button", { name: /Hand back to/ }).click();
      await expect(cant.getByText("Say why it can't be done.")).toBeVisible();
      await cant.getByLabel("Why can't it be done?").fill("No desks free on the 3rd floor until December.");
      await cant.getByRole("button", { name: /Hand back to/ }).click();
      await expect(page.getByText(/Handed back to/)).toBeVisible({ timeout: 60_000 });

      // --- The coordinator: the stopped workflow, Skip and carry on ------------------
      await page.goto(`/desk/tickets/${parentNo}`);
      const banner = page.getByRole("region", { name: /Workflow stopped/ });
      await expect(banner).toContainText("No desks free on the 3rd floor", { timeout: 60_000 });
      await banner.getByRole("button", { name: "Skip and carry on" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Skip and carry on" }).click();
      await expect(page.getByText("Skipped. The workflow carries on.")).toBeVisible({ timeout: 60_000 });
      await expect(banner).toHaveCount(0);

      // --- A "Carry on" task: Can't be done says the workflow carries on, and it does ----
      let packNo = 0;
      await expect
        .poll(async () => {
          const d = await api(page, `/api/helpdesk/tickets/${parentNo}`);
          const child = (d.body?.children ?? []).find((c: { subject: string }) => c.subject.startsWith("Welcome pack"));
          packNo = child?.number ?? 0;
          return packNo;
        })
        .toBeGreaterThan(0);
      made.tickets.push(packNo);
      await page.goto(`/desk/tickets/${packNo}`);
      await page.getByRole("region", { name: "Workflow task" }).getByRole("button", { name: "Can't be done" }).click();
      const carry = page.getByRole("dialog", { name: /Can't do .Welcome pack./ });
      await expect(carry.getByText("The workflow carries on with its next step.", { exact: false })).toBeVisible({ timeout: 60_000 });
      await expect(carry.getByText(/The workflow stops/)).toHaveCount(0);
      await expect(carry.getByRole("button", { name: /Hand back to/ })).toHaveCount(0);
      await carry.getByLabel("Why can't it be done?").fill("Out of welcome packs.");
      await carry.getByRole("button", { name: "Mark can't be done" }).click();
      await expect(page.getByText(/marked can't be done\. The workflow carries on\./)).toBeVisible({ timeout: 60_000 });
      await expect
        .poll(async () => (await api(page, `/api/helpdesk/tickets/${parentNo}`)).body?.workflow?.state, { timeout: 60_000 })
        .toBe("done");

      // --- The read-only view, as the Facilities agent ----------------------------------
      const ctx = await browser.newContext();
      const fp = await ctx.newPage();
      await login(fp, FAC_USER);
      await fp.goto(`/desk/requests/${parentNo}?from=${taskNo}`);
      await expect(fp.getByText(/Read-only/).first()).toBeVisible({ timeout: 60_000 });
      await expect(fp.getByText(/because Facilities .* a task on it/)).toBeVisible();
      await expect(fp.getByText("Starts Monday.")).toBeVisible();
      await expect(fp.getByText(secret)).toHaveCount(0);
      await expect(fp.getByRole("textbox", { name: /reply/i })).toHaveCount(0);
      await ctx.close();
    } finally {
      // Best effort: a timed-out page can't clean up, so each delete stands alone.
      const del = (path: string) => api(page, path, { method: "DELETE" }).catch(() => null);
      for (const n of made.tickets.reverse()) await del(`/api/helpdesk/tickets/${n}`);
      if (made.type) await del(`/api/helpdesk/admin/request-types/${made.type}`);
      if (made.workflow) await del(`/api/helpdesk/admin/workflows/${made.workflow}`);
      for (const t of made.teams) await del(`/api/helpdesk/admin/teams/${t}`);
      if (made.user) await del(`/api/admin/users/${made.user}`);
    }
  });
});
