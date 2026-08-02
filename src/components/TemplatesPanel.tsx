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
import { Field, SectionEmpty, Select, TextInput, Toggle } from "@/components/form";
import { RichTextEditor } from "@/components/RichTextEditor";
import { toast } from "@/components/Toasts";
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

export function TemplatesPanel({ initial }: { initial: TemplateRow[] }) {
  const router = useRouter();
  const [templates, setTemplates] = useState<TemplateRow[]>(initial);
  const [openId, setOpenId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  async function refresh() {
    const res = await fetch("/api/admin/templates");
    if (res.ok) setTemplates((await res.json()).templates);
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">
            Starting points writers pick from when creating a document. Placeholders like{" "}
            <code className="rounded-sm bg-slate-100 px-1 py-0.5 text-xs">{"{{date}}"}</code> fill in
            automatically; anything else (say{" "}
            <code className="rounded-sm bg-slate-100 px-1 py-0.5 text-xs">{"{{owner}}"}</code>) stays
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
            className="shrink-0 rounded-lg bg-compass-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-compass-700"
          >
            ＋ New template
          </button>
        )}
      </div>

      {creating && (
        <TemplateForm
          onCancel={() => setCreating(false)}
          onSaved={async () => {
            setCreating(false);
            await refresh();
          }}
        />
      )}

      <div className="space-y-3">
        {templates.map((t) => {
          const isOpen = t.id === openId;
          return (
            <div
              key={t.id}
              className="overflow-hidden rounded-xl border border-slate-200 bg-surface shadow-xs"
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
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
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
                  />
                </div>
              )}
            </div>
          );
        })}
        {templates.length === 0 && !creating && (
          <SectionEmpty
            className="py-6"
            action={{
              label: "New template",
              onClick: () => {
                setCreating(true);
                setOpenId(null);
              },
            }}
          >
            No templates yet.
          </SectionEmpty>
        )}
      </div>
    </div>
  );
}

function TemplateForm({
  template,
  onCancel,
  onSaved,
}: {
  template?: TemplateRow;
  onCancel: () => void;
  onSaved: () => void;
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
      toast("error", "Give the template a name.");
      return;
    }
    setBusy(true);
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
      toast("error", (await res.json().catch(() => ({}))).error || "Could not save the template.");
      return;
    }
    toast("ok", template ? "Template saved." : "Template created.");
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
      toast("error", (await res.json().catch(() => ({}))).error || "Reset failed.");
      return;
    }
    toast("ok", "Template restored to shipped content.");
    onSaved();
  }

  async function remove() {
    if (!template || template.builtin_key) return;
    if (!confirm(`Delete the "${template.name}" template? This can't be undone.`)) return;
    setBusy(true);
    const res = await fetch(`/api/admin/templates/${template.id}`, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) {
      toast("error", (await res.json().catch(() => ({}))).error || "Delete failed.");
      return;
    }
    toast("ok", "Template deleted.");
    onSaved();
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Runbook"
            maxLength={80}
          />
        </Field>
        <Field
          label={
            <>
              Description <span className="text-slate-400">(shown in the picker)</span>
            </>
          }
        >
          <TextInput
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Operational response guide with triage flow and escalation."
            maxLength={200}
          />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Document type">
          <Select value={docType} onChange={(e) => setDocType(e.target.value as DocType)}>
            {DOC_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={
            <>
              Title pattern <span className="text-slate-400">(e.g. Runbook — {"{{title}}"})</span>
            </>
          }
        >
          <TextInput
            value={titlePattern}
            onChange={(e) => setTitlePattern(e.target.value)}
            placeholder="{{title}}"
            maxLength={120}
          />
        </Field>
        <Field
          label={
            <>
              Tags <span className="text-slate-400">(comma-separated)</span>
            </>
          }
        >
          <TextInput
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="runbook, on-call"
            maxLength={200}
          />
        </Field>
      </div>

      <Field
        label={
          <>
            Summary <span className="text-slate-400">(pre-filled; placeholders work here too)</span>
          </>
        }
      >
        <TextInput
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="How to respond when {{title}} misbehaves."
          maxLength={300}
        />
      </Field>

      <div>
        <span className="mb-1 block text-xs font-medium text-slate-500">Body</span>
        <div className="rounded-xl border border-slate-200">
          <RichTextEditor value={body} onChange={setBody} tagMenu={PLACEHOLDERS} />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <Braces className="h-3.5 w-3.5" />
          {PLACEHOLDERS.map((p) => (
            <code key={p.tag} title={p.label} className="rounded-sm bg-slate-100 px-1.5 py-0.5">
              {`{{${p.tag}}}`}
            </code>
          ))}
          <span>
            fill automatically — any other <code className="rounded-sm bg-slate-100 px-1 py-0.5">{"{{tag}}"}</code>{" "}
            stays as a prompt for the writer.
          </span>
        </div>
      </div>

      {template && (
        <Toggle
          label="Hide from the picker"
          help={
            <>
              Hidden templates aren&apos;t offered to writers (or over the Claude connector) but
              keep their content here.
            </>
          }
          checked={hidden}
          onChange={setHidden}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={save}
          disabled={busy}
          className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white shadow-xs hover:bg-compass-700 disabled:opacity-60"
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
