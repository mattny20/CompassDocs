"use client";

// Opening a sign-in link: one button spends it. Opening the page alone
// spends nothing, so a mail scanner that follows links signs nobody in.

import { useState } from "react";
import { Button } from "@/components/Button";
import { FormError } from "@/components/form";
import { portalFetch } from "./client";

export function PortalContinue({ token }: { token: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function go() {
    setBusy(true);
    setError("");
    const r = await portalFetch<{ next: string }>(
      "/support/api/session",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) },
      "Couldn't sign you in. Ask for a new link."
    );
    if (r.ok) {
      window.location.replace(r.data.next || "/support/requests");
      return;
    }
    setBusy(false);
    setError(r.error);
  }
  return (
    <>
      <FormError className="mt-4">{error}</FormError>
      {error ? (
        <Button href="/support" size="lg" variant="secondary" className="mt-4 w-full">
          Ask for a new link
        </Button>
      ) : (
        <Button size="lg" busy={busy} onClick={go} className="mt-5 w-full">
          Continue
        </Button>
      )}
    </>
  );
}
