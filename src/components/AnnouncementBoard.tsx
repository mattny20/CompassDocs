"use client";

// Dashboard block for organization announcements. Every user sees active
// messages; the ✕ dismisses one for that user only (admins archive for all
// from Settings → Announcements).

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Megaphone, TriangleAlert, Siren, X } from "lucide-react";

export interface AnnouncementView {
  id: number;
  title: string;
  body: string;
  level: "info" | "warning" | "critical";
  author_name: string;
  created_at: string;
  /** Optional in-app link ("/doc/12#comments") rendered as a button. */
  link?: string;
}

// Amber/red are literal Tailwind colors (they don't follow the CSS-variable
// theme like slate/compass do), and compass-900 stays dark in dark mode — so
// every piece needs an explicit dark: counterpart to stay legible.
const STYLE = {
  info: {
    box: "border-compass-200 bg-compass-50/70 dark:border-compass-100 dark:bg-compass-50/60",
    title: "text-compass-900 dark:text-compass-300",
    body: "text-compass-900/80 dark:text-slate-600",
    icon: <Megaphone className="h-4 w-4 text-compass-600 dark:text-compass-400" />,
  },
  warning: {
    box: "border-amber-300 bg-amber-50 dark:border-amber-700/60 dark:bg-amber-950/40",
    title: "text-amber-900 dark:text-amber-200",
    body: "text-amber-900/80 dark:text-amber-100/70",
    icon: <TriangleAlert className="h-4 w-4 text-amber-600 dark:text-amber-400" />,
  },
  critical: {
    box: "border-red-300 bg-red-50 dark:border-red-800/70 dark:bg-red-950/40",
    title: "text-red-900 dark:text-red-200",
    body: "text-red-900/80 dark:text-red-100/70",
    icon: <Siren className="h-4 w-4 text-red-600 dark:text-red-400" />,
  },
} as const;

export function AnnouncementBoard({ initial }: { initial: AnnouncementView[] }) {
  const router = useRouter();
  const [items, setItems] = useState(initial);
  if (items.length === 0) return null;

  async function dismiss(id: number) {
    setItems((prev) => prev.filter((a) => a.id !== id));
    await fetch(`/api/announcements/${id}/dismiss`, { method: "POST" }).catch(() => {});
    // Re-render server components so the sidebar's unread badge follows.
    router.refresh();
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
                {a.link && (
                  <a
                    href={a.link}
                    className="mt-2 inline-block rounded-lg border border-compass-200 bg-white/70 px-3 py-1 text-xs font-semibold text-compass-700 hover:bg-white dark:border-compass-100 dark:bg-white/10 dark:text-compass-300"
                  >
                    View document →
                  </a>
                )}
                <p className="mt-2 text-xs text-slate-500">
                  {a.author_name} · {new Date(a.created_at).toLocaleDateString()}
                </p>
              </div>
              <button
                onClick={() => dismiss(a.id)}
                title="Dismiss for me"
                aria-label="Dismiss announcement"
                className="shrink-0 rounded-md p-1 text-slate-400 hover:bg-white/60 hover:text-slate-600 dark:hover:bg-white/10"
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
