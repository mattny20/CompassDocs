"use client";

// The Outlook task-pane app. Runs inside Outlook's webview (~320–450px wide),
// same-origin with the CompassDocs API, so the normal session cookie carries
// auth. Three states: loading → sign-in → workspace. In compose windows the
// results grow "Insert link" buttons (Office.js setSelectedDataAsync); in read
// windows and plain browsers those hide and everything opens in a new tab.

import { useCallback, useEffect, useMemo, useState } from "react";
import Script from "next/script";
import ReactMarkdown from "react-markdown";
import { Search, Sparkles, ExternalLink, CornerDownLeft, LogOut } from "lucide-react";

/* global Office */
declare const Office: any;

interface Summary {
  user: { name: string };
  org: string;
  accent: string;
  recent: { id: number; title: string; space_name: string; space_icon: string }[];
}

interface Hit {
  id: number;
  title: string;
  space_name: string;
  space_icon: string;
  snippet?: string;
}

interface Answer {
  answer: string;
  sources: { id: number; title: string }[];
}

function officeReady(): boolean {
  return typeof Office !== "undefined" && Boolean(Office?.context?.mailbox);
}

function canInsert(): boolean {
  try {
    return officeReady() && typeof Office.context.mailbox.item?.body?.setSelectedDataAsync === "function";
  } catch {
    return false;
  }
}

function insertHtml(html: string, done: (ok: boolean) => void) {
  try {
    Office.context.mailbox.item.body.setSelectedDataAsync(
      html,
      { coercionType: Office.CoercionType.Html },
      (res: any) => done(res?.status === Office.AsyncResultStatus.Succeeded)
    );
  } catch {
    done(false);
  }
}

const mdToBasicHtml = (md: string) =>
  md
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/\*(.+?)\*/g, "<i>$1</i>")
    .replace(/^#+\s*(.+)$/gm, "<b>$1</b>")
    .replace(/\n/g, "<br>");

export function OutlookPane() {
  const [state, setState] = useState<"loading" | "auth" | "ready">("loading");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState<"" | "search" | "ask">("");
  const [flash, setFlash] = useState("");
  const [compose, setCompose] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/addin/summary");
    if (res.status === 401) {
      setState("auth");
      return;
    }
    if (res.ok) {
      setSummary(await res.json());
      setState("ready");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    // Re-check compose capability once Office.js lands (script is async).
    const t = setInterval(() => {
      if (officeReady()) {
        setCompose(canInsert());
        clearInterval(t);
      }
    }, 300);
    setTimeout(() => clearInterval(t), 8000);
    return () => clearInterval(t);
  }, [state]);

  async function search() {
    if (!q.trim()) return;
    setBusy("search");
    setAnswer(null);
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=8`);
    setHits(res.ok ? (await res.json()).hits : []);
    setBusy("");
  }

  async function ask() {
    if (!q.trim()) return;
    setBusy("ask");
    setHits(null);
    const res = await fetch("/api/ai-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q }),
    });
    const data = res.ok ? await res.json() : null;
    setAnswer(data && data.answer ? { answer: data.answer, sources: data.sources ?? [] } : null);
    if (data && !data.answer) setHits(data.sources ?? []);
    setBusy("");
  }

  function note(msg: string) {
    setFlash(msg);
    setTimeout(() => setFlash(""), 1800);
  }

  const docUrl = (id: number) => `${window.location.origin}/doc/${id}`;

  function insertDocLink(d: { id: number; title: string }) {
    insertHtml(`<a href="${docUrl(d.id)}">${d.title}</a>`, (ok) =>
      note(ok ? "Link inserted." : "Couldn't insert — click into the email body first.")
    );
  }

  function insertAnswer() {
    if (!answer) return;
    const src = answer.sources
      .map((s) => `<a href="${docUrl(s.id)}">${s.title}</a>`)
      .join(" &middot; ");
    insertHtml(
      `<div>${mdToBasicHtml(answer.answer)}${src ? `<br><br><span style="font-size:12px;color:#64748b">Sources: ${src}</span>` : ""}</div>`,
      (ok) => note(ok ? "Answer inserted." : "Couldn't insert — click into the email body first.")
    );
  }

  function signIn() {
    const url = `${window.location.origin}/addin/outlook/auth`;
    if (officeReady() && Office.context.ui?.displayDialogAsync) {
      Office.context.ui.displayDialogAsync(url, { height: 60, width: 30 }, (res: any) => {
        const dialog = res?.value;
        if (!dialog) return;
        dialog.addEventHandler(Office.EventType.DialogMessageReceived, (arg: any) => {
          if (arg?.message === "compassdocs-auth-ok") {
            dialog.close();
            load();
          }
        });
      });
    } else {
      // Plain-browser fallback (dev/testing): open in a popup and poll.
      const w = window.open(url, "compassdocs-auth", "width=420,height=560");
      const t = setInterval(async () => {
        if (w?.closed) {
          clearInterval(t);
          load();
        }
      }, 800);
    }
  }

  const header = useMemo(
    () => (
      <div
        className="flex items-center justify-between px-3 py-2 text-white"
        style={{ background: summary?.accent || "#2e75bd" }}
      >
        <span className="flex items-center gap-2 text-sm font-semibold">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/addin/icon-32.png" alt="" className="h-5 w-5" />
          {summary?.org || "CompassDocs"}
        </span>
        {state === "ready" && (
          <button
            title="Sign out"
            className="opacity-80 hover:opacity-100"
            onClick={async () => {
              await fetch("/api/auth/logout", { method: "POST" });
              setSummary(null);
              setState("auth");
            }}
          >
            <LogOut className="h-4 w-4" />
          </button>
        )}
      </div>
    ),
    [summary, state]
  );

  return (
    <div className="min-h-screen bg-surface text-slate-800">
      <Script src="https://appsforoffice.microsoft.com/lib/1/hosted/office.js" strategy="afterInteractive" />
      {header}

      {state === "loading" && <p className="p-4 text-sm text-slate-400">Loading…</p>}

      {state === "auth" && (
        <div className="p-4">
          <p className="mb-3 text-sm text-slate-600">
            Sign in to search your knowledge base and insert document links without leaving Outlook.
          </p>
          <button
            onClick={signIn}
            className="w-full rounded-lg bg-compass-600 px-3 py-2 text-sm font-semibold text-white hover:bg-compass-700"
          >
            Sign in to CompassDocs
          </button>
          <p className="mt-3 text-xs text-slate-400">
            A sign-in window will open — your usual password or single sign-on works.
          </p>
        </div>
      )}

      {state === "ready" && summary && (
        <div className="p-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              search();
            }}
            className="flex gap-1.5"
          >
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search or ask a question…"
              className="min-w-0 flex-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm focus:border-compass-400 focus:outline-none"
            />
            <button type="submit" title="Search" disabled={!!busy} className="rounded-lg border border-slate-200 px-2 hover:bg-slate-50">
              <Search className="h-4 w-4 text-slate-500" />
            </button>
            <button type="button" title="Ask AI" disabled={!!busy} onClick={ask} className="rounded-lg bg-compass-600 px-2 text-white hover:bg-compass-700">
              <Sparkles className="h-4 w-4" />
            </button>
          </form>

          {flash && <p className="mt-2 rounded bg-green-50 px-2 py-1 text-xs text-green-700">{flash}</p>}
          {busy && <p className="mt-3 text-sm text-slate-400">{busy === "ask" ? "Thinking…" : "Searching…"}</p>}

          {answer && (
            <div className="mt-3 rounded-lg border border-compass-100 bg-compass-50/50 p-3">
              <div className="prose prose-sm max-w-none text-[13px] leading-snug text-slate-700">
                <ReactMarkdown>{answer.answer}</ReactMarkdown>
              </div>
              {answer.sources.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {answer.sources.map((s) => (
                    <a
                      key={s.id}
                      href={docUrl(s.id)}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-xs text-slate-600 hover:border-compass-400"
                    >
                      {s.title}
                    </a>
                  ))}
                </div>
              )}
              {compose && (
                <button
                  onClick={insertAnswer}
                  className="mt-2 flex items-center gap-1 rounded-lg bg-compass-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-compass-700"
                >
                  <CornerDownLeft className="h-3.5 w-3.5" /> Insert answer into email
                </button>
              )}
            </div>
          )}

          {hits && (
            <ul className="mt-3 space-y-2">
              {hits.length === 0 && <li className="text-sm text-slate-400">No results.</li>}
              {hits.map((h) => (
                <DocRow key={h.id} id={h.id} title={h.title} meta={`${h.space_icon} ${h.space_name}`} snippet={h.snippet} compose={compose} onInsert={insertDocLink} docUrl={docUrl} />
              ))}
            </ul>
          )}

          {!hits && !answer && !busy && (
            <>
              <p className="mb-1.5 mt-4 text-xs font-semibold uppercase tracking-wide text-slate-400">Recently updated</p>
              <ul className="space-y-2">
                {summary.recent.map((d) => (
                  <DocRow key={d.id} id={d.id} title={d.title} meta={`${d.space_icon} ${d.space_name}`} compose={compose} onInsert={insertDocLink} docUrl={docUrl} />
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function DocRow({
  id,
  title,
  meta,
  snippet,
  compose,
  onInsert,
  docUrl,
}: {
  id: number;
  title: string;
  meta: string;
  snippet?: string;
  compose: boolean;
  onInsert: (d: { id: number; title: string }) => void;
  docUrl: (id: number) => string;
}) {
  return (
    <li className="rounded-lg border border-slate-200 bg-white p-2.5">
      <p className="text-sm font-semibold leading-tight text-slate-800">{title}</p>
      <p className="mt-0.5 text-xs text-slate-400">{meta}</p>
      {snippet && (
        <p
          className="mt-1 text-xs leading-snug text-slate-500 [&_mark]:bg-amber-100 [&_mark]:px-0.5"
          dangerouslySetInnerHTML={{ __html: snippet }}
        />
      )}
      <div className="mt-1.5 flex gap-2">
        <a
          href={docUrl(id)}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 text-xs font-medium text-compass-700 hover:underline"
        >
          <ExternalLink className="h-3 w-3" /> Open
        </a>
        {compose && (
          <button
            onClick={() => onInsert({ id, title })}
            className="flex items-center gap-1 text-xs font-medium text-compass-700 hover:underline"
          >
            <CornerDownLeft className="h-3 w-3" /> Insert link
          </button>
        )}
      </div>
    </li>
  );
}

/** Dialog page body: report success to the pane, or show a mini login form. */
export function AddinAuthClient({ authed }: { authed: boolean }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!authed) return;
    setDone(true);
    // Tell the task pane we're signed in (when opened as an Office dialog).
    const t = setInterval(() => {
      try {
        if (typeof Office !== "undefined" && Office?.context?.ui?.messageParent) {
          Office.context.ui.messageParent("compassdocs-auth-ok");
          clearInterval(t);
        }
      } catch {
        /* not in an Office dialog — plain window; user closes it */
      }
    }, 300);
    setTimeout(() => clearInterval(t), 6000);
    return () => clearInterval(t);
  }, [authed]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (res.ok) {
      window.location.reload(); // page re-renders authed → messageParent fires
      return;
    }
    const data = await res.json().catch(() => ({}));
    setError(data?.error || "Sign-in failed.");
    setBusy(false);
  }

  return (
    <div className="min-h-screen bg-surface p-5">
      <Script src="https://appsforoffice.microsoft.com/lib/1/hosted/office.js" strategy="afterInteractive" />
      <div className="mx-auto max-w-xs">
        <p className="mb-4 flex items-center gap-2 font-semibold text-slate-800">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/addin/icon-32.png" alt="" className="h-6 w-6" /> CompassDocs
        </p>
        {done ? (
          <p className="text-sm text-slate-600">
            ✓ Signed in. You can close this window and return to Outlook.
          </p>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            {error && <p className="text-sm text-red-600">{error}</p>}
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Username"
              autoComplete="username"
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-compass-400 focus:outline-none"
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              autoComplete="current-password"
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-compass-400 focus:outline-none"
            />
            <button
              disabled={busy || !username || !password}
              className="w-full rounded-lg bg-compass-600 px-3 py-2 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-50"
            >
              {busy ? "Signing in…" : "Sign in"}
            </button>
            <p className="text-xs text-slate-400">
              Uses your normal CompassDocs account. If your team signs in with single sign-on,{" "}
              <a href="/login" className="text-compass-700 underline">
                use the full sign-in page
              </a>{" "}
              — then close this window and click Sign in again.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
