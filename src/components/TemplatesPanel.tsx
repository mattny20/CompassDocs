"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Braces,
  EyeOff,
  LayoutTemplate,
  LoaderCircle,
  RotateCcw,
  SquarePen,
  Trash2,
} from "lucide-react";
import { RichTextEditor } from "@/components/RichTextEditor";
import { DOC_TYPES, DOC_TYPE_LABEL } from "@/lib/types";
import type { DocType } from "@/lib/types";

// Admin manager for document templates (Settings → Templates). Built-ins can
// be edited, hidden, or reset to their shipped content; custom templates can
// also be deleted. Placeholders fill automatically when a writer creates a
// doc from the template; unknown ones (like {{owner}}) stay visible as prompts.

export interface TemplateRow {
  id: number;
  builtin_key: string | null;
  name: string;
  description: string;
  doc_type: DocType;
  title_pattern: string;
  summary: string;
  tags: string;
  body: string;
  hidden: number;
}

const PLACEHOLDERS = [
  { tag: "title", label: "Document title" },
  { tag: "date", label: "Creation date" },
  { tag: "author", label: "Author's name" },
  { tag: "space", label: "Space name" },
];

const field =
  "w-full rounded-lg border border-slate-200 bg-surface px-3 py-2 text-sm outline-none focus:border-compass-400";

export function TemplatesPanel({ initial }: { initial: TemplateRow[] }) {
  const router = useRouter();
  const [templates, setTemplates] = useState<TemplateRow[]>(initial);
  const [openId, setOpenId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  async function refresh() {
    const res = await fetch("/api/admin/templates");
    if (res.ok) setTemplates((await res.json()).templates);
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Document templates</h2>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">
            Starting points writers pick from when creating a document. Placeholders like{" "}
            <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">{"{{date}}"}</code> fill in
            automatically; anything else (say{" "}
            <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">{"{{owner}}"}</code>) stays
            visible as a prompt for the writer. Set a per-space default under Settings → Spaces, or
            save any existing document as a template from its page actions.
          </p>
        </div>
        {!creating && (
          <button
            onClick={() => {
              setCreating(true);
              setOpenId(null);
            }}
            className="shrink-0 rounded-lg bg-compass-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-compass-700"
          >
            ＋ New template
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {creating && (
        <TemplateForm
          onCancel={() => setCreating(false)}
          onSaved={async () => {
            setCreating(false);
            await refresh();
          }}
          onError={setError}
        />
      )}

      <div className="space-y-3">
        {templates.map((t) => {
          const isOpen = t.id === openId;
          return (
            <div
              key={t.id}
              className="overflow-hidden rounded-xl border border-slate-200 bg-surface shadow-sm"
            >
              <button
                onClick={() => {
                  setOpenId(isOpen ? null : t.id);
                  setCreating(false);
                }}
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-compass-50 text-compass-600">
                  <LayoutTemplate className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-800">{t.name}</span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                      {DOC_TYPE_LABEL[t.doc_type]}
                    </span>
                    {t.builtin_key ? (
                      <span className="rounded-full bg-compass-50 px-2 py-0.5 text-xs font-medium text-compass-700">
                        Built-in
                      </span>
                    ) : (
                      <span className="rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700">
                        Custom
                      </span>
                    )}
                    {t.hidden === 1 && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                        <EyeOff className="h-3 w-3" /> Hidden
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-sm text-slate-500">
                    {t.description}
                  </span>
                </span>
                <SquarePen className="h-4 w-4 shrink-0 text-slate-400" />
              </button>
              {isOpen && (
                <div className="border-t border-slate-100 p-4">
                  <TemplateForm
                    template={t}
                    onCancel={() => setOpenId(null)}
                    onSaved={async () => {
                      setOpenId(null);
                      await refresh();
                    }}
                    onError={setError}
                  />
                </div>
              )}
            </div>
          );
        })}
        {templates.length === 0 && !creating && (
          <p className="rounded-lg border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-400">
            No templates yet.
          </p>
        )}
      </div>
    </div>
  );
}

function TemplateForm({
  template,
  onCancel,
  onSaved,
  onError,
}: {
  template?: TemplateRow;
  onCancel: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState(template?.name ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [docType, setDocType] = useState<DocType>(template?.doc_type ?? "knowledge");
  const [titlePattern, setTitlePattern] = useState(template?.title_pattern ?? "{{title}}");
  const [summary, setSummary] = useState(template?.summary ?? "");
  const [tags, setTags] = useState(template?.tags ?? "");
  const [body, setBody] = useState(template?.body ?? "");
  const [hidden, setHidden] = useState(template?.hidden === 1);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!name.trim()) {
      onError("Give the template a name.");
      return;
    }
    setBusy(true);
    onError("");
    const payload = {
      name: name.trim(),
      description: description.trim(),
      doc_type: docType,
      title_pattern: titlePattern.trim(),
      summary: summary.trim(),
      tags: tags.trim(),
      body,
      ...(template ? { hidden } : {}),
    };
    const res = await fetch(
      template ? `/api/admin/templates/${template.id}` : "/api/admin/templates",
      {
        method: template ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );
    setBusy(false);
    if (!res.ok) {
      onError((await res.json().catch(() => ({}))).error || "Could not save the template.");
      return;
    }
    onSaved();
  }

  async function reset() {
    if (!template?.builtin_key) return;
    if (!confirm("Restore this built-in template to its shipped content?")) return;
    setBusy(true);
    const res = await fetch(`/api/admin/templates/${template.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reset" }),
    });
    setBusy(false);
    if (!res.ok) {
      onError((await res.json().catch(() => ({}))).error || "Reset failed.");
      return;
    }
    onSaved();
  }

  async function remove() {
    if (!template || template.builtin_key) return;
    if (!confirm(`Delete the "${template.name}" template? This can't be undone.`)) return;
    setBusy(true);
    const res = await fetch(`/api/admin/templates/${template.id}`, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) {
      onError((await res.json().catch(() => ({}))).error || "Delete failed.");
      return;
    }
    onSaved();
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={field}
            placeholder="Runbook"
            maxLength={80}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">
            Description <span className="text-slate-400">(shown in the picker)</span>
          </span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={field}
            placeholder="Operational response guide with triage flow and escalation."
            maxLength={200}
          />
        </label>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">Document type</span>
          <select value={docType} onChange={(e) => setDocType(e.target.value as DocType)} className={field}>
            {DOC_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">
            Title pattern <span className="text-slate-400">(e.g. Runbook — {"{{title}}"})</span>
          </span>
          <input
            value={titlePattern}
            onChange={(e) => setTitlePattern(e.target.value)}
            className={field}
            placeholder="{{title}}"
            maxLength={120}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">
            Tags <span className="text-slate-400">(comma-separated)</span>
          </span>
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            className={field}
            placeholder="runbook, on-call"
            maxLength={200}
          />
        </label>
      </div>

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-500">
          Summary <span className="text-slate-400">(pre-filled; placeholders work here too)</span>
        </span>
        <input
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          className={field}
          placeholder="How to respond when {{title}} misbehaves."
          maxLength={300}
        />
      </label>

      <div>
        <span className="mb-1 block text-xs font-medium text-slate-500">Body</span>
        <div className="rounded-xl border border-slate-200">
          <RichTextEditor value={body} onChange={setBody} tagMenu={PLACEHOLDERS} />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <Braces className="h-3.5 w-3.5" />
          {PLACEHOLDERS.map((p) => (
            <code key={p.tag} title={p.label} className="rounded bg-slate-100 px-1.5 py-0.5">
              {`{{${p.tag}}}`}
            </code>
          ))}
          <span>
            fill automatically — any other <code className="rounded bg-slate-100 px-1 py-0.5">{"{{tag}}"}</code>{" "}
            stays as a prompt for the writer.
          </span>
        </div>
      </div>

      {template && (
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={hidden}
            onChange={(e) => setHidden(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-compass-600"
          />
          <span>
            <span className="text-sm font-medium text-slate-800">Hide from the picker</span>
            <span className="mt-0.5 block text-xs text-slate-500">
              Hidden templates aren&apos;t offered to writers (or over the Claude connector) but
              keep their content here.
            </span>
          </span>
        </label>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={save}
          disabled={busy}
          className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-compass-700 disabled:opacity-60"
        >
          {busy ? (
            <span className="inline-flex items-center gap-1.5">
              <LoaderCircle className="h-4 w-4 animate-spin" /> Saving…
            </span>
          ) : template ? (
            "Save changes"
          ) : (
            "Create template"
          )}
        </button>
        <button
          onClick={onCancel}
          className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
        >
          Cancel
        </button>
        {template?.builtin_key && (
          <button
            onClick={reset}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            <RotateCcw className="h-4 w-4" /> Reset to shipped content
          </button>
        )}
        {template && !template.builtin_key && (
          <button
            onClick={remove}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" /> Delete
          </button>
        )}
      </div>
    </div>
  );
}
