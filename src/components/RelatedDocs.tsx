"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Link2, Plus, X } from "lucide-react";

// Related documents section of the doc side panel. Groups links by their
// direction-aware label ("Procedures", "Procedure for", "Supersedes", …).
// Editors add links with a kind picker + async document search; removing is
// one click. Everything round-trips through /api/documents/[id]/relations.

interface RelatedDoc {
  relation_id: number;
  kind: string;
  label: string;
  id: number;
  title: string;
  type: string;
  status: string;
  space_name: string;
  space_icon: string;
}

interface SearchHit {
  id: number;
  title: string;
  space_name: string;
  space_icon: string;
}

// Mirrors RELATION_KINDS in lib/relations.ts (client copy — labels only).
const KIND_OPTIONS: { value: string; label: string }[] = [
  { value: "related", label: "is related to" },
  { value: "procedure_for:out", label: "is a procedure for" },
  { value: "procedure_for:in", label: "has procedure" },
  { value: "supersedes:out", label: "supersedes" },
  { value: "supersedes:in", label: "is superseded by" },
];

export function RelatedDocs({
  docId,
  initial,
  canEdit,
}: {
  docId: number;
  initial: RelatedDoc[];
  canEdit: boolean;
}) {
  const [relations, setRelations] = useState<RelatedDoc[]>(initial);
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState(KIND_OPTIONS[0].value);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [error, setError] = useState("");
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Async doc search for the picker.
  useEffect(() => {
    if (!adding) return;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!query.trim()) {
      setHits([]);
      return;
    }
    searchTimer.current = setTimeout(async () => {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=8`);
      if (res.ok) {
        const data = await res.json();
        setHits(
          (data.hits ?? [])
            .filter((h: any) => h.id !== docId)
            .map((h: any) => ({ id: h.id, title: h.title, space_name: h.space_name, space_icon: h.space_icon }))
        );
      }
    }, 250);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [query, adding, docId]);

  async function link(target: SearchHit) {
    setError("");
    const [k, dir] = kind.includes(":") ? kind.split(":") : [kind, "out"];
    const res = await fetch(`/api/documents/${docId}/relations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_id: target.id, kind: k, direction: dir }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error || "Could not link.");
      return;
    }
    setRelations(data.relations);
    setQuery("");
    setHits([]);
    setAdding(false);
  }

  async function unlink(rid: number) {
    const res = await fetch(`/api/documents/${docId}/relations?rid=${rid}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (res.ok) setRelations(data.relations);
  }

  // Group by label, preserving first-seen order.
  const groups: { label: string; docs: RelatedDoc[] }[] = [];
  for (const r of relations) {
    const g = groups.find((x) => x.label === r.label);
    if (g) g.docs.push(r);
    else groups.push({ label: r.label, docs: [r] });
  }

  if (relations.length === 0 && !canEdit) return null;

  return (
    <section>
      <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-slate-400">
        <Link2 className="h-3.5 w-3.5" /> Related documents
      </h2>

      {groups.map((g) => (
        <div key={g.label} className="mb-3">
          <div className="mb-1 text-xs font-medium text-slate-400">{g.label}</div>
          <ul className="space-y-1">
            {g.docs.map((d) => (
              <li key={d.relation_id} className="group flex items-start gap-1.5">
                <Link
                  href={`/doc/${d.id}`}
                  className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 hover:text-compass-700"
                >
                  <span className="block truncate">{d.title}</span>
                  <span className="block truncate text-xs font-normal text-slate-400">
                    {d.space_icon} {d.space_name}
                    {d.status === "draft" ? " · draft" : ""}
                  </span>
                </Link>
                {canEdit && (
                  <button
                    onClick={() => unlink(d.relation_id)}
                    title="Remove link"
                    aria-label={`Remove link to ${d.title}`}
                    className="mt-1.5 rounded p-1 text-slate-300 opacity-0 transition hover:bg-red-50 hover:text-red-600 group-hover:opacity-100"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}

      {relations.length === 0 && (
        <p className="mb-2 text-sm text-slate-400">No linked documents yet.</p>
      )}

      {canEdit && !adding && (
        <button
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-compass-600 hover:bg-compass-50"
        >
          <Plus className="h-3.5 w-3.5" /> Link a document
        </button>
      )}

      {canEdit && adding && (
        <div className="rounded-lg border border-slate-200 p-2">
          <div className="mb-1.5 flex items-center gap-1 text-xs text-slate-500">
            <span>This document</span>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              aria-label="Relationship type"
              className="rounded-md border border-slate-200 bg-surface px-1.5 py-1 text-xs outline-none focus:border-compass-400"
            >
              {KIND_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search documents…"
            autoFocus
            className="w-full rounded-md border border-slate-200 bg-surface px-2 py-1.5 text-sm outline-none placeholder:text-slate-400 focus:border-compass-400"
          />
          {hits.length > 0 && (
            <ul className="mt-1 max-h-48 overflow-y-auto">
              {hits.map((h) => (
                <li key={h.id}>
                  <button
                    onClick={() => link(h)}
                    className="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-compass-50"
                  >
                    <span className="block truncate font-medium text-slate-700">{h.title}</span>
                    <span className="block truncate text-xs text-slate-400">
                      {h.space_icon} {h.space_name}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
          <button
            onClick={() => {
              setAdding(false);
              setQuery("");
              setError("");
            }}
            className="mt-1.5 text-xs font-medium text-slate-400 hover:text-slate-600"
          >
            Cancel
          </button>
        </div>
      )}
    </section>
  );
}
