"use client";

// Follow/unfollow a space. Three effective states: subscribed directly,
// subscribed via an admin-assigned group (mutable), or not subscribed.
// Subscribers get an email when a doc in the space is published or updated.

import { useState } from "react";
import { Bell, BellOff, BellRing } from "lucide-react";

type State = "subscribed" | "muted" | null;

export function SubscribeButton({
  spaceId,
  initialState,
  initialViaGroup,
}: {
  spaceId: number;
  initialState: State;
  initialViaGroup: boolean;
}) {
  const [state, setState] = useState<State>(initialState);
  const [viaGroup] = useState(initialViaGroup);
  const [busy, setBusy] = useState(false);

  const effective = state === "subscribed" || (viaGroup && state !== "muted");

  async function apply(action: "subscribe" | "mute" | "clear") {
    setBusy(true);
    const res = await fetch(`/api/spaces/${spaceId}/subscription`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    setBusy(false);
    if (res.ok) setState((await res.json()).state);
  }

  function toggle() {
    if (effective) {
      // Group-driven subscriptions are muted (can't be removed by the user);
      // direct ones are simply cleared.
      void apply(viaGroup ? "mute" : "clear");
    } else {
      void apply("subscribe");
    }
  }

  return (
    <button
      onClick={toggle}
      disabled={busy}
      title={
        effective
          ? viaGroup && state !== "subscribed"
            ? "Subscribed via a group — click to mute emails for this space"
            : "Subscribed — click to unsubscribe"
          : "Get an email when documents in this space are published or updated"
      }
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border px-3 py-2 text-sm font-medium transition disabled:opacity-60 ${
        effective
          ? "border-compass-200 bg-compass-50 text-compass-700 hover:bg-compass-100"
          : "border-slate-200 bg-surface text-slate-600 hover:bg-slate-50"
      }`}
    >
      {effective ? (
        <BellRing className="h-4 w-4" />
      ) : state === "muted" ? (
        <BellOff className="h-4 w-4" />
      ) : (
        <Bell className="h-4 w-4" />
      )}
      {effective ? "Subscribed" : state === "muted" ? "Muted" : "Subscribe"}
    </button>
  );
}
