"use client";

import { useState } from "react";
import { buttonClass } from "@/components/Button";
import { Field, FormError, TextInput } from "@/components/form";
import { PASSWORD_HELP, PASSWORD_MIN, passwordProblem } from "@/lib/password-policy";
import { useRouter } from "next/navigation";

export function ChangePasswordForm({ forced }: { forced: boolean }) {
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [tried, setTried] = useState(false);
  const [loading, setLoading] = useState(false);

  // Inline validation, shown once a submit has been attempted so the form
  // doesn't shout while someone is still typing.
  const nextError = next.length > 0 ? (passwordProblem(next) ? PASSWORD_HELP : undefined) : undefined;
  const confirmError = confirm && next !== confirm ? "Passwords don't match." : undefined;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    if (next.length < PASSWORD_MIN) return setError(`New password must be at least ${PASSWORD_MIN} characters.`);
    if (next !== confirm) return setError("New passwords don't match.");
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Could not change password.");
      router.push("/");
      router.refresh();
    } catch (e: any) {
      setError(e.message);
      setLoading(false);
    }
  }

  // The forced-reset page is a narrow centred card: full width there. In
  // Account → Security the form sits in a wide card: medium.
  const size = forced ? "full" : "md";

  return (
    <form onSubmit={submit} className="space-y-4">
      <FormError>{error}</FormError>
      <Field label="Current password" size={size}>
        <TextInput
          type="password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password"
        />
      </Field>
      <Field label="New password" size={size} error={tried ? nextError : undefined} help={PASSWORD_HELP}>
        <TextInput
          type="password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          autoComplete="new-password"
        />
      </Field>
      <Field label="Confirm new password" size={size} error={tried ? confirmError : undefined}>
        <TextInput
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
        />
      </Field>
      <button
        type="submit"
        disabled={loading}
        className={buttonClass("primary", "md", forced ? "w-full" : "")}
      >
        {loading ? "Saving…" : forced ? "Set password & continue" : "Update password"}
      </button>
    </form>
  );
}
