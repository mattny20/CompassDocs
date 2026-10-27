import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { ADMIN, login } from "./helpers";

// 1.16.0: the email-first sign-in steps, walked through on the admin's
// preview (/login/preview?flow=identify). The community build has no single
// sign-on, so /login itself only ever shows the combined form; the preview
// runs the real SignInFlow against the scripted demo transport
// (lib/sign-in-demo), which is how CI exercises the other steps:
//   name@sso.example   → one provider: "Redirecting to Microsoft"
//   name@both.example  → a choice of two
//   anything else      → the password step
//   password wrong / locked / 2fa (code 123456) / anything else
// Nothing typed in the preview is sent: no request reaches /api/auth/.
// The ?sso_error banner is checked on /login itself (a page load, nothing
// sent either).

type Ctx = { ctx: BrowserContext; page: Page; sent: string[] };
let signedIn: Awaited<ReturnType<BrowserContext["storageState"]>>;

test.beforeAll(async ({ browser }) => {
  // One real sign-in for the whole file; each test gets its own context
  // carrying that session (and the remembered identifier it left behind).
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, ADMIN);
  signedIn = await ctx.storageState();
  await ctx.close();
});

async function openPreview(
  browser: Browser,
  opts: { remembered?: boolean; path?: string; viewport?: { width: number; height: number } } = {}
): Promise<Ctx> {
  const ctx = await browser.newContext({ storageState: signedIn, viewport: opts.viewport ?? { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const sent: string[] = [];
  page.on("request", (r) => {
    if (/\/api\/auth\/(lookup|login)\b/.test(r.url())) sent.push(`${r.method()} ${r.url()}`);
  });
  if (!opts.remembered) {
    await page.addInitScript(() => {
      try {
        localStorage.removeItem("compass-sign-in-identifier");
      } catch {
        // storage blocked: nothing to forget
      }
    });
  }
  await page.goto(opts.path ?? "/login/preview?flow=identify");
  // Hydrated: the submit is server-rendered disabled until then.
  await expect(page.locator('button[type="submit"]')).toBeEnabled();
  return { ctx, page, sent };
}

const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const identifier = (page: Page) => page.locator('input[autocomplete="username"]');
const password = (page: Page) => page.locator('input[autocomplete="current-password"]');
const alertWith = (page: Page, text: string) => page.getByRole("alert").filter({ hasText: text });
const ssoHint = (page: Page) => page.getByText("If your organization uses single sign-on, open Other ways to sign in below.");

/** The text of everything that describes a control (aria-describedby). */
async function describedText(control: Locator): Promise<string> {
  return control.evaluate((el) =>
    (el.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
  );
}

async function identify(page: Page, value: string) {
  await identifier(page).fill(value);
  await page.getByRole("button", { name: "Continue" }).click();
}

async function toPassword(page: Page, who = "jane") {
  await identify(page, who);
  await expect(heading(page)).toHaveText("Enter your password");
}

async function signIn(page: Page, pw: string) {
  await password(page).fill(pw);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

test("the preview opens on the email-first step and says nothing is sent", async ({ browser }) => {
  const { ctx, page, sent } = await openPreview(browser);
  try {
    await expect(heading(page)).toHaveText("Sign in");
    await expect(page.getByText(/^Preview\. Nothing you type here is sent anywhere\./)).toBeVisible();
    await expect(identifier(page)).toHaveCount(1);
    await expect(page.getByLabel("Email or username")).toBeFocused();
    // No password field on the first step, and the escape to it is there.
    await expect(password(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Use a password instead" })).toBeVisible();

    // An empty identifier is a field error, not a request.
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Enter your email or username." })).toBeVisible();
    await expect(identifier(page)).toBeFocused();
    expect(sent).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test("one provider: Redirecting to Microsoft, the status row focused, the fallback after 3 seconds, and Change", async ({ browser }) => {
  const { ctx, page, sent } = await openPreview(browser);
  try {
    // Record what the busy state does while the (350ms) lookup runs: the
    // submit is aria-disabled, never disabled, so focus cannot fall to <body>.
    await page.evaluate(() => {
      const w = window as unknown as { busySeen: { ariaDisabled: boolean; disabled: boolean; formBusy: boolean } };
      w.busySeen = { ariaDisabled: false, disabled: false, formBusy: false };
      const form = document.querySelector("form")!;
      new MutationObserver(() => {
        const button = form.querySelector('button[type="submit"]');
        if (button?.getAttribute("aria-disabled") === "true") w.busySeen.ariaDisabled = true;
        if (button?.hasAttribute("disabled")) w.busySeen.disabled = true;
        if (form.getAttribute("aria-busy") === "true") w.busySeen.formBusy = true;
      }).observe(form, { subtree: true, attributes: true });
    });

    await identify(page, "x@sso.example");
    await expect(heading(page)).toHaveText("Redirecting to Microsoft");
    const busy = await page.evaluate(() => (window as unknown as { busySeen: Record<string, boolean> }).busySeen);
    expect(busy).toEqual({ ariaDisabled: true, disabled: false, formBusy: true });

    const status = page.locator('[role="status"][tabindex="-1"]');
    await expect(status).toHaveText("Taking you to Microsoft…");
    await expect(status).toBeFocused();
    await expect(page.getByRole("group", { name: "Email or username" })).toContainText("x@sso.example");
    // No password anywhere near a hand-off.
    await expect(password(page)).toHaveCount(0);

    // The demo never leaves the page, so the fallback link appears after 3 seconds.
    const fallback = page.getByText("Not redirected?");
    await expect(fallback).toHaveCount(0);
    await expect(fallback).toBeVisible({ timeout: 6_000 });
    await expect(page.getByRole("link", { name: "Sign in with Microsoft" })).toHaveAttribute("href", /^\/api\/ee\//);

    // The real page remembers the identifier just before an SSO hand-off; the
    // preview never does (it would prefill the admin's own sign-in page).
    const remembered = await page.evaluate(() => JSON.parse(localStorage.getItem("compass-sign-in-identifier") || "null"));
    expect(remembered).toBeNull();

    // Change: back to the first step, the value kept and selected.
    await page.getByRole("button", { name: "Change email or username" }).click();
    await expect(heading(page)).toHaveText("Sign in");
    await expect(identifier(page)).toBeVisible();
    await expect(identifier(page)).toHaveValue("x@sso.example");
    await expect(identifier(page)).toBeFocused();
    const selected = await identifier(page).evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd, el.value.length]);
    expect(selected).toEqual([0, 13, 13]);
    await expect(page.getByText("Not redirected?")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();
    expect(sent).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test("two providers: a choice of two links, focus on the heading, and the password escape", async ({ browser }) => {
  const { ctx, page, sent } = await openPreview(browser);
  try {
    await identify(page, "x@both.example");
    await expect(heading(page)).toHaveText("Choose how to sign in");
    await expect(heading(page)).toBeFocused();
    await expect(page.getByText("Your organization offers more than one way to sign in.")).toBeVisible();
    const providers = page.locator('main a[href^="/api/ee/"]');
    await expect(providers).toHaveCount(2);
    await expect(providers.first()).toHaveText("Sign in with Microsoft");
    // No submit on a choice: the links are the actions.
    await expect(page.locator('button[type="submit"]')).toHaveCount(0);

    await page.getByRole("button", { name: "Use a password instead" }).click();
    await expect(heading(page)).toHaveText("Enter your password");
    await expect(password(page)).toBeFocused();
    expect(sent).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test("a password account: the password step under the locked identifier, Show password, wrong and locked", async ({ browser }) => {
  const { ctx, page, sent } = await openPreview(browser);
  try {
    await toPassword(page, "jane");
    await expect(page.getByText("to continue to", { exact: false })).toBeVisible();
    const row = page.getByRole("group", { name: "Email or username" });
    await expect(row).toContainText("jane");
    await expect(row.getByRole("button", { name: "Change email or username" })).toBeVisible();
    await expect(password(page)).toBeFocused();
    // Still exactly one username field (hidden, kept for password managers).
    await expect(identifier(page)).toHaveCount(1);
    await expect(identifier(page)).toBeHidden();
    // SSO sits behind a closed disclosure on a password step, never beside the field.
    const otherWays = page.locator("details", { hasText: "Other ways to sign in" });
    await expect(otherWays).toHaveCount(1);
    expect(await otherWays.evaluate((d: HTMLDetailsElement) => d.open)).toBe(false);

    // Show password turns the field to text; signing in turns it back first.
    await password(page).fill("wrong");
    const show = page.getByLabel("Show password");
    await show.check();
    await expect(password(page)).toHaveAttribute("type", "text");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(password(page)).toHaveAttribute("type", "password");
    await expect(show).not.toBeChecked();

    // wrong: the server's 401 sentence; the password is cleared and focused.
    await expect(page.getByRole("alert").filter({ hasText: "Invalid username or password." })).toBeVisible();
    await expect(password(page)).toHaveValue("");
    await expect(password(page)).toBeFocused();
    await expect(page.getByText("If your organization uses single sign-on, open Other ways to sign in below.")).toBeVisible();

    // locked: the 429 sentence.
    await signIn(page, "locked");
    await expect(page.getByRole("alert").filter({ hasText: "Too many failed attempts. Try again in 15 minutes." })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: "Invalid username or password." })).toHaveCount(0);
    await expect(password(page)).toBeFocused();
    expect(sent).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test("Back from the identity provider, or Change, leaves no error or SSO hint from the last password behind", async ({ browser }) => {
  const { ctx, page } = await openPreview(browser);
  try {
    await toPassword(page, "jane");
    await signIn(page, "wrong");
    await expect(alertWith(page, "Invalid username or password.")).toBeVisible();
    await expect(ssoHint(page)).toBeVisible();

    // The page restored from the back-forward cache (Back from the identity provider).
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await expect(heading(page)).toHaveText("Sign in");
    await expect(identifier(page)).toBeFocused();
    await expect(identifier(page)).toHaveValue("jane");
    await expect(alertWith(page, "Invalid username or password.")).toHaveCount(0);

    // A wrong password, Change, then a password step for someone else: nothing carried over.
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(heading(page)).toHaveText("Enter your password");
    await signIn(page, "wrong");
    await expect(ssoHint(page)).toBeVisible();
    await page.getByRole("button", { name: "Change email or username" }).click();
    await identifier(page).fill("bob");
    await page.getByRole("button", { name: "Use a password instead" }).click();
    await expect(heading(page)).toHaveText("Sign in with a password");
    await expect(ssoHint(page)).toHaveCount(0);
    await expect(alertWith(page, "Invalid username or password.")).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});

test("the combined preview has no single sign-on, as on /login: a wrong password shows no SSO hint", async ({ browser }) => {
  const { ctx, page, sent } = await openPreview(browser, { path: "/login/preview" });
  try {
    test.skip((await password(page).count()) === 0, "this workspace has single sign-on, so the preview shows the email-first steps");
    await identifier(page).fill("jane");
    await signIn(page, "wrong");
    await expect(alertWith(page, "Invalid username or password.")).toBeVisible();
    await expect(page.locator("details", { hasText: "Other ways to sign in" })).toHaveCount(0);
    await expect(ssoHint(page)).toHaveCount(0);
    await expect(page.locator('a[href^="/api/ee/"]')).toHaveCount(0);
    expect(sent).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test("2fa: the code step, the recovery code, a wrong code, then 123456 signs in (preview)", async ({ browser }) => {
  const { ctx, page, sent } = await openPreview(browser);
  try {
    await toPassword(page, "jane");
    await signIn(page, "2fa");
    await expect(heading(page)).toHaveText("Two-factor authentication");
    await expect(page.getByText("Enter the 6-digit code from your authenticator app.").first()).toBeVisible();
    const code = page.getByLabel("Two-factor code");
    await expect(code).toBeFocused();
    await expect(code).toHaveAttribute("inputmode", "numeric");
    await expect(code).toHaveAttribute("autocomplete", "one-time-code");
    await expect(page.getByRole("group", { name: "Email or username" })).toContainText("jane");

    // Recovery mode: a text keyboard, its own help.
    await page.getByRole("button", { name: "Use a recovery code" }).click();
    const recovery = page.getByLabel("Recovery code");
    await expect(recovery).toBeFocused();
    await expect(recovery).toHaveAttribute("inputmode", "text");
    await expect(page.getByText("Each recovery code works once.")).toBeVisible();
    await page.getByRole("button", { name: "Use your authenticator app" }).click();
    await expect(page.getByLabel("Two-factor code")).toBeFocused();

    // A wrong code: the server's sentence, the code cleared and focused.
    await page.getByLabel("Two-factor code").fill("000000");
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "That code didn't work — try again." })).toBeVisible();
    await expect(page.getByLabel("Two-factor code")).toHaveValue("");
    await expect(page.getByLabel("Two-factor code")).toBeFocused();

    await page.getByLabel("Two-factor code").fill("123456");
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByText("Signed in (preview).")).toBeVisible();
    // The preview stays put: no navigation, nothing sent.
    expect(new URL(page.url()).pathname).toBe("/login/preview");
    expect(sent).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test("Back from the code step returns to the password step with the password kept", async ({ browser }) => {
  const { ctx, page } = await openPreview(browser);
  try {
    await toPassword(page, "jane");
    await signIn(page, "2fa");
    await expect(page.getByLabel("Two-factor code")).toBeFocused();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(heading(page)).toHaveText("Enter your password");
    await expect(password(page)).toHaveValue("2fa");
    await expect(password(page)).toBeFocused();
  } finally {
    await ctx.close();
  }
});

test("Back or the code switch during a Verify abandons it: its answer never lands on the next step", async ({ browser }) => {
  const { ctx, page } = await openPreview(browser);
  try {
    await toPassword(page, "jane");
    await signIn(page, "2fa");
    await page.getByLabel("Two-factor code").fill("000000");
    // The demo answers after 350ms; Back comes first.
    await page.getByRole("button", { name: "Verify" }).click();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(heading(page)).toHaveText("Enter your password");
    await expect(page.locator("form")).not.toHaveAttribute("aria-busy", "true");
    await page.waitForTimeout(700);
    await expect(heading(page)).toHaveText("Enter your password");
    await expect(alertWith(page, "That code didn't work")).toHaveCount(0);
    await expect(password(page)).toBeFocused();
    // Nothing is left in flight: Sign in is not swallowed.
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(heading(page)).toHaveText("Two-factor authentication");

    // The same with the switch to a recovery code: the half-typed code stays.
    await page.getByLabel("Two-factor code").fill("000000");
    await page.getByRole("button", { name: "Verify" }).click();
    await page.getByRole("button", { name: "Use a recovery code" }).click();
    const recovery = page.getByLabel("Recovery code");
    await expect(recovery).toBeFocused();
    await recovery.fill("abcd");
    await page.waitForTimeout(700);
    await expect(recovery).toHaveValue("abcd");
    await expect(alertWith(page, "That code didn't work")).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});

test("the locked identifier keeps its domain whole and shortens the part before the @ first (320px)", async ({ browser }) => {
  const { ctx, page } = await openPreview(browser, { viewport: { width: 320, height: 640 } });
  try {
    for (const [who, localCut] of [
      ["pat@acme.example", false],
      ["alexandra.kowalczyk@acme.example", true],
    ] as const) {
      await toPassword(page, who);
      const parts = await page
        .getByRole("group", { name: "Email or username" })
        .evaluate((g) => [...g.querySelectorAll("span[title] > span")].map((s) => ({ text: s.textContent, cut: s.scrollWidth > s.clientWidth })));
      expect(parts, who).toEqual([
        { text: who.slice(0, who.indexOf("@")), cut: localCut },
        { text: "@acme.example", cut: false },
      ]);
      await page.getByRole("button", { name: "Change email or username" }).click();
    }
  } finally {
    await ctx.close();
  }
});

test("the remembered identifier is offered back, and Use another account clears it (the preview leaves the real one alone)", async ({ browser }) => {
  // The real sign-in in beforeAll remembered e2e_admin on this browser.
  const { ctx, page } = await openPreview(browser, { remembered: true });
  try {
    await expect(identifier(page)).toHaveValue(ADMIN.username);
    await expect(identifier(page)).toBeFocused();
    await expect(page.getByText("Not you?")).toBeVisible();
    // Never submitted on its own.
    await expect(heading(page)).toHaveText("Sign in");

    await page.getByRole("button", { name: "Use another account" }).click();
    await expect(identifier(page)).toHaveValue("");
    await expect(identifier(page)).toBeFocused();
    await expect(page.getByText("Not you?")).toHaveCount(0);
    // On /login this forgets it; the preview only clears the field.
    const kept = await page.evaluate(() => JSON.parse(localStorage.getItem("compass-sign-in-identifier") || "null"));
    expect(kept?.id).toBe(ADMIN.username);
  } finally {
    await ctx.close();
  }
});

test("an https help link opens in a new tab whatever the case of its scheme; a mailto link does not", async ({ browser }) => {
  const url = (helpUrl: string) => `/login/preview?flow=identify&help=${encodeURIComponent("Need help?")}&help_url=${encodeURIComponent(helpUrl)}`;
  const { ctx, page } = await openPreview(browser, { path: url("HTTPS://help.example.com/sign-in") });
  try {
    const link = page.getByRole("link", { name: "Need help?" });
    await expect(link).toHaveAttribute("href", "HTTPS://help.example.com/sign-in");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await expect(link.locator("svg")).toHaveCount(1);

    await page.goto(url("mailto:help@example.com"));
    await expect(link).toHaveAttribute("href", "mailto:help@example.com");
    await expect(link).not.toHaveAttribute("target", "_blank");
    await expect(link.locator("svg")).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});

test("Caps Lock is announced under the password", async ({ browser }) => {
  const { ctx, page } = await openPreview(browser);
  try {
    await toPassword(page, "jane");
    // Playwright's CapsLock key does not set the modifier state in Chromium
    // (it tracks Alt, Control, Meta and Shift only). When it does not, a key
    // event carrying the modifier (EventModifierInit's modifierCapsLock,
    // which Chromium honours) stands in for it; if neither reports the
    // state, there is nothing to check.
    await page.evaluate(() => {
      const w = window as unknown as { capsSeen: boolean };
      w.capsSeen = false;
      window.addEventListener("keyup", (e) => {
        if (e.getModifierState("CapsLock")) w.capsSeen = true;
      });
    });
    await page.keyboard.press("CapsLock");
    await page.keyboard.press("KeyA");
    const real = await page.evaluate(() => (window as unknown as { capsSeen: boolean }).capsSeen);
    const capsKey = async (on: boolean) => {
      if (real) {
        await page.keyboard.press("CapsLock");
        await page.keyboard.press(on ? "KeyA" : "KeyB");
        return;
      }
      await password(page).evaluate((el, capsOn) => {
        for (const type of ["keydown", "keyup"]) {
          el.dispatchEvent(new KeyboardEvent(type, { key: capsOn ? "A" : "b", code: capsOn ? "KeyA" : "KeyB", bubbles: true, modifierCapsLock: capsOn } as KeyboardEventInit));
        }
      }, on);
    };
    if (!real) {
      const honoured = await page.evaluate(() =>
        new KeyboardEvent("keyup", { key: "A", modifierCapsLock: true } as KeyboardEventInit).getModifierState("CapsLock")
      );
      test.skip(!honoured, "this browser reports no Caps Lock state for test key events");
      await capsKey(true);
    }

    // The hint is the field's help, so it is read with the field, and announced once.
    await expect.poll(() => describedText(password(page))).toContain("Caps Lock is on.");
    await expect(page.locator('p[role="status"][aria-live="polite"]')).toHaveText("Caps Lock is on.");
    await capsKey(false);
    await expect.poll(() => describedText(password(page))).not.toContain("Caps Lock is on.");
  } finally {
    await ctx.close();
  }
});

test("a ?sso_error banner on /login stays while the person types, and an unknown code is the general sentence", async ({ browser }) => {
  // Signed out, and nothing is submitted: only page loads.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  try {
    await page.goto("/login?sso_error=domain&next=/search");
    await expect(page.locator('button[type="submit"]')).toBeEnabled();
    const banner = alertWith(page, "Your email domain isn't allowed to sign in here.");
    await expect(banner).toBeVisible();
    // The code leaves the address (a reload shows no stale banner); next stays.
    await expect.poll(() => new URL(page.url()).search).toBe("?next=%2Fsearch");

    await identifier(page).pressSequentially("ja");
    await expect(banner).toBeVisible();
    expect(await describedText(identifier(page))).toContain("Your email domain isn't allowed to sign in here.");

    // Object.prototype's names are not codes.
    for (const code of ["constructor", "__proto__", "toString"]) {
      const res = await page.goto(`/login?sso_error=${code}`);
      expect(res?.status(), code).toBe(200);
      await expect(alertWith(page, "Something went wrong during sign-in. Please try again.")).toBeVisible();
    }
  } finally {
    await ctx.close();
  }
});
