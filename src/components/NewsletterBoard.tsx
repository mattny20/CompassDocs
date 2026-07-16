"use client";

// Dashboard block for recently sent newsletters: every user sees pieces from
// the last few days until they dismiss them (per-user, like announcements).

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Mail, X } from "lucide-react";

export interface NewsletterCard {
  id: number;
  subject: string;
  author_name: string;
  sent_at: string;
}

export function NewsletterBoard({ initial }: { initial: NewsletterCard[] }) {
  const router = useRouter();
  const [items, setItems] = useState(initial);
  if (items.length === 0) return null;

  async function dismiss(id: number) {
    setItems((prev) => prev.filter((n) => n.id !== id));
    await fetch(`/api/newsletter/${id}/dismiss`, { method: "POST" }).catch(() => {});
    // Re-render server components so the sidebar's unread badge follows.
    router.refresh();
  }

  return (
    <div className="mb-6 space-y-3">
      {items.map((n) => (
        <div
          key={n.id}
          className="rounded-xl border border-compass-200 bg-compass-50/70 p-4 dark:border-compass-100 dark:bg-compass-50/60"
        >
          <div className="flex items-start gap-3">
            <span className="mt-0.5 shrink-0">
              <Mail className="h-4 w-4 text-compass-600 dark:text-compass-400" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold uppercase tracking-wider text-compass-600/80 dark:text-compass-400/90">
                Newsletter
              </p>
              <Link
                href={`/newsletter/${n.id}`}
                className="font-semibold text-compass-900 hover:underline dark:text-compass-300"
              >
                {n.subject}
              </Link>
              <p className="mt-1 text-xs text-slate-500">
                {n.author_name} · {new Date(n.sent_at).toLocaleDateString()} ·{" "}
                <Link href={`/newsletter/${n.id}`} className="underline hover:no-underline">
                  read it here
                </Link>
              </p>
            </div>
            <button
              onClick={() => dismiss(n.id)}
              title="Dismiss for me"
              aria-label="Dismiss newsletter"
              className="shrink-0 rounded-md p-1 text-slate-400 hover:bg-white/60 hover:text-slate-600 dark:hover:bg-white/10"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
