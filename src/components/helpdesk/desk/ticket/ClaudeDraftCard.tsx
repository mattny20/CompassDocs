"use client";

// "Draft from Claude" (1.19.1, agent V1): a reply the Claude connector's
// hd_draft_reply saved on this ticket, shown above the composer as a dashed
// card (STYLEGUIDE §Desk, Claude draft card). It was not sent: "Use as
// reply" moves the text into the public reply box (the agent edits and
// sends it, under the normal rules, newbie review included) and "Discard"
// throws it away. Drafts are agent-only; requesters never see them.
// Loads GET /api/helpdesk/tickets/[number]/drafts; closes one with PATCH
// (used) or DELETE (discarded) on …/drafts/[id].

import { useCallback, useEffect, useState } from "react";
import { Bot, Pencil } from "lucide-react";
import { Button } from "@/components/Button";
import { MarkdownView } from "@/components/MarkdownView";
import { RelativeTime } from "@/components/RelativeTime";
import { toast } from "@/components/Toasts";
import type { HdReplyDraft } from "@/lib/helpdesk/drafts";
import { getJson, sendJson } from "../api";

export function ClaudeDraftCard({ number, onUse }: { number: number; onUse: (body: string) => void }) {
  const [drafts, setDrafts] = useState<HdReplyDraft[]>([]);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(
    () =>
      getJson<{ drafts: HdReplyDraft[] }>(`/api/helpdesk/tickets/${number}/drafts`, "Couldn't load the drafts.")
        .then((r) => setDrafts(r.drafts ?? []))
        .catch(() => setDrafts([])),
    [number]
  );

  useEffect(() => {
    setDrafts([]);
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && load(), 45_000);
    return () => clearInterval(t);
  }, [load]);

  // The newest pending draft; older ones wait behind it.
  const d = drafts[0];
  if (!d) return null;

  async function close(how: "used" | "discarded") {
    if (!d) return;
    setBusy(d.id);
    try {
      if (how === "used") {
        await sendJson(`/api/helpdesk/tickets/${number}/drafts/${d.id}`, "PATCH", { state: "used" }, "Couldn't use the draft.");
        onUse(d.body);
        toast("ok", "The draft is in the reply box. Check it, then send.");
      } else {
        await sendJson(`/api/helpdesk/tickets/${number}/drafts/${d.id}`, "DELETE", undefined, "Couldn't discard the draft.");
        toast("ok", "Draft discarded.");
      }
      setDrafts((all) => all.filter((x) => x.id !== d.id));
    } catch (e) {
      toast("error", (e as Error).message);
      void load();
    } finally {
      setBusy(null);
    }
  }

  const headingId = `claude-draft-${d.id}`;
  return (
    <section
      aria-labelledby={headingId}
      className="rounded-xl border-[1.5px] border-dashed border-compass-300 bg-compass-50 p-4 print:hidden dark:border-compass-500/50 dark:bg-compass-500/10"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-slate-900 text-slate-50" aria-hidden>
          <Bot className="h-4 w-4" />
        </span>
        <h3 id={headingId} className="text-sm font-semibold text-slate-900">
          Draft from Claude
        </h3>
        <span className="text-xs text-slate-500">
          {d.created_by_name ? `asked by ${d.created_by_name} · ` : ""}
          <RelativeTime value={d.created_at} /> · not sent
          {drafts.length > 1 && ` · ${drafts.length - 1} older ${drafts.length === 2 ? "draft" : "drafts"} waiting`}
        </span>
      </div>
      <div className="mt-1.5 min-w-0 pl-9 [&_.doc-prose]:text-sm! [&_.doc-prose]:leading-relaxed! [&_.doc-prose_p]:my-1.5">
        <MarkdownView content={d.body} headingOffset={2} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 pl-9">
        <Button icon={<Pencil />} busy={busy === d.id} onClick={() => close("used")}>
          Use as reply
        </Button>
        <Button variant="secondary" disabled={busy === d.id} onClick={() => close("discarded")}>
          Discard
        </Button>
        <span className="text-xs text-slate-500">Claude can only draft. A person sends.</span>
      </div>
    </section>
  );
}
