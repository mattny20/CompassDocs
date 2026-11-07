"use client";

// Articles that might answer a request, under the portal request form's
// subject (Helpdesk 1.19.4, C3): from three typed characters, up to three
// public articles from /support/api/help/search, each opening in a new tab
// so the form keeps what was typed. The subject goes in a POST body (never
// the address) and is never stored or counted as a search. Opening an
// article starts or continues the tab's journey; raising the request
// afterwards ends it (the form sends the journey; the server records it).
// Nothing renders while there is nothing to suggest; while searching is
// rate-limited the last suggestions stay.

import { useEffect, useState } from "react";
import { BookOpen, ExternalLink } from "lucide-react";
import type { HelpSuggestion } from "@/lib/helpdesk/help-centre-shared";
import { ArticleLink } from "./HelpBits";

const MIN_QUERY = 3;

export function RequestSuggestions({ text }: { text: string }) {
  const [items, setItems] = useState<HelpSuggestion[]>([]);
  const query = text.trim();

  useEffect(() => {
    if (query.length < MIN_QUERY) {
      setItems([]);
      return;
    }
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/support/api/help/search", {
          method: "POST",
          signal: ctl.signal,
          credentials: "same-origin",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ q: query }),
        });
        const data = (await res.json().catch(() => ({}))) as { articles?: HelpSuggestion[] };
        if (ctl.signal.aborted || res.status === 429) return;
        setItems(res.ok ? (data.articles ?? []).slice(0, 3) : []);
      } catch {
        /* offline or aborted: keep what was shown */
      }
    }, 400);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [query]);

  if (!items.length) return null;
  return (
    <section aria-label="Articles that might help" className="rounded-xl border border-compass-200 bg-compass-50 px-3.5 py-3 dark:border-compass-500/40" data-testid="request-suggestions">
      <p className="text-sm font-semibold text-slate-800">These articles might answer it</p>
      <ul className="mt-1.5 space-y-1">
        {items.map((a) => (
          <li key={a.id}>
            <ArticleLink href={a.href} newTab className="inline-flex items-start gap-2 text-sm font-medium text-compass-700 hover:underline">
              <BookOpen className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                {a.title}
                <ExternalLink className="ml-1 inline h-3 w-3 align-[-0.1em] text-compass-600" aria-hidden />
                <span className="sr-only"> (opens in a new tab)</span>
              </span>
            </ArticleLink>
          </li>
        ))}
      </ul>
    </section>
  );
}
