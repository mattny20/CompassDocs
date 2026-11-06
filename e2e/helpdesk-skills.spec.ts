import { test, expect, type Page } from "@playwright/test";
import { ADMIN, api, ensureUser, login } from "./helpers";

// Skills and languages routing (1.19.2, agent W2). Desk settings → Skills
// and languages: add a skill, add French if the workspace lacks it, tag an
// agent. Settings → Assignment → Rules: a rule "Ticket language is French →
// an agent with the right skills or language" (speaks French, knows the
// skill), the "N agents match today" preview, Test a ticket explaining the
// match. Then a French ticket: its language is detected from the first
// message, it goes to the tagged agent, and an agent changes the language
// in the ticket's Properties. CI's community build asserts the licence
// gate; the licensed flow runs on the EE rig and skips itself on 402.
// Everything it makes (a team, an agent's desk role, a skill, the rule, its
// tickets, French if it added it) is its own and is removed afterwards.

const slow = expect.configure({ timeout: 60_000 });
const SHOTS = process.env.W2_SHOTS; // a folder: also save the sanity screenshots there

async function licensed(page: Page): Promise<boolean> {
  return (await api(page, "/api/helpdesk/admin/skills")).status !== 402;
}

test("skills: the licence gate holds in the community build", async ({ page }) => {
  await login(page, ADMIN);
  test.skip(await licensed(page), "the helpdesk is licensed here; the gate is not shown");
  expect((await api(page, "/api/helpdesk/admin/skills")).status).toBe(402);
});

test.describe.serial("skills and languages (licensed)", () => {
  const stamp = Date.now().toString(36);
  const AGENT = { username: "e2e_w2_skills_agent", password: "E2eSkillsAgent!12345" };
  const AGENT_NAME = "Ana Kowalski E2E";
  const teamName = `E2E Skills ${stamp}`;
  const skillName = `Mac ${stamp}`;
  const ruleName = `French speakers ${stamp}`;
  let teamId = 0;
  let agentId = 0;
  let skillId = 0;
  let ruleId = 0;
  let addedFrench = false;
  const tickets: number[] = [];

  test.beforeEach(async ({ page }) => {
    if (SHOTS) {
      page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
      page.on("console", (m) => m.type() === "error" && console.log(`[console] ${m.text().slice(0, 300)}`));
    }
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
    if (!teamId) {
      await ensureUser(page, AGENT, "viewer", AGENT_NAME);
      const users = await api(page, "/api/users/mentionable");
      agentId = (users.body.users as { id: number; username: string }[]).find((u) => u.username === AGENT.username)!.id;
      const desk = await api(page, "/api/helpdesk/admin/agents", { method: "POST", body: { user_id: agentId, role: "agent" } });
      expect([201, 400, 409], JSON.stringify(desk.body)).toContain(desk.status);
      const team = await api(page, "/api/helpdesk/admin/teams", { method: "POST", body: { name: teamName, icon: "monitor", members: [{ user_id: agentId, role: "agent" }] } });
      expect(team.status, JSON.stringify(team.body)).toBe(201);
      teamId = team.body.team.id;
      const mode = await api(page, `/api/helpdesk/admin/assignment/teams/${teamId}`, { method: "PUT", body: { mode: "round_robin", respect_shift: 0 } });
      expect(mode.status, JSON.stringify(mode.body)).toBe(200);
    }
  });

  test.afterAll(async ({ browser }) => {
    test.setTimeout(240_000);
    const page = await browser.newPage();
    await login(page, ADMIN);
    if (ruleId) await api(page, `/api/helpdesk/admin/assignment/rules/${ruleId}`, { method: "DELETE" });
    for (const n of new Set(tickets)) await api(page, `/api/helpdesk/tickets/${n}`, { method: "DELETE" });
    if (agentId) await api(page, `/api/helpdesk/admin/skills/agents/${agentId}`, { method: "PUT", body: { skill_ids: [], languages: [] } });
    if (skillId) await api(page, `/api/helpdesk/admin/skills/${skillId}`, { method: "DELETE" });
    if (addedFrench) await api(page, "/api/helpdesk/admin/skills/languages/fr", { method: "DELETE" });
    if (teamId) await api(page, `/api/helpdesk/admin/teams/${teamId}`, { method: "DELETE" });
    if (agentId) await api(page, `/api/helpdesk/admin/agents/${agentId}`, { method: "DELETE" });
    await page.close();
  });

  test("Settings: add a skill, add French, tag an agent", async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto("/desk/settings/skills");
    await slow(page.getByRole("heading", { level: 1, name: "Skills and languages" })).toBeVisible({ timeout: 60_000 });
    await slow(page.getByRole("link", { name: "Skills and languages" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("A ticket's language comes from the requester's directory entry, or is detected from the first message.")).toBeVisible();

    await page.getByRole("button", { name: "Add skill" }).click();
    const prompt = page.getByRole("dialog");
    await prompt.getByLabel("Skill").fill(skillName);
    const created = page.waitForResponse((r) => r.url().endsWith("/api/helpdesk/admin/skills") && r.request().method() === "POST");
    await prompt.getByRole("button", { name: "Add skill" }).click();
    skillId = (await (await created).json()).skill.id;
    await slow(page.getByText(`${skillName} added.`)).toBeVisible();
    const skills = page.getByRole("list", { name: "Skills" });
    await slow(skills.getByRole("listitem").filter({ hasText: skillName })).toContainText("0 agents");

    const languages = page.getByRole("list", { name: "Languages" });
    const hasFrench = (await api(page, "/api/helpdesk/admin/skills")).body.languages.some((l: { code: string }) => l.code === "fr");
    if (!hasFrench) {
      await page.getByRole("button", { name: "Add language" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Language").selectOption("fr");
      await dialog.getByRole("button", { name: "Add language" }).click();
      await slow(page.getByText("French added.")).toBeVisible();
      addedFrench = true;
    }
    await slow(languages.getByRole("listitem").filter({ hasText: "French" })).toBeVisible();

    const row = page.getByRole("row").filter({ hasText: AGENT_NAME });
    await row.getByRole("button", { name: `Change ${AGENT_NAME}'s skills and languages` }).click();
    const tags = page.getByRole("dialog");
    await tags.getByRole("checkbox", { name: skillName }).check();
    await tags.getByRole("checkbox", { name: "French" }).check();
    await tags.getByRole("button", { name: "Save" }).click();
    await slow(page.getByText(`${AGENT_NAME}'s skills and languages saved.`)).toBeVisible();
    await slow(row).toContainText(skillName);
    await slow(row).toContainText("French");
    await slow(skills.getByRole("listitem").filter({ hasText: skillName })).toContainText("1 agent");
    await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (SHOTS) {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.reload();
      await slow(page.getByRole("row").filter({ hasText: AGENT_NAME })).toContainText("French");
      await page.screenshot({ path: `${SHOTS}/b1-skills-settings-1440-light.png` });
    }
  });

  test("Rules: language condition, the skills action, N agents match today, Test a ticket", async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto("/desk/settings/assignment/rules");
    await slow(page.getByRole("heading", { level: 1, name: "Assignment" })).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "New rule" }).first().click();
    const editor = page.getByRole("dialog");
    await editor.getByLabel("Name").fill(ruleName);
    await editor.getByLabel("Applies to").selectOption({ label: `Only ${teamName}'s tickets` });
    await editor.getByRole("button", { name: "Add a condition" }).click();
    await editor.getByRole("combobox", { name: "Condition 1: what to check" }).selectOption({ label: "Ticket language" });
    await expect(editor.getByRole("combobox", { name: "Condition 1: how to compare" })).toHaveValue("equals");
    await editor.getByRole("checkbox", { name: "French" }).check();

    await editor.getByRole("radio", { name: "An agent with the right skills or language" }).check();
    await expect(editor.getByText("Among available agents of the team, in turn.")).toBeVisible();
    await expect(editor.getByRole("combobox", { name: "Speaks" })).toHaveValue("fr");
    await editor.getByRole("button", { name: "Skill", exact: true }).click();
    await page.getByRole("menuitemradio", { name: skillName }).click();
    await expect(editor.getByText(skillName, { exact: true })).toBeVisible();
    await expect(editor.getByRole("combobox", { name: "Nobody matching available?" })).toHaveValue("team");
    await slow(editor.getByText(`1 agent matches today: ${AGENT_NAME}.`)).toBeVisible({ timeout: 30_000 });
    await expect(editor.getByText(`In ${teamName}: if ticket language is French, then assign to an agent who speaks French and knows ${skillName} (else the team's turn).`)).toBeVisible();
    if (SHOTS) {
      await page.setViewportSize({ width: 1440, height: 1100 });
      await editor.getByRole("radio", { name: "An agent with the right skills or language" }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/b2-skills-rule-1440-light.png` });
    }

    const created = page.waitForResponse((r) => r.url().endsWith("/api/helpdesk/admin/assignment/rules") && r.request().method() === "POST");
    await editor.getByRole("button", { name: "Create rule" }).click();
    const res = await created;
    expect(res.status()).toBe(201);
    ruleId = (await res.json()).rule.id;
    await slow(page.getByText("Rule created.")).toBeVisible();
    await slow(page.getByRole("listitem").filter({ hasText: ruleName })).toContainText(`speaks French and knows ${skillName}`);

    // Test a ticket: a made-up French ticket for the team.
    // (The editor is closed: these fields are the test box's.)
    await page.getByLabel("Subject").fill(`VPN ${stamp}`);
    await page.getByRole("combobox", { name: "Team", exact: true }).selectOption({ label: teamName });
    await page.getByLabel("Ticket language").selectOption("fr");
    await page.getByRole("button", { name: "Test", exact: true }).click();
    await slow(page.getByText(new RegExp(`Rule “${ruleName}” matches: it goes to an agent in ${teamName} who speaks French and knows ${skillName} \\(${AGENT_NAME} matches\\): next is ${AGENT_NAME}\\.`))).toBeVisible();
    await expect(page.getByText("Ticket language: French.")).toBeVisible();
  });

  test("A French ticket: detected, routed to the French speaker, language changed by an agent", async ({ page }) => {
    test.setTimeout(300_000);
    const t = await api(page, "/api/helpdesk/tickets", {
      method: "POST",
      body: { subject: `Accès VPN ${stamp}`, body: "Bonjour, je n'arrive plus à me connecter au VPN depuis ce matin. Pouvez-vous m'aider ? Merci", team_id: teamId, priority: "normal" },
    });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    const number = t.body.ticket.number as number;
    tickets.push(number);
    const detail = await api(page, `/api/helpdesk/tickets/${number}`);
    const ticket = detail.body.ticket ?? detail.body.detail?.ticket;
    expect(ticket.language).toBe("fr");
    expect(ticket.language_source).toBe("detected");
    expect(ticket.assignee_id).toBe(agentId);
    const log = await api(page, `/api/helpdesk/tickets/${number}/assignment-log`);
    expect(log.body.entries.at(-1).method).toBe("skills");

    await page.goto(`/desk/tickets/${number}`);
    const props = page.getByRole("region", { name: "Properties" });
    const lang = props.getByRole("button", { name: /^Language: French \(detected from the first message\)\. Change$/ });
    await slow(lang).toBeVisible({ timeout: 60_000 });
    await lang.click();
    await page.getByRole("menuitemradio", { name: "Spanish" }).click();
    await slow(page.getByText("Language set to Spanish.")).toBeVisible();
    await slow(props.getByRole("button", { name: /^Language: Spanish \(set by an agent\)\. Change$/ })).toBeVisible();
    // The timeline gains its internal line straight away (the side panel reloads the ticket).
    await slow(page.getByText(/changed the language from French to Spanish/)).toBeVisible({ timeout: 15_000 });
    if (SHOTS) {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.waitForTimeout(500);
      await props.screenshot({ path: `${SHOTS}/ticket-language-property-1440-light.png` });
    }
    const after = await api(page, `/api/helpdesk/tickets/${number}/language`);
    expect(after.body).toMatchObject({ language: "es", source: "agent" });
  });
});
