"use client";

import { useRef, useState } from "react";
import { buttonClass } from "@/components/Button";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toasts";
import type { ImportResult } from "@/lib/transfer";
import { Download } from "lucide-react";

/** "3 policies" / "1 policy": the import's own count noun. */
function policies(n: number): string {
  return `${n} ${n === 1 ? "policy" : "policies"}`;
}

export function ImportExport() {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  // Off by default (H2, 1.11.0): an import cannot ask whether a change is
  // editorial, so a published document that requires read confirmation is
  // left unchanged unless the admin says otherwise.
  const [overwritePolicies, setOverwritePolicies] = useState(false);

  async function runImport() {
    const file = fileInput.current?.files?.[0];
    if (!file) {
      toast("error", "Choose a .zip file first.");
      return;
    }
    setImporting(true);
    setResult(null);
    const body = new FormData();
    body.append("file", file);
    if (overwritePolicies) body.append("overwrite_policies", "1");
    const res = await fetch("/api/import", { method: "POST", body });
    setImporting(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast("error", data?.error || "Import failed.");
      return;
    }
    setResult(data as ImportResult);
    router.refresh();
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {/* Export */}
      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
        <h3 className="mb-1 font-semibold text-slate-900">Export</h3>
        <p className="mb-3 text-sm text-slate-500">
          Download every document (including drafts) as a zip of Markdown files with
          front-matter metadata, organized by space.
        </p>
        <a
          href="/api/export"
          className={buttonClass("primary")}
        >
          <Download className="h-4 w-4" aria-hidden /> Export all documents (.zip)
        </a>
      </div>

      {/* Import */}
      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
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
            }}
            className="block w-full text-sm text-slate-500 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
          />
          <button
            onClick={runImport}
            disabled={importing || !fileName}
            className={buttonClass("primary")}
          >
            {importing ? "Importing…" : "Import"}
          </button>
        </div>
        {/* Native checkbox: the global accent-color rule paints it (STYLEGUIDE §Color and theming). */}
        <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={overwritePolicies}
            onChange={(e) => setOverwritePolicies(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300"
          />
          <span>
            Also overwrite documents that require read confirmation
            <span className="mt-0.5 block text-xs text-slate-500">
              Off, published documents that require read confirmation are left unchanged and listed
              below. On, such documents are overwritten and each one&apos;s edit default decides what
              readers see (under the recommended default everyone is asked to re-confirm).
            </span>
          </span>
        </label>

        {result && (
          <div className="notice-ok mt-3 rounded-lg px-3 py-2 text-sm">
            Imported: <strong>{result.created}</strong> created,{" "}
            <strong>{result.updated}</strong> updated, <strong>{result.spacesCreated}</strong>{" "}
            space{result.spacesCreated === 1 ? "" : "s"} created
            {result.skipped > 0 && (
              <>
                , <strong>{result.skipped}</strong> skipped
              </>
            )}
            .
            {/* What the import did to readers' confirmations (H2, 1.11.0), in people and policies. */}
            {(result.reconfirm_requested ?? 0) > 0 && (
              <span className="block">{policies(result.reconfirm_requested)} will ask people to re-confirm.</span>
            )}
            {(result.policies_skipped ?? 0) > 0 && (
              <span className="block">
                {policies(result.policies_skipped)} that {result.policies_skipped === 1 ? "requires" : "require"}{" "}
                read confirmation {result.policies_skipped === 1 ? "was" : "were"} left unchanged.
              </span>
            )}
            {result.errors.length > 0 && (
              <details className="mt-1">
                <summary className="cursor-pointer text-xs font-medium text-emerald-700">
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
