"use client";

// Who sees the built-in contact columns. Custom fields carry their own
// "who sees it" in their settings; email, phone and mobile are columns,
// not fields, so they are set here.

import { useState } from "react";
import { EyeOff } from "lucide-react";
import { Field, Select } from "@/components/form";
import { toast } from "@/components/Toasts";
import { CONTACT_COLUMNS, type ColumnVisibility, type Visibility } from "@/lib/directory-visibility";
import { jsonFetch } from "./shared";

const LABEL: Record<(typeof CONTACT_COLUMNS)[number], string> = { email: "Email", phone: "Phone", mobile: "Mobile" };

export function ContactVisibilityPanel({ initial }: { initial: ColumnVisibility }) {
  const [v, setV] = useState<ColumnVisibility>(initial);
  const [busy, setBusy] = useState(false);

  async function set(column: (typeof CONTACT_COLUMNS)[number], value: Visibility) {
    const next = { ...v, [column]: value };
    if (value === "everyone") delete next[column];
    setV(next);
    setBusy(true);
    const r = await jsonFetch("/api/admin/directory/list-columns", { method: "PUT", body: JSON.stringify({ column_visibility: next }) });
    setBusy(false);
    if (!r.ok) {
      toast("error", r.data?.error || "Could not save.");
      setV(v);
      return;
    }
    setV(r.data.column_visibility ?? next);
    toast("ok", `${LABEL[column]} is now for ${value === "admins" ? "admins only" : "everyone"}.`);
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
      <h3 className="mb-1 flex items-center gap-2 font-semibold text-slate-900">
        <EyeOff className="h-4 w-4 text-compass-600" aria-hidden /> Contact details
      </h3>
      <p className="mb-3 text-sm text-slate-500">
        Who sees each contact column. <em>Admins only</em> keeps it out of the directory, profiles, exports and contact
        cards for everyone else — a mobile number the whole firm should not have. Name, title, department and office
        are always shown; each custom field has its own setting in its row above.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        {CONTACT_COLUMNS.map((c) => (
          <Field key={c} label={LABEL[c]}>
            <Select value={v[c] ?? "everyone"} onChange={(e) => set(c, e.target.value as Visibility)} className="w-full" disabled={busy} aria-label={`Who sees ${LABEL[c].toLowerCase()}`}>
              <option value="everyone">Everyone signed in</option>
              <option value="admins">Admins only</option>
            </Select>
          </Field>
        ))}
      </div>
    </div>
  );
}
