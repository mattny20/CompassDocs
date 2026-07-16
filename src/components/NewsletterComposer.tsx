"use client";

// Org newsletter composer: the same rich editor as documents, rendered
// server-side into a branded HTML email. Send a test to yourself first, then
// blast to everyone or selected groups.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Send, FlaskConical } from "lucide-react";
import { RichTextEditor } from "./RichTextEditor";

interface NewsletterRow {
  id: number;
  subject: string;
  author_name: string;
  audience: string;
  sent_count: number;
  created_at: string;
}

interface GroupLite {
  id: number;
  name: string;
  member_count: number;
}

const field =
  "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-compass-400 focus:ring-2 focus:ring-compass-100";

export function NewsletterComposer({
  initial,
  groups,
  smtpReady,
}: {
  initial: NewsletterRow[];
  groups: GroupLite[];
  smtpReady: boolean;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [mode, setMode] = useState<"all" | "groups">("all");
  const [groupIds, setGroupIds] = useState<number[]>([]);
  const [busy, setBusy] = useState<"" | "test" | "send">("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  async function submit(test: boolean) {
    if (!test) {
      const who =
        mode === "all"
          ? "every active user"
          : `members of ${groupIds.length} group${groupIds.length === 1 ? "" : "s"}`;
      if (!confirm(`Send this newsletter to ${who}? This can't be undone.`)) return;
    }
    setBusy(test ? "test" : "send");
    setError("");
    setDone("");
    const res = await fetch("/api/admin/newsletter", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subject,
        body,
        mode,
        group_ids: mode === "groups" ? groupIds : [],
        test,
      }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy("");
    if (!res.ok) {
      setError(data?.error || "Sending failed.");
      return;
    }
    if (test) {
      setDone("Test sent to your inbox — check how it looks before the real send.");
    } else {
      setDone(`Newsletter sent to ${data.sent} ${data.sent === 1 ? "person" : "people"}.`);
      setSubject("");
      setBody("");
      setMode("all");
      setGroupIds([]);
      const list = await fetch("/api/admin/newsletter");
      if (list.ok) setRows((await list.json()).newsletters);
      router.refresh();
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Newsletter</h1>
        <p className="mt-1 text-sm text-slate-500">
          Write with the same editor as documents; it&apos;s sent as a branded HTML email
          (your logo and accent color) with a plain-text fallback. Send yourself a test
          first.
        </p>
      </div>

      {!smtpReady && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Email needs SMTP — set it up under{" "}
          <a href="/admin/notifications" className="font-medium underline">Settings → Notifications</a>{" "}
          first.
        </div>
      )}

      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">Subject</span>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className={field}
              placeholder="July company update"
              maxLength={200}
            />
          </label>

          <div>
            <span className="mb-1 block text-xs font-medium text-slate-500">Content</span>
            <RichTextEditor value={body} onChange={setBody} />
            <p className="mt-1 text-xs text-slate-400">
              Tip: images linked from documents require sign-in and may not display in
              inboxes — externally hosted images work everywhere.
            </p>
          </div>

          <fieldset>
            <legend className="mb-1 text-xs font-medium text-slate-500">Recipients</legend>
            <div className="space-y-1.5 text-sm">
              <label className="flex cursor-pointer items-center gap-2">
                <input type="radio" name="nl_mode" checked={mode === "all"} onChange={() => setMode("all")} className="accent-compass-600" />
                Everyone (all active accounts)
              </label>
              <label className={`flex items-center gap-2 ${groups.length ? "cursor-pointer" : "opacity-50"}`}>
                <input type="radio" name="nl_mode" disabled={!groups.length} checked={mode === "groups"} onChange={() => setMode("groups")} className="accent-compass-600" />
                Selected groups only
              </label>
              {mode === "groups" && (
                <div className="ml-6 flex flex-wrap gap-x-4 gap-y-1 pt-1">
                  {groups.map((g) => (
                    <label key={g.id} className="flex cursor-pointer items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={groupIds.includes(g.id)}
                        onChange={(e) =>
                          setGroupIds((prev) =>
                            e.target.checked ? [...prev, g.id] : prev.filter((x) => x !== g.id)
                          )
                        }
                        className="accent-compass-600"
                      />
                      {g.name}
                      <span className="text-xs text-slate-400">{g.member_count}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </fieldset>

          {error && <p className="text-sm text-red-600">{error}</p>}
          {done && <p className="text-sm text-green-600">✓ {done}</p>}

          <div className="flex items-center gap-2">
            <button
              onClick={() => submit(true)}
              disabled={!!busy || !smtpReady || !subject.trim() || !body.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              <FlaskConical className="h-4 w-4" />
              {busy === "test" ? "Sending…" : "Send test to me"}
            </button>
            <button
              onClick={() => submit(false)}
              disabled={!!busy || !smtpReady || !subject.trim() || !body.trim() || (mode === "groups" && groupIds.length === 0)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-compass-700 disabled:opacity-50"
            >
              <Send className="h-4 w-4" />
              {busy === "send" ? "Sending…" : "Send newsletter"}
            </button>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
        <h2 className="mb-3 font-semibold text-slate-900">Sent</h2>
        {rows.length === 0 ? (
          <p className="text-sm text-slate-400">No newsletters sent yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center gap-3 py-2.5 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-slate-800">{r.subject}</p>
                  <p className="text-xs text-slate-400">
                    {r.author_name} · {new Date(r.created_at).toLocaleString()} · {r.audience}
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                  {r.sent_count} sent
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
