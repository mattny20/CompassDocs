"use client";

// The customer portal's sign-in (mock #13): one card, "How can we help?",
// an email field and "Email me a sign-in link". The answer is always the
// same sentence (the portal never says whether an address is known), shown
// in place of the form with a way to send another.

import { useRef, useState } from "react";
import { MailCheck } from "lucide-react";
import { Button } from "@/components/Button";
import { Field, FormError, TextInput } from "@/components/form";
import { portalFetch } from "./client";
import { journeyId } from "./help/journey";

export function PortalSignIn({ next, notice }: { next: string; notice?: string }) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [sent, setSent] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Enter your email address, like name@example.com.");
      input.current?.focus();
      return;
    }
    setBusy(true);
    const r = await portalFetch<{ message: string }>(
      "/support/api/link",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: email.trim(), next, ...(journeyId() ? { j: journeyId() } : {}) }) },
      "Couldn't send the link. Try again."
    );
    setBusy(false);
    if (r.ok) setSent(r.data.message);
    else setError(r.error);
  }

  return (
    <div className="mx-auto mt-10 w-full max-w-md rounded-2xl border border-slate-200 bg-surface p-6 shadow-xs sm:mt-20 sm:p-7">
      {sent ? (
        <div role="status">
          <MailCheck className="h-6 w-6 text-compass-600" aria-hidden />
          <h1 className="mt-2 text-2xl font-bold text-slate-900">Check your email</h1>
          <p className="mt-1.5 text-sm text-slate-600">{sent}</p>
          <p className="mt-3 text-sm text-slate-500">The link works once and for 15 minutes. You can close this page.</p>
          <button type="button" className="link mt-4 text-sm font-medium" onClick={() => setSent("")}>
            Use a different address
          </button>
        </div>
      ) : (
        <form onSubmit={submit} noValidate>
          <h1 className="text-2xl font-bold text-slate-900">How can we help?</h1>
          <p className="mt-1.5 text-sm text-slate-600">
            Enter your email and we&apos;ll send you a link to raise a request or see your requests. No password needed.
          </p>
          {notice && <p className="notice-warn mt-4 rounded-lg border px-3 py-2 text-sm">{notice}</p>}
          <Field label="Email" className="mt-5">
            <TextInput
              ref={input}
              type="email"
              name="email"
              autoComplete="email"
              inputMode="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              className="h-11 text-base sm:text-sm"
            />
          </Field>
          <FormError className="mt-3">{error}</FormError>
          <Button type="submit" size="lg" busy={busy} className="mt-4 w-full">
            Email me a sign-in link
          </Button>
          <p className="mt-3 text-xs text-slate-500">The link works once and for 15 minutes.</p>
        </form>
      )}
    </div>
  );
}
