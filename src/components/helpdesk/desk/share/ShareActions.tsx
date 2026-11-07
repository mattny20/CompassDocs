"use client";

// Share and print a ticket (1.19.4, area C6; mock-ups u1, u2, u4).
//
//   useShareMenu(ticket)  the ticket … menu's first group: "Share with an
//     agent…", "Copy link" and "Print or save as PDF…" (with its Ctrl/⌘ P
//     keycap), their dialogs, and Ctrl/Cmd+P on the open ticket, which opens
//     the print dialog instead of printing the raw page.
//   ShareDialog   pick agents (only those who work the ticket; the others
//     are listed disabled with the reason), an optional message, "Make them
//     follow this ticket" (on). POST …/share.
//   PrintDialog   what to include (the conversation always; notes off), then
//     the print page in a new tab, which opens the browser's print dialog.
//
// STYLEGUIDE §Helpdesk: share and print a ticket.

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Forward, Link2, Printer, X } from "lucide-react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/Button";
import { CopyButton } from "@/components/CopyButton";
import { MenuItem } from "@/components/Popover";
import { Kbd, MOD_KEY } from "@/components/palette/Kbd";
import { chipClass } from "@/components/Chip";
import { Field, FormError, SectionEmpty, Textarea } from "@/components/form";
import { LoadingRow } from "@/components/Spinner";
import { toast } from "@/components/Toasts";
import { initialsOf } from "@/components/UserAvatar";
import { blockModKey } from "@/lib/hotkeys";
import { overlayOpen } from "@/lib/overlay-stack";
import {
  HD_PRINT_DEFAULTS,
  HD_PRINT_PARTS,
  HD_PRINT_PART_INFO,
  HD_SHARE_MESSAGE_MAX,
  HD_SHARE_RECIPIENTS_MAX,
  nameList,
  printHref,
  type HdPrintOptions,
  type HdPrintPart,
  type HdShareCandidate,
  type HdShareOptions,
  type HdShareResult,
} from "@/lib/helpdesk/share-shared";
import { getJson, sendJson } from "../api";

interface TicketLike {
  number: number;
  subject: string;
}

function deskUrl(number: number): string {
  return `${window.location.origin}/desk/tickets/${number}`;
}

async function copyLink(number: number): Promise<void> {
  try {
    await navigator.clipboard.writeText(deskUrl(number));
    toast("ok", `Link to #${number} copied.`);
  } catch {
    toast("error", "Couldn't copy the link. Copy it from the address bar.");
  }
}

/** The … menu's share and print items, their dialogs, and Ctrl/Cmd+P on the ticket. */
export function useShareMenu(t: TicketLike, opts: { onShared?: () => void } = {}): { any: boolean; items: (close: () => void) => ReactNode; dialogs: ReactNode } {
  const [sharing, setSharing] = useState(false);
  const [printing, setPrinting] = useState(false);

  // Ctrl/Cmd+P on an open ticket opens the print dialog instead of printing
  // the desk as it stands. With another overlay open the browser keeps it.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== "p" || blockModKey(e) || overlayOpen()) return;
      e.preventDefault();
      setPrinting(true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return {
    any: true,
    items: (close) => (
      <>
        <MenuItem icon={<Forward />} onClick={() => { close(); setSharing(true); }}>
          Share with an agent…
        </MenuItem>
        <MenuItem icon={<Link2 />} onClick={() => { close(); void copyLink(t.number); }}>
          Copy link
        </MenuItem>
        <MenuItem icon={<Printer />} aria-keyshortcuts="Control+P Meta+P" onClick={() => { close(); setPrinting(true); }}>
          <span className="flex items-center justify-between gap-3">
            Print or save as PDF…
            <span aria-hidden>
              <Kbd keys={[MOD_KEY, "p"]} />
            </span>
          </span>
        </MenuItem>
      </>
    ),
    dialogs: (
      <>
        <ShareDialog open={sharing} onClose={() => setSharing(false)} ticket={t} onShared={opts.onShared} />
        <PrintDialog open={printing} onClose={() => setPrinting(false)} ticket={t} />
      </>
    ),
  };
}

// --- Share -------------------------------------------------------------------------

export function ShareDialog({ open, onClose, ticket, onShared }: { open: boolean; onClose: () => void; ticket: TicketLike; onShared?: () => void }) {
  const [candidates, setCandidates] = useState<HdShareCandidate[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [follow, setFollow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setCandidates(null);
    setLoadError(null);
    setPicked([]);
    setQuery("");
    setMessage("");
    setFollow(true);
    setError(null);
    const ctl = new AbortController();
    getJson<HdShareOptions>(`/api/helpdesk/tickets/${ticket.number}/share`, "Couldn't load the agents.", ctl.signal)
      .then((r) => setCandidates(r.candidates ?? []))
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setLoadError((e as Error).message);
      });
    return () => ctl.abort();
  }, [open, ticket.number]);

  const byId = useMemo(() => new Map((candidates ?? []).map((c) => [c.user_id, c])), [candidates]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = candidates ?? [];
    return q ? all.filter((c) => `${c.name} ${c.teams}`.toLowerCase().includes(q)) : all;
  }, [candidates, query]);
  const selectable = shown.filter((c) => c.can_see);
  const full = picked.length >= HD_SHARE_RECIPIENTS_MAX;

  function toggle(c: HdShareCandidate) {
    if (!c.can_see) return;
    setPicked((p) => (p.includes(c.user_id) ? p.filter((x) => x !== c.user_id) : p.length >= HD_SHARE_RECIPIENTS_MAX ? p : [...p, c.user_id]));
    setActive(c.user_id);
    setError(null);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!selectable.length) return;
      const at = selectable.findIndex((c) => c.user_id === active);
      const next = e.key === "ArrowDown" ? (at + 1) % selectable.length : (at <= 0 ? selectable.length : at) - 1;
      setActive(selectable[next].user_id);
      document.getElementById(`${id}-o${selectable[next].user_id}`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const c = active !== null ? byId.get(active) : selectable.length === 1 ? selectable[0] : undefined;
      if (c) toggle(c);
    } else if (e.key === "Backspace" && !query && picked.length) {
      setPicked((p) => p.slice(0, -1));
    }
  }

  async function submit() {
    if (!picked.length) {
      setError("Pick at least one agent to share it with.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await sendJson<HdShareResult>(
        `/api/helpdesk/tickets/${ticket.number}/share`,
        "POST",
        { user_ids: picked, message: message.trim(), follow },
        "Couldn't share the ticket."
      );
      toast("ok", `Shared #${ticket.number} with ${nameList(r.shared.map((s) => s.name))}.`);
      onShared?.();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const listId = `${id}-list`;
  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy={`${id}-t`}
      describedBy={`${id}-d`}
      className="max-h-[calc(100vh-2rem)] w-full max-w-lg overflow-y-auto rounded-xl border border-slate-200 bg-surface p-5 shadow-modal"
    >
      <h2 id={`${id}-t`} className="flex items-center gap-2 text-base font-semibold text-slate-900">
        <Forward className="h-4.5 w-4.5 text-slate-700" aria-hidden />
        Share #{ticket.number}
      </h2>
      <p id={`${id}-d`} className="mt-0.5 truncate text-sm text-slate-600">
        {ticket.subject}
      </p>

      <div className="mt-4">
        <label htmlFor={`${id}-q`} className="mb-1 block text-xs font-medium text-slate-500">
          Share with
        </label>
        <div
          className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-slate-300 bg-surface px-2 py-1.5 focus-within:border-compass-500 focus-within:ring-2 focus-within:ring-compass-500/20"
          onClick={() => inputRef.current?.focus()}
        >
          {picked.map((uid) => {
            const c = byId.get(uid);
            if (!c) return null;
            return (
              <span key={uid} className={chipClass("accent")}>
                {c.name}
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setPicked((p) => p.filter((x) => x !== uid)); }}
                  aria-label={`Remove ${c.name}`}
                  data-tt="Remove"
                  className="-mr-1 grid h-4 w-4 place-items-center rounded-full hover:bg-compass-100"
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </span>
            );
          })}
          <input
            ref={inputRef}
            id={`${id}-q`}
            data-autofocus
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active !== null ? `${id}-o${active}` : undefined}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={picked.length ? "Add another agent…" : "Find an agent…"}
            className="min-w-32 flex-1 bg-transparent py-0.5 text-sm text-slate-800 outline-none placeholder:text-slate-400"
          />
        </div>
        <div className="mt-1.5 max-h-56 overflow-y-auto rounded-lg border border-slate-200 p-1">
          {loadError ? (
            <FormError className="m-2">{loadError}</FormError>
          ) : !candidates ? (
            <LoadingRow className="py-6" />
          ) : shown.length === 0 ? (
            <SectionEmpty className="m-1">{candidates.length ? "No agent matches that." : "There are no other agents on the desk."}</SectionEmpty>
          ) : (
            <ul id={listId} role="listbox" aria-multiselectable aria-label="Agents">
              {shown.map((c) => {
                const on = picked.includes(c.user_id);
                const disabled = !c.can_see || (full && !on);
                const sub = [c.teams || "No team", c.viewing ? "viewing now" : "", c.following ? "following" : ""].filter(Boolean).join(" · ");
                return (
                  <li
                    key={c.user_id}
                    id={`${id}-o${c.user_id}`}
                    role="option"
                    aria-selected={on}
                    aria-disabled={disabled || undefined}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => !disabled && toggle(c)}
                    className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm ${
                      on ? "bg-compass-50" : active === c.user_id && !disabled ? "bg-slate-50" : ""
                    } ${disabled ? "cursor-default opacity-60" : "cursor-pointer hover:bg-slate-50"}`}
                  >
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-compass-100 text-2xs font-bold text-compass-700" aria-hidden>
                      {initialsOf(c.name)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-slate-800">{c.name}</span>
                      <span className="block truncate text-xs text-slate-500">{sub}</span>
                    </span>
                    {on ? (
                      <Check className="h-4 w-4 shrink-0 text-compass-600" aria-hidden />
                    ) : !c.can_see && c.reason ? (
                      <span className="max-w-[45%] shrink-0 text-right text-xs text-slate-500">{c.reason}</span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {full && <p className="mt-1 text-xs text-slate-500">You can share with up to {HD_SHARE_RECIPIENTS_MAX} agents at a time.</p>}
      </div>

      <Field
        className="mt-4"
        label={
          <>
            Message <span className="font-normal text-slate-400">(optional)</span>
          </>
        }
        help={`${message.length} of ${HD_SHARE_MESSAGE_MAX} characters`}
      >
        <Textarea rows={3} maxLength={HD_SHARE_MESSAGE_MAX} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="What should they look at?" />
      </Field>

      <label className="mt-3 flex items-start gap-2 text-sm text-slate-700">
        <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-compass-600" />
        <span>
          Make them follow this ticket
          <span className="mt-0.5 block text-xs text-slate-500">They&apos;ll hear about new replies and notes.</span>
        </span>
      </label>
      <p className="mt-3 text-xs text-slate-500">They get a bell and an email with a link to the ticket. The share is noted on the timeline, visible to agents only.</p>

      <FormError className="mt-3">{error}</FormError>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <CopyButton text={() => deskUrl(ticket.number)} label="Copy link" copiedLabel="Link copied" size="md" />
        <span className="flex-1" />
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button icon={<Forward />} busy={busy} disabled={!picked.length} onClick={() => void submit()}>
          {picked.length > 1 ? `Share with ${picked.length}` : "Share"}
        </Button>
      </div>
    </Modal>
  );
}

// --- Print -------------------------------------------------------------------------

export function PrintDialog({ open, onClose, ticket }: { open: boolean; onClose: () => void; ticket: TicketLike }) {
  const [o, setO] = useState<HdPrintOptions>(HD_PRINT_DEFAULTS);
  const id = useId();
  useEffect(() => {
    if (open) setO({ ...HD_PRINT_DEFAULTS });
  }, [open]);

  function print() {
    const href = printHref(ticket.number, o);
    // In the click itself, so a popup blocker lets the tab through; blocked, the page opens here.
    const w = window.open(href, "_blank");
    if (w) w.opener = null;
    else window.location.assign(href);
    onClose();
  }

  const row = (key: HdPrintPart | "conversation") => {
    const info = key === "conversation" ? { label: "The conversation", hint: "Requester and agent replies, with times." } : HD_PRINT_PART_INFO[key];
    const checked = key === "conversation" ? true : o[key];
    return (
      <label key={key} className={`flex items-start gap-2.5 py-1.5 text-sm ${key === "conversation" ? "text-slate-500" : "text-slate-800"}`}>
        <input
          type="checkbox"
          checked={checked}
          disabled={key === "conversation"}
          onChange={(e) => key !== "conversation" && setO((p) => ({ ...p, [key]: e.target.checked }))}
          className="mt-0.5 h-4 w-4 shrink-0 accent-compass-600"
        />
        <span>
          {info.label}
          {info.hint && <span className="mt-0.5 block text-xs text-slate-500">{info.hint}</span>}
        </span>
      </label>
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy={`${id}-t`}
      describedBy={`${id}-d`}
      className="max-h-[calc(100vh-2rem)] w-full max-w-md overflow-y-auto rounded-xl border border-slate-200 bg-surface p-5 shadow-modal"
    >
      <h2 id={`${id}-t`} className="flex items-center gap-2 text-base font-semibold text-slate-900">
        <Printer className="h-4.5 w-4.5 text-slate-700" aria-hidden />
        Print #{ticket.number}
      </h2>
      <p id={`${id}-d`} className="mt-0.5 text-sm text-slate-600">
        Print it, or choose Save as PDF in the next window.
      </p>
      <fieldset className="mt-4">
        <legend className="mb-1 text-xs font-medium text-slate-500">Include</legend>
        {row("conversation")}
        {HD_PRINT_PARTS.map((p) => row(p))}
      </fieldset>
      <p className="mt-2 text-xs text-slate-500">Printing is noted in the audit log.</p>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button icon={<Printer />} onClick={print} data-autofocus>
          Print
        </Button>
      </div>
    </Modal>
  );
}

