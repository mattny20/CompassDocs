"use client";

// Dashboard block for organization announcements. Every user sees active
// messages; the ✕ dismisses one for that user only (admins archive for all
// from Settings → Announcements).

import { useState } from "react";
import { Megaphone, TriangleAlert, Siren, X } from "lucide-react";

export interface AnnouncementView {
  id: number;
  title: string;
  body: string;
  level: "info" | "warning" | "critical";
  author_name: string;
  created_at: string;
}

const STYLE = {
  info: {
    box: "border-compass-200 bg-compass-50/70",
    title: "text-compass-900",
    body: "text-compass-900/80",
    icon: <Megaphone className="h-4 w-4 text-compass-600" />,
  },
  warning: {
    box: "border-amber-300 bg-amber-50",
    title: "text-amber-900",
    body: "text-amber-900/80",
    icon: <TriangleAlert className="h-4 w-4 text-amber-600" />,
  },
  critical: {
    box: "border-red-300 bg-red-50",
    title: "text-red-900",
    body: "text-red-900/80",
    icon: <Siren className="h-4 w-4 text-red-600" />,
  },
} as const;

export function AnnouncementBoard({ initial }: { initial: AnnouncementView[] }) {
  const [items, setItems] = useState(initial);
  if (items.length === 0) return null;

  async function dismiss(id: number) {
    setItems((prev) => prev.filter((a) => a.id !== id));
    await fetch(`/api/announcements/${id}/dismiss`, { method: "POST" }).catch(() => {});
  }

  return (
    <div className="mb-6 space-y-3">
      {items.map((a) => {
        const s = STYLE[a.level] ?? STYLE.info;
        return (
          <div key={a.id} className={`rounded-xl border p-4 ${s.box}`}>
            <div className="flex items-start gap-3">
              <span className="mt-0.5 shrink-0">{s.icon}</span>
              <div className="min-w-0 flex-1">
                <p className={`font-semibold ${s.title}`}>{a.title}</p>
                <p className={`mt-1 whitespace-pre-line text-sm ${s.body}`}>{a.body}</p>
                <p className="mt-2 text-xs text-slate-500">
                  {a.author_name} · {new Date(a.created_at).toLocaleDateString()}
                </p>
              </div>
              <button
                onClick={() => dismiss(a.id)}
                title="Dismiss for me"
                aria-label="Dismiss announcement"
                className="shrink-0 rounded-md p-1 text-slate-400 hover:bg-white/60 hover:text-slate-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
