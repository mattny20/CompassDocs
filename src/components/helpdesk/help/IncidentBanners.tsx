"use client";

// Get help's major incident banners (1.19.2, agent W1; mock-up a3): one
// notice-error card per open incident shown to this person, under the
// page header: the title, the latest update, "IT Service Desk · last
// update 10:42 · 61 people affected", and "Me too", which counts them as
// affected without raising a request (they then hear its updates) and
// takes it back on a second press. The first render comes from the server.

import { useState } from "react";
import { Check, Siren, Users } from "lucide-react";
import { Button } from "@/components/Button";
import { toast } from "@/components/Toasts";
import type { IncidentBannerView } from "@/lib/helpdesk/incidents-shared";

function lastUpdate(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? time : `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}

export function IncidentBanners({ initial }: { initial: IncidentBannerView[] }) {
  const [list, setList] = useState(initial);
  const [busy, setBusy] = useState<number | null>(null);
  if (!list.length) return null;

  async function meToo(b: IncidentBannerView) {
    setBusy(b.id);
    try {
      const res = await fetch(`/api/helpdesk/incidents/banners/${b.id}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ affected: !b.me_too }),
      });
      const r = (await res.json().catch(() => ({}))) as { banner?: IncidentBannerView; error?: string };
      if (!res.ok || !r.banner) throw new Error(r.error || "Couldn't save that. Try again.");
      setList((l) => l.map((x) => (x.id === b.id ? r.banner! : x)));
      toast("ok", r.banner.me_too ? "Thanks. You're counted as affected, and you'll hear each update." : "You're no longer counted as affected.");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mb-5 space-y-3" data-testid="incident-banners">
      {list.map((b) => (
        <section
          key={b.id}
          aria-labelledby={`incident-${b.id}`}
          className="notice-error flex flex-wrap items-start gap-x-3 gap-y-3 rounded-xl border p-4 text-sm sm:flex-nowrap"
        >
          <Siren className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1 basis-[calc(100%-2rem)] sm:basis-auto">
            <h2 id={`incident-${b.id}`} className="text-[0.9375rem] font-semibold">
              {b.title}
            </h2>
            <p className="mt-0.5 whitespace-pre-wrap break-words">{b.message}</p>
            <p className="mt-1 text-xs opacity-80">
              {[b.team_name, `last update ${lastUpdate(b.last_update_at)}`, `${b.affected} ${b.affected === 1 ? "person" : "people"} affected`]
                .filter(Boolean)
                .join(" · ")}
              {b.me_too && " · including you"}
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            icon={b.me_too ? <Check /> : <Users />}
            busy={busy === b.id}
            aria-pressed={b.me_too}
            data-tt={b.me_too ? "You said this affects you. Press again to take it back." : "This affects me too. No need to raise a request."}
            className="ml-8 shrink-0 sm:ml-0"
            onClick={() => void meToo(b)}
          >
            Me too
          </Button>
        </section>
      ))}
    </div>
  );
}
