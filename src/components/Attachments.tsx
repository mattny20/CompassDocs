"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, FileText, Link2, Trash2 } from "lucide-react";

interface Att {
  id: number;
  filename: string;
  mime_type: string;
  size: number;
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const isImg = (m: string) => ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(m);

export function Attachments({
  documentId,
  attachments,
  canEdit,
  maxMb,
}: {
  documentId: number;
  attachments: Att[];
  canEdit: boolean;
  maxMb: number;
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<number | null>(null);

  if (attachments.length === 0 && !canEdit) return null;

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError("");
    setUploading(true);
    for (const file of Array.from(files)) {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(`/api/documents/${documentId}/attachments`, { method: "POST", body });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(`${file.name}: ${d?.error || "upload failed"}`);
        break;
      }
    }
    setUploading(false);
    if (fileInput.current) fileInput.current.value = "";
    router.refresh();
  }

  async function remove(a: Att) {
    if (!confirm(`Delete attachment "${a.filename}"?`)) return;
    const res = await fetch(`/api/attachments/${a.id}`, { method: "DELETE" });
    if (res.ok) router.refresh();
  }

  async function copyLink(a: Att) {
    // A plain URL — paste it anywhere. (Embedding an image in the doc is
    // easier done by pasting the image straight into the editor.)
    try {
      await navigator.clipboard.writeText(`${location.origin}/api/attachments/${a.id}`);
      setCopied(a.id);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard blocked */
    }
  }

  return (
    <section className="mt-8 border-t border-slate-100 pt-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Attachments{attachments.length > 0 && ` (${attachments.length})`}
        </h2>
        {canEdit && (
          <>
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => upload(e.target.files)}
            />
            <button
              onClick={() => fileInput.current?.click()}
              disabled={uploading}
              className="rounded-lg border border-slate-200 bg-surface px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60"
            >
              {uploading ? "Uploading…" : "＋ Add file"}
            </button>
          </>
        )}
      </div>

      {error && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {canEdit && attachments.length === 0 && (
        <p className="text-sm text-slate-400">
          No attachments yet. Files up to {maxMb} MB. Images can be embedded in the doc via
          &ldquo;Copy link&rdquo;.
        </p>
      )}

      {/* Compact single-column rows — this list lives in the narrow side
          panel, so actions are icon buttons and everything stays on one line. */}
      <ul className="space-y-1.5">
        {attachments.map((a) => (
          <li
            key={a.id}
            className="flex items-center gap-2 rounded-lg border border-slate-200 bg-surface p-1.5"
          >
            {isImg(a.mime_type) ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/attachments/${a.id}`}
                alt={a.filename}
                className="h-8 w-8 shrink-0 rounded object-cover ring-1 ring-slate-200"
              />
            ) : (
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded bg-slate-100 text-slate-400">
                <FileText className="h-4 w-4" />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <a
                href={`/api/attachments/${a.id}`}
                target="_blank"
                rel="noreferrer"
                title={a.filename}
                className="block truncate text-sm font-medium text-slate-700 hover:text-compass-600"
              >
                {a.filename}
              </a>
              <div className="text-xs text-slate-400">{bytes(a.size)}</div>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <button
                onClick={() => copyLink(a)}
                title={copied === a.id ? "Copied!" : "Copy link"}
                aria-label={`Copy link to ${a.filename}`}
                className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                {copied === a.id ? (
                  <Check className="h-4 w-4 text-emerald-600" />
                ) : (
                  <Link2 className="h-4 w-4" />
                )}
              </button>
              {canEdit && (
                <button
                  onClick={() => remove(a)}
                  title="Delete"
                  aria-label={`Delete ${a.filename}`}
                  className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
