"use client";

// Sign out of the customer portal: ends this browser's portal session and
// returns to the sign-in page.

import { useState } from "react";
import { portalFetch } from "./client";

export function PortalSignOut({ email }: { email: string }) {
  const [busy, setBusy] = useState(false);
  async function signOut() {
    setBusy(true);
    await portalFetch("/support/api/session", { method: "DELETE" }, "");
    window.location.assign("/support");
  }
  return (
    <button type="button" onClick={signOut} disabled={busy} className="shrink-0 whitespace-nowrap font-medium text-slate-600 hover:text-compass-700 disabled:opacity-60">
      Sign out<span className="sr-only"> ({email})</span>
    </button>
  );
}
