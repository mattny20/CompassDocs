"use client";

// "Sam Lee replied while you were typing" (1.19.1 collision warnings, agent
// V4; mock-up 5). The composer opens it when Send answers 409 { newer }:
// nothing was sent. It shows what landed (up to three messages), one
// sentence on why it matters, and three ways on: Keep editing (focus back
// in the box; the warning is not repeated for these messages), Discard
// mine (the draft goes), Send anyway (posts with force).

import { useId } from "react";
import { CircleAlert, Lock } from "lucide-react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/Button";
import { chipClass } from "@/components/Chip";
import { RelativeTime } from "@/components/RelativeTime";
import type { HdNewerMessage } from "@/lib/helpdesk/presence-shared";

const first = (n: string) => n.trim().split(/\s+/)[0] || n;

export function collisionTitle(newer: HdNewerMessage[]): string {
  const authors = Array.from(new Set(newer.map((m) => m.author_name)));
  const who = authors.length === 1 ? authors[0] : `${authors[0]} and ${authors.length - 1} ${authors.length === 2 ? "other" : "others"}`;
  const onlyNotes = newer.every((m) => m.kind === "internal");
  return `${who} ${onlyNotes ? (newer.length > 1 ? "added notes" : "added a note") : "replied"} while you were typing`;
}

export function collisionLede(newer: HdNewerMessage[], mode: "public" | "internal", requesterName: string): string {
  const last = newer[newer.length - 1];
  const whose = newer.length > 1 ? "them" : `${first(last.author_name)}'s`;
  if (mode === "internal") return `Your note hasn't been added. Read ${whose} first.`;
  if (newer.every((m) => m.from_requester)) return `Your reply hasn't been sent. ${first(last.author_name)} wrote again; read it first so your answer covers it.`;
  const requester = requesterName ? first(requesterName) : "the requester";
  return `Your reply hasn't been sent. Read ${whose === "them" ? "them" : whose} first so ${requester} doesn't get two different answers.`;
}

export function CollisionDialog({
  open,
  newer,
  mode,
  requesterName,
  busy = false,
  onKeep,
  onDiscard,
  onSendAnyway,
}: {
  open: boolean;
  newer: HdNewerMessage[];
  mode: "public" | "internal";
  requesterName: string;
  busy?: boolean;
  onKeep: () => void;
  onDiscard: () => void;
  onSendAnyway: () => void;
}) {
  const titleId = useId();
  const ledeId = useId();
  if (!newer.length) return null;
  return (
    <Modal open={open} onClose={onKeep} labelledBy={titleId} describedBy={ledeId} className="w-full max-w-lg rounded-xl border border-slate-200 bg-surface p-5 shadow-modal">
      <h2 id={titleId} className="flex items-start gap-2 text-base font-semibold text-slate-900">
        <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden />
        {collisionTitle(newer)}
      </h2>
      <ul className="mt-3 space-y-2" aria-label="Messages you haven't read">
        {newer.slice(-3).map((m) => (
          <li
            key={m.id}
            className={`rounded-lg border p-3 ${
              m.kind === "internal" ? "border-amber-200 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/10" : "border-slate-200 bg-slate-50"
            }`}
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-compass-100 text-2xs font-bold text-compass-700" aria-hidden>
                {m.initials}
              </span>
              <span className="text-sm font-semibold text-slate-900">{m.author_name}</span>
              <span className="text-xs text-slate-500">
                <RelativeTime value={m.created_at} />
                {m.kind === "public" && !m.from_requester && " · to the requester"}
              </span>
              {m.kind === "internal" && (
                <span className={chipClass("warn", "sm")}>
                  <Lock className="h-3 w-3" aria-hidden />
                  Internal note
                </span>
              )}
            </div>
            <p className="mt-1.5 line-clamp-6 whitespace-pre-wrap break-words text-sm text-slate-700">{m.body}</p>
          </li>
        ))}
      </ul>
      {newer.length > 3 && <p className="mt-1 text-xs text-slate-500">And {newer.length - 3} earlier, in the conversation.</p>}
      <p id={ledeId} className="mt-3 text-sm text-slate-600">
        {collisionLede(newer, mode, requesterName)}
      </p>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onKeep} data-autofocus>
          Keep editing
        </Button>
        <Button variant="secondary" onClick={onDiscard}>
          Discard mine
        </Button>
        <Button variant="primary" onClick={onSendAnyway} busy={busy}>
          {mode === "internal" ? "Add anyway" : "Send anyway"}
        </Button>
      </div>
    </Modal>
  );
}
