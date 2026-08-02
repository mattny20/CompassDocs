"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  Link2,
  Paperclip,
  Trash2,
} from "lucide-react";
import { usePanelCollapse } from "@/lib/use-panel-collapse";

interface Att {
  id: number;
  filename: string;
  mime_type: string;
  size: number;
}

interface DmsLinkItem {
  id: number;
  system: string;
  title: string;
  url: string;
}

// Branded chips for known document-management systems; anything else gets a
// neutral link badge. Initials, not logos — no trademark artwork shipped.
const DMS_BADGE: Record<string, { label: string; short: string; cls: string }> = {
  imanage: { label: "iManage", short: "iM", cls: "bg-sky-600" },
  netdocuments: { label: "NetDocuments", short: "nD", cls: "bg-lime-600" },
  sharepoint: { label: "SharePoint", short: "SP", cls: "bg-teal-600" },
};

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const isImg = (m: string) => ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(m);

function safeHost(url: string): string {
  if (url.toLowerCase().startsWith("iwl:")) return "iManage desktop link";
  try {
    return new URL(url).hostname;
  } catch {
    return "link";
  }
}

export function Attachments({
  documentId,
  attachments,
  dmsLinks = [],
  canEdit,
  maxMb,
}: {
  documentId: number;
  attachments: Att[];
  dmsLinks?: DmsLinkItem[];
  canEdit: boolean;
  maxMb: number;
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<number | null>(null);
  const [linkFormOpen, setLinkFormOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkTitle, setLinkTitle] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [open, toggleOpen] = usePanelCollapse(
    "attachments",
    attachments.length + dmsLinks.length > 0
  );

  if (attachments.length === 0 && dmsLinks.length === 0 && !canEdit) return null;
  const itemCount = attachments.length + dmsLinks.length;

  async function addLink(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLinkBusy(true);
    const res = await fetch(`/api/documents/${documentId}/dms-links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: linkUrl, title: linkTitle }),
    });
    setLinkBusy(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d?.error || "Couldn't add the link.");
      return;
    }
    setLinkUrl("");
    setLinkTitle("");
    setLinkFormOpen(false);
    router.refresh();
  }

  async function removeLink(l: DmsLinkItem) {
    if (!confirm(`Remove link "${l.title}"?`)) return;
    const res = await fetch(`/api/documents/${documentId}/dms-links/${l.id}`, {
      method: "DELETE",
    });
    if (res.ok) router.refresh();
  }

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
        <h2>
          <button
            onClick={toggleOpen}
            aria-expanded={open}
            className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-700"
          >
            {open ? (
              <ChevronDown className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            )}
            <Paperclip className="h-3.5 w-3.5" aria-hidden />
            Attachments{itemCount > 0 && ` (${itemCount})`}
          </button>
        </h2>
        {canEdit && (
          <div className="flex items-center gap-1.5">
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => upload(e.target.files)}
            />
            <button
              onClick={() => setLinkFormOpen((v) => !v)}
              data-tt="Add a link to iManage, NetDocuments, SharePoint, or any https URL" aria-label="Add a link to iManage, NetDocuments, SharePoint, or any https URL"
              className="shrink-0 whitespace-nowrap rounded-lg border border-slate-200 bg-surface px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              {"＋ Link"}
            </button>
            <button
              onClick={() => fileInput.current?.click()}
              disabled={uploading}
              className="shrink-0 whitespace-nowrap rounded-lg border border-slate-200 bg-surface px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60"
            >
              {uploading ? "Uploading…" : "＋ File"}
            </button>
          </div>
        )}
      </div>

      {linkFormOpen && (
        <form
          onSubmit={addLink}
          className="mb-3 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3"
        >
          <input
            type="text"
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            placeholder="https://acme.sharepoint.com/… or iManage / NetDocuments link"
            required
            className="w-full rounded-lg border border-slate-200 bg-surface px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-compass-400 focus:outline-none"
          />
          <input
            type="text"
            value={linkTitle}
            onChange={(e) => setLinkTitle(e.target.value)}
            placeholder="Display name (optional)"
            maxLength={200}
            className="w-full rounded-lg border border-slate-200 bg-surface px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-compass-400 focus:outline-none"
          />
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={linkBusy}
              className="whitespace-nowrap rounded-lg bg-compass-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-compass-700 disabled:opacity-60"
            >
              {linkBusy ? "Adding…" : "Add link"}
            </button>
            <button
              type="button"
              onClick={() => setLinkFormOpen(false)}
              className="rounded-lg px-2.5 py-1.5 text-sm text-slate-500 hover:text-slate-700"
            >
              Cancel
            </button>
            <span className="text-xs text-slate-400">
              iManage, NetDocuments &amp; SharePoint links get their own badge.
            </span>
          </div>
        </form>
      )}

      {error && <div className="notice-error mb-3 rounded-lg px-3 py-2 text-sm">{error}</div>}
      {open && canEdit && attachments.length === 0 && dmsLinks.length === 0 && !linkFormOpen && (
        <p className="text-sm text-slate-500">
          {/* Literal curly quotes, not &ldquo;-entities: Turbopack (Next 16)
              splits text nodes at entities and eats the leading space after
              {maxMb} when the node also wraps a line. */}
          No attachments yet. Files up to {maxMb} MB. Images can be embedded in the doc via
          “Copy link”.
        </p>
      )}

      {/* Compact single-column rows — this list lives in the narrow side
          panel, so actions are icon buttons and everything stays on one line.
          DMS links render first: same chrome as files, branded system badge,
          nothing stored locally. An in-progress add keeps the list visible
          even when the section is collapsed. */}
      <ul className={`space-y-1.5 ${open || linkFormOpen || uploading ? "" : "hidden"}`}>
        {dmsLinks.map((l) => {
          const badge = DMS_BADGE[l.system];
          return (
            <li
              key={`dms-${l.id}`}
              title={`${l.title}\n${l.url}`}
              className="flex items-center gap-2 rounded-lg border border-slate-200 bg-surface p-1.5"
            >
              {badge ? (
                <span
                  className={`grid h-8 w-8 shrink-0 place-items-center rounded-sm text-[11px] font-bold text-white ${badge.cls}`}
                  title={badge.label}
                >
                  {badge.short}
                </span>
              ) : (
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-sm bg-slate-100 text-slate-400">
                  <ExternalLink className="h-4 w-4" />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <a
                  href={l.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  data-tt={`${l.title}\n${l.url}`} aria-label={`${l.title}\n${l.url}`}
                  className="block truncate text-sm font-medium text-slate-700 hover:text-compass-600"
                >
                  {l.title}
                </a>
                <div className="truncate text-xs text-slate-500">
                  {badge ? badge.label : safeHost(l.url)}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <a
                  href={l.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  data-tt="Open"
                  aria-label={`Open ${l.title}`}
                  className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
                {canEdit && (
                  <button
                    onClick={() => removeLink(l)}
                    data-tt="Remove link"
                    aria-label={`Remove ${l.title}`}
                    className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            </li>
          );
        })}
        {attachments.map((a) => (
          <li
            key={a.id}
            title={a.filename}
            className="flex items-center gap-2 rounded-lg border border-slate-200 bg-surface p-1.5"
          >
            {isImg(a.mime_type) ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/attachments/${a.id}`}
                alt={a.filename}
                className="h-8 w-8 shrink-0 rounded-sm object-cover ring-1 ring-slate-200"
              />
            ) : (
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-sm bg-slate-100 text-slate-400">
                <FileText className="h-4 w-4" />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <a
                href={`/api/attachments/${a.id}`}
                target="_blank"
                rel="noreferrer"
                data-tt={a.filename} aria-label={a.filename}
                className="block truncate text-sm font-medium text-slate-700 hover:text-compass-600"
              >
                {a.filename}
              </a>
              <div className="text-xs text-slate-500">{bytes(a.size)}</div>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <button
                onClick={() => copyLink(a)}
                data-tt={copied === a.id ? "Copied!" : "Copy link"}
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
                  data-tt="Delete"
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
