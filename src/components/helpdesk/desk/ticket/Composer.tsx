"use client";

// The ticket's composer: Reply (public, emailed to the requester) or
// Internal note (agents only), Markdown text, a macro picker ("/" at the
// start of an empty box), an article picker ("[[" anywhere, or the
// Article button; the suggestions from your documents first), attachments,
// and a split Send whose menu sends and sets the status in one step
// (Waiting on requester, On hold, Solved). Ctrl/⌘+Enter sends. An unsent
// draft is kept per ticket in this browser, so switching tickets loses
// nothing.

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { replyLabel } from "@/lib/helpdesk/ccs-shared";
import { BookOpen, ChevronDown, Lock, Paperclip, Reply, X, Zap } from "lucide-react";
import { buttonClass, iconButtonClass } from "@/components/Button";
import { Popover, MenuItem } from "@/components/Popover";
import { Segmented } from "@/components/Segmented";
import { Spinner } from "@/components/Spinner";
import { controlClass } from "@/components/form";
import { toast } from "@/components/Toasts";
import type { HdAttachment, HdMacro, HdStatus, HdSuggestedArticle } from "@/lib/helpdesk/types";
import { itemOf, sendJson } from "../api";
import { bytesLabel, firstName } from "../ui";
import { MacroPicker, fillMacro } from "./MacroPicker";
import { ArticlePicker } from "./ArticlePicker";
import type { HdNewerMessage } from "@/lib/helpdesk/presence-shared";
import { CollisionError, clearTyping, noteTyping, postGuarded } from "../presence/presence";
import { CollisionDialog } from "../presence/CollisionDialog";
import { useDeskMe } from "../me";
import { askTimeOnSolve } from "../time/TimeCard";

export type ComposerMode = "public" | "internal";

export interface ComposerHandle {
  focus: (mode?: ComposerMode) => void;
  /** Write a Markdown link to a document at the caret (the side column's Insert). */
  insertLink: (title: string, url: string) => void;
  /** Put this text in the public reply box, after anything already written there ("Use as reply" on a Claude draft, 1.19.1). */
  fill: (text: string) => void;
}

const THEN: { status: HdStatus; label: string }[] = [
  { status: "pending", label: "Send and set Waiting on requester" },
  { status: "on_hold", label: "Send and set On hold" },
  { status: "solved", label: "Send and set Solved" },
];

const MAX_FILES = 10;
const MAX_BYTES = 20 * 1024 * 1024;

function draftKey(n: number, mode: ComposerMode) {
  return `compass-desk-draft:${n}:${mode}`;
}
function readDraft(n: number, mode: ComposerMode): string {
  try {
    return localStorage.getItem(draftKey(n, mode)) ?? "";
  } catch {
    return "";
  }
}
function writeDraft(n: number, mode: ComposerMode, text: string) {
  try {
    if (text) localStorage.setItem(draftKey(n, mode), text);
    else localStorage.removeItem(draftKey(n, mode));
  } catch {
    /* private mode: no draft */
  }
}

export const Composer = forwardRef<
  ComposerHandle,
  {
    number: number;
    subject: string;
    requesterName: string;
    agentName: string;
    suggestions: HdSuggestedArticle[];
    /** Called after a message is sent; `macro` carries field changes to apply. */
    onSent: (opts: { macro: HdMacro | null; status: HdStatus | null }) => void;
    disabled?: boolean;
    /** A newbie's public replies wait for a lead's review before the requester sees them. */
    forReview?: boolean;
    /** The desk role may add internal notes (tickets.internal_note). */
    allowNotes?: boolean;
    /** Where the composer starts: an automated ticket (no human requester) opens on the internal note. */
    defaultMode?: ComposerMode;
    /** Opened by an integration: the public tab reads "Reply", not "Reply to Monitoring". */
    automated?: boolean;
    /** The newest message the pane shows: the send guard's starting point (1.19.1 collision warnings). */
    latestMessageId?: number;
    /** Someone replied while you were typing: reload the conversation (1.19.1). */
    onNewer?: () => void;
    /** People copied on the ticket: the public tab reads "Reply to Daniel + 2 CC" (1.19.1, agent V3). */
    ccCount?: number;
  }
>(function Composer({ number, subject, requesterName, agentName, suggestions, onSent, disabled, forReview = false, allowNotes = true, defaultMode = "public", automated = false, latestMessageId, onNewer, ccCount = 0 }, ref) {
  const me = useDeskMe();
  const [mode, setMode] = useState<ComposerMode>(defaultMode);
  useEffect(() => setMode(allowNotes ? defaultMode : "public"), [number, defaultMode, allowNotes]);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<HdAttachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [macro, setMacro] = useState<HdMacro | null>(null);
  const [macroOpen, setMacroOpen] = useState(false);
  const [articleOpen, setArticleOpen] = useState(false);
  const [thenOpen, setThenOpen] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const macroBtn = useRef<HTMLButtonElement>(null);
  const articleBtn = useRef<HTMLButtonElement>(null);
  const thenBtn = useRef<HTMLButtonElement>(null);
  /** Text handed over by fill() across a switch to the public box (1.19.1). */
  const filled = useRef<string | null>(null);
  // 1.19.1 send guard (lib/helpdesk/presence): the newest message id when
  // this text was started; Send asks the server whether anyone else has
  // written since. A collision opens the dialog instead of sending.
  const baseline = useRef<number | null>(null);
  const [collision, setCollision] = useState<{ newer: HdNewerMessage[]; then: HdStatus | null } | null>(null);
  useEffect(() => {
    baseline.current = null;
  }, [number, mode]);
  useEffect(() => {
    if (!text.trim()) {
      baseline.current = null;
      clearTyping(number);
    } else if (baseline.current === null) baseline.current = latestMessageId ?? 0;
  }, [text, number, latestMessageId]);

  // A new ticket (or a mode switch) loads its own draft.
  useEffect(() => {
    setText(filled.current ?? readDraft(number, mode));
    filled.current = null;
    setFiles([]);
    setMacro(null);
    setUploadError("");
  }, [number, mode]);

  useImperativeHandle(ref, () => ({
    focus(next) {
      if (next && next !== mode && (next === "public" || allowNotes)) setMode(next);
      requestAnimationFrame(() => area.current?.focus());
    },
    insertLink(title, url) {
      insertAtCursor(`[${title}](${absolute(url)})`);
    },
    fill(draft) {
      // What the agent already wrote in the reply box stays, above the draft.
      const had = (mode === "public" ? text : readDraft(number, "public")).trim();
      const next = had ? `${had}\n\n${draft}` : draft;
      writeDraft(number, "public", next);
      if (mode === "public") setText(next);
      else {
        filled.current = next;
        setMode("public");
      }
      requestAnimationFrame(() => area.current?.focus());
    },
  }));

  function change(v: string) {
    setText(v);
    writeDraft(number, mode, v);
    if (v.trim()) noteTyping(number); // "is replying" for the others (1.19.1)
  }

  function insertAtCursor(snippet: string) {
    const el = area.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + snippet + text.slice(end);
    change(next);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = start + snippet.length;
      el.setSelectionRange(pos, pos);
    });
  }

  function onInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value;
    // "/" typed into an empty box opens the macros instead of writing it.
    if (text === "" && v === "/") {
      setMacroOpen(true);
      return;
    }
    // "[[" opens the article picker; the brackets are not kept.
    const caret = e.target.selectionStart ?? v.length;
    if (v.slice(caret - 2, caret) === "[[" && v.length > text.length) {
      change(v.slice(0, caret - 2) + v.slice(caret));
      setArticleOpen(true);
      return;
    }
    change(v);
  }

  async function upload(list: FileList | null) {
    if (!list || list.length === 0) return;
    setUploadError("");
    const picked = Array.from(list).slice(0, MAX_FILES - files.length);
    for (const f of picked) {
      if (f.size > MAX_BYTES) {
        setUploadError(`${f.name} is larger than 20 MB, the limit for one file.`);
        continue;
      }
      setUploading((u) => u + 1);
      try {
        const body = new FormData();
        body.append("file", f);
        const res = await fetch("/api/helpdesk/attachments", { method: "POST", body });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const server = (data as { error?: string }).error;
          if (res.status === 413) throw new Error(server || `${f.name} is too large to attach.`);
          if (res.status === 415) throw new Error(server || `${f.name} is a kind of file that can't be attached.`);
          throw new Error(server || `Couldn't attach ${f.name}.`);
        }
        setFiles((prev) => [...prev, itemOf<HdAttachment>(data, "attachment")]);
      } catch (err) {
        setUploadError((err as Error).message);
      } finally {
        setUploading((u) => u - 1);
      }
    }
    if (fileInput.current) fileInput.current.value = "";
  }

  async function send(then: HdStatus | null, force = false) {
    setThenOpen(false);
    if (!text.trim() || busy || uploading) {
      if (!text.trim()) area.current?.focus();
      return;
    }
    const status = then ?? (mode === "public" && macro?.actions.status ? macro.actions.status : null);
    // A team that records time asks for it before a solve, as Solve and `e`
    // do (1.19.1, agent V8's askTimeOnSolve); cancelling sends nothing. A
    // forced resend after a collision warning was already asked.
    if (status === "solved" && !force && !(await askTimeOnSolve(number, me.id))) return;
    setBusy(true);
    try {
      // The send guard (1.19.1): postGuarded throws CollisionError on a 409 { newer }.
      await postGuarded(
        `/api/helpdesk/tickets/${number}/messages`,
        {
          kind: mode,
          body: text.trim(),
          attachments: files.map((f) => f.id),
          then_status: status ?? undefined,
          ...(latestMessageId !== undefined ? { expect_last_message_id: baseline.current ?? latestMessageId } : {}),
          ...(force ? { force: true } : {}),
        },
        mode === "public" ? "Couldn't send the reply." : "Couldn't add the note."
      );
      clearTyping(number);
      toast("ok", mode === "public" ? (forReview ? "Sent for review. A lead checks it before it goes out." : "Reply sent.") : "Note added.");
      writeDraft(number, mode, "");
      setText("");
      setFiles([]);
      const used = macro;
      setMacro(null);
      onSent({ macro: used, status });
    } catch (err) {
      if (err instanceof CollisionError) {
        setCollision({ newer: err.newer, then });
        onNewer?.();
      } else toast("error", (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const internal = mode === "internal";
  const sendLabel = internal ? "Add note" : forReview ? "Send for review" : "Send";

  return (
    <section
      aria-label="Reply"
      className={`rounded-xl border shadow-xs ${
        internal ? "border-amber-200 bg-amber-50/60 dark:border-amber-500/30 dark:bg-amber-500/5" : "border-slate-200 bg-surface"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2">
        <Segmented
          size="sm"
          label="Message type"
          value={mode}
          onChange={setMode}
          options={[
            { value: "public", label: replyLabel(requesterName && !automated ? firstName(requesterName) : "", ccCount), icon: Reply },
            ...(allowNotes ? [{ value: "internal" as const, label: "Internal note", icon: Lock }] : []),
          ]}
        />
        {internal && <span className="text-xs text-slate-500">Only agents see notes.</span>}
        {!internal && forReview && <span className="text-xs text-slate-500">A lead reviews your reply before it goes out.</span>}
      </div>
      <textarea
        ref={area}
        value={text}
        onChange={onInput}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send(null);
          }
        }}
        disabled={disabled}
        aria-label={internal ? "Internal note" : "Reply"}
        placeholder={internal ? "Write a note for the team… / for a macro, [[ for an article" : "Write a reply… / for a macro, [[ for an article"}
        rows={4}
        maxLength={20000}
        className={controlClass(false, "block min-h-24 w-full resize-y rounded-none border-0 bg-transparent px-3 py-3 text-sm shadow-none")}
      />
      {macro && (
        <p className="px-3 pb-1 text-xs text-slate-500">
          Macro: <span className="font-medium text-slate-700">{macro.title}</span>
          {macroChanges(macro) && <> · on send it also {macroChanges(macro)}</>}{" "}
          <button type="button" className="link" onClick={() => setMacro(null)}>
            Don&apos;t apply
          </button>
        </p>
      )}
      {(files.length > 0 || uploading > 0) && (
        <ul className="flex flex-wrap gap-2 px-3 pb-2" aria-label="Attachments">
          {files.map((f) => (
            <li key={f.id} className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-surface py-0.5 pl-2 pr-0.5 text-xs text-slate-600">
              <Paperclip className="h-3.5 w-3.5 text-slate-400" aria-hidden />
              <span className="max-w-48 truncate">{f.name}</span>
              <span className="text-slate-500">· {bytesLabel(f.size)}</span>
              <button
                type="button"
                onClick={() => setFiles((prev) => prev.filter((x) => x.id !== f.id))}
                aria-label={`Remove ${f.name}`}
                data-tt="Remove"
                className={iconButtonClass("quiet", "sm")}
              >
                <X aria-hidden />
              </button>
            </li>
          ))}
          {uploading > 0 && (
            <li className="inline-flex items-center gap-1.5 text-xs text-slate-500">
              <Spinner size="sm" /> Uploading…
            </li>
          )}
        </ul>
      )}
      {uploadError && (
        <p role="alert" className="px-3 pb-2 text-xs text-red-600">
          {uploadError}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-3 py-2">
        <div className="relative">
          <button
            ref={macroBtn}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={macroOpen}
            onClick={() => setMacroOpen((o) => !o)}
            className={buttonClass("secondary", "sm")}
          >
            <Zap className="h-3.5 w-3.5" aria-hidden />
            Macro
          </button>
          <MacroPicker
            open={macroOpen}
            onClose={() => setMacroOpen(false)}
            triggerRef={macroBtn}
            onPick={async (m) => {
              setMacroOpen(false);
              setMacro(m);
              // The server fills every placeholder for this ticket; the
              // client fill is the fallback if the preview is refused.
              let body = fillMacro(m.body, { requesterName, agentName, number, subject });
              try {
                const d = await sendJson<{ body?: string }>(`/api/helpdesk/tickets/${number}/macro/${m.id}`, "POST", { preview: true });
                if (typeof d.body === "string") body = d.body;
              } catch {
                /* keep the client-side fill */
              }
              insertAtCursor(body);
            }}
          />
        </div>
        <div className="relative">
          <button
            ref={articleBtn}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={articleOpen}
            onClick={() => setArticleOpen((o) => !o)}
            className={buttonClass("secondary", "sm")}
          >
            <BookOpen className="h-3.5 w-3.5" aria-hidden />
            Article
          </button>
          <ArticlePicker
            open={articleOpen}
            onClose={() => setArticleOpen(false)}
            triggerRef={articleBtn}
            suggestions={suggestions}
            onPick={(a) => {
              setArticleOpen(false);
              insertAtCursor(`[${a.title}](${absolute(a.url)})`);
            }}
          />
        </div>
        <input ref={fileInput} type="file" multiple className="sr-only" tabIndex={-1} onChange={(e) => upload(e.target.files)} aria-hidden />
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={files.length >= MAX_FILES}
          aria-label="Attach files"
          data-tt="Attach files"
          className={iconButtonClass("bordered", "sm")}
        >
          <Paperclip aria-hidden />
        </button>
        <div className="relative ml-auto inline-flex">
          <button
            type="button"
            onClick={() => send(null)}
            disabled={busy || uploading > 0 || disabled}
            aria-busy={busy || undefined}
            className={buttonClass("primary", "sm", "rounded-r-none")}
          >
            {busy && <Spinner size="sm" />}
            {sendLabel}
          </button>
          <button
            ref={thenBtn}
            type="button"
            onClick={() => setThenOpen((o) => !o)}
            disabled={busy || uploading > 0 || disabled}
            aria-haspopup="menu"
            aria-expanded={thenOpen}
            aria-label={`${sendLabel} and set the status`}
            data-tt="Send and set the status"
            className={buttonClass("primary", "sm", "rounded-l-none border-l border-white/30 px-1.5")}
          >
            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          </button>
          <Popover open={thenOpen} onClose={() => setThenOpen(false)} triggerRef={thenBtn} role="menu" label="Send and set the status" align="end" side="top" width="w-72">
            {THEN.map((t) => (
              <MenuItem key={t.status} onClick={() => send(t.status)}>
                {internal ? t.label.replace("Send", "Add note") : t.label}
              </MenuItem>
            ))}
          </Popover>
        </div>
      </div>
      {/* 1.19.1 collision warning (mock-up 5): nothing was sent. */}
      <CollisionDialog
        open={collision !== null}
        newer={collision?.newer ?? []}
        mode={mode}
        requesterName={automated ? "" : requesterName}
        busy={busy}
        onKeep={() => {
          // These messages have been seen now: Send warns only about newer ones.
          baseline.current = Math.max(baseline.current ?? 0, ...(collision?.newer ?? []).map((m) => m.id));
          setCollision(null);
          requestAnimationFrame(() => area.current?.focus());
        }}
        onDiscard={() => {
          setCollision(null);
          change("");
          setFiles([]);
          setMacro(null);
          clearTyping(number);
        }}
        onSendAnyway={() => {
          const then = collision?.then ?? null;
          setCollision(null);
          void send(then, true);
        }}
      />
    </section>
  );
});

function absolute(url: string): string {
  if (/^https?:\/\//i.test(url) || typeof window === "undefined") return url;
  return `${window.location.origin}${url.startsWith("/") ? "" : "/"}${url}`;
}

function macroChanges(m: HdMacro): string {
  const parts: string[] = [];
  if (m.actions.status) parts.push("sets the status");
  if (m.actions.priority) parts.push("sets the priority");
  if (m.actions.team_id) parts.push("moves the team");
  if (m.actions.tags_add?.length) parts.push(`adds ${m.actions.tags_add.join(", ")}`);
  return parts.join(", ");
}
