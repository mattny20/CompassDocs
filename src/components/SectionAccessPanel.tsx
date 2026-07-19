"use client";

import { useState } from "react";
import { Megaphone, ShieldCheck } from "lucide-react";
import { EntityPicker } from "@/components/EntityPicker";

// Settings → Section access: grant non-admins the operational sections that
// live in the main navigation (Announcements, Compliance), per user or group.

interface SectionRow {
  key: string;
  label: string;
  description: string;
  users: number[];
  groups: number[];
}
interface PickUser {
  id: number;
  name: string;
  username: string;
  role: string;
}
interface PickGroup {
  id: number;
  name: string;
  member_count: number;
}

const ICONS: Record<string, React.ReactNode> = {
  announcements: <Megaphone className="h-4 w-4" />,
  compliance: <ShieldCheck className="h-4 w-4" />,
};

export function SectionAccessPanel({
  initial,
  users,
  groups,
}: {
  initial: SectionRow[];
  users: PickUser[];
  groups: PickGroup[];
}) {
  const [sections, setSections] = useState<SectionRow[]>(initial);
  const [busyKey, setBusyKey] = useState("");
  const [message, setMessage] = useState<{ key: string; tone: "ok" | "error"; text: string } | null>(
    null
  );

  async function save(section: SectionRow) {
    setBusyKey(section.key);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/section-access", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ section: section.key, users: section.users, groups: section.groups }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ key: section.key, tone: "error", text: data.error || "Save failed." });
      } else {
        setMessage({ key: section.key, tone: "ok", text: "Saved — access applies immediately." });
      }
    } catch {
      setMessage({ key: section.key, tone: "error", text: "Save failed." });
    }
    setBusyKey("");
  }

  function update(key: string, patch: Partial<SectionRow>) {
    setSections((all) => all.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">Section access</h2>
        <p className="mt-1 max-w-2xl text-sm text-slate-500">
          Announcements and Compliance live in the main navigation. Admins always have access;
          grant them here to individual people or groups so a comms lead or HR manager can run
          them without the admin role. Granted users see the section appear in their sidebar.
        </p>
      </div>

      {sections.map((s) => {
        const msg = message?.key === s.key ? message : null;
        return (
          <div key={s.key} className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
            <div className="mb-1 flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-compass-50 text-compass-600">
                {ICONS[s.key]}
              </span>
              <div>
                <h3 className="font-semibold text-slate-900">{s.label}</h3>
                <p className="text-sm text-slate-500">{s.description}</p>
              </div>
            </div>

            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <div>
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">
                  People
                </span>
                <EntityPicker
                  options={users
                    .filter((u) => u.role !== "admin")
                    .map((u) => ({ id: u.id, label: u.name, sublabel: `${u.username} · ${u.role}` }))}
                  value={s.users}
                  onChange={(ids) => update(s.key, { users: ids })}
                  placeholder="Search people…"
                />
              </div>
              <div>
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">
                  Groups
                </span>
                <EntityPicker
                  options={groups.map((g) => ({
                    id: g.id,
                    label: g.name,
                    sublabel: `${g.member_count} member${g.member_count === 1 ? "" : "s"}`,
                  }))}
                  value={s.groups}
                  onChange={(ids) => update(s.key, { groups: ids })}
                  placeholder="Search groups…"
                />
              </div>
            </div>

            <div className="mt-3 flex items-center gap-3">
              <button
                onClick={() => save(s)}
                disabled={busyKey === s.key}
                className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-medium text-white hover:bg-compass-700 disabled:opacity-60"
              >
                {busyKey === s.key ? "Saving…" : "Save"}
              </button>
              {msg && (
                <span className={`text-sm ${msg.tone === "ok" ? "text-green-600" : "text-red-600"}`}>
                  {msg.text}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
