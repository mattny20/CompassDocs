"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface SpaceOpt {
  id: number;
  name: string;
}
interface Preview {
  source: "notion" | "confluence";
  suggestedSpaceName: string;
  pageCount: number;
  attachmentCount: number;
  topLevel: number;
  warnings: string[];
}
interface Result {
  source: string;
  spaceId: number;
  spaceName: string;
  spaceCreated: boolean;
  pagesCreated: number;
  attachmentsCreated: number;
  skipped: number;
  warnings: string[];
}

const LABEL = { notion: "Notion", confluence: "Confluence" } as const;

// Guided migration from a Confluence (HTML) or Notion (Markdown & CSV) export.
export function MigrateImport({ spaces }: { spaces: SpaceOpt[] }) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");

  // Destination + options.
  const [dest, setDest] = useState<"new" | "existing">("new");
  const [newName, setNewName] = useState("");
  const [targetSpaceId, setTargetSpaceId] = useState<string>(spaces[0]?.id.toString() ?? "");
  const [publish, setPublish] = useState(false);

  function reset() {
    setPreview(null);
    setResult(null);
    setError("");
  }

  async function onPick(f: File | null) {
    reset();
    setFile(f);
    if (!f) return;
    setBusy(true);
    try {
      const body = new FormData();
      body.append("file", f);
      body.append("mode", "preview");
      const res = await fetch("/api/admin/migrate", { method: "POST", body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || "Could not read the export.");
      } else {
        setPreview(data as Preview);
        setNewName((data as Preview).suggestedSpaceName || "");
      }
    } catch {
      setError("Could not read the export.");
    } finally {
      setBusy(false);
    }
  }

  async function runImport() {
    if (!file || !preview) return;
    setBusy(true);
    setError("");
    try {
      const body = new FormData();
      body.append("file", file);
      body.append("mode", "commit");
      body.append("source", preview.source);
      body.append("publish", publish ? "true" : "false");
      if (dest === "existing" && targetSpaceId) body.append("targetSpaceId", targetSpaceId);
      else body.append("newSpaceName", newName);
      const res = await fetch("/api/admin/migrate", { method: "POST", body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || "Import failed.");
      } else {
        setResult(data as Result);
        router.refresh();
      }
    } catch {
      setError("Import failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
      <h3 className="mb-1 font-semibold text-slate-900">Migrate from Confluence or Notion</h3>
      <p className="mb-3 text-sm text-slate-500">
        Upload the <strong>.zip</strong> you exported from Confluence (<em>Export space → HTML</em>)
        or Notion (<em>Export → Markdown &amp; CSV</em>, include subpages). CompassDocs detects the
        format, recreates the page hierarchy as nested pages, and imports images and attachments.
      </p>

      <input
        ref={fileInput}
        type="file"
        accept=".zip,application/zip"
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
        className="block w-full text-sm text-slate-500 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
      />

      {busy && !result && <p className="mt-3 text-sm text-slate-500">Reading export…</p>}

      {error && (
        <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      {preview && !result && (
        <div className="mt-4 space-y-4">
          <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
            Detected <strong>{LABEL[preview.source]}</strong> export:{" "}
            <strong>{preview.pageCount}</strong> page{preview.pageCount === 1 ? "" : "s"}
            {preview.attachmentCount > 0 && (
              <>
                {" "}
                and <strong>{preview.attachmentCount}</strong> attachment
                {preview.attachmentCount === 1 ? "" : "s"}
              </>
            )}
            .
          </div>

          {/* Destination */}
          <div className="space-y-2">
            <div className="text-sm font-medium text-slate-700">Import into</div>
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="radio"
                name="dest"
                checked={dest === "new"}
                onChange={() => setDest("new")}
              />
              A new space named
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onFocus={() => setDest("new")}
                maxLength={60}
                className="ml-1 flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm"
              />
            </label>
            {spaces.length > 0 && (
              <label className="flex items-center gap-2 text-sm text-slate-600">
                <input
                  type="radio"
                  name="dest"
                  checked={dest === "existing"}
                  onChange={() => setDest("existing")}
                />
                An existing space
                <select
                  value={targetSpaceId}
                  onChange={(e) => setTargetSpaceId(e.target.value)}
                  onFocus={() => setDest("existing")}
                  className="ml-1 rounded-md border border-slate-300 px-2 py-1 text-sm"
                >
                  {spaces.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} />
            Publish imported pages (otherwise they arrive as drafts to review first)
          </label>

          {preview.warnings.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer font-medium text-amber-700">
                {preview.warnings.length} note{preview.warnings.length === 1 ? "" : "s"}
              </summary>
              <ul className="mt-1 list-disc pl-5 text-xs text-slate-600">
                {preview.warnings.slice(0, 20).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}

          <button
            onClick={runImport}
            disabled={busy || (dest === "new" && !newName.trim())}
            className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-compass-700 disabled:opacity-50"
          >
            {busy ? "Importing…" : `Import ${preview.pageCount} page${preview.pageCount === 1 ? "" : "s"}`}
          </button>
        </div>
      )}

      {result && (
        <div className="mt-4 rounded-lg bg-green-50 px-3 py-3 text-sm text-green-800">
          Imported <strong>{result.pagesCreated}</strong> page
          {result.pagesCreated === 1 ? "" : "s"}
          {result.attachmentsCreated > 0 && (
            <>
              {" "}
              and <strong>{result.attachmentsCreated}</strong> attachment
              {result.attachmentsCreated === 1 ? "" : "s"}
            </>
          )}{" "}
          into{" "}
          <a href={`/spaces`} className="font-semibold underline">
            {result.spaceName}
          </a>
          {result.spaceCreated ? " (new space)" : ""}.
          {result.skipped > 0 && (
            <>
              {" "}
              <strong>{result.skipped}</strong> skipped.
            </>
          )}
          {result.warnings.length > 0 && (
            <details className="mt-1">
              <summary className="cursor-pointer text-xs font-medium text-green-700">
                {result.warnings.length} note{result.warnings.length === 1 ? "" : "s"}
              </summary>
              <ul className="mt-1 list-disc pl-5 text-xs text-slate-600">
                {result.warnings.slice(0, 30).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
