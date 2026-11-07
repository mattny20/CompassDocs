"use client";

// The Claude panel (1.20.0, mock c1): docked at the right of the desk
// (full screen under 640px). The agent's chat with Claude on the open
// ticket: their questions, Claude's streamed answer with a tool activity
// line and source chips, draft cards (put straight into the reply box) and
// Apply / Skip cards for proposed changes. Apply goes through the ticket's
// own patch, so the desk's rules all apply; nothing is ever sent from here.
// History per ticket (the history menu: earlier chats, New chat). Screen
// readers hear the answer once it is complete (role="log", aria-busy while
// streaming); focus starts in the question box and returns to the opener.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  BookOpen,
  CircleCheck,
  CircleStop,
  Globe,
  History,
  ListChecks,
  MessageSquareText,
  Minimize2,
  Package,
  Pencil,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkle,
  Ticket,
  TriangleAlert,
  X,
} from "lucide-react";
import { buttonClass, iconButtonClass } from "@/components/Button";
import { chipClass } from "@/components/Chip";
import { MarkdownView } from "@/components/MarkdownView";
import { Popover } from "@/components/Popover";
import { toast } from "@/components/Toasts";
import { overlayOpen } from "@/lib/overlay-stack";
import {
  CLAUDE_FOOTER_NOTE,
  CLAUDE_INPUT_PLACEHOLDER,
  CLAUDE_INPUT_PLACEHOLDER_NO_TICKET,
  type ClaudeCard,
  type ClaudeChatHistory,
  type ClaudeChatTurn,
  type ClaudeIntent,
  type ClaudeSource,
} from "@/lib/helpdesk/claude/shared";
import { getJson, sendJson } from "../api";
import { useClaudeDesk } from "./ClaudeDesk";
import { askClaude } from "./stream";

const ACTIVITY_ICON: Record<string, React.ReactNode> = {
  search: <Search className="h-3 w-3" aria-hidden />,
  book: <BookOpen className="h-3 w-3" aria-hidden />,
  package: <Package className="h-3 w-3" aria-hidden />,
  ticket: <Ticket className="h-3 w-3" aria-hidden />,
  list: <ListChecks className="h-3 w-3" aria-hidden />,
  globe: <Globe className="h-3 w-3" aria-hidden />,
  message: <MessageSquareText className="h-3 w-3" aria-hidden />,
};

const SOURCE_ICON: Record<ClaudeSource["kind"], React.ReactNode> = {
  ticket: <Ticket className="h-3 w-3" aria-hidden />,
  article: <BookOpen className="h-3 w-3" aria-hidden />,
  web: <Globe className="h-3 w-3" aria-hidden />,
};

/** The pill a source or a context item is shown in (STYLEGUIDE §Helpdesk: Claude in the desk). */
const PILL = "inline-flex max-w-full items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700";

interface LiveTurn extends ClaudeChatTurn {
  live?: boolean;
}

export function ClaudePanel() {
  const ctx = useClaudeDesk()!;
  const ticket = ctx.ticket;
  const number = ticket?.number ?? null;
  const [turns, setTurns] = useState<LiveTurn[]>([]);
  const [chatId, setChatId] = useState<number | null>(null);
  const [chats, setChats] = useState<ClaudeChatHistory["chats"]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyBtn = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);
  const fresh = useRef(false);
  const filled = useRef(new Set<number>());
  /** The last Claude draft put in each box ("1047:public"), so a refined draft replaces it instead of stacking. */
  const lastFill = useRef(new Map<string, string>());
  /** "May quote internal notes": the agent's explicit say-so, for the next question only. */
  const [quoteNotes, setQuoteNotes] = useState(false);

  /** Bumped by every load and every question: only the newest load applies, and never over a question asked since. */
  const loadSeq = useRef(0);
  const load = useCallback(
    async (chat?: number | null) => {
      const seq = ++loadSeq.current;
      setLoading(true);
      try {
        const q = new URLSearchParams();
        if (number) q.set("ticket", String(number));
        if (chat) q.set("chat", String(chat));
        const h = await getJson<ClaudeChatHistory>(`/api/helpdesk/claude/chat?${q}`, "Couldn't load your chat.");
        if (seq !== loadSeq.current) return;
        setTurns(h.turns);
        setChatId(h.chat_id);
        setChats(h.chats);
      } catch (e) {
        if (seq !== loadSeq.current) return;
        setTurns([]);
        toast("error", (e as Error).message);
      } finally {
        if (seq === loadSeq.current) setLoading(false);
      }
    },
    [number]
  );

  // A different ticket: its own chat. A running answer for the previous one stops.
  useEffect(() => {
    abort.current?.abort();
    fresh.current = false;
    void load();
  }, [load]);

  useEffect(() => {
    requestAnimationFrame(() => input.current?.focus());
  }, []);

  // Keep the newest words in view while they stream.
  useEffect(() => {
    const el = body.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  // Escape closes the panel when focus is in it and no overlay is open.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || overlayOpen()) return;
      const panel = document.getElementById("claude-desk-panel");
      if (!panel?.contains(document.activeElement)) return;
      e.preventDefault();
      ctx.closePanel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ctx]);

  const patchLive = (fn: (t: LiveTurn) => LiveTurn) => setTurns((all) => all.map((t) => (t.live ? fn(t) : t)));

  /** Put a draft in its box. On arrival (`auto`), never one that cites another ticket: that waits for a click. */
  const putDraft = useCallback(
    (card: ClaudeCard, auto: boolean) => {
      if (card.kind !== "reply" && card.kind !== "note") return false;
      if (!ticket || ticket.number !== card.number) return false;
      if (auto && card.cites_other) return false;
      const mode = card.kind === "reply" ? "public" : "internal";
      const key = `${card.number}:${mode}`;
      ticket.fill(card.body, mode, lastFill.current.get(key) ?? null);
      lastFill.current.set(key, card.body);
      filled.current.add(card.id);
      void sendJson(`/api/helpdesk/claude/cards/${card.id}`, "POST", { state: "applied" }).catch(() => {});
      return true;
    },
    [ticket]
  );

  const send = useCallback(
    async (q: string, intent: ClaudeIntent | null) => {
      const question = q.trim();
      if (!question || streaming) return;
      // A history load still on its way must not replace this question and its answer.
      loadSeq.current++;
      setLoading(false);
      setText("");
      const includeNotes = quoteNotes;
      setQuoteNotes(false);
      const now = new Date().toISOString();
      setTurns((all) => [
        ...all,
        { id: -Date.now(), role: "user", text: question, activity: [], sources: [], cards: [], at: now },
        { id: -Date.now() - 1, role: "assistant", text: "", activity: [], sources: [], cards: [], at: now, live: true },
      ]);
      setStreaming(true);
      setStatus("Claude is answering.");
      const ac = new AbortController();
      abort.current = ac;
      try {
        await askClaude(
          { ticket: number, text: question, intent, chat_id: fresh.current ? null : chatId, new_chat: fresh.current, include_notes: includeNotes },
          (e) => {
            switch (e.type) {
              case "start":
                fresh.current = false;
                setChatId(e.chat_id);
                break;
              case "text":
                patchLive((t) => ({ ...t, text: t.text + e.delta }));
                break;
              case "rewind":
                // A step is being re-run: the words it had streamed go.
                patchLive((t) => ({ ...t, text: t.text.slice(0, e.keep) }));
                break;
              case "activity":
                patchLive((t) => ({ ...t, activity: [...t.activity, { label: e.label, icon: e.icon }] }));
                break;
              case "card": {
                const card = e.card;
                const put = putDraft(card, true);
                patchLive((t) => ({ ...t, cards: [...t.cards, put ? { ...card, state: "applied" } : card] }));
                break;
              }
              case "sources":
                patchLive((t) => ({ ...t, sources: e.sources }));
                break;
              case "notice":
                patchLive((t) => ({ ...t, notice: { tone: e.tone, message: e.message } }));
                break;
              case "refusal":
                patchLive((t) => ({ ...t, text: "", notice: { tone: "warn", message: e.message } }));
                break;
              case "done":
                break;
            }
          },
          ac.signal
        );
        setStatus("Claude answered.");
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          patchLive((t) => ({ ...t, notice: t.notice ?? { tone: "warn", message: "Stopped." } }));
          setStatus("Stopped.");
        } else {
          patchLive((t) => ({ ...t, notice: { tone: "error", message: (e as Error).message } }));
          setStatus((e as Error).message);
        }
      } finally {
        setTurns((all) => all.map((t) => (t.live ? { ...t, live: false } : t)));
        setStreaming(false);
        abort.current = null;
        void getJson<ClaudeChatHistory>(`/api/helpdesk/claude/chat?${new URLSearchParams(number ? { ticket: String(number) } : {})}`)
          .then((h) => setChats(h.chats))
          .catch(() => {});
        requestAnimationFrame(() => input.current?.focus());
      }
    },
    [number, chatId, streaming, putDraft, quoteNotes]
  );

  // A question from the launcher (c2).
  useEffect(() => {
    if (!ctx.pending || loading || streaming) return;
    const p = ctx.pending;
    ctx.takePending();
    void send(p.text, p.intent);
  }, [ctx, loading, streaming, send]);

  async function decide(card: ClaudeCard, how: "applied" | "skipped") {
    try {
      if (how === "applied") {
        if (card.kind === "change") {
          // Solving goes through the desk's solve flow (time, maintenance, required items), which runs in the open ticket.
          const solves = card.patch.status === "solved" || card.patch.status === "closed";
          if (solves && ticket?.number !== card.number) {
            toast("error", `Open #${card.number} to solve it there.`);
            return;
          }
          const ok =
            ticket && ticket.number === card.number
              ? await ticket.apply({ ...card.patch, via: "claude_desk" })
              : await sendJson(`/api/helpdesk/tickets/${card.number}`, "PATCH", { ...card.patch, via: "claude_desk" }, "Couldn't apply the change.").then(
                  () => true,
                  (e: Error) => {
                    toast("error", e.message);
                    return false;
                  }
                );
          if (!ok) return;
        } else if (card.kind === "checklist") {
          await sendJson(`/api/helpdesk/tickets/${card.number}/checklists`, "POST", { template_id: card.template_id, via: "claude_desk" }, "Couldn't add the checklist.");
          if (ticket?.number === card.number) ticket.reload();
        } else if (!putDraft(card, false)) {
          toast("error", `Open #${card.number} to use this draft.`);
          return;
        }
      }
      if (card.kind === "change" || card.kind === "checklist") {
        await sendJson(`/api/helpdesk/claude/cards/${card.id}`, "POST", { state: how }).catch(() => {});
      }
      // The card's buttons give way to its state: focus stays in the panel, on the question box.
      // It moves before the buttons go (React may remove them after the next frame), and only
      // when it is still in the panel or lost, never away from where the agent has since gone.
      const active = document.activeElement;
      const inPanel = !active || active === document.body || !!document.getElementById("claude-desk-panel")?.contains(active);
      if (inPanel) input.current?.focus();
      setTurns((all) => all.map((t) => ({ ...t, cards: t.cards.map((c) => (c.id === card.id ? { ...c, state: how } : c)) })));
      if (how === "applied" && card.kind === "change") toast("ok", `${card.title}. Done.`);
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  function newChat() {
    setHistoryOpen(false);
    abort.current?.abort();
    fresh.current = true;
    loadSeq.current++;
    setLoading(false);
    setTurns([]);
    setChatId(null);
    requestAnimationFrame(() => input.current?.focus());
  }

  const contextChips: { icon: React.ReactNode; label: string }[] = [];
  if (ctx.props.caps.read && number) contextChips.push({ icon: SOURCE_ICON.ticket, label: `#${number} and its notes` });
  if (ctx.props.caps.read) contextChips.push({ icon: SOURCE_ICON.article, label: "Your articles" });
  if (ctx.props.webLabel) contextChips.push({ icon: SOURCE_ICON.web, label: ctx.props.webLabel });

  return (
    <aside
      id="claude-desk-panel"
      aria-labelledby="claude-desk-title"
      className="fixed inset-0 z-40 flex flex-col overflow-hidden bg-surface shadow-modal sm:inset-auto sm:right-4 sm:top-15 sm:bottom-4 sm:w-[min(430px,calc(100vw-2rem))] sm:rounded-2xl sm:border sm:border-slate-200 print:hidden"
    >
      <div className="flex items-center gap-2 border-b border-slate-100 px-3.5 py-3">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-slate-900 text-slate-50" aria-hidden>
          <Sparkle className="h-3.5 w-3.5" />
        </span>
        <h2 id="claude-desk-title" className="text-base font-bold text-slate-900">
          Claude
        </h2>
        {number && <span className={chipClass("neutral", "sm")}>On #{number}</span>}
        <span className="ml-auto flex items-center gap-0.5">
          <span className="relative">
            <button
              ref={historyBtn}
              type="button"
              onClick={() => setHistoryOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={historyOpen}
              aria-label="Chat history"
              data-tt="Chat history"
              data-tt-pos="bottom"
              className={iconButtonClass("quiet", "sm")}
            >
              <History aria-hidden />
            </button>
            <Popover open={historyOpen} onClose={() => setHistoryOpen(false)} triggerRef={historyBtn} role="menu" label="Chat history" align="end" width="w-72" className="mt-1">
              <button type="button" role="menuitem" onClick={newChat} className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-slate-800 hover:bg-slate-100">
                <Plus className="h-4 w-4 text-slate-500" aria-hidden /> New chat
              </button>
              {chats.length > 0 && <div className="my-1 border-t border-slate-100" role="separator" />}
              {chats.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={c.id === chatId}
                  onClick={() => {
                    setHistoryOpen(false);
                    fresh.current = false;
                    void load(c.id);
                  }}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-slate-800 hover:bg-slate-100"
                >
                  <MessageSquareText className="h-4 w-4 shrink-0 text-slate-500" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{c.title || "Chat"}</span>
                </button>
              ))}
            </Popover>
          </span>
          <button type="button" onClick={ctx.closePanel} aria-label="Minimise Claude" data-tt="Minimise" data-tt-pos="bottom" className={iconButtonClass("quiet", "sm")}>
            <Minimize2 aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => {
              abort.current?.abort();
              ctx.closePanel();
            }}
            aria-label="Close Claude"
            data-tt="Close"
            data-tt-pos="bottom"
            className={iconButtonClass("quiet", "sm")}
          >
            <X aria-hidden />
          </button>
        </span>
      </div>

      <div ref={body} className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        <p className="sr-only" role="status" aria-live="polite">
          {status}
        </p>
        <div role="log" aria-label="Chat with Claude" aria-busy={streaming} className="flex flex-col gap-2.5 text-sm text-slate-800">
          {!loading && turns.length === 0 && (
            <div className="py-6 text-center">
              <Sparkle className="mx-auto h-6 w-6 text-slate-400" aria-hidden />
              <p className="mt-2 font-semibold text-slate-800">{number ? `Ask Claude about #${number}` : "Ask Claude"}</p>
              <p className="mx-auto mt-1 max-w-xs text-sm text-slate-500">
                {number ? "It reads the ticket and its notes, finds what fixed it before, and drafts replies for you to send." : "Ask about your tickets, or how something is done in your articles."}
              </p>
            </div>
          )}
          {turns.map((t) =>
            t.role === "user" ? (
              <div key={t.id} className="max-w-[85%] self-end whitespace-pre-wrap break-words rounded-[12px_12px_4px_12px] bg-compass-600 px-3 py-2 text-white">
                {t.text}
              </div>
            ) : (
              <AssistantTurn key={t.id} t={t} onDecide={decide} filled={filled.current} />
            )
          )}
        </div>
      </div>

      <div className="border-t border-slate-100 px-3 py-2.5">
        {contextChips.length > 0 && (
          <ul aria-label="What Claude can use" className="mb-2 flex flex-wrap gap-1.5">
            {contextChips.map((c) => (
              <li key={c.label} className={PILL}>
                {c.icon}
                <span className="truncate">{c.label}</span>
              </li>
            ))}
          </ul>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send(text, null);
          }}
          className="flex items-end gap-2 rounded-lg border border-slate-300 bg-surface px-2.5 py-1.5 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-compass-600 dark:has-[:focus-visible]:outline-compass-300"
        >
          <label htmlFor="claude-desk-input" className="sr-only">
            Ask Claude
          </label>
          <textarea
            id="claude-desk-input"
            ref={input}
            rows={1}
            value={text}
            maxLength={4000}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(text, null);
              }
            }}
            placeholder={number ? CLAUDE_INPUT_PLACEHOLDER : CLAUDE_INPUT_PLACEHOLDER_NO_TICKET}
            className="frame-input max-h-36 min-h-7 flex-1 resize-none bg-transparent py-1 text-sm text-slate-900 placeholder:text-slate-400 [field-sizing:content]"
          />
          {streaming ? (
            <button type="button" onClick={() => abort.current?.abort()} aria-label="Stop" data-tt="Stop" className={iconButtonClass("quiet", "sm")}>
              <CircleStop aria-hidden />
            </button>
          ) : (
            <button type="submit" disabled={!text.trim()} aria-label="Send" data-tt="Send" className={`${iconButtonClass("quiet", "sm")} text-compass-600 disabled:text-slate-400`}>
              <ArrowUp aria-hidden />
            </button>
          )}
        </form>
        {number && ctx.props.caps.drafts && (
          <label className="mt-1.5 flex items-center gap-1.5 text-xs text-slate-600">
            <input type="checkbox" className="h-3.5 w-3.5" checked={quoteNotes} onChange={(e) => setQuoteNotes(e.target.checked)} />
            May quote internal notes in a reply (this question only)
          </label>
        )}
        <p className="mt-1.5 text-xs text-slate-500">{CLAUDE_FOOTER_NOTE}</p>
      </div>
    </aside>
  );
}

function AssistantTurn({ t, onDecide, filled }: { t: LiveTurn; onDecide: (c: ClaudeCard, how: "applied" | "skipped") => void; filled: Set<number> }) {
  const thinking = t.live && !t.text && !t.notice;
  return (
    <div className="flex flex-col gap-1.5">
      {t.activity.length > 0 && (
        <ul aria-label="What Claude looked at" className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
          {t.activity.map((a) => (
            <li key={a.label} className="inline-flex items-center gap-1">
              {ACTIVITY_ICON[a.icon] ?? ACTIVITY_ICON.search}
              {a.label}
            </li>
          ))}
        </ul>
      )}
      {thinking && (
        <p className="inline-flex items-center gap-1.5 text-xs text-slate-500">
          <Sparkle className="h-3 w-3 animate-pulse motion-reduce:animate-none" aria-hidden /> Thinking…
        </p>
      )}
      {t.text && (
        <div className="leading-relaxed [&_.prose]:text-sm">
          <MarkdownView content={t.text} headingOffset={2} />
        </div>
      )}
      {t.sources.length > 0 && (
        <ul aria-label="Sources" className="flex flex-wrap gap-1">
          {t.sources.map((s) => (
            <li key={s.href}>
              <Link
                href={s.href}
                {...(s.kind === "web" ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                className={`${PILL} hover:bg-slate-200 hover:text-slate-900`}
              >
                {SOURCE_ICON[s.kind]}
                <span className="truncate">{s.label}</span>
                {s.kind === "web" && <span className="sr-only"> (opens in a new tab)</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {t.cards.map((c) => (
        <CardView key={c.id} card={c} onDecide={onDecide} inBox={filled.has(c.id) || c.state === "applied"} />
      ))}
      {t.notice && (
        <p role={t.notice.tone === "error" ? "alert" : undefined} className={`flex items-start gap-1.5 text-xs ${t.notice.tone === "error" ? "text-red-600" : "ink-warn"}`}>
          <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          {t.notice.message}
        </p>
      )}
    </div>
  );
}

function CardView({ card, onDecide, inBox }: { card: ClaudeCard; onDecide: (c: ClaudeCard, how: "applied" | "skipped") => void; inBox: boolean }) {
  const shell = "rounded-xl border border-compass-200 bg-compass-50 px-3 py-2.5 dark:border-compass-500/40 dark:bg-compass-500/10";
  if (card.kind === "reply" || card.kind === "note") {
    return (
      <section aria-label={card.title} className={shell}>
        <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
          <Pencil className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{card.title}</span>
          {inBox ? (
            <span className="shrink-0 text-xs font-normal text-slate-500">{card.kind === "reply" ? "in your reply box" : "in your note box"}</span>
          ) : (
            <button type="button" onClick={() => onDecide(card, "applied")} className={buttonClass("secondary", "sm")}>
              {card.kind === "reply" ? "Put in reply box" : "Put in note box"}
            </button>
          )}
        </div>
        <p className="mt-1 line-clamp-3 text-xs text-slate-700">{card.body}</p>
      </section>
    );
  }
  const decided = card.state !== "offered";
  const hint = card.kind === "change" || card.kind === "checklist" ? card.hint : "";
  return (
    <section aria-label={card.title} className={shell}>
      <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
        {card.kind === "checklist" ? <ListChecks className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <SlidersHorizontal className="h-3.5 w-3.5 shrink-0" aria-hidden />}
        <span className="min-w-0 flex-1">{card.title}</span>
      </div>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
      {decided ? (
        <p className="mt-2">
          <span className={chipClass(card.state === "applied" ? "ok" : "neutral", "sm")}>
            {card.state === "applied" && <CircleCheck className="h-3 w-3" aria-hidden />}
            {card.state === "applied" ? "Applied" : "Skipped"}
          </span>
        </p>
      ) : (
        <div className="mt-2 flex gap-2">
          <button type="button" onClick={() => onDecide(card, "applied")} className={buttonClass("primary", "sm")}>
            Apply
          </button>
          <button type="button" onClick={() => onDecide(card, "skipped")} className={buttonClass("secondary", "sm")}>
            Skip
          </button>
        </div>
      )}
    </section>
  );
}
