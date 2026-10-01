"use client";

// Export a fixed set of people — a team page — through the same route the
// directory's Export menu uses.

import { useState } from "react";
import { Download, FileText, Table2, Contact } from "lucide-react";
import { toast } from "@/components/Toasts";

export function ExportPeopleButtons({ ids, groupBy = "", title }: { ids: number[]; groupBy?: string; title?: string }) {
  const [busy, setBusy] = useState<string>("");
  async function run(format: "pdf" | "csv" | "vcf") {
    setBusy(format);
    try {
      const res = await fetch("/api/directory/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, format, group_by: groupBy, sort: "name", sort_dir: "asc", title }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast("error", data?.error || "The export failed.");
        return;
      }
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") || "")?.[1] || `team.${format}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      toast("error", "The export failed — check your connection and try again.");
    } finally {
      setBusy("");
    }
  }
  const btn = "inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-surface px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
        <Download className="h-3.5 w-3.5" aria-hidden /> Export
      </span>
      <button type="button" className={btn} onClick={() => run("pdf")} disabled={!!busy} data-tt="The team as a PDF sheet">
        <FileText className="h-4 w-4 text-slate-400" aria-hidden /> PDF
      </button>
      <button type="button" className={btn} onClick={() => run("csv")} disabled={!!busy} data-tt="The team as a spreadsheet">
        <Table2 className="h-4 w-4 text-slate-400" aria-hidden /> CSV
      </button>
      <button type="button" className={btn} onClick={() => run("vcf")} disabled={!!busy} data-tt="Everyone as contact cards">
        <Contact className="h-4 w-4 text-slate-400" aria-hidden /> Contacts
      </button>
    </div>
  );
}
