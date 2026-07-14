"use client";

// Shared "one-click Microsoft setup" wizard (used by the SSO and directory
// sync panels). Starts the enterprise device-code flow, shows the code to
// enter at microsoft.com/devicelogin, polls until the tenant admin finishes
// signing in, then refetches the panel's state and hands it to the caller.

import { useRef, useState } from "react";

export function MsDeviceSetup({
  startUrl,
  pollUrl,
  refreshUrl,
  blurb,
  doneMessage,
  onDone,
}: {
  startUrl: string;
  pollUrl: string;
  /** Admin view endpoint refetched after success; its JSON goes to onDone. */
  refreshUrl: string;
  blurb: string;
  doneMessage: string;
  onDone: (state: any) => void;
}) {
  const [phase, setPhase] = useState<"idle" | "starting" | "waiting" | "done">("idle");
  const [code, setCode] = useState("");
  const [uri, setUri] = useState("");
  const [error, setError] = useState("");
  const stop = useRef(false);

  async function begin() {
    setError("");
    setPhase("starting");
    stop.current = false;
    const res = await fetch(startUrl, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data?.error || "Could not start Microsoft sign-in.");
      setPhase("idle");
      return;
    }
    setCode(data.user_code);
    setUri(data.verification_uri);
    setPhase("waiting");

    const intervalMs = Math.max(2, data.interval ?? 5) * 1000;
    const deadline = Date.now() + (data.expires_in ?? 900) * 1000;
    while (!stop.current && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, intervalMs));
      if (stop.current) return;
      const p = await fetch(pollUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ setup_id: data.setup_id }),
      });
      const pd = await p.json().catch(() => ({}));
      if (p.ok && pd.status === "done") {
        setPhase("done");
        const fresh = await fetch(refreshUrl);
        if (fresh.ok) onDone(await fresh.json());
        return;
      }
      if (!p.ok) {
        setError(pd?.error || "Setup failed.");
        setPhase("idle");
        return;
      }
    }
    if (!stop.current) {
      setError("The sign-in window expired — try again.");
      setPhase("idle");
    }
  }

  if (phase === "done") {
    return (
      <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
        {doneMessage}
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-lg border border-compass-100 bg-compass-50/50 p-3">
      {phase === "waiting" ? (
        <div className="text-sm text-slate-700">
          <p>
            Go to{" "}
            <a
              href={uri}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-compass-600 underline"
            >
              {uri.replace(/^https?:\/\//, "")}
            </a>{" "}
            and enter the code{" "}
            <code className="rounded bg-white px-2 py-0.5 font-mono text-base font-bold tracking-widest ring-1 ring-slate-200">
              {code}
            </code>
            , signing in as a tenant admin.
          </p>
          <p className="mt-1 flex items-center gap-2 text-xs text-slate-500">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-compass-500" />
            Waiting for you to finish signing in…
            <button
              className="font-medium text-slate-400 underline hover:text-slate-600"
              onClick={() => {
                stop.current = true;
                setPhase("idle");
              }}
            >
              cancel
            </button>
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={begin}
            disabled={phase === "starting"}
            className="rounded-lg bg-compass-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60"
          >
            {phase === "starting" ? "Contacting Microsoft…" : "Set up automatically with Microsoft"}
          </button>
          <span className="text-xs text-slate-500">{blurb}</span>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
