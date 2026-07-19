"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  AtSign,
  BellRing,
  Braces,
  FileText,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
  Siren,
  SquarePen,
} from "lucide-react";
import { RichTextEditor } from "@/components/RichTextEditor";

// Admin editor for the emails CompassDocs sends (Settings → Notifications →
// Email templates). One template open at a time: subject line, doc-editor
// body with an insert-tag menu, live preview with sample values, save /
// reset-to-default.

interface Template {
  key: string;
  label: string;
  description: string;
  tags: { tag: string; label: string }[];
  default_subject: string;
  default_body: string;
  subject: string;
  body: string;
  customized: boolean;
}

const ICON = "h-4 w-4";
const KEY_ICON: Record<string, React.ReactNode> = {
  doc_update: <FileText className={ICON} />,
  announcement: <Siren className={ICON} />,
  mention: <AtSign className={ICON} />,
  ack_request: <ShieldCheck className={ICON} />,
  workflow_event: <BellRing className={ICON} />,
};

export function EmailTemplatesPanel({ initial }: { initial: Template[] }) {
  const [templates, setTemplates] = useState<Template[]>(initial);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const open = templates.find((t) => t.key === openKey) ?? null;
  const dirty = open ? subject !== open.subject || body !== open.body : false;
  const isDefault = open ? subject === open.default_subject && body === open.default_body : true;

  function edit(t: Template) {
    setOpenKey(t.key);
    setSubject(t.subject);
    setBody(t.body);
    setPreview(null);
    setMessage(null);
  }

  // Live preview: re-render (debounced) whenever the draft changes.
  useEffect(() => {
    if (!openKey) return;
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/admin/email-templates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: openKey, subject, body }),
        });
        if (res.ok) setPreview(await res.json());
      } catch {
        /* preview is best-effort */
      }
    }, 400);
    return () => {
      if (previewTimer.current) clearTimeout(previewTimer.current);
    };
  }, [openKey, subject, body]);

  async function save() {
    if (!open) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/email-templates", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: open.key, subject, body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ tone: "error", text: data.error || "Save failed." });
      } else {
        setTemplates((all) =>
          all.map((t) =>
            t.key === open.key ? { ...t, subject, body, customized: data.customized } : t
          )
        );
        setMessage({ tone: "ok", text: "Template saved — future emails use it immediately." });
      }
    } catch {
      setMessage({ tone: "error", text: "Save failed." });
    }
    setBusy(false);
  }

  async function resetToDefault() {
    if (!open) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/email-templates?key=${encodeURIComponent(open.key)}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ tone: "error", text: data.error || "Reset failed." });
      } else {
        setSubject(data.subject);
        setBody(data.body);
        setTemplates((all) =>
          all.map((t) =>
            t.key === open.key
              ? { ...t, subject: data.subject, body: data.body, customized: false }
              : t
          )
        );
        setMessage({ tone: "ok", text: "Restored the default template." });
      }
    } catch {
      setMessage({ tone: "error", text: "Reset failed." });
    }
    setBusy(false);
  }

  return (
    <div className="space-y-4">
      <div>
        <Link
          href="/admin/notifications"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-700"
        >
          <ArrowLeft className="h-4 w-4" /> Notifications
        </Link>
        <h2 className="mt-2 text-lg font-semibold text-slate-900">Email templates</h2>
        <p className="mt-1 max-w-2xl text-sm text-slate-500">
          Every alert email CompassDocs sends, editable. Dynamic tags like{" "}
          <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">{"{{doc_title}}"}</code> are
          replaced with the real value when each email goes out — use the{" "}
          <span className="font-medium">Insert tag</span> menu in the editor toolbar. Newsletters
          have their own editor under Settings → Newsletter.
        </p>
      </div>

      <div className="space-y-3">
        {templates.map((t) => {
          const isOpen = t.key === openKey;
          return (
            <div
              key={t.key}
              className="overflow-hidden rounded-xl border border-slate-200 bg-surface shadow-sm"
            >
              <button
                onClick={() => (isOpen ? setOpenKey(null) : edit(t))}
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-compass-50 text-compass-600">
                  {KEY_ICON[t.key] ?? <FileText className={ICON} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="font-medium text-slate-800">{t.label}</span>
                    {t.customized && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                        Customized
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
                  <div className="grid gap-4 lg:grid-cols-2">
                    <div className="space-y-3">
                      <div>
                        <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">
                          Subject
                        </label>
                        <input
                          value={subject}
                          onChange={(e) => setSubject(e.target.value)}
                          className="w-full rounded-lg border border-slate-200 bg-surface px-3 py-2 text-sm outline-none focus:border-compass-400"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">
                          Body
                        </label>
                        <div className="rounded-xl border border-slate-200">
                          <RichTextEditor value={body} onChange={setBody} tagMenu={t.tags} />
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                        <Braces className="h-3.5 w-3.5" />
                        {t.tags.map((tag) => (
                          <code
                            key={tag.tag}
                            title={tag.label}
                            className="rounded bg-slate-100 px-1.5 py-0.5"
                          >
                            {`{{${tag.tag}}}`}
                          </code>
                        ))}
                      </div>
                    </div>

                    <div>
                      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">
                        Preview (sample values)
                      </div>
                      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                        {preview ? (
                          <>
                            <div className="mb-3 border-b border-slate-200 pb-2 text-sm">
                              <span className="text-slate-400">Subject: </span>
                              <span className="font-medium text-slate-800">{preview.subject}</span>
                            </div>
                            <div
                              className="rounded-lg bg-white p-4 text-sm shadow-sm"
                              dangerouslySetInnerHTML={{ __html: preview.html }}
                            />
                          </>
                        ) : (
                          <div className="flex items-center gap-2 py-8 text-sm text-slate-400">
                            <LoaderCircle className="h-4 w-4 animate-spin" /> Rendering preview…
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <button
                      onClick={save}
                      disabled={busy || !dirty}
                      className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-medium text-white hover:bg-compass-700 disabled:opacity-50"
                    >
                      {busy ? "Saving…" : "Save template"}
                    </button>
                    <button
                      onClick={resetToDefault}
                      disabled={busy || (isDefault && !t.customized)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                    >
                      <RotateCcw className="h-4 w-4" /> Reset to default
                    </button>
                    {message && (
                      <span
                        className={`text-sm ${message.tone === "ok" ? "text-green-600" : "text-red-600"}`}
                      >
                        {message.text}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
