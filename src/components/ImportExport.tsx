"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ImportResult } from "@/lib/transfer";

export function ImportExport() {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState("");

  async function runImport() {
    const file = fileInput.current?.files?.[0];
    if (!file) {
      setError("Choose a .zip file first.");
      return;
    }
    setImporting(true);
    setError("");
    setResult(null);
    const body = new FormData();
    body.append("file", file);
    const res = await fetch("/api/import", { method: "POST", body });
    setImporting(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data?.error || "Import failed.");
      return;
    }
    setResult(data as ImportResult);
    router.refresh();
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {/* Export */}
      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
        <h3 className="mb-1 font-semibold text-slate-900">Export</h3>
        <p className="mb-3 text-sm text-slate-500">
          Download every document (including drafts) as a zip of Markdown files with
          front-matter metadata, organized by space.
        </p>
        <a
          href="/api/export"
          className="inline-flex items-center gap-1.5 rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-compass-700"
        >
          ⬇ Export all docs (.zip)
        </a>
      </div>

      {/* Import */}
      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
        <h3 className="mb-1 font-semibold text-slate-900">Import</h3>
        <p className="mb-3 text-sm text-slate-500">
          Upload a CompassDocs export (or any zip of front-matter Markdown). Matching
          documents are updated; new ones and missing spaces are created.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            accept=".zip,application/zip"
            onChange={(e) => {
              setFileName(e.target.files?.[0]?.name ?? "");
              setResult(null);
              setError("");
            }}
            className="block w-full text-sm text-slate-500 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
          />
          <button
            onClick={runImport}
            disabled={importing || !fileName}
            className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-compass-700 disabled:opacity-50"
          >
            {importing ? "Importing…" : "Import"}
          </button>
        </div>

        {error && (
          <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        )}
        {result && (
          <div className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">
            Imported: <strong>{result.created}</strong> created,{" "}
            <strong>{result.updated}</strong> updated, <strong>{result.spacesCreated}</strong>{" "}
            space{result.spacesCreated === 1 ? "" : "s"} created
            {result.skipped > 0 && (
              <>
                , <strong>{result.skipped}</strong> skipped
              </>
            )}
            .
            {result.errors.length > 0 && (
              <details className="mt-1">
                <summary className="cursor-pointer text-xs font-medium text-green-700">
                  {result.errors.length} warning{result.errors.length === 1 ? "" : "s"}
                </summary>
                <ul className="mt-1 list-disc pl-5 text-xs text-slate-600">
                  {result.errors.slice(0, 30).map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
