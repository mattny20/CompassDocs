"use client";

// Changing your own password, in two places:
//   Account → Security   a routine change inside a card (forced={false})
//   /account/password    the forced change after an admin reset or a first
//                        sign-in, in the sign-in shell (1.16.0, STYLEGUIDE
//                        §Sign-in surfaces): the account it is for, with
//                        Sign out; a hidden username so a password manager
//                        updates the right entry; "Show passwords"; the
//                        sign-in surfaces' lg submit with an aria-disabled
//                        busy state and a delayed spinner.
// Inputs are uncontrolled and read on submit, so nothing typed or filled
// before hydration is lost; state mirrors them only for the inline checks.

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useRouter } from "next/navigation";
import { buttonClass } from "@/components/Button";
import { Field, FormError, TextInput } from "@/components/form";
import { Spinner } from "@/components/Spinner";
import { SignOutLink } from "@/components/SignOutLink";
import { IdentifierRow } from "@/components/auth/IdentifierRow";
import { PASSWORD_HELP, PASSWORD_MIN, passwordProblem } from "@/lib/password-policy";

const UNREACHABLE = "Couldn't reach the server. Check your connection and try again.";
const GENERIC = "Something went wrong. Try again in a moment.";

export function ChangePasswordForm(
  props:
    | {
        forced: true;
        /** Where to go once the change is done (already sanitised). */
        next?: string;
        /** The signed-in account the new password is for. */
        account: string;
      }
    | { forced: false; next?: undefined; account?: undefined }
) {
  const { forced, next: destination = "/", account } = props;
  const router = useRouter();
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [tried, setTried] = useState(false);
  const [loading, setLoading] = useState(false);
  const [spin, setSpin] = useState(false);
  const [show, setShow] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const currentRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);

  useEffect(() => setHydrated(true), []);

  // The spinner only after 150ms of waiting, so a fast answer never flashes.
  useEffect(() => {
    if (!loading) return;
    const t = window.setTimeout(() => setSpin(true), 150);
    return () => window.clearTimeout(t);
  }, [loading]);

  // Inline validation, shown once a submit has been attempted so the form
  // doesn't shout while someone is still typing.
  const nextError = next.length > 0 ? (passwordProblem(next) ? PASSWORD_HELP : undefined) : undefined;
  const confirmError = confirm && next !== confirm ? "Passwords don't match." : undefined;

  /** The field to fix after an error (the forced page only; Security keeps focus where it was). */
  const focusField = (el: HTMLInputElement | null) => {
    if (!forced || !el) return;
    el.focus();
    el.select();
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    const current = currentRef.current?.value ?? "";
    const fresh = nextRef.current?.value ?? "";
    const again = confirmRef.current?.value ?? "";
    setNext(fresh);
    setConfirm(again);
    setTried(true);
    if (fresh.length < PASSWORD_MIN) {
      setError(`New password must be at least ${PASSWORD_MIN} characters.`);
      return focusField(nextRef.current);
    }
    if (fresh !== again) {
      setError("New passwords don't match.");
      return focusField(confirmRef.current);
    }
    // Password fields again before the browser decides whether to offer saving.
    if (forced) flushSync(() => setShow(false));
    inFlight.current = true;
    setLoading(true);
    setError("");
    let res: Response;
    try {
      res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: fresh }),
      });
    } catch {
      return fail(UNREACHABLE);
    }
    const data = (res.headers.get("content-type") ?? "").includes("application/json")
      ? await res.json().catch(() => null)
      : null;
    if (!res.ok) {
      const message = data?.error ? String(data.error) : forced ? GENERIC : "Could not change password.";
      return fail(message, /^current password/i.test(message) ? currentRef.current : null);
    }
    // Busy stays on until the next page commits.
    router.push(forced ? destination : "/");
    router.refresh();
  }

  function fail(message: string, field: HTMLInputElement | null = null) {
    inFlight.current = false;
    setError(message);
    setLoading(false);
    setSpin(false);
    focusField(field);
  }

  if (!forced) {
    // Account → Security: unchanged since before the sign-in redesign.
    return (
      <form onSubmit={submit} className="space-y-4">
        <FormError>{error}</FormError>
        <Field label="Current password" size="md">
          <TextInput ref={currentRef} type="password" defaultValue="" autoComplete="current-password" />
        </Field>
        <Field label="New password" size="md" error={tried ? nextError : undefined} help={PASSWORD_HELP}>
          <TextInput
            ref={nextRef}
            type="password"
            defaultValue=""
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
          />
        </Field>
        <Field label="Confirm new password" size="md" error={tried ? confirmError : undefined}>
          <TextInput
            ref={confirmRef}
            type="password"
            defaultValue=""
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
          />
        </Field>
        <button type="submit" disabled={loading} className={buttonClass("primary", "md")}>
          {loading ? "Saving…" : "Update password"}
        </button>
      </form>
    );
  }

  const type = show ? "text" : "password";
  const input = "h-10 text-base sm:text-sm";
  return (
    <form method="post" noValidate aria-labelledby="auth-title" aria-busy={loading || undefined} onSubmit={submit} className="space-y-4">
      <IdentifierRow label="Signed in as" value={account} action={<SignOutLink className={buttonClass("ghost", "sm")} />} />
      {/* For password managers: the entry this new password belongs to. */}
      <input type="text" name="username" autoComplete="username" value={account} readOnly hidden />
      <Field label="Current password">
        <TextInput ref={currentRef} type={type} defaultValue="" autoComplete="current-password" autoFocus className={input} />
      </Field>
      <Field label="New password" error={tried ? nextError : undefined} help={PASSWORD_HELP}>
        <TextInput
          ref={nextRef}
          type={type}
          defaultValue=""
          onChange={(e) => setNext(e.target.value)}
          autoComplete="new-password"
          className={input}
        />
      </Field>
      <div>
        <Field label="Confirm new password" error={tried ? confirmError : undefined}>
          <TextInput
            ref={confirmRef}
            type={type}
            defaultValue=""
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            className={input}
          />
        </Field>
        <label className="mt-2 inline-flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" className="h-4 w-4" checked={show} onChange={(e) => setShow(e.target.checked)} />
          Show passwords
        </label>
      </div>
      <FormError>{error}</FormError>
      <button
        type="submit"
        disabled={!hydrated}
        aria-disabled={loading || undefined}
        aria-busy={loading || undefined}
        className={buttonClass("primary", "lg", "w-full")}
      >
        {spin && <Spinner />}
        Set password &amp; continue
      </button>
    </form>
  );
}
