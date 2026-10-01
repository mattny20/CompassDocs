"use client";

import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { buttonClass } from "@/components/Button";
import { Field, FormError, TextInput } from "@/components/form";
import { useRouter } from "next/navigation";

export function LoginForm({ next = "/" }: { next?: string }) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username,
          password,
          ...(needsTotp && totpCode ? { totp_code: totpCode } : {}),
        }),
      });
      const data = await res.json();
      if (data?.totp_required) {
        // Correct password, 2FA account: reveal the code field.
        setNeedsTotp(true);
        setTotpCode("");
        setError(data?.error || "");
        setLoading(false);
        return;
      }
      if (!res.ok) throw new Error(data?.error || "Sign in failed.");
      router.push(data.must_change_password ? "/account/password" : next);
      router.refresh();
    } catch (e: any) {
      setError(e.message);
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <FormError>{error}</FormError>
      {!needsTotp ? (
        <>
          <Field label="Username">
            <TextInput
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              autoComplete="username"
            />
          </Field>
          <Field label="Password">
            <TextInput
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </Field>
        </>
      ) : (
        <Field
          label="Two-factor code"
          help="From your authenticator app — or one of your recovery codes."
        >
          <TextInput
            value={totpCode}
            onChange={(e) => setTotpCode(e.target.value)}
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="6-digit code or recovery code"
            className="text-center font-mono tracking-widest"
          />
        </Field>
      )}
      <button
        type="submit"
        disabled={loading || (needsTotp && !totpCode)}
        className={buttonClass("primary", "md", "w-full")}
      >
        {loading ? "Signing in…" : needsTotp ? "Verify" : "Sign in"}
      </button>
      {needsTotp && (
        <button
          type="button"
          onClick={() => {
            setNeedsTotp(false);
            setTotpCode("");
            setError("");
          }}
          className="inline-flex w-full items-center justify-center gap-1 text-center text-xs font-medium text-slate-500 hover:text-slate-600"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back
        </button>
      )}
    </form>
  );
}
