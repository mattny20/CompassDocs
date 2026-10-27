// The admin preview's transport (1.16.0): the real sign-in steps, scripted,
// so an admin can walk through them without sending anything. The providers
// are the workspace's own (DEMO_PROVIDERS when it has none, for the preview's
// ?flow=identify). The rules:
//   identifier *@sso.example   → the first provider alone (the redirect step)
//   identifier *@both.example  → every provider: a choice when there are two
//   any other identifier       → the password step, or with SSO only on
//                                every provider (rule 2, as on /login: one
//                                provider redirects, two are a choice)
//   password "wrong"           → Invalid username or password.
//   password "locked"          → the lockout sentence
//   password "2fa"             → a code step; 123456 signs in
//   any other password         → signed in (preview)
// Client-safe.

import type { LoginResult, LookupResult, SignInProviderLink, SignInTransport } from "./sign-in-transport";

export const DEMO_PROVIDERS: SignInProviderLink[] = [
  { id: "oidc", label: "Sign in with Microsoft", mark: "microsoft", start: "/api/ee/sso/login" },
  { id: "saml", label: "Sign in with single sign-on", mark: "saml", start: "/api/ee/saml/login" },
];

export interface DemoOptions {
  /** The workspace's "SSO only". */
  ssoOnly?: boolean;
  /** The workspace's providers; empty or missing, DEMO_PROVIDERS. */
  providers?: SignInProviderLink[];
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });

export function demoLookup(identifier: string, opts: DemoOptions = {}): LookupResult {
  const list = opts.providers?.length ? opts.providers : DEMO_PROVIDERS;
  const id = identifier.trim().toLowerCase();
  if (id.endsWith("@sso.example")) return { kind: "sso", providers: [list[0]] };
  if (opts.ssoOnly || id.endsWith("@both.example")) return { kind: "sso", providers: list };
  return { kind: "password" };
}

export function demoLogin(body: { password: string; totp_code?: string }): LoginResult {
  if (body.password === "wrong") return { kind: "invalid", error: "Invalid username or password." };
  if (body.password === "locked") return { kind: "limited", error: "Too many failed attempts. Try again in 15 minutes." };
  if (body.password === "2fa") {
    if (!body.totp_code) return { kind: "totp" };
    return body.totp_code.replace(/\s/g, "") === "123456" ? { kind: "ok", mustChange: false } : { kind: "totp", error: "That code didn't work — try again." };
  }
  return { kind: "ok", mustChange: false };
}

export function demoTransport(onSignedIn: () => void, opts: DemoOptions = {}): SignInTransport {
  return {
    async lookup(identifier, _next, signal) {
      await wait(350, signal);
      return demoLookup(identifier, opts);
    },
    async login(body, signal) {
      await wait(350, signal);
      return demoLogin(body);
    },
    navigate() {
      // The preview never leaves: the redirect state and its fallback stay on screen.
    },
    signedIn() {
      onSignedIn();
    },
  };
}
