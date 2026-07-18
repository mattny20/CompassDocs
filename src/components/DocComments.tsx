"use client";

// Comments under a document: flat thread + composer with @mention
// autocomplete. Type "@" and a few letters to get a picker of active users;
// selecting one inserts their name and queues them for notification (email +
// dashboard notice) when the comment posts. Admins can remove any comment;
// authors their own. Deleted comments keep their slot ("removed") so the
// thread stays coherent.

import { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquare, Trash2 } from "lucide-react";
import { timeAgo } from "@/lib/ui";

interface Mention {
  id: number;
  name: string;
}

interface CommentRow {
  id: number;
  user_id: number | null;
  author_name: string;
  body: string;
  created_at: string;
  deleted_at: string | null;
  deleted_by: string;
  mentions: Mention[];
}

interface MentionableUser {
  id: number;
  name: string;
  username: string;
}

/** Render a comment body with the @mentions highlighted. */
function BodyWithMentions({ body, mentions }: { body: string; mentions: Mention[] }) {
  if (mentions.length === 0) return <>{body}</>;
  // Split on any "@Name" occurrence (longest names first so "Sam Hill" wins
  // over "Sam").
  const names = [...mentions].sort((a, b) => b.name.length - a.name.length).map((m) => m.name);
  const pattern = new RegExp(
    `@(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "g"
  );
  const parts = body.split(pattern);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span
            key={i}
            className="rounded bg-compass-50 px-1 font-medium text-compass-700 dark:bg-compass-100 dark:text-compass-300"
          >
            @{part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

export function DocComments({
  docId,
  currentUserId,
  isAdmin,
}: {
  docId: number;
  currentUserId: number;
  isAdmin: boolean;
}) {
  const [comments, setComments] = useState<CommentRow[] | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [body, setBody] = useState("");
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // @mention picker state
  const [users, setUsers] = useState<MentionableUser[] | null>(null);
  const [picker, setPicker] = useState<{ query: string; at: number } | null>(null);
  const [pickerIndex, setPickerIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/documents/${docId}/comments`);
    if (!res.ok) return;
    const data = await res.json();
    setEnabled(data.enabled);
    setComments(data.comments ?? []);
  }, [docId]);

  useEffect(() => {
    load();
  }, [load]);

  async function ensureUsers(): Promise<MentionableUser[]> {
    if (users) return users;
    const res = await fetch("/api/users/mentionable");
    const data = res.ok ? await res.json() : { users: [] };
    setUsers(data.users);
    return data.users;
  }

  function onBodyChange(next: string, caret: number) {
    setBody(next);
    // Look backwards from the caret for an "@query" being typed.
    const upToCaret = next.slice(0, caret);
    const m = upToCaret.match(/(^|\s)@([\p{L}\p{N} ._-]{0,30})$/u);
    if (m) {
      void ensureUsers();
      setPicker({ query: m[2], at: caret - m[2].length - 1 });
      setPickerIndex(0);
    } else {
      setPicker(null);
    }
  }

  const suggestions =
    picker && users
      ? users
          .filter(
            (u) =>
              u.id !== currentUserId &&
              (u.name.toLowerCase().includes(picker.query.toLowerCase()) ||
                u.username.toLowerCase().includes(picker.query.toLowerCase()))
          )
          .slice(0, 6)
      : [];

  function pick(u: MentionableUser) {
    if (!picker) return;
    const display = u.name || u.username;
    const before = body.slice(0, picker.at);
    const after = body.slice(picker.at + 1 + picker.query.length);
    const next = `${before}@${display} ${after}`;
    setBody(next);
    setMentions((prev) => (prev.some((m) => m.id === u.id) ? prev : [...prev, { id: u.id, name: display }]));
    setPicker(null);
    textareaRef.current?.focus();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim() || saving) return;
    setSaving(true);
    setError("");
    // Only send mention ids whose @Name still appears in the body (they may
    // have been edited out after picking).
    const stillMentioned = mentions.filter((m) => body.includes(`@${m.name}`));
    const res = await fetch(`/api/documents/${docId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body, mention_ids: stillMentioned.map((m) => m.id) }),
    });
    const data = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) {
      setError(data?.error || "Failed to post the comment.");
      return;
    }
    setBody("");
    setMentions([]);
    setComments((prev) => [...(prev ?? []), data.comment]);
  }

  async function remove(id: number) {
    if (!window.confirm("Remove this comment?")) return;
    const res = await fetch(`/api/comments/${id}`, { method: "DELETE" });
    if (res.ok) await load();
  }

  if (!enabled || comments === null) return null;

  return (
    <section id="comments" className="mt-10 border-t border-slate-100 pt-6 print:hidden">
      <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-slate-900">
        <MessageSquare className="h-5 w-5 text-slate-400" />
        Comments
        {comments.length > 0 && (
          <span className="text-sm font-normal text-slate-400">({comments.filter((c) => !c.deleted_at).length})</span>
        )}
      </h2>

      <ul className="space-y-4">
        {comments.map((c) => (
          <li key={c.id} className="rounded-xl border border-slate-200 bg-surface px-4 py-3">
            {c.deleted_at ? (
              <p className="text-sm italic text-slate-400">Comment removed by {c.deleted_by || "a moderator"}.</p>
            ) : (
              <>
                <div className="mb-1 flex items-baseline justify-between gap-3">
                  <span className="text-sm font-semibold text-slate-800">{c.author_name}</span>
                  <span className="flex items-center gap-3 text-xs text-slate-400">
                    {timeAgo(c.created_at)}
                    {(isAdmin || c.user_id === currentUserId) && (
                      <button
                        onClick={() => remove(c.id)}
                        title={isAdmin && c.user_id !== currentUserId ? "Remove (moderation)" : "Delete your comment"}
                        className="text-slate-300 hover:text-red-600"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </span>
                </div>
                <p className="whitespace-pre-line text-sm text-slate-700">
                  <BodyWithMentions body={c.body} mentions={c.mentions} />
                </p>
              </>
            )}
          </li>
        ))}
        {comments.length === 0 && (
          <li className="text-sm text-slate-400">No comments yet — start the discussion.</li>
        )}
      </ul>

      <form onSubmit={submit} className="relative mt-4">
        {error && <div className="mb-2 text-sm text-red-600">{error}</div>}
        <textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => onBodyChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
          onKeyDown={(e) => {
            if (picker && suggestions.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setPickerIndex((i) => (i + 1) % suggestions.length);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setPickerIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
              } else if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pick(suggestions[pickerIndex]);
              } else if (e.key === "Escape") {
                setPicker(null);
              }
            }
          }}
          rows={3}
          maxLength={4000}
          placeholder="Add a comment… type @ to mention someone (they'll be notified)"
          className="w-full rounded-xl border border-slate-200 bg-surface px-3 py-2 text-sm text-slate-800 focus:border-compass-400 focus:outline-none"
        />
        {picker && suggestions.length > 0 && (
          <ul className="absolute bottom-full left-0 z-20 mb-1 w-72 overflow-hidden rounded-lg border border-slate-200 bg-surface shadow-lg">
            {suggestions.map((u, i) => (
              <li key={u.id}>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(u);
                  }}
                  className={`block w-full px-3 py-1.5 text-left text-sm ${
                    i === pickerIndex ? "bg-compass-50 text-compass-800" : "text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  {u.name || u.username}
                  {u.name && <span className="ml-2 text-xs text-slate-400">{u.username}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex items-center justify-between">
          <span className="text-xs text-slate-400">
            {mentions.filter((m) => body.includes(`@${m.name}`)).length > 0 &&
              `Will notify: ${mentions
                .filter((m) => body.includes(`@${m.name}`))
                .map((m) => m.name)
                .join(", ")}`}
          </span>
          <button
            type="submit"
            disabled={saving || !body.trim()}
            className="rounded-lg bg-compass-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-compass-700 disabled:opacity-50"
          >
            {saving ? "Posting…" : "Comment"}
          </button>
        </div>
      </form>
    </section>
  );
}
