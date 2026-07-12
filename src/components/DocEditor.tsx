"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { MarkdownView } from "./MarkdownView";
import { DOC_TYPES } from "@/lib/types";
import type { DocType, DocStatus, Space } from "@/lib/types";

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
  const [tab, setTab] = useState<"write" | "preview">("write");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [submittedDocId, setSubmittedDocId] = useState<number | null>(null);

  // An editor without publish rights who marks the doc "published" is really
  // submitting a change for approval.
  const willSubmitForReview = !canPublish && status === "published";

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
      const res =
        mode === "create"
          ? await fetch("/api/documents", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            })
          : await fetch(`/api/documents/${initial.id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...payload, versionNote: "Edited via editor" }),
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
            className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
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
    <div className="mx-auto max-w-4xl px-8 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-900">
          {mode === "create" ? "New document" : "Edit document"}
        </h1>
        <div className="flex items-center gap-2">
          <Link
            href={mode === "edit" && initial.id ? `/doc/${initial.id}` : "/"}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
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
          className="w-full rounded-lg border border-slate-200 bg-white px-4 py-3 text-lg font-semibold text-slate-900 outline-none focus:border-compass-400 focus:ring-2 focus:ring-compass-100"
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Space">
            <select
              value={spaceId}
              onChange={(e) => setSpaceId(Number(e.target.value))}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-compass-400"
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
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-compass-400"
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
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-compass-400"
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
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-compass-400"
            />
          </Field>
          <Field label="Tags (comma separated)">
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="deploy, ci-cd, release"
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-compass-400"
            />
          </Field>
        </div>

        {/* Editor / preview */}
        <div className="rounded-lg border border-slate-200 bg-white">
          <div className="flex items-center gap-1 border-b border-slate-100 px-2 py-1.5">
            <TabButton active={tab === "write"} onClick={() => setTab("write")}>
              Write
            </TabButton>
            <TabButton active={tab === "preview"} onClick={() => setTab("preview")}>
              Preview
            </TabButton>
            <span className="ml-auto pr-2 text-xs text-slate-400">Markdown supported</span>
          </div>
          {tab === "write" ? (
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="# Start writing…"
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
      </div>
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
