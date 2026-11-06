"use client";

// CCs on a request (1.19.1, agent V3): the pieces the desk's CC row, Get
// help's request page and the new-request form share.
//
//   CcChip           one person copied: a neutral chip, an outside address
//                    marked with Mail, an optional remove button.
//   AddPeoplePanel   the people picker over the directory's active accounts
//                    (/api/users/mentionable: names only) and, when outside
//                    senders are allowed, an email address box.
//   AddPeopleButton  a trigger opening the panel: a Popover in the desk, inline
//                    beneath the button in Get help.
//
// STYLEGUIDE §Helpdesk: CCs and followers.

import { useEffect, useId, useRef, useState } from "react";
import { Mail, Plus, X } from "lucide-react";
import { Popover } from "@/components/Popover";
import { Button, iconButtonClass } from "@/components/Button";
import { chipClass } from "@/components/Chip";
import { controlClass } from "@/components/form";
import { EntityPicker, type PickerOption } from "@/components/EntityPicker";
import { looksLikeEmail } from "@/lib/helpdesk/ccs-shared";

/** What a picker hands back: an account, or an outside address. */
export type CcPick = { user_id: number; name: string } | { email: string; name: string };

let peopleCache: Promise<PickerOption[]> | null = null;

function loadPeople(): Promise<PickerOption[]> {
  if (!peopleCache) {
    peopleCache = fetch("/api/users/mentionable", { headers: { accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : { users: [] }))
      .then((d: { users?: { id: number; name: string; username: string }[] }) =>
        (d.users ?? []).map((u) => ({ id: u.id, label: u.name || u.username, sublabel: u.username }))
      )
      .catch(() => {
        peopleCache = null;
        return [];
      });
  }
  return peopleCache;
}

export function CcChip({
  name,
  email,
  outside,
  onRemove,
  removeLabel,
}: {
  name: string;
  email?: string;
  outside?: boolean;
  onRemove?: () => void;
  removeLabel?: string;
}) {
  return (
    <span className={chipClass("neutral", "md", onRemove ? "pr-0.5" : "")} data-cc-chip={name}>
      {outside && <Mail className="h-3 w-3 shrink-0" aria-hidden />}
      <span className="max-w-[14rem] truncate" {...(email && email !== name ? { "data-tt": email } : {})}>
        {name}
      </span>
      {outside && <span className="sr-only"> (outside the workspace)</span>}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel ?? `Remove ${name}`}
          data-tt="Remove"
          className={iconButtonClass("quiet", "sm", "!h-5 !w-5 rounded-full [&>svg]:!h-3 [&>svg]:!w-3")}
        >
          <X aria-hidden />
        </button>
      )}
    </span>
  );
}

export function AddPeoplePanel({
  outsideAllowed,
  excludeIds = [],
  onAdd,
}: {
  outsideAllowed: boolean;
  /** Accounts already on the request (the requester, people copied). */
  excludeIds?: number[];
  onAdd: (p: CcPick) => void | Promise<void>;
}) {
  const [people, setPeople] = useState<PickerOption[] | null>(null);
  const [email, setEmail] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    void loadPeople().then((p) => live && setPeople(p));
    return () => {
      live = false;
    };
  }, []);
  const options = (people ?? []).filter((p) => !excludeIds.includes(p.id));
  function addEmail() {
    const v = email.trim();
    if (!looksLikeEmail(v)) {
      setErr("Enter one email address, like name@example.com.");
      return;
    }
    setErr("");
    setEmail("");
    void onAdd({ email: v.toLowerCase(), name: v.toLowerCase() });
  }
  return (
    <div className="flex flex-col gap-2 p-2">
      <EntityPicker
        options={options}
        onPick={(id) => {
          const p = people?.find((o) => o.id === id);
          if (p) void onAdd({ user_id: p.id, name: p.label });
        }}
        label="Add people from the directory"
        placeholder={people ? "Search people…" : "Loading people…"}
        disabled={!people}
        emptyText="No one matches."
      />
      {outsideAllowed ? (
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500" htmlFor="cc-outside-email">
            Or someone outside the workspace
          </label>
          <div className="flex gap-1.5">
            <input
              id="cc-outside-email"
              type="email"
              inputMode="email"
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addEmail();
                }
              }}
              placeholder="name@example.com"
              aria-invalid={err ? true : undefined}
              aria-describedby={err ? "cc-outside-email-err" : undefined}
              className={controlClass(!!err, "min-w-0 flex-1")}
            />
            <Button variant="secondary" size="md" onClick={addEmail} disabled={!email.trim()}>
              Add
            </Button>
          </div>
          {err && (
            <p id="cc-outside-email-err" role="alert" className="mt-1 text-xs text-red-600">
              {err}
            </p>
          )}
        </div>
      ) : (
        <p className="text-xs text-slate-500">People in the directory only. Outside addresses need outside senders on in Desk settings.</p>
      )}
    </div>
  );
}

export function AddPeopleButton({
  label = "Add",
  outsideAllowed,
  excludeIds,
  onAdd,
  variant = "chip",
  disabled = false,
}: {
  label?: string;
  outsideAllowed: boolean;
  excludeIds?: number[];
  onAdd: (p: CcPick) => void | Promise<void>;
  /**
   * "chip": the desk's inline "+ Add", opening a Popover (hung from whichever
   * edge keeps it on screen). "button": a bordered sm "+ Add people" that
   * opens the panel inline beneath it (Get help, the new-request form), so a
   * phone never has to fit a floating panel beside a narrow column.
   */
  variant?: "chip" | "button";
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [align, setAlign] = useState<"start" | "end">("start");
  const btn = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const panel = (
    <AddPeoplePanel
      outsideAllowed={outsideAllowed}
      excludeIds={excludeIds}
      onAdd={async (p) => {
        await onAdd(p);
      }}
    />
  );
  function toggle() {
    const r = btn.current?.getBoundingClientRect();
    if (r && typeof window !== "undefined") setAlign(r.left + 336 > window.innerWidth ? "end" : "start");
    setOpen((o) => !o);
  }
  if (variant === "button") {
    return (
      <>
        <button
          ref={btn}
          type="button"
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={panelId}
          className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-slate-200 bg-surface px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60 print:hidden"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          {label}
        </button>
        {open && (
          <div
            id={panelId}
            role="group"
            aria-label="Add people"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setOpen(false);
                btn.current?.focus();
              }
            }}
            className="w-full basis-full rounded-lg border border-slate-200 bg-surface print:hidden"
          >
            {panel}
          </div>
        )}
      </>
    );
  }
  return (
    <span className="relative inline-flex">
      <button
        ref={btn}
        type="button"
        disabled={disabled}
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex h-6 items-center gap-1 rounded-full px-2 text-xs font-medium text-compass-700 hover:bg-compass-50 disabled:opacity-60 print:hidden"
      >
        <Plus className="h-3 w-3" aria-hidden />
        {label}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} triggerRef={btn} label="Add people" align={align} width="w-[min(20rem,calc(100vw-2rem))]" padding="p-0">
        {panel}
      </Popover>
    </span>
  );
}
