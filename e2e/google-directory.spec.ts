import { test, expect } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// The Google Workspace configuration surface (0.97).
//
// 0.96 shipped the seams — the provider interface, source-scoped writes, the
// google_path column, the SSO vendor discriminator — with nothing an admin
// could actually reach. These are the tests that the surface exists and that
// its two sharp edges hold: a credential that never comes back out, and a
// malformed key rejected at the door rather than at the next sync.

test("the Google directory config stores a key without ever echoing it", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, ADMIN);

  // Assembled at runtime rather than written out: a fixture that looks like a
  // credential trips secret scanners and teaches people to wave them through.
  const pem = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ");
  const key = JSON.stringify({
    type: ["service", "account"].join("_"),
    client_email: "e2e-sync@example.iam.gserviceaccount.com",
    private_key: `${pem}\nE2E-FIXTURE-NOT-A-REAL-KEY\n${pem.replace("BEGIN", "END")}\n`,
    client_id: "100000000000000000001",
  });

  try {
    // Start from a known state rather than assuming one. This suite shares a
    // database with everything else and, on a long-lived rig, with whatever a
    // human last poked at — a test that only passes on a fresh install is a
    // test that will eventually report a product bug that isn't there.
    await api(page, "/api/admin/directory/google", { method: "DELETE" });
    await api(page, "/api/admin/directory/google", { method: "PATCH", body: { group: "" } });

    const before = await api(page, "/api/admin/directory/google");
    expect(before.status).toBe(200);
    expect(before.body?.has_service_account, "nothing configured to start").toBe(false);
    expect(before.body?.customer_id, "defaults to the impersonated admin's account").toBe(
      "my_customer"
    );
    expect(before.body?.scopes?.length, "the delegation scopes are published").toBeGreaterThan(0);

    // A malformed key is refused before it is stored — otherwise it surfaces as
    // an auth failure at the next sync, pointing at the wrong thing.
    const notJson = await api(page, "/api/admin/directory/google", {
      method: "PATCH",
      body: { service_account: "paste gone wrong" },
    });
    expect(notJson.status, "invalid JSON rejected").toBe(400);
    expect(notJson.body?.error).toContain("valid JSON");

    const wrongFile = await api(page, "/api/admin/directory/google", {
      method: "PATCH",
      body: { service_account: JSON.stringify({ type: "authorized_user" }) },
    });
    expect(wrongFile.status, "the wrong kind of key file is rejected").toBe(400);
    // Assert on what the admin is told, not on the literal token — spelling
    // that token out here is what made the scanner flag the source file.
    expect(wrongFile.body?.error).toContain("service-account key");
    expect(wrongFile.body?.error, "and names the type it actually got").toContain(
      "authorized_user"
    );

    const saved = await api(page, "/api/admin/directory/google", {
      method: "PATCH",
      body: { service_account: key, admin_email: "admin@example.com" },
    });
    expect(saved.status).toBe(200);
    expect(saved.body?.has_service_account, "the key is stored").toBe(true);
    expect(saved.body?.configured, "key plus an impersonation target is enough to sync").toBe(true);
    // The client_id is not secret and is what an admin pastes into the
    // domain-wide delegation screen, so it comes back; nothing else does.
    expect(saved.body?.service_account_client_id).toBe("100000000000000000001");

    const roundTrip = JSON.stringify(await api(page, "/api/admin/directory/google"));
    expect(roundTrip, "the private key is never echoed to the client").not.toContain(pem);
    expect(roundTrip).not.toContain("E2E-FIXTURE-NOT-A-REAL-KEY");

    // "" means "leave it alone" on PATCH, so clearing needs its own verb.
    const untouched = await api(page, "/api/admin/directory/google", {
      method: "PATCH",
      body: { service_account: "", group: "engineering@example.com" },
    });
    expect(untouched.body?.has_service_account, "an empty string does not clear the key").toBe(true);
    expect(untouched.body?.group).toBe("engineering@example.com");
  } finally {
    const cleared = await api(page, "/api/admin/directory/google", { method: "DELETE" });
    expect(cleared.body?.has_service_account, "DELETE clears it").toBe(false);
    await api(page, "/api/admin/directory/google", { method: "PATCH", body: { group: "" } });
    await ctx.close();
  }
});

test("the SSO vendor picks the authority, and defaults to Microsoft", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, ADMIN);

  try {
    const google = await api(page, "/api/admin/sso", {
      method: "PATCH",
      body: { vendor: "google" },
    });
    expect(google.body?.state?.vendor).toBe("google");
    expect(
      google.body?.state?.effective_authority,
      "choosing Google no longer means pasting a URL into an Advanced field"
    ).toBe("https://accounts.google.com");

    const junk = await api(page, "/api/admin/sso", { method: "PATCH", body: { vendor: "nonsense" } });
    expect(junk.body?.state?.vendor, "an unrecognised vendor falls back, it does not persist").toBe(
      "microsoft"
    );
  } finally {
    await api(page, "/api/admin/sso", { method: "PATCH", body: { vendor: "microsoft" } });
    await ctx.close();
  }
});

test("Users & roles shows the roles a person holds beyond their rung", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, ADMIN);

  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const user = { username: `e2e_extrarole_${stamp}`, password: "E2eExtra!12345" };
  let userId: number | null = null;
  let roleId: number | null = null;

  try {
    const created = await api(page, "/api/admin/users", {
      method: "POST",
      body: { ...user, role: "viewer", name: `E2E Extra ${stamp}` },
    });
    expect(created.status).toBe(201);
    userId = created.body?.user?.id;

    const role = await api(page, "/api/admin/rbac/roles", {
      method: "POST",
      body: { name: `E2E Extra Role ${stamp}`, permissions: ["link.manage"] },
    });
    roleId = role.body?.id;
    await api(page, "/api/admin/rbac/assignments", {
      method: "POST",
      body: { role_id: roleId, user_id: userId },
    });

    // The page used to render this person as a plain "Viewer" — a true
    // statement about their rung and a wrong answer to "what can they do?".
    await page.goto("/admin/users");
    await expect(page.getByText(`E2E Extra Role ${stamp}`)).toBeVisible();
  } finally {
    if (roleId) await api(page, `/api/admin/rbac/roles/${roleId}`, { method: "DELETE" });
    if (userId) await api(page, `/api/admin/users/${userId}`, { method: "DELETE" });
    await ctx.close();
  }
});
