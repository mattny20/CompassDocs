"use client";

import { useEffect, useRef, useState } from "react";
import { UnsavedHint } from "@/components/SaveRow";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import { chipClass } from "@/components/Chip";
import { buttonClass } from "@/components/Button";
import { SectionEmpty } from "@/components/form";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronDown, ClipboardCheck, House, ListChecks, ShieldCheck, Sparkles, SquareSplitVertical, Table as TableIcon, X } from "lucide-react";
import { EmptyState, Select, TextInput } from "./form";
import { StatusBadge } from "./Badges";
import { confirmDialog } from "./Dialog";
import { Popover } from "./Popover";
import { EntityPicker } from "./EntityPicker";
import { MarkdownView } from "./MarkdownView";
import { PageWidth } from "./PageWidth";
import { RichTextEditor, RICH_BLOCK_BUTTONS } from "./RichTextEditor";
import { blockModKey } from "@/lib/hotkeys";
import { overlayOpen } from "@/lib/overlay-stack";
import { DOC_TYPES } from "@/lib/types";
import type { DocType, DocStatus, Space } from "@/lib/types";

type EditorTab = "rich" | "markdown" | "preview";

interface ProofChange {
  type: string;
  before: string;
  after: string;
  note: string;
}
interface ProofResult {
  mode: "ai" | "unavailable";
  revised?: string;
  changes?: ProofChange[];
  truncated?: boolean;
  message?: string;
}

// Mirror of the writing-assist types in @/lib/ai (kept local so this client
// component doesn't pull in the server-only AI module).
type WriteAction = "draft" | "improve" | "expand" | "shorten" | "summarize" | "tone";
type WriteTone = "professional" | "friendly" | "concise" | "confident";
interface WriteResult {
  mode: "ai" | "unavailable";
  text?: string;
  truncated?: boolean;
  message?: string;
}

interface Category {
  id: number;
  space_id: number;
  name: string;
}

interface Initial {
  id?: number;
  space_id?: number;
  category_id?: number | null;
  title: string;
  type: DocType;
  status: DocStatus;
  summary: string;
  tags: string[];
  content: string;
  author: string;
  parent_id?: number | null;
  publish_at?: string | null;
  archive_at?: string | null;
  /** Concurrency token: the updated_at this editor session loaded. */
  updated_at?: string;
}

export function DocEditor({
  spaces,
  categories = [],
  initial,
  mode,
  canPublish,
  nestedEnabled = false,
  docLinks = false,
  trainingDeck = false,
}: {
  spaces: Pick<Space, "id" | "name" | "icon">[];
  /** Categories across the offered spaces; filtered by the selected space. */
  categories?: Category[];
  initial: Initial;
  mode: "create" | "edit";
  canPublish: boolean;
  /** Nested pages toggle (admin-gated): shows the parent-page selector. */
  nestedEnabled?: boolean;
  /** Backlinks toggle (admin-gated): [[ link autocomplete in the editor. */
  docLinks?: boolean;
  /** This document is a training deck — preview `---` as slide-break markers. */
  trainingDeck?: boolean;
}) {
  const router = useRouter();
  const [spaceId, setSpaceId] = useState(initial.space_id ?? spaces[0]?.id);
  const [categoryId, setCategoryId] = useState<number | null>(initial.category_id ?? null);
  const [title, setTitle] = useState(initial.title);
  const [type, setType] = useState<DocType>(initial.type);
  // The SAVED status (1.9.0): what the document is right now, shown as a chip
  // beside the title. Null until a first save creates the row. Nobody picks
  // a status from a select any more — Publish, Unpublish and Submit for
  // review are the actions, and each save names the status it is for.
  const [savedStatus, setSavedStatus] = useState<DocStatus | null>(initial.id ? initial.status : null);
  // Scheduled publish / auto-unpublish (datetime-local strings, "" = off).
  const toLocal = (iso?: string | null) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const [publishAt, setPublishAt] = useState<string>(toLocal(initial.publish_at));
  const [archiveAt, setArchiveAt] = useState<string>(toLocal(initial.archive_at));
  const [summary, setSummary] = useState(initial.summary);
  const [tags, setTags] = useState(initial.tags.join(", "));
  const [content, setContent] = useState(initial.content);
  const [changeNote, setChangeNote] = useState("");
  const [tab, setTab] = useState<EditorTab>("rich");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [submittedDocId, setSubmittedDocId] = useState<number | null>(null);
  // The doc we attach uploads to. In edit mode it's the doc being edited; in
  // create mode it starts empty and is filled by the silent draft-save that a
  // first image upload triggers (images need a document row to belong to).
  const [docId, setDocId] = useState<number | undefined>(initial.id);
  const [autoDrafted, setAutoDrafted] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [otherEditors, setOtherEditors] = useState<string[]>([]);

  // Editing presence: heartbeat every 30s while an existing doc is open, so
  // anyone else opening the same editor sees a "also editing" banner. Best
  // effort — a closed tab stops heartbeating and ages out server-side.
  useEffect(() => {
    if (!initial.id) return;
    const id = initial.id;
    let alive = true;
    const beat = async () => {
      try {
        const res = await fetch(`/api/documents/${id}/editing`, { method: "POST" });
        if (!res.ok || !alive) return;
        const data = await res.json();
        setOtherEditors((data.others || []).map((o: { user_name: string }) => o.user_name));
      } catch {
        // Offline blip — next beat catches up.
      }
    };
    void beat();
    const t = setInterval(beat, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
      // keepalive lets the goodbye survive tab close/navigation.
      void fetch(`/api/documents/${id}/editing`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leaving: true }),
        keepalive: true,
      }).catch(() => {});
    };
  }, [initial.id]);
  // Nested pages: optional parent within the selected space.
  const [parentId, setParentId] = useState<number | null>(initial.parent_id ?? null);
  const [parentOptions, setParentOptions] = useState<{ id: number; title: string }[]>([]);
  useEffect(() => {
    if (!nestedEnabled || !spaceId) return;
    let cancelled = false;
    fetch(`/api/documents/lookup?space=${spaceId}&limit=50`)
      .then((r) => (r.ok ? r.json() : { docs: [] }))
      .then((d) => {
        if (cancelled) return;
        const opts = (d.docs as { id: number; title: string }[]).filter((o) => o.id !== initial.id);
        setParentOptions(opts);
        // A stale parent from another space clears when the space changes.
        setParentId((p) => (p !== null && !opts.some((o) => o.id === p) ? null : p));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nestedEnabled, spaceId]);
  const [uploading, setUploading] = useState(false);
  const mdRef = useRef<HTMLTextAreaElement>(null);

  // ── Unsaved work ─────────────────────────────────────────────────────────
  /** Every field a writer can change, serialised. */
  const snapshot = JSON.stringify([
    spaceId,
    categoryId,
    title,
    type,
    publishAt,
    archiveAt,
    summary,
    tags,
    content,
    parentId,
    changeNote,
  ]);
  // Shared with every settings page (lib/use-unsaved): the touched gate, the
  // beforeunload guard and the in-app link guard. The leave prompt is the
  // browser's own on purpose; editor-safety.spec listens for it.
  const rootRef = useRef<HTMLDivElement>(null);
  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(snapshot);
  const LEAVE_PROMPT = "You have unsaved changes. Discard them and leave the editor?";
  useLeaveGuard(dirty, hasUnsavedChanges, { message: LEAVE_PROMPT, ignoreWithin: rootRef });

  // The Cancel/Save row is sticky, and so is the formatting toolbar inside the
  // editor card. Publish the row's measured height so the toolbar can pin
  // directly *below* it instead of underneath it (RichTextEditor reads
  // --rte-sticky-top, defaulting to 0 for its other hosts).
  const headerRef = useRef<HTMLDivElement>(null);
  const [headerH, setHeaderH] = useState(0);
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const measure = () => setHeaderH(el.getBoundingClientRect().height);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // AI proofreading state.
  const [proofing, setProofing] = useState(false);
  const [proof, setProof] = useState<ProofResult | null>(null);
  const [proofError, setProofError] = useState("");

  async function runProofread() {
    setProofing(true);
    setProof(null);
    setProofError("");
    try {
      const res = await fetch("/api/proofread", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const data = await res.json();
      if (!res.ok) setProofError(data?.error || "Proofreading failed.");
      else setProof(data as ProofResult);
    } catch {
      setProofError("Proofreading failed. Please try again.");
    }
    setProofing(false);
  }

  function applyProof() {
    if (proof?.revised != null) {
      markDirty();
      setContent(proof.revised);
    }
    setProof(null);
  }

  // AI writing-assist state.
  const [assistMenu, setAssistMenu] = useState(false);
  const assistBtnRef = useRef<HTMLButtonElement>(null);
  const [assisting, setAssisting] = useState<string>("");
  const [assist, setAssist] = useState<{ action: WriteAction; text: string; truncated?: boolean } | null>(null);
  const [assistError, setAssistError] = useState("");

  async function runAssist(action: WriteAction, tone?: WriteTone) {
    setAssistMenu(false);
    setAssist(null);
    setAssistError("");
    setAssisting(action + (tone ? `:${tone}` : ""));
    try {
      const res = await fetch("/api/ai/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, tone, title, docType: type, content }),
      });
      const data = (await res.json()) as WriteResult;
      if (!res.ok) setAssistError((data as any)?.error || "Writing assist failed.");
      else if (data.mode === "unavailable" || !data.text) setAssistError(data.message || "Writing assist is unavailable.");
      else setAssist({ action, text: data.text, truncated: data.truncated });
    } catch {
      setAssistError("Writing assist failed. Please try again.");
    }
    setAssisting("");
  }

  function applyAssist() {
    if (!assist) return;
    markDirty();
    if (assist.action === "summarize") setSummary(assist.text.slice(0, 280));
    else setContent(assist.text);
    setAssist(null);
  }

  // The actions this person has, from the saved state and their rights
  // (decision D-7). Publishing is an explicit button, never a select:
  //   not saved yet   Save draft · Publish          (or Save draft alone)
  //   saved draft     Save draft · Publish          (or · Submit for review)
  //   published       Unpublish · Save changes      (or Submit for review)
  // A non-publisher's "publish" is a change request, which the API decides —
  // the button says what will happen. On a brand-new document the API would
  // quietly downgrade a publish to a draft, so there is no Submit until the
  // draft exists.
  const isPublished = savedStatus === "published";
  const primary: { label: string; status: DocStatus } = isPublished
    ? canPublish
      ? { label: "Save changes", status: "published" }
      : { label: "Submit for review", status: "published" }
    : canPublish
      ? { label: "Publish", status: "published" }
      : savedStatus === "draft"
        ? { label: "Submit for review", status: "published" }
        : { label: "Save draft", status: "draft" };
  const secondary: { label: string; status: DocStatus; confirm?: boolean } | null = isPublished
    ? canPublish
      ? { label: "Unpublish", status: "draft", confirm: true }
      : null
    : primary.status === "published"
      ? { label: "Save draft", status: "draft" }
      : null;

  /**
   * Upload an image and return its serving URL, creating a draft first when
   * the document doesn't exist yet. Returns null (and sets the error banner)
   * on failure so callers can simply bail.
   */
  async function uploadImage(file: File): Promise<string | null> {
    setError("");
    setUploading(true);
    try {
      let id = docId;
      if (!id) {
        const res = await fetch("/api/documents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            space_id: spaceId,
            category_id: categoryId,
            title: title.trim() || "Untitled",
            type,
            status: "draft",
            summary,
            tags,
            content,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "Could not save a draft for the image.");
        id = data.doc.id as number;
        setDocId(id);
        setSavedStatus("draft");
        setAutoDrafted(true);
      }
      const fd = new FormData();
      fd.append("file", file, file.name || "image.png");
      const res = await fetch(`/api/documents/${id}/attachments`, { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Image upload failed.");
      return data.attachment.url as string;
    } catch (e: any) {
      setError(e.message || "Image upload failed.");
      return null;
    } finally {
      setUploading(false);
    }
  }

  /** Insert image markdown at the cursor of the raw-markdown textarea. */
  async function insertImageIntoMarkdown(file: File) {
    const url = await uploadImage(file);
    if (!url) return;
    const alt = (file.name || "image").replace(/\.[a-z0-9]+$/i, "") || "image";
    const snippet = `![${alt}](${url})`;
    markDirty();
    const ta = mdRef.current;
    if (ta) {
      const start = ta.selectionStart ?? content.length;
      const end = ta.selectionEnd ?? start;
      const before = content.slice(0, start);
      const after = content.slice(end);
      const pad = before && !before.endsWith("\n") ? "\n\n" : before.endsWith("\n\n") || !before ? "" : "\n";
      setContent(before + pad + snippet + "\n" + after);
    } else {
      setContent(content + (content.endsWith("\n") || !content ? "" : "\n") + snippet + "\n");
    }
  }

  // Markdown templates for the rich-block Insert menu.
  const SNIPPETS: Record<string, string> = {
    callout: ':::tip[Pro tip]\nYour advice here.\n:::',
    tabs: '::::tabs\n:::tab[First tab]\nContent for the first tab.\n:::\n:::tab[Second tab]\nContent for the second tab.\n:::\n::::',
    details: ':::details[Click to expand]\nHidden until the reader opens it.\n:::',
    mermaid:
      "```mermaid\nflowchart LR\n  A[Start] --> B{Decision?}\n  B -- Yes --> C[Do the thing]\n  B -- No --> D[Skip it]\n```",
    plantuml: "```plantuml\nAlice -> Bob: Request\nBob --> Alice: Response\n```",
    decision:
      "```decision\nstart: Is the service responding?\n- Yes -> logs\n- No -> Escalate to the on-call engineer.\nlogs: Any errors in the application log?\n- Yes -> Follow the runbook for that error code.\n- No -> Capture details and open a ticket.\n```",
    video: '::video[Optional caption]{src="https://www.youtube.com/watch?v=VIDEO_ID"}',
    embed: '::embed{src="https://example.com/status" height="500"}',
    checklist: "- [ ] First step\n- [ ] Second step\n- [ ] Third step",
  slideBreak: "---",
  compliance:
    ":::compliance\nI confirm that I have completed this training and understood the material.\n:::",
  quiz:
    ":::quiz\nQ: Which statement is correct?\n- [ ] A wrong answer\n- [x] The right answer\n- [ ] Another wrong answer\n:::",
    table: "| Name | Team | Status |\n| --- | --- | --- |\n| Alice | Platform | Active |\n| Bob | Support | Active |",
  };

  function insertSnippet(kind: string) {
    const snippet = SNIPPETS[kind];
    if (!snippet) return;
    markDirty();
    const ta = mdRef.current;
    const start = ta?.selectionStart ?? content.length;
    const end = ta?.selectionEnd ?? start;
    const before = content.slice(0, start);
    const after = content.slice(end);
    const pad = before && !before.endsWith("\n\n") ? (before.endsWith("\n") ? "\n" : "\n\n") : "";
    const next = before + pad + snippet + "\n\n" + after;
    setContent(next);
    requestAnimationFrame(() => {
      if (!ta) return;
      const cursor = (before + pad + snippet).length;
      ta.focus();
      ta.setSelectionRange(cursor, cursor);
    });
  }

  function imageFromDataTransfer(items: DataTransferItemList | null): File | null {
    if (!items) return null;
    for (const item of Array.from(items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) return item.getAsFile();
    }
    return null;
  }

  /** Save with the given status — the status is the action. */
  async function save(status: DocStatus) {
    if (!title.trim()) {
      setError("A title is required.");
      return;
    }
    setSaving(true);
    setError("");
    const payload = {
      space_id: spaceId,
      category_id: categoryId,
      title: title.trim(),
      type,
      status,
      summary,
      tags,
      content,
      ...(nestedEnabled ? { parent_id: parentId } : {}),
      ...(canPublish && docId
        ? {
            // Only the field matching the submitted status applies; the other
            // clears, so a hidden stale value can't ride along on a status flip.
            publish_at:
              status === "draft" && publishAt ? new Date(publishAt).toISOString() : null,
            archive_at:
              status === "published" && archiveAt ? new Date(archiveAt).toISOString() : null,
          }
        : {}),
    };
    try {
      const res = !docId
        ? await fetch("/api/documents", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch(`/api/documents/${docId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...payload,
              base_updated_at: initial.updated_at,
              versionNote:
                changeNote.trim() || (mode === "create" ? "Created" : "Edited via editor"),
            }),
          });
      const data = await res.json();
      if (res.status === 409 && data?.conflict) {
        setConflict(true);
        throw new Error(data.error);
      }
      if (!res.ok) throw new Error(data?.error || "Save failed.");
      // Persisted — the fields as they were when this save started are now the
      // clean baseline, so nothing warns on the way out.
      markClean(snapshot);
      if (data.pending) {
        // Editor's change to live content went to the review queue.
        setSubmittedDocId(data.docId);
        setSaving(false);
        return;
      }
      // Refresh BEFORE navigating: it invalidates the client router cache, so
      // the doc page fetches the just-saved content instead of briefly (or,
      // if the refresh races the navigation, persistently) showing the stale
      // cached copy from before the edit.
      router.refresh();
      router.push(`/doc/${data.doc.id}`);
    } catch (e: any) {
      setError(e.message || "Something went wrong.");
      setSaving(false);
    }
  }

  // ⌘S / Ctrl+S saves. This is the one shortcut in the app that MUST fire
  // while the user is typing — reaching for it mid-sentence is the entire
  // point — so `blockModKey` (which deliberately permits typing) is the only
  // key guard, with no not-typing check. It is still gated on the overlay
  // stack so ⌘S under a modal doesn't save the page behind it.
  // Ctrl+S keeps the document as it is: a draft stays a draft, a published
  // document stays published (for a non-publisher that is a review request,
  // exactly as the button beside Cancel says).
  const saveHotkeyRef = useRef<() => void>(() => {});
  useEffect(() => {
    saveHotkeyRef.current = () => {
      if (saving) return;
      void save(savedStatus ?? "draft");
    };
  });

  async function unpublish() {
    const ok = await confirmDialog({
      title: "Unpublish this document?",
      body: "Readers lose access until it is published again. Your edits are kept with it as a draft.",
      confirmLabel: "Unpublish",
      danger: true,
    });
    if (ok === true) void save("draft");
  }
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (blockModKey(e)) return;
      // Match on the character produced, both cases (Caps Lock yields "S").
      if (e.key !== "s" && e.key !== "S") return;
      if (overlayOpen()) return;
      // Swallow it unconditionally: the browser's Save-page dialog must never
      // appear over the editor, even when we decline to save.
      e.preventDefault();
      saveHotkeyRef.current();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (submittedDocId !== null) {
    return (
      <div className="mx-auto max-w-lg px-8 py-16">
        {/* The shared empty-state tiers (icon, headline, sentence, action):
            this screen used to be a typed clipboard glyph over a hand-built box. The
            headline is a status, so it stays below the page's h1 ladder. */}
        <EmptyState
          icon={<ClipboardCheck />}
          title="Submitted for review"
          body="Your change was sent to the review queue. An approver or admin will publish it."
          action={{ href: "/", label: "Back to dashboard", icon: <House /> }}
        >
          <div className="mt-4">
            <Link href={`/doc/${submittedDocId}`} className="link font-medium">
              View document
            </Link>
          </div>
        </EmptyState>
      </div>
    );
  }

  return (
    <PageWidth>
      <div ref={rootRef}>
      {/* Sticky, the same way the formatting toolbar below is sticky: it rides
          along while you scroll a long document, so Save never leaves the
          screen. It pins at the very top and publishes its height so the
          toolbar pins immediately underneath rather than behind it. */}
      <div
        ref={headerRef}
        className="sticky top-0 z-40 -mx-8 mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 bg-surface px-8 py-3"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <h1 className="min-w-0 text-xl font-bold text-slate-900">
            {mode === "create" ? "New document" : "Edit document"}
          </h1>
          {/* The saved state, where the person deciding what to do next can
              see it. A new document has none until its first save. */}
          {savedStatus ? (
            <StatusBadge status={savedStatus} />
          ) : (
            <span className={chipClass("neutral")}>Not saved yet</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <UnsavedHint dirty={dirty} className="mr-1 hidden sm:inline-flex" />
          <Link
            href={mode === "edit" && initial.id ? `/doc/${initial.id}` : "/"}
            onClick={(e) => {
              if (!hasUnsavedChanges()) return;
              if (!window.confirm(LEAVE_PROMPT)) {
                e.preventDefault();
              }
            }}
            className={buttonClass("secondary")}
          >
            Cancel
          </Link>
          {secondary && (
            <button
              type="button"
              onClick={() => (secondary.confirm ? void unpublish() : void save(secondary.status))}
              disabled={saving}
              className={buttonClass("secondary")}
            >
              {secondary.label}
            </button>
          )}
          <button
            type="button"
            onClick={() => void save(primary.status)}
            disabled={saving}
            className={buttonClass("primary")}
          >
            {saving ? "Saving…" : primary.label}
          </button>
        </div>
      </div>

      {otherEditors.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
          <strong>{otherEditors.join(", ")}</strong>
          {otherEditors.length === 1 ? " is" : " are"} also editing this document right now —
          coordinate to avoid overwriting each other.
        </div>
      )}

      {error && (
        <div className="notice-error mb-4 rounded-lg border px-4 py-2 text-sm">
          {error}
          {conflict && docId && (
            <span className="mt-1 block">
              <a
                href={`/doc/${docId}`}
                target="_blank"
                rel="noreferrer"
                className="font-medium underline"
              >
                Open the latest version in a new tab
              </a>{" "}
              to review what changed, copy your edits over, then reload this editor. Your text
              here is untouched.
            </span>
          )}
        </div>
      )}

      <div
        className="space-y-4"
        style={{ "--rte-sticky-top": `${headerH}px` } as React.CSSProperties}
      >
        <TextInput
          value={title}
          onChange={(e) => {
            markDirty();
            setTitle(e.target.value);
          }}
          placeholder="Document title"
          aria-label="Document title"
          className="px-4 py-3 text-lg font-semibold text-slate-900"
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Space">
            <Select
              value={spaceId}
              onChange={(e) => {
                const next = Number(e.target.value);
                markDirty();
                setSpaceId(next);
                if (categoryId && !categories.some((c) => c.id === categoryId && c.space_id === next)) {
                  setCategoryId(null);
                }
              }}
            >
              {spaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.icon} {s.name}
                </option>
              ))}
            </Select>
          </Field>
          {nestedEnabled && parentOptions.length > 0 && (
            <Field label="Parent page">
              {parentId !== null && parentId !== undefined ? (
                <span className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-compass-200 bg-compass-50 px-3 py-2 text-sm font-medium text-compass-800">
                  <span className="truncate">
                    {parentOptions.find((o) => o.id === parentId)?.title ?? `#${parentId}`}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      markDirty();
                      setParentId(null);
                    }}
                    aria-label="Clear parent page (top level)"
                    className="shrink-0 opacity-60 hover:opacity-100"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </span>
              ) : (
                <EntityPicker
                  options={parentOptions.map((o) => ({ id: o.id, label: o.title }))}
                  onPick={(id) => {
                    markDirty();
                    setParentId(id);
                  }}
                  placeholder="None — search to nest under a page…"
                  emptyText="No pages match."
                  maxVisible={10}
                />
              )}
            </Field>
          )}
          {categories.some((c) => c.space_id === spaceId) && (
            <Field label="Category">
              <Select
                value={categoryId ?? ""}
                onChange={(e) => {
                  markDirty();
                  setCategoryId(e.target.value ? Number(e.target.value) : null);
                }}
              >
                <option value="">General</option>
                {categories
                  .filter((c) => c.space_id === spaceId)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </Select>
            </Field>
          )}
          <Field label="Type">
            <Select
              value={type}
              onChange={(e) => {
                markDirty();
                setType(e.target.value as DocType);
              }}
            >
              {DOC_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
          {/* Scheduling follows the SAVED status: a draft can be published
              at a time, a published document unpublished at one. */}
          {canPublish && docId && savedStatus === "draft" && (
            <Field label="Publish automatically at (optional)">
              <TextInput
                type="datetime-local"
                value={publishAt}
                onChange={(e) => {
                  markDirty();
                  setPublishAt(e.target.value);
                }}
              />
            </Field>
          )}
          {canPublish && docId && savedStatus === "published" && (
            <Field label="Unpublish automatically at (optional)">
              <TextInput
                type="datetime-local"
                value={archiveAt}
                onChange={(e) => {
                  markDirty();
                  setArchiveAt(e.target.value);
                }}
              />
            </Field>
          )}
        </div>

        {!canPublish && (
          <p className="notice-warn rounded-lg border px-3 py-2 text-xs">
            You can save drafts freely. <strong>Submit for review</strong> sends your change to
            the review queue for an approver to publish.
          </p>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Summary">
            <TextInput
              value={summary}
              onChange={(e) => {
                markDirty();
                setSummary(e.target.value);
              }}
              placeholder="One-line description for cards & search"
            />
          </Field>
          <Field label="Tags (comma separated)">
            <TextInput
              value={tags}
              onChange={(e) => {
                markDirty();
                setTags(e.target.value);
              }}
              placeholder="deploy, ci-cd, release"
            />
          </Field>
        </div>

        {mode === "edit" && (
          <Field label="Change note (shown in version history)">
            <TextInput
              value={changeNote}
              onChange={(e) => {
                markDirty();
                setChangeNote(e.target.value);
              }}
              placeholder="What changed and why? e.g. Updated escalation contacts for Q3"
              maxLength={200}
            />
          </Field>
        )}

        {/* Editor / preview */}
        <div className="rounded-lg border border-slate-200 bg-surface">
          <div className="flex flex-wrap items-center gap-1 border-b border-slate-100 px-2 py-1.5">
            <TabButton active={tab === "rich"} onClick={() => setTab("rich")}>
              Rich text
            </TabButton>
            <TabButton active={tab === "markdown"} onClick={() => setTab("markdown")}>
              Markdown
            </TabButton>
            <TabButton active={tab === "preview"} onClick={() => setTab("preview")}>
              Preview
            </TabButton>
            {tab === "markdown" && (
              <span className="ml-2 flex items-center gap-0.5 border-l border-slate-200 pl-2">
                {RICH_BLOCK_BUTTONS.map(({ kind, label, Icon }) => (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => insertSnippet(kind)}
                    data-tt={label}
                    aria-label={`Insert ${label}`}
                    className="rounded-sm p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                  >
                    <Icon className="h-4 w-4" />
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => insertSnippet("table")}
                  data-tt="Table"
                  aria-label="Insert table"
                  className="rounded-sm p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                >
                  <TableIcon className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => insertSnippet("slideBreak")}
                  data-tt="Training page break — starts a new slide (invisible on the published page)"
                  aria-label="Insert training page break"
                  className="rounded-sm p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                >
                  <SquareSplitVertical className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => insertSnippet("compliance")}
                  data-tt="Compliance confirmation (training decks)"
                  aria-label="Insert compliance block"
                  className="rounded-sm p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                >
                  <ShieldCheck className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => insertSnippet("quiz")}
                  data-tt="Quiz questions (training decks) — graded in the player, answers stay server-side"
                  aria-label="Insert quiz block"
                  className="rounded-sm p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                >
                  <ListChecks className="h-4 w-4" />
                </button>
              </span>
            )}
            <span className="relative z-30 ml-auto flex items-center gap-1">
              <div className="relative">
                <button
                  ref={assistBtnRef}
                  type="button"
                  onClick={() => setAssistMenu((o) => !o)}
                  disabled={!!assisting}
                  aria-haspopup="menu"
                  aria-expanded={assistMenu}
                  data-tt="Draft, rewrite, or summarize with AI" aria-label="Draft, rewrite, or summarize with AI"
                  className="flex items-center gap-1 rounded-md px-2.5 py-1 text-sm font-medium text-compass-700 hover:bg-compass-50 disabled:opacity-50"
                >
                  {assisting ? (
                    "Writing…"
                  ) : (
                    <>
                      <Sparkles className="h-4 w-4" aria-hidden /> Write <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                    </>
                  )}
                </button>
                <Popover
                  open={assistMenu}
                  onClose={() => setAssistMenu(false)}
                  triggerRef={assistBtnRef}
                  role="menu"
                  label="Write with AI"
                  align="end"
                  width="w-52"
                  padding="py-1"
                  className="text-sm"
                >
                  <AssistItem onClick={() => runAssist("draft")} disabled={!title.trim()}>
                    Draft from title
                  </AssistItem>
                  <AssistItem onClick={() => runAssist("improve")} disabled={!content.trim()}>
                    Improve writing
                  </AssistItem>
                  <AssistItem onClick={() => runAssist("expand")} disabled={!content.trim()}>
                    Expand
                  </AssistItem>
                  <AssistItem onClick={() => runAssist("shorten")} disabled={!content.trim()}>
                    Make shorter
                  </AssistItem>
                  <AssistItem onClick={() => runAssist("summarize")} disabled={!content.trim()}>
                    Summarize → summary field
                  </AssistItem>
                  <div className="my-1 border-t border-slate-100" />
                  <div className="px-3 py-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Change tone
                  </div>
                  {(["professional", "friendly", "concise", "confident"] as WriteTone[]).map((t) => (
                    <AssistItem key={t} onClick={() => runAssist("tone", t)} disabled={!content.trim()}>
                      <span className="capitalize">{t}</span>
                    </AssistItem>
                  ))}
                </Popover>
              </div>
              <button
                type="button"
                onClick={runProofread}
                disabled={proofing || !content.trim()}
                data-tt="Check grammar, spelling, and clarity with AI" aria-label="Check grammar, spelling, and clarity with AI"
                className="mr-1 flex items-center gap-1 rounded-md px-2.5 py-1 text-sm font-medium text-compass-700 hover:bg-compass-50 disabled:opacity-50"
              >
                {proofing ? (
                  "Proofreading…"
                ) : (
                  <>
                    <Sparkles className="h-4 w-4" aria-hidden /> Proofread
                  </>
                )}
              </button>
            </span>
          </div>

          {tab === "rich" ? (
            <RichTextEditor
              value={content}
              onChange={(md) => {
                markDirty();
                setContent(md);
              }}
              onUploadImage={uploadImage}
              docLinks={docLinks}
              measure
            />
          ) : tab === "markdown" ? (
            <textarea
              ref={mdRef}
              value={content}
              onChange={(e) => {
                markDirty();
                setContent(e.target.value);
              }}
              onPaste={(e) => {
                const file = imageFromDataTransfer(e.clipboardData?.items ?? null);
                if (file) {
                  e.preventDefault();
                  void insertImageIntoMarkdown(file);
                }
              }}
              onDrop={(e) => {
                const file = imageFromDataTransfer(e.dataTransfer?.items ?? null);
                if (file) {
                  e.preventDefault();
                  void insertImageIntoMarkdown(file);
                }
              }}
              placeholder="# Start writing…  (paste or drop a screenshot to insert it)"
              className="h-[26.25rem] w-full resize-y rounded-b-lg px-4 py-3 font-mono text-sm text-slate-700 outline-hidden"
            />
          ) : (
            <div className="doc-edit min-h-[26.25rem] px-5 py-4">
              {content.trim() ? (
                // Training docs (an existing deck, or a doc being authored with a
                // compliance block) preview --- as labeled slide-break markers.
                <MarkdownView
                  content={content}
                  slideBreaks={
                    trainingDeck || /^:::compliance\s*$/m.test(content) ? "indicator" : undefined
                  }
                />
              ) : (
                <SectionEmpty>Nothing to preview yet.</SectionEmpty>
              )}
            </div>
          )}
        </div>

        {uploading && (
          <p className="text-xs text-slate-500">Uploading image…</p>
        )}
        {autoDrafted && (
          <p className="rounded-lg border border-compass-200 bg-compass-50 px-3 py-2 text-xs text-compass-800">
            A draft was saved automatically so your image had a document to attach to — keep
            editing and save as usual.
          </p>
        )}
        {proofError && (
          <div className="notice-error rounded-lg border px-3 py-2 text-sm">
            {proofError}
          </div>
        )}

        {proof && <ProofPanel proof={proof} onApply={applyProof} onDismiss={() => setProof(null)} />}

        {assistError && (
          <div className="notice-warn rounded-lg border px-3 py-2 text-sm">
            {assistError}
          </div>
        )}
        {assist && (
          <AssistPanel
            action={assist.action}
            text={assist.text}
            truncated={assist.truncated}
            onApply={applyAssist}
            onDismiss={() => setAssist(null)}
          />
        )}
      </div>
      </div>
    </PageWidth>
  );
}

function AssistItem({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className="block w-full px-3 py-1.5 text-left text-slate-700 hover:bg-compass-50 disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

const ASSIST_LABEL: Record<WriteAction, string> = {
  draft: "Suggested draft",
  improve: "Improved version",
  expand: "Expanded version",
  shorten: "Shortened version",
  summarize: "Suggested summary",
  tone: "Rewritten",
};

function AssistPanel({
  action,
  text,
  truncated,
  onApply,
  onDismiss,
}: {
  action: WriteAction;
  text: string;
  truncated?: boolean;
  onApply: () => void;
  onDismiss: () => void;
}) {
  const applyLabel =
    action === "summarize" ? "Use as summary" : action === "draft" ? "Use this draft" : "Replace document";
  return (
    <div className="rounded-lg border border-compass-200 bg-compass-50/60">
      <div className="flex items-center gap-2 border-b border-compass-100 px-4 py-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-compass-800">
          <Sparkles className="h-4 w-4" aria-hidden /> {ASSIST_LABEL[action]}
        </span>
        <span className="ml-auto flex gap-2">
          <button
            type="button"
            onClick={onApply}
            className={buttonClass("primary")}
          >
            {applyLabel}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-md px-3 py-1 text-sm font-medium text-slate-600 hover:bg-slate-100"
          >
            Dismiss
          </button>
        </span>
      </div>
      {truncated && (
        <p className="px-4 pt-2 text-xs ink-warn">
          This document is long — only the beginning was rewritten; the rest is kept unchanged.
        </p>
      )}
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap px-4 py-3 font-sans text-sm text-slate-700">
        {text}
      </pre>
      <p className="px-4 pb-3 text-xs text-slate-500">
        AI can make mistakes and won’t know facts you haven’t written down — review before applying.
      </p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-500">{label}</span>
      {children}
    </label>
  );
}

function ProofPanel({
  proof,
  onApply,
  onDismiss,
}: {
  proof: ProofResult;
  onApply: () => void;
  onDismiss: () => void;
}) {
  const hasChanges = (proof.changes?.length ?? 0) > 0;

  if (proof.mode === "unavailable") {
    return (
      <div className="notice-warn rounded-lg border px-4 py-3 text-sm">
        {proof.message || "AI proofreading is unavailable."}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-compass-200 bg-compass-50/50 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-1.5 font-semibold text-slate-900">
          <Sparkles className="h-4 w-4" aria-hidden /> Proofreading {hasChanges ? `— ${proof.changes!.length} suggestion${proof.changes!.length === 1 ? "" : "s"}` : ""}
        </h3>
        <div className="flex items-center gap-2">
          {hasChanges && (
            <button
              onClick={onApply}
              className={buttonClass("primary")}
            >
              Apply polished version
            </button>
          )}
          <button
            onClick={onDismiss}
            className={buttonClass("secondary")}
          >
            Dismiss
          </button>
        </div>
      </div>

      {proof.truncated && (
        <p className="mb-3 text-xs ink-warn">
          This document is long — only the beginning was proofread. The rest is kept unchanged.
        </p>
      )}

      {!hasChanges ? (
        <p className="text-sm text-slate-600">{proof.message || "No changes suggested."}</p>
      ) : (
        <ul className="space-y-2">
          {proof.changes!.map((c, i) => (
            <li key={i} className="rounded-lg border border-slate-200 bg-surface p-2.5 text-sm">
              <div className="mb-1 flex items-center gap-2">
                <span className={chipClass("neutral", "sm")}>
                  {c.type}
                </span>
                {c.note && <span className="text-xs text-slate-500">{c.note}</span>}
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="rounded-sm bg-red-50 px-1.5 py-0.5 text-red-700 line-through decoration-red-300 dark:bg-red-950/40 dark:text-red-300">
                  {c.before}
                </span>
                <span className="text-slate-500">→</span>
                <span className="rounded-sm bg-emerald-50 px-1.5 py-0.5 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">{c.after}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ${
        active ? "bg-compass-50 text-compass-700" : "text-slate-500 hover:bg-slate-50"
      }`}
    >
      {children}
    </button>
  );
}
