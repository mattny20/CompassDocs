// The admin preview's transport (1.16.0): the real sign-in steps, scripted,
// so an admin can walk through them without sending anything. The rules:
//   identifier *@sso.example   → one provider (Microsoft)
//   identifier *@both.example  → two providers (Microsoft and SAML)
//   any other identifier       → the password step
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

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });

export function demoLookup(identifier: string): LookupResult {
  const id = identifier.trim().toLowerCase();
  if (id.endsWith("@sso.example")) return { kind: "sso", providers: [DEMO_PROVIDERS[0]] };
  if (id.endsWith("@both.example")) return { kind: "sso", providers: DEMO_PROVIDERS };
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

export function demoTransport(onSignedIn: () => void): SignInTransport {
  return {
    async lookup(identifier, _next, signal) {
      await wait(350, signal);
      return demoLookup(identifier);
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
