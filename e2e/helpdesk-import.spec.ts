import { test, expect, type Page } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { ADMIN, login, api } from "./helpers";

// Desk settings → Import (1.19.1, agent V7): upload the Zoho Desk fixture
// export, check the mapping, run the dry run, import, and find the tickets
// in the desk with their "Zoho #" reference. Licensed only (skips on 402).
//
// Parallel-safe: the fixture's Zoho ids, email domain and department names
// are rewritten with this run's stamp before upload, so the tickets and
// teams are this spec's own; everything is deleted afterwards.

async function licensed(page: Page): Promise<boolean> {
  return (await api(page, "/api/helpdesk/counts")).status !== 402;
}

const stamp = Date.now().toString(36);
const digits = String(2_000_000_000 + Math.floor(Math.random() * 7_999_999_999)).slice(0, 10);
const IT_TEAM = `IT Support e2e ${stamp}`;
const OFFICE_TEAM = `Office Services e2e ${stamp}`;

async function stampedZip(out: string): Promise<string> {
  const src = await JSZip.loadAsync(await readFile(path.join(__dirname, "..", "test", "fixtures", "helpdesk-import", "zoho-desk-export.zip")));
  const zip = new JSZip();
  const fix = (s: string) =>
    s
      .replaceAll("4181000000", digits)
      .replaceAll("acme-example.com", `e2e-${stamp}.test`)
      .replaceAll("outside-example.org", `out-e2e-${stamp}.test`)
      .replaceAll("IT Support", IT_TEAM)
      .replaceAll("Office Services", OFFICE_TEAM);
  for (const [name, entry] of Object.entries(src.files)) {
    if (entry.dir) continue;
    if (name.endsWith(".csv")) zip.file(fix(name), fix(await entry.async("string")));
    else zip.file(fix(name), await entry.async("nodebuffer"));
  }
  await mkdir(out, { recursive: true });
  const file = path.join(out, "zoho-desk-export-2026-11.zip");
  await writeFile(file, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  return file;
}

test.describe("helpdesk import (licensed)", () => {
  let itTeam = 0;
  let jobId = 0;

  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await login(page, ADMIN);
    const teams = ((await api(page, "/api/helpdesk/admin/teams")).body?.teams ?? []) as { id: number; name: string }[];
    for (const t of teams.filter((x) => x.name === IT_TEAM || x.name === OFFICE_TEAM)) {
      const list = await api(page, `/api/helpdesk/tickets?view=all&team=${t.id}&limit=100`);
      for (const row of (list.body?.tickets ?? []) as { number: number }[]) await api(page, `/api/helpdesk/tickets/${row.number}`, { method: "DELETE" });
      await api(page, `/api/helpdesk/admin/teams/${t.id}`, { method: "DELETE" });
    }
    if (jobId) await api(page, `/api/helpdesk/admin/import/${jobId}`, { method: "DELETE" });
    await page.close();
  });

  test("upload → map → dry run → import → tickets in the desk", async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const team = await api(page, "/api/helpdesk/admin/teams", { method: "POST", body: { name: IT_TEAM, icon: "monitor", members: [] } });
    expect(team.status).toBe(201);
    itTeam = team.body.team.id;
    // The project's output folder: the per-test one has a "→" in its name, which file uploads mishandle.
    const file = await stampedZip(path.join(testInfo.project.outputDir, `hd-import-${stamp}`));

    await page.goto("/desk/settings/import");
    await expect(page.getByRole("heading", { level: 1, name: "Import" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Desk settings" }).getByRole("link", { name: "Import" })).toHaveAttribute("aria-current", "page");
    const steps = page.getByRole("list", { name: "Import steps" });
    await expect(steps.getByRole("listitem").first()).toHaveAttribute("aria-current", "step");

    // 1 Upload
    await page.getByLabel("Export file (.zip)").setInputFiles(file);
    await page.getByRole("button", { name: "Upload and continue" }).click();

    // 2 Map: the existing team is picked, the other department becomes a new team.
    await expect(page.getByRole("heading", { name: "Departments → teams" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByLabel(`Team for ${IT_TEAM}`)).toHaveValue(String(itTeam));
    await expect(page.getByLabel(`Team for ${OFFICE_TEAM}`)).toHaveValue("create");
    await expect(page.getByLabel("Status for Escalated")).toHaveValue("open");
    await expect(page.getByLabel("Tag for Escalated")).toHaveValue("escalated");
    await page.getByLabel("Time zone of the export's times").fill("UTC");
    await page.getByRole("button", { name: "Run the dry run" }).click();

    // 3 Dry run: counts, the mapping summary, the promise.
    await expect(page.getByRole("button", { name: "Import 5 tickets" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("tickets to create")).toBeVisible();
    await expect(page.getByText("rows skipped")).toBeVisible();
    await expect(page.getByRole("link", { name: "see why" })).toHaveAttribute("href", /skipped\?of=dry_run/);
    await expect(page.getByText(`Department: ${OFFICE_TEAM}`)).toBeVisible();
    await expect(page.getByText(/No emails are sent to anyone during the import/)).toBeVisible();
    jobId = Number(new URL(page.url()).searchParams.get("job"));
    expect(jobId).toBeGreaterThan(0);

    // 4 Import
    await page.getByRole("button", { name: "Import 5 tickets" }).click();
    await expect(page.getByText("Import finished.")).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText(/Nobody was emailed or notified/)).toBeVisible();

    // The tickets are in the desk, with their Zoho number.
    const list = await api(page, `/api/helpdesk/tickets?view=all&team=${itTeam}&limit=100`);
    const vpn = ((list.body?.tickets ?? []) as { number: number; subject: string }[]).find((t) => t.subject === "VPN drops every hour");
    expect(vpn, "the imported ticket is listed in its team").toBeTruthy();
    await page.goto(`/desk/tickets/${vpn!.number}?team=${itTeam}`);
    await expect(page.getByRole("heading", { level: 2, name: "VPN drops every hour" })).toBeVisible();
    await expect(page.getByTestId("import-ref")).toHaveText(/Zoho #1201/);
    await expect(page.getByText("Thanks Priya, we are looking at it.")).toBeVisible();
  });
});
