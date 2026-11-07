"use client";

// Claude in the desk (1.20.0, mocks c1 and c2). The desk shell wraps its
// page in <ClaudeDeskProvider> when Claude is on for this agent; it renders
// the Claude button in the top bar (the launcher with quick prompts, c2),
// binds Ctrl/⌘+J anywhere in the desk, and hosts the docked panel (c1).
// The open ticket registers itself with useClaudeTicket so the panel knows
// which ticket it is on and can put a draft into its reply box or apply a
// proposed change through the ticket's own patch (the desk's PATCH route,
// with the agent's session). STYLEGUIDE §Helpdesk: Claude in the desk.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MessageSquare, Sparkle } from "lucide-react";
import { Popover } from "@/components/Popover";
import { blockModKey, modLabel } from "@/lib/hotkeys";
import { CLAUDE_QUICK_PROMPTS, type ClaudeIntent } from "@/lib/helpdesk/claude/shared";
import { ClaudePanel } from "./ClaudePanel";

export interface ClaudeDeskProps {
  /** What the workspace lets Claude do (for the panel's context chips and cards). */
  caps: { read: boolean; drafts: boolean; changes: boolean; web: boolean };
  /** "Web: support.microsoft.com" / "Web: 3 sites", or null without web search. */
  webLabel: string | null;
}

/** What the open ticket hands the panel. */
export interface ClaudeTicketBridge {
  number: number;
  subject: string;
  /** Put text into the reply box ("public") or the internal note box, replacing `replace` (an earlier draft) if it is still there. */
  fill: (text: string, mode: "public" | "internal", replace?: string | null) => void;
  /** Apply a change through the ticket pane's own patch; true when it went through. */
  apply: (patch: Record<string, unknown>) => Promise<boolean>;
  /** Reload the ticket (after a checklist was added). */
  reload: () => void;
}

interface Ctx {
  props: ClaudeDeskProps;
  ticket: ClaudeTicketBridge | null;
  register: (b: ClaudeTicketBridge | null) => void;
  open: boolean;
  openPanel: (ask?: { text: string; intent: ClaudeIntent | null }) => void;
  closePanel: () => void;
  /** A question waiting for the panel to send (from the launcher). */
  pending: { text: string; intent: ClaudeIntent | null; id: number } | null;
  takePending: () => void;
}

const ClaudeDeskContext = createContext<Ctx | null>(null);

export function useClaudeDesk(): Ctx | null {
  return useContext(ClaudeDeskContext);
}

/** The open ticket's hook: register while mounted (no-op when Claude is off). */
export function useClaudeTicket(bridge: ClaudeTicketBridge | null): void {
  const ctx = useContext(ClaudeDeskContext);
  const register = ctx?.register;
  const ref = useRef(bridge);
  ref.current = bridge;
  const number = bridge?.number ?? null;
  const subject = bridge?.subject ?? "";
  useEffect(() => {
    if (!register || number === null) return;
    // Calls go through the ref so the panel always reaches the pane's latest functions.
    register({
      number,
      subject,
      fill: (t, m, r) => ref.current?.fill(t, m, r),
      apply: (p) => ref.current?.apply(p) ?? Promise.resolve(false),
      reload: () => ref.current?.reload(),
    });
    return () => register(null);
  }, [register, number, subject]);
}

export function ClaudeDeskProvider({ props, children }: { props: ClaudeDeskProps; children: ReactNode }) {
  const [ticket, setTicket] = useState<ClaudeTicketBridge | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<Ctx["pending"]>(null);
  const seq = useRef(0);
  const opener = useRef<HTMLElement | null>(null);

  const openPanel = useCallback((ask?: { text: string; intent: ClaudeIntent | null }) => {
    if (!open && document.activeElement instanceof HTMLElement) opener.current = document.activeElement;
    setOpen(true);
    if (ask) setPending({ ...ask, id: ++seq.current });
  }, [open]);
  const closePanel = useCallback(() => {
    setOpen(false);
    // Focus goes back to whatever opened the panel (the Claude button, the composer).
    const back = opener.current;
    opener.current = null;
    requestAnimationFrame(() => (back && document.contains(back) ? back.focus() : document.getElementById("claude-desk-button")?.focus()));
  }, []);

  // Ctrl/⌘+J anywhere in the desk, typing included (a Mod chord never types).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (blockModKey(e) || e.key.toLowerCase() !== "j") return;
      e.preventDefault();
      if (open) {
        const panel = document.getElementById("claude-desk-panel");
        if (panel && !panel.contains(document.activeElement)) document.getElementById("claude-desk-input")?.focus();
        else closePanel();
      } else openPanel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, openPanel, closePanel]);

  const value = useMemo<Ctx>(
    () => ({ props, ticket, register: setTicket, open, openPanel, closePanel, pending, takePending: () => setPending(null) }),
    [props, ticket, open, openPanel, closePanel, pending]
  );
  return (
    <ClaudeDeskContext.Provider value={value}>
      {children}
      {open && <ClaudePanel />}
    </ClaudeDeskContext.Provider>
  );
}

/** The top bar's Claude button and its launcher (c2). */
export function ClaudeButton() {
  const ctx = useClaudeDesk();
  const [menu, setMenu] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const [mod, setMod] = useState("Ctrl");
  useEffect(() => setMod(modLabel()), []);
  if (!ctx) return null;
  const t = ctx.ticket;
  const ask = (text: string, intent: ClaudeIntent | null) => {
    setMenu(false);
    ctx.openPanel({ text, intent });
  };
  return (
    <div className="relative">
      <button
        id="claude-desk-button"
        ref={btn}
        type="button"
        onClick={() => (ctx.open ? ctx.closePanel() : setMenu((o) => !o))}
        aria-haspopup="menu"
        aria-expanded={menu || ctx.open}
        aria-keyshortcuts="Control+J Meta+J"
        data-tt={`Claude (${mod} J)`}
        data-tt-pos="bottom"
        className="inline-flex h-8.5 items-center gap-1.5 rounded-full bg-slate-900 px-3 text-sm font-semibold text-slate-50 transition hover:bg-slate-800 max-sm:w-8.5 max-sm:justify-center max-sm:px-0"
      >
        <Sparkle className="h-3.5 w-3.5" aria-hidden />
        <span className="max-sm:sr-only">Claude</span>
      </button>
      <Popover open={menu} onClose={() => setMenu(false)} triggerRef={btn} role="menu" label={t ? `Ask Claude about #${t.number}` : "Ask Claude"} align="end" width="w-72" padding="p-2" className="mt-1">
        <p className="px-2 pb-1 pt-0.5 text-sm font-semibold text-slate-900">{t ? `Ask Claude about #${t.number}` : "Ask Claude"}</p>
        {t ? (
          CLAUDE_QUICK_PROMPTS.map((p) => (
            <button
              key={p.text}
              type="button"
              role="menuitem"
              onClick={() => ask(p.text, p.intent)}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-slate-800 hover:bg-slate-100 focus-visible:bg-slate-100"
            >
              <Sparkle className="h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden />
              {p.text}
            </button>
          ))
        ) : (
          <p className="px-2 py-1 text-xs text-slate-500">Open a ticket for the quick prompts, or chat about your tickets and articles.</p>
        )}
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setMenu(false);
            ctx.openPanel();
          }}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-slate-800 hover:bg-slate-100 focus-visible:bg-slate-100"
        >
          <MessageSquare className="h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden />
          Open the chat
        </button>
        <p className="px-2 pt-1 text-xs text-slate-500">
          Or press <kbd className="rounded-sm border border-slate-200 bg-canvas px-1.5 py-0.5 font-sans text-2xs text-slate-500">{mod} J</kbd> anywhere in the desk.
        </p>
      </Popover>
    </div>
  );
}
