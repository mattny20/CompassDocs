"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { MarkdownView } from "./MarkdownView";
import { PageWidth } from "./PageWidth";
import { RichTextEditor } from "./RichTextEditor";
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

interface Initial {
  id?: number;
  space_id?: number;
  title: string;
  type: DocType;
  status: DocStatus;
  summary: string;
  tags: string[];
  content: string;
  author: string;
}

export function DocEditor({
  spaces,
  initial,
  mode,
  canPublish,
}: {
  spaces: Pick<Space, "id" | "name" | "icon">[];
  initial: Initial;
  mode: "create" | "edit";
  canPublish: boolean;
}) {
  const router = useRouter();
  const [spaceId, setSpaceId] = useState(initial.space_id ?? spaces[0]?.id);
  const [title, setTitle] = useState(initial.title);
  const [type, setType] = useState<DocType>(initial.type);
  const [status, setStatus] = useState<DocStatus>(initial.status);
  const [summary, setSummary] = useState(initial.summary);
  const [tags, setTags] = useState(initial.tags.join(", "));
  const [content, setContent] = useState(initial.content);
  const [tab, setTab] = useState<EditorTab>("rich");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [submittedDocId, setSubmittedDocId] = useState<number | null>(null);
  // The doc we attach uploads to. In edit mode it's the doc being edited; in
  // create mode it starts empty and is filled by the silent draft-save that a
  // first image upload triggers (images need a document row to belong to).
  const [docId, setDocId] = useState<number | undefined>(initial.id);
  const [autoDrafted, setAutoDrafted] = useState(false);
  const [uploading, setUploading] = useState(false);
  const mdRef = useRef<HTMLTextAreaElement>(null);

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
    if (proof?.revised != null) setContent(proof.revised);
    setProof(null);
  }

  // An editor without publish rights who marks the doc "published" is really
  // submitting a change for approval.
  const willSubmitForReview = !canPublish && status === "published";

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

  function imageFromDataTransfer(items: DataTransferItemList | null): File | null {
    if (!items) return null;
    for (const item of Array.from(items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) return item.getAsFile();
    }
    return null;
  }

  async function save() {
    if (!title.trim()) {
      setError("A title is required.");
      return;
    }
    setSaving(true);
    setError("");
    const payload = {
      space_id: spaceId,
      title: title.trim(),
      type,
      status,
      summary,
      tags,
      content,
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
              versionNote: mode === "create" ? "Created" : "Edited via editor",
            }),
          });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Save failed.");
      if (data.pending) {
        // Editor's change to live content went to the review queue.
        setSubmittedDocId(data.docId);
        setSaving(false);
        return;
      }
      router.push(`/doc/${data.doc.id}`);
      router.refresh();
    } catch (e: any) {
      setError(e.message || "Something went wrong.");
      setSaving(false);
    }
  }

  if (submittedDocId !== null) {
    return (
      <div className="mx-auto max-w-lg px-8 py-16 text-center">
        <div className="mb-3 text-4xl">📋</div>
        <h1 className="text-xl font-bold text-slate-900">Submitted for review</h1>
        <p className="mt-2 text-slate-500">
          Your change was sent to the review queue. An approver or admin will publish it.
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <Link
            href={`/doc/${submittedDocId}`}
            className="rounded-lg border border-slate-200 bg-surface px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            View document
          </Link>
          <Link
            href="/"
            className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white hover:bg-compass-700"
          >
            Back to dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <PageWidth>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-900">
          {mode === "create" ? "New document" : "Edit document"}
        </h1>
        <div className="flex items-center gap-2">
          <Link
            href={mode === "edit" && initial.id ? `/doc/${initial.id}` : "/"}
            className="rounded-lg border border-slate-200 bg-surface px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            Cancel
          </Link>
          <button
            onClick={save}
            disabled={saving}
            className="rounded-lg bg-compass-600 px-4 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-compass-700 disabled:opacity-60"
          >
            {saving
              ? "Saving…"
              : willSubmitForReview
                ? "Submit for review"
                : mode === "create"
                  ? status === "published"
                    ? "Publish"
                    : "Save draft"
                  : "Save changes"}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="space-y-4">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Document title"
          className="w-full rounded-lg border border-slate-200 bg-surface px-4 py-3 text-lg font-semibold text-slate-900 outline-none focus:border-compass-400 focus:ring-2 focus:ring-compass-100"
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Space">
            <select
              value={spaceId}
              onChange={(e) => setSpaceId(Number(e.target.value))}
              className="w-full rounded-lg border border-slate-200 bg-surface px-3 py-2 text-sm outline-none focus:border-compass-400"
            >
              {spaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.icon} {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Type">
            <select
              value={type}
              onChange={(e) => setType(e.target.value as DocType)}
              className="w-full rounded-lg border border-slate-200 bg-surface px-3 py-2 text-sm outline-none focus:border-compass-400"
            >
              {DOC_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Status">
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as DocStatus)}
              className="w-full rounded-lg border border-slate-200 bg-surface px-3 py-2 text-sm outline-none focus:border-compass-400"
            >
              <option value="draft">Draft</option>
              <option value="published">Published</option>
            </select>
          </Field>
        </div>

        {!canPublish && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            You can save drafts freely. Setting the status to <strong>Published</strong> submits
            your change to the review queue for an approver to publish.
          </p>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Summary">
            <input
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="One-line description for cards & search"
              className="w-full rounded-lg border border-slate-200 bg-surface px-3 py-2 text-sm outline-none focus:border-compass-400"
            />
          </Field>
          <Field label="Tags (comma separated)">
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="deploy, ci-cd, release"
              className="w-full rounded-lg border border-slate-200 bg-surface px-3 py-2 text-sm outline-none focus:border-compass-400"
            />
          </Field>
        </div>

        {/* Editor / preview */}
        <div className="rounded-lg border border-slate-200 bg-surface">
          <div className="flex items-center gap-1 border-b border-slate-100 px-2 py-1.5">
            <TabButton active={tab === "rich"} onClick={() => setTab("rich")}>
              Rich text
            </TabButton>
            <TabButton active={tab === "markdown"} onClick={() => setTab("markdown")}>
              Markdown
            </TabButton>
            <TabButton active={tab === "preview"} onClick={() => setTab("preview")}>
              Preview
            </TabButton>
            <button
              type="button"
              onClick={runProofread}
              disabled={proofing || !content.trim()}
              title="Check grammar, spelling, and clarity with AI"
              className="ml-auto mr-1 flex items-center gap-1 rounded-md px-2.5 py-1 text-sm font-medium text-compass-700 hover:bg-compass-50 disabled:opacity-50"
            >
              {proofing ? "Proofreading…" : "✨ Proofread"}
            </button>
          </div>

          {tab === "rich" ? (
            <RichTextEditor value={content} onChange={setContent} onUploadImage={uploadImage} />
          ) : tab === "markdown" ? (
            <textarea
              ref={mdRef}
              value={content}
              onChange={(e) => setContent(e.target.value)}
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
              className="h-[420px] w-full resize-y rounded-b-lg px-4 py-3 font-mono text-sm text-slate-700 outline-none"
            />
          ) : (
            <div className="min-h-[420px] px-5 py-4">
              {content.trim() ? (
                <MarkdownView content={content} />
              ) : (
                <p className="text-sm text-slate-400">Nothing to preview yet.</p>
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
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {proofError}
          </div>
        )}

        {proof && <ProofPanel proof={proof} onApply={applyProof} onDismiss={() => setProof(null)} />}
      </div>
    </PageWidth>
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
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        {proof.message || "AI proofreading is unavailable."}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-compass-200 bg-compass-50/50 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="font-semibold text-slate-900">
          ✨ Proofreading {hasChanges ? `— ${proof.changes!.length} suggestion${proof.changes!.length === 1 ? "" : "s"}` : ""}
        </h3>
        <div className="flex items-center gap-2">
          {hasChanges && (
            <button
              onClick={onApply}
              className="rounded-lg bg-compass-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-compass-700"
            >
              Apply polished version
            </button>
          )}
          <button
            onClick={onDismiss}
            className="rounded-lg border border-slate-200 bg-surface px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            Dismiss
          </button>
        </div>
      </div>

      {proof.truncated && (
        <p className="mb-3 text-xs text-amber-700">
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
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                  {c.type}
                </span>
                {c.note && <span className="text-xs text-slate-500">{c.note}</span>}
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="rounded bg-red-50 px-1.5 py-0.5 text-red-700 line-through decoration-red-300">
                  {c.before}
                </span>
                <span className="text-slate-400">→</span>
                <span className="rounded bg-green-50 px-1.5 py-0.5 text-green-700">{c.after}</span>
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
      className={`rounded-md px-3 py-1 text-sm font-medium ${
        active ? "bg-compass-50 text-compass-700" : "text-slate-500 hover:bg-slate-50"
      }`}
    >
      {children}
    </button>
  );
}
