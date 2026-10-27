// How the sign-in page talks to the server (1.16.0). SignInFlow takes a
// transport so the same steps run against the real API on /login and a
// scripted one in the admin's preview (lib/sign-in-demo), where nothing
// typed is ever sent. Client-safe.

import type { ProviderMarkKind } from "@/components/auth/ProviderMark";

export interface SignInProviderLink {
  id: "oidc" | "saml";
  label: string;
  mark: ProviderMarkKind;
  /** A same-origin /api/ee/… path the server built. */
  start: string;
}

export type LookupResult =
  | { kind: "password" }
  | { kind: "sso"; providers: SignInProviderLink[] }
  | { kind: "field" | "limited" | "error"; error: string };

export type LoginResult =
  | { kind: "ok"; mustChange: boolean }
  | { kind: "totp"; error?: string }
  | { kind: "invalid" | "limited" | "error"; error: string };

export interface SignInTransport {
  lookup(identifier: string, next: string, signal: AbortSignal): Promise<LookupResult>;
  login(body: { username: string; password: string; totp_code?: string }, signal: AbortSignal): Promise<LoginResult>;
  /** Hand the page to a provider (a full navigation; the preview stays put). */
  navigate(url: string): void;
  /** Signed in: go where the person was going. */
  signedIn(dest: string): void;
}

export const UNREACHABLE = "Couldn't reach the server. Check your connection and try again.";
export const BROKEN = "Something went wrong. Try again in a moment.";
export const RELOAD = "Sign-in failed. Reload the page and try again.";

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  if (!(res.headers.get("content-type") ?? "").includes("application/json")) return null;
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function withTimeout(signal: AbortSignal, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return AbortSignal.any ? AbortSignal.any([signal, timeout]) : signal;
}

export function realTransport(router: { push: (href: string) => void; refresh: () => void }): SignInTransport {
  return {
    async lookup(identifier, next, signal) {
      let res: Response;
      try {
        res = await fetch("/api/auth/lookup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier, next }),
          cache: "no-store",
          signal: withTimeout(signal, 15_000),
        });
      } catch (e) {
        if (signal.aborted) throw e;
        return { kind: "error", error: UNREACHABLE };
      }
      const data = await readJson(res);
      if (res.status === 429) return { kind: "limited", error: String(data?.error || BROKEN) };
      if (res.status === 400) return { kind: "field", error: String(data?.error || "Enter your email or username.") };
      if (res.status === 403 || res.status === 415) return { kind: "error", error: RELOAD };
      if (!res.ok || !data) return { kind: "error", error: BROKEN };
      if (data.step === "sso" && Array.isArray(data.providers)) {
        return { kind: "sso", providers: data.providers as SignInProviderLink[] };
      }
      return { kind: "password" };
    },
    async login(body, signal) {
      let res: Response;
      try {
        res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          cache: "no-store",
          signal: withTimeout(signal, 30_000),
        });
      } catch (e) {
        if (signal.aborted) throw e;
        return { kind: "error", error: UNREACHABLE };
      }
      const data = await readJson(res);
      if (data?.totp_required) return { kind: "totp", error: typeof data.error === "string" ? data.error : undefined };
      if (res.ok && data?.ok) return { kind: "ok", mustChange: data.must_change_password === true };
      if (res.status === 401) return { kind: "invalid", error: String(data?.error || "Invalid username or password.") };
      if (res.status === 429) return { kind: "limited", error: String(data?.error || BROKEN) };
      if (res.status === 400) return { kind: "invalid", error: String(data?.error || BROKEN) };
      if (res.status === 403) return { kind: "error", error: RELOAD };
      return { kind: "error", error: BROKEN };
    },
    navigate(url) {
      window.location.assign(url);
    },
    signedIn(dest) {
      router.push(dest);
      router.refresh();
    },
  };
}
