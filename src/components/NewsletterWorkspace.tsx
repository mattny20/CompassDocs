"use client";

// A single newsletter through its editorial life: the author drafts and
// submits, approvers comment / edit / send back or approve, and an approver
// (or admin) fires the actual send. One page, capabilities decided server-side
// and re-fetched after every action.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Send,
  FlaskConical,
  CheckCircle2,
  Undo2,
  Trash2,
  MessageSquare,
  Mail,
  Save,
  CalendarClock,
  X,
} from "lucide-react";
import { RichTextEditor } from "./RichTextEditor";
import { MarkdownView } from "./MarkdownView";
import { StatusBadge } from "./NewsletterList";

interface NewsletterDetail {
  id: number;
  subject: string;
  body: string;
  author_name: string;
  created_by: number | null;
  audience: string;
  sent_count: number;
  status: string;
  mode: string;
  group_ids: string;
  updated_at: string;
  sent_at: string | null;
  scheduled_at: string | null;
  from_address: string;
}

interface CommentRow {
  id: number;
  author_name: string;
  body: string;
  kind: string;
  created_at: string;
}

interface Caps {
  edit: boolean;
  submit: boolean;
  decide: boolean;
  send: boolean;
  comment: boolean;
  delete: boolean;
}

export interface DetailPayload {
  newsletter: NewsletterDetail;
  comments: CommentRow[];
  approver_ids: number[];
  can: Caps;
}

interface GroupLite {
  id: number;
  name: string;
  member_count: number;
}

interface ApproverLite {
  id: number;
  name: string;
  email: string;
}

const field =
  "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-compass-400 focus:ring-2 focus:ring-compass-100";

export function NewsletterWorkspace({
  initial,
  groups,
  approverPool,
  smtpReady,
  fromAddresses = [],
  hasModuleAccess = true,
}: {
  initial: DetailPayload;
  groups: GroupLite[];
  approverPool: ApproverLite[];
  smtpReady: boolean;
  /** Admin-curated sender list; empty hides the From picker. */
  fromAddresses?: string[];
  /** False for readers who only see sent pieces (no editorial thread). */
  hasModuleAccess?: boolean;
}) {
  const router = useRouter();
  const [n, setN] = useState(initial.newsletter);
  const [comments, setComments] = useState(initial.comments);
  const [approverIds, setApproverIds] = useState(initial.approver_ids);
  const [can, setCan] = useState(initial.can);

  // Editable copy of the content; `dirty` gates the workflow buttons so a
  // submit/approve always acts on what's saved, never on unsaved edits.
  const [subject, setSubject] = useState(initial.newsletter.subject);
  const [body, setBody] = useState(initial.newsletter.body);
  const [mode, setMode] = useState<"all" | "groups">(
    initial.newsletter.mode === "groups" ? "groups" : "all"
  );
  const [groupIds, setGroupIds] = useState<number[]>(
    (initial.newsletter.group_ids || "").split(",").map(Number).filter(Boolean)
  );
  const [pickedApprovers, setPickedApprovers] = useState<number[]>(initial.approver_ids);
  const [fromAddress, setFromAddress] = useState(initial.newsletter.from_address || "");

  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [decisionOpen, setDecisionOpen] = useState(false);
  const [decisionNote, setDecisionNote] = useState("");
  const [submitNote, setSubmitNote] = useState("");
  const [submitOpen, setSubmitOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");
  const [newComment, setNewComment] = useState("");

  const dirty =
    can.edit &&
    (subject !== n.subject ||
      body !== n.body ||
      mode !== (n.mode === "groups" ? "groups" : "all") ||
      groupIds.join(",") !== (n.group_ids || "").split(",").map(Number).filter(Boolean).join(",") ||
      fromAddress !== (n.from_address || "") ||
      pickedApprovers.join(",") !== approverIds.join(","));

  const apply = useCallback((data: DetailPayload) => {
    setN(data.newsletter);
    setComments(data.comments);
    setApproverIds(data.approver_ids);
    setCan(data.can);
    setSubject(data.newsletter.subject);
    setBody(data.newsletter.body);
    setMode(data.newsletter.mode === "groups" ? "groups" : "all");
    setGroupIds((data.newsletter.group_ids || "").split(",").map(Number).filter(Boolean));
    setPickedApprovers(data.approver_ids);
    setFromAddress(data.newsletter.from_address || "");
  }, []);

  async function refresh() {
    const res = await fetch(`/api/newsletter/${n.id}`);
    if (res.ok) apply(await res.json());
  }

  async function call(path: string, init: RequestInit, busyKey: string): Promise<any | null> {
    setBusy(busyKey);
    setError("");
    setNotice("");
    const res = await fetch(path, init);
    const data = await res.json().catch(() => ({}));
    setBusy("");
    if (!res.ok) {
      setError(data?.error || "That didn't work.");
      return null;
    }
    return data;
  }

  async function save(): Promise<boolean> {
    const data = await call(
      `/api/newsletter/${n.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject,
          body,
          mode,
          group_ids: mode === "groups" ? groupIds : [],
          from_address: fromAddress,
          approver_ids: pickedApprovers,
        }),
      },
      "save"
    );
    if (!data) return false;
    setN(data.newsletter);
    setApproverIds(data.approver_ids);
    setPickedApprovers(data.approver_ids);
    setNotice("Saved.");
    return true;
  }

  async function submitForReview() {
    const data = await call(
      `/api/newsletter/${n.id}/submit`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: submitNote.trim() }),
      },
      "submit"
    );
    if (!data) return;
    setSubmitOpen(false);
    setSubmitNote("");
    setNotice("Submitted — the approvers have been notified.");
    await refresh();
    router.refresh();
  }

  async function decide(action: "approve" | "request_changes") {
    if (action === "request_changes" && !decisionNote.trim()) {
      setError("Tell the author what to change — a note is required.");
      return;
    }
    const data = await call(
      `/api/newsletter/${n.id}/decision`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, note: decisionNote.trim() }),
      },
      action
    );
    if (!data) return;
    setDecisionOpen(false);
    setDecisionNote("");
    setNotice(action === "approve" ? "Approved — it can be sent now." : "Sent back to the author.");
    await refresh();
    router.refresh();
  }

  async function sendIt(test: boolean) {
    if (!test) {
      const who =
        mode === "all"
          ? "every active user"
          : `members of ${groupIds.length} group${groupIds.length === 1 ? "" : "s"}`;
      if (!confirm(`Send this newsletter to ${who}? This can't be undone.`)) return;
    }
    const data = await call(
      `/api/newsletter/${n.id}/send`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ test }),
      },
      test ? "test" : "send"
    );
    if (!data) return;
    if (test) {
      setNotice("Test sent to your inbox — check how it looks.");
    } else {
      setNotice(`Newsletter sent to ${data.sent} ${data.sent === 1 ? "person" : "people"}.`);
      await refresh();
      router.refresh();
    }
  }

  async function remove() {
    if (!confirm("Delete this newsletter? This can't be undone.")) return;
    const data = await call(`/api/newsletter/${n.id}`, { method: "DELETE" }, "delete");
    if (!data) return;
    router.push("/newsletter");
    router.refresh();
  }

  // Newsletter images are stored publicly (unguessable names) so they load in
  // recipients' inboxes without a session.
  async function uploadImage(file: File): Promise<string | null> {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/newsletter/assets", { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data?.error || "Image upload failed.");
      return null;
    }
    return data.url as string;
  }

  async function schedule(at: string | null) {
    const data = await call(
      `/api/newsletter/${n.id}/schedule`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ at: at ? new Date(at).toISOString() : null }),
      },
      "schedule"
    );
    if (!data) return;
    setScheduleOpen(false);
    setScheduleAt("");
    setNotice(
      at
        ? `Scheduled — it will go out ${new Date(at).toLocaleString()}.`
        : "Schedule cancelled."
    );
    await refresh();
    router.refresh();
  }

  async function postComment() {
    const text = newComment.trim();
    if (!text) return;
    const data = await call(
      `/api/newsletter/${n.id}/comments`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: text }),
      },
      "comment"
    );
    if (!data) return;
    setNewComment("");
    setComments((prev) => [...prev, data.comment]);
  }

  // Clear the transient "Saved." notice when edits resume.
  useEffect(() => {
    if (dirty) setNotice("");
  }, [dirty]);

  const showRecipients = can.edit;
  const isSent = n.status === "sent";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link
            href={hasModuleAccess ? "/newsletter" : "/"}
            className="inline-flex items-center gap-1 text-sm font-medium text-slate-500 hover:text-compass-600"
          >
            <ArrowLeft className="h-4 w-4" /> {hasModuleAccess ? "Newsletter" : "Dashboard"}
          </Link>
          <StatusBadge status={n.status} />
          <span className="text-xs text-slate-400">
            by {n.author_name}
            {n.sent_at ? ` · sent ${new Date(n.sent_at).toLocaleString()}` : ""}
          </span>
        </div>
        {can.delete && (
          <button
            onClick={remove}
            disabled={!!busy}
            title="Delete newsletter"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-500/10"
          >
            <Trash2 className="h-4 w-4" /> Delete
          </button>
        )}
      </div>

      {!smtpReady && !isSent && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          Email needs SMTP — an admin can set it up under{" "}
          <span className="font-medium">Settings → Notifications</span>. You can still draft
          and review in the meantime.
        </div>
      )}

      {n.scheduled_at && n.status === "approved" && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-500/30 dark:bg-green-500/10 dark:text-green-300">
          <span className="inline-flex items-center gap-1.5">
            <CalendarClock className="h-4 w-4" />
            Scheduled to send {new Date(n.scheduled_at).toLocaleString()}.
          </span>
          {can.send && (
            <button
              onClick={() => schedule(null)}
              disabled={!!busy}
              className="inline-flex items-center gap-1 font-medium underline hover:no-underline disabled:opacity-50"
            >
              <X className="h-3.5 w-3.5" /> Cancel schedule
            </button>
          )}
        </div>
      )}

      {/* Content: editable while the workflow allows it, read-only otherwise. */}
      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
        {can.edit ? (
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
              <RichTextEditor value={body} onChange={setBody} onUploadImage={uploadImage} emailBlocks />
              <p className="mt-1 text-xs text-slate-400">
                Images added here (uploaded, pasted, or dragged in) are hosted for inboxes
                and display for every recipient. Use the button and spacer blocks to shape
                the email.
              </p>
            </div>
          </div>
        ) : (
          <div>
            <h1 className="mb-4 text-2xl font-bold text-slate-900">
              {n.subject || <span className="italic text-slate-400">Untitled</span>}
            </h1>
            <MarkdownView content={n.body} />
          </div>
        )}
      </div>

      {/* Recipients + reviewers (editable alongside the content). */}
      {showRecipients && (
        <div className="grid gap-4 md:grid-cols-2">
          <fieldset className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
            <legend className="px-1 text-xs font-medium text-slate-500">Recipients</legend>
            {fromAddresses.length > 0 && (
              <label className="mb-3 block">
                <span className="mb-1 block text-xs font-medium text-slate-500">From</span>
                <select
                  value={fromAddress}
                  onChange={(e) => setFromAddress(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 bg-surface px-2 py-1.5 text-sm outline-none focus:border-compass-400"
                >
                  <option value="">Workspace default</option>
                  {fromAddresses.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="space-y-1.5 text-sm">
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="nl_mode"
                  checked={mode === "all"}
                  onChange={() => setMode("all")}
                  className="accent-compass-600"
                />
                Everyone (all active accounts)
              </label>
              <label
                className={`flex items-center gap-2 ${groups.length ? "cursor-pointer" : "opacity-50"}`}
              >
                <input
                  type="radio"
                  name="nl_mode"
                  disabled={!groups.length}
                  checked={mode === "groups"}
                  onChange={() => setMode("groups")}
                  className="accent-compass-600"
                />
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

          <fieldset className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
            <legend className="px-1 text-xs font-medium text-slate-500">Approvers</legend>
            {approverPool.length === 0 ? (
              <p className="text-sm text-slate-400">
                No approvers yet — an admin can grant the approver capability under
                Settings → Newsletter.
              </p>
            ) : (
              <>
                <p className="mb-2 text-xs text-slate-400">
                  Leave everyone unticked to let any approver review this one; tick names to
                  restrict it to specific reviewers.
                </p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  {approverPool.map((a) => (
                    <label key={a.id} className="flex cursor-pointer items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={pickedApprovers.includes(a.id)}
                        onChange={(e) =>
                          setPickedApprovers((prev) =>
                            e.target.checked ? [...prev, a.id] : prev.filter((x) => x !== a.id)
                          )
                        }
                        className="accent-compass-600"
                      />
                      {a.name}
                    </label>
                  ))}
                </div>
              </>
            )}
          </fieldset>
        </div>
      )}

      {/* Read-only audience summary once it's out of the author's hands. */}
      {!showRecipients && !isSent && (
        <p className="text-sm text-slate-500">
          Recipients:{" "}
          {n.mode === "groups"
            ? `selected groups (${(n.group_ids || "").split(",").filter(Boolean).length})`
            : "everyone"}
          {approverIds.length > 0
            ? ` · restricted to ${approverIds.length} approver${approverIds.length === 1 ? "" : "s"}`
            : ""}
        </p>
      )}

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {notice && <p className="text-sm text-green-600 dark:text-green-400">✓ {notice}</p>}

      {/* Action bar: what you can do next, given the state and your capability. */}
      {!isSent && (
        <div className="flex flex-wrap items-center gap-2">
          {can.edit && (
            <button
              onClick={save}
              disabled={!!busy || !dirty}
              className="inline-flex items-center gap-1.5 rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-compass-700 disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {busy === "save" ? "Saving…" : dirty ? "Save changes" : "Saved"}
            </button>
          )}
          {can.comment && (
            <button
              onClick={() => sendIt(true)}
              disabled={!!busy || dirty || !smtpReady || !n.subject.trim() || !n.body.trim()}
              title={dirty ? "Save your changes first" : undefined}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              <FlaskConical className="h-4 w-4" />
              {busy === "test" ? "Sending…" : "Send test to me"}
            </button>
          )}
          {can.submit && (
            <button
              onClick={() => setSubmitOpen((v) => !v)}
              disabled={!!busy || dirty || !n.subject.trim() || !n.body.trim()}
              title={dirty ? "Save your changes first" : undefined}
              className="inline-flex items-center gap-1.5 rounded-lg border border-compass-200 bg-compass-50 px-4 py-2 text-sm font-semibold text-compass-700 hover:bg-compass-100 disabled:opacity-50"
            >
              <Send className="h-4 w-4" /> Submit for review
            </button>
          )}
          {can.decide && (
            <button
              onClick={() => setDecisionOpen((v) => !v)}
              disabled={!!busy || dirty}
              title={dirty ? "Save your changes first" : undefined}
              className="inline-flex items-center gap-1.5 rounded-lg border border-compass-200 bg-compass-50 px-4 py-2 text-sm font-semibold text-compass-700 hover:bg-compass-100 disabled:opacity-50"
            >
              <CheckCircle2 className="h-4 w-4" /> Review decision
            </button>
          )}
          {can.send && (
            <button
              onClick={() => sendIt(false)}
              disabled={!!busy || dirty || !smtpReady}
              title={dirty ? "Save your changes first" : undefined}
              className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-green-700 disabled:opacity-50"
            >
              <Mail className="h-4 w-4" />
              {busy === "send" ? "Sending…" : "Send newsletter"}
            </button>
          )}
          {can.send && !n.scheduled_at && (
            <button
              onClick={() => setScheduleOpen((v) => !v)}
              disabled={!!busy || dirty || !smtpReady}
              title={dirty ? "Save your changes first" : "Pick a date and time for the send"}
              className="inline-flex items-center gap-1.5 rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-sm font-semibold text-green-700 hover:bg-green-100 disabled:opacity-50 dark:border-green-500/30 dark:bg-green-500/10 dark:text-green-300 dark:hover:bg-green-500/20"
            >
              <CalendarClock className="h-4 w-4" /> Schedule…
            </button>
          )}
        </div>
      )}

      {scheduleOpen && can.send && !n.scheduled_at && (
        <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">
              Send date &amp; time (your local time — delivered within a minute of it)
            </span>
            <input
              type="datetime-local"
              value={scheduleAt}
              onChange={(e) => setScheduleAt(e.target.value)}
              className={`${field} max-w-xs`}
            />
          </label>
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => schedule(scheduleAt)}
              disabled={!!busy || !scheduleAt}
              className="inline-flex items-center gap-1.5 rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-50"
            >
              <CalendarClock className="h-4 w-4" />
              {busy === "schedule" ? "Scheduling…" : "Confirm schedule"}
            </button>
            <button
              onClick={() => setScheduleOpen(false)}
              className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {submitOpen && can.submit && (
        <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">
              Note for the approvers (optional)
            </span>
            <textarea
              value={submitNote}
              onChange={(e) => setSubmitNote(e.target.value)}
              rows={2}
              className={field}
              placeholder="Anything the reviewers should know?"
            />
          </label>
          <div className="mt-2 flex gap-2">
            <button
              onClick={submitForReview}
              disabled={!!busy}
              className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-50"
            >
              {busy === "submit" ? "Submitting…" : "Confirm submit"}
            </button>
            <button
              onClick={() => setSubmitOpen(false)}
              className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {decisionOpen && can.decide && (
        <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">
              Note to the author (required when requesting changes)
            </span>
            <textarea
              value={decisionNote}
              onChange={(e) => setDecisionNote(e.target.value)}
              rows={3}
              className={field}
              placeholder="What should change — or a note to go with your approval?"
            />
          </label>
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => decide("approve")}
              disabled={!!busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50"
            >
              <CheckCircle2 className="h-4 w-4" />
              {busy === "approve" ? "Working…" : "Approve"}
            </button>
            <button
              onClick={() => decide("request_changes")}
              disabled={!!busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300 dark:hover:bg-red-500/20"
            >
              <Undo2 className="h-4 w-4" />
              {busy === "request_changes" ? "Working…" : "Request changes"}
            </button>
          </div>
        </div>
      )}

      {/* Activity: workflow events and discussion, oldest first. Hidden from
          readers outside the editorial crew. */}
      {hasModuleAccess && (
      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
        <h2 className="mb-3 flex items-center gap-2 font-semibold text-slate-900">
          <MessageSquare className="h-4 w-4 text-slate-400" /> Activity
        </h2>
        {comments.length === 0 ? (
          <p className="text-sm text-slate-400">No comments yet.</p>
        ) : (
          <ul className="space-y-3">
            {comments.map((c) => (
              <li key={c.id} className="flex gap-3 text-sm">
                <EventIcon kind={c.kind} />
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-slate-400">
                    <span className="font-medium text-slate-600">{c.author_name}</span>
                    {" · "}
                    {eventLabel(c.kind)}
                    {" · "}
                    {new Date(c.created_at).toLocaleString()}
                  </p>
                  <p className="whitespace-pre-wrap text-slate-700">{c.body}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
        {can.comment && (
          <div className="mt-4 flex items-start gap-2">
            <textarea
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              rows={2}
              className={field}
              placeholder="Add a comment or suggestion…"
            />
            <button
              onClick={postComment}
              disabled={!!busy || !newComment.trim()}
              className="shrink-0 rounded-lg bg-compass-600 px-3 py-2 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-50"
            >
              {busy === "comment" ? "…" : "Post"}
            </button>
          </div>
        )}
      </div>
      )}
    </div>
  );
}

function eventLabel(kind: string): string {
  switch (kind) {
    case "submitted":
      return "submitted for review";
    case "approved":
      return "approved";
    case "changes_requested":
      return "requested changes";
    case "sent":
      return "sent";
    default:
      return "commented";
  }
}

function EventIcon({ kind }: { kind: string }) {
  const base = "mt-0.5 h-4 w-4 shrink-0";
  switch (kind) {
    case "submitted":
      return <Send className={`${base} text-compass-500`} />;
    case "approved":
      return <CheckCircle2 className={`${base} text-green-600 dark:text-green-400`} />;
    case "changes_requested":
      return <Undo2 className={`${base} text-red-500 dark:text-red-400`} />;
    case "sent":
      return <Mail className={`${base} text-compass-500`} />;
    default:
      return <MessageSquare className={`${base} text-slate-300`} />;
  }
}
