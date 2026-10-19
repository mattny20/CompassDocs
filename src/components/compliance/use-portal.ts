// The compliance portal's state, shared by its routed pages (B4, 1.12.0):
// the one fetch of /api/admin/compliance, every action through useAction()
// with its toast, the per-policy roster cache behind the expand rows and
// the candidate picker behind Request read confirmation. Until 1.12.0 all
// of this lived in one CompliancePanel with hand-rolled tabs; the split
// into Overview, Policies and People moved the views into routes and the
// state in here, and changed no action, dialog, toast or string. Each page
// mounts the hook once, so a visit costs one GET, as the panel did.
//
// Request and Remind ask first (A8): the shared requireAckDialog with the
// audience count, and a "Remind N people?" confirmDialog, because sending
// mail cannot be undone. Stop requiring tells rather than asks (STYLEGUIDE
// §Feedback): the record is kept, and Undo re-requests quietly.
//
// Retire and Un-retire (G3, 1.12.0) both ask: retiring takes a reason of at
// least 10 characters through the formDialog items/G3.md spells out, and
// resuming a retired policy asks once because it puts the policy back on
// everyone's list. Each posts to the policy's own route
// (/api/documents/[id]/ack/retire, …/unretire), not to the portal's POST.

import { useCallback, useEffect, useState } from "react";
import { confirmDialog, formDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { requireAckDialog } from "@/components/RequireAckDialog";
import { RECONFIRM_REASON_TOO_SHORT } from "@/components/ReconfirmButton";
import type { AckRosterRow } from "@/components/AckRoster";
import { people } from "@/components/compliance/copy";
import type { EditDefault } from "@/lib/compliance-settings";
import { useAction } from "@/lib/use-action";

// ── The GET payload, as src/app/api/admin/compliance/route.ts answers it ────

export interface DocRow {
  id: number;
  title: string;
  space_name: string;
  space_icon: string;
  /** 'draft' is a paused policy (G2): unpublished with the requirement on; it is out of the tiles and has no actions. */
  status: "draft" | "published";
  updated_at: string;
  ack_last_reminded_at: string | null;
  required: number;
  acked: number;
  /** The marker version's number ("v12"). */
  ack_rev?: number | null;
  /** The ledger (C1, 1.10.0): the newest decision of either outcome, and the newest reset (who last asked everyone, and why). */
  last_decision?: DecisionBrief | null;
  last_reset?: DecisionBrief | null;
  /** Kept edits since everyone was last asked, and how far the text has drifted from the version they confirmed. */
  kept_since_reset?: number;
  drift_pct?: number | string | null;
  /** How the policy treats a text edit (A5): the "Asks editor" / "Asks when material" / "Always re-asks" chip. */
  ack_edit_default?: EditDefault;
  /**
   * Retirement (G3, 1.12.0): set on a retired policy, which the Policies
   * page lists in its collapsed Retired group with `required` / `acked`
   * frozen at that moment and `retired_rev` the version people had been
   * asked to confirm. `superseded_by_title` is null when no replacement was
   * named or it was trashed.
   */
  ack_retired_at: string | null;
  ack_retired_by_name: string;
  ack_retired_reason: string;
  ack_superseded_by: number | null;
  superseded_by_title: string | null;
  retired_rev: number | null;
  /** Periodic re-confirmation (G1, 1.12.0): the interval, the stored next date and the effective date ('YYYY-MM-DD'). */
  ack_recert_months: number | null;
  ack_next_recert_at: string | null;
  ack_effective_at: string | null;
}

export interface DecisionBrief {
  decided_at: string;
  decided_by_name: string;
  reason: string;
  outcome: string;
  source: string;
}

export interface PersonRow {
  id: number;
  name: string;
  username: string;
  role: string;
  required: number;
  acked: number;
}

export interface CandidateDoc {
  id: number;
  title: string;
  space_name: string;
  space_icon: string;
}

export interface CompliancePayload {
  kpis: {
    policies: number;
    required: number;
    acked: number;
    outstanding: number;
    pct: number;
    users_compliant: number;
    users_total: number;
    /** Live policies whose next re-confirmation falls within 30 days (G1, 1.12.0). */
    recert_due_30: number;
  };
  docs: DocRow[];
  users: PersonRow[];
  candidates: CandidateDoc[];
  /** What the viewer may do (F6): manage = request, remind, stop; export = the CSVs. */
  can: { manage: boolean; export: boolean };
}

/**
 * One row of GET /api/documents/{id}/acknowledgements (the roster expand):
 * AckStatusRow as the route spreads it, which is the shape AckRoster takes
 * (C4, 1.12.0), so the expand row mounts the Record tab's roster as is.
 */
export type RosterRow = AckRosterRow;

/** The POST answers the portal reads back. */
interface PostResult {
  ok?: boolean;
  queued?: number;
  eligible?: number;
  acked?: number;
  required?: number;
  /** POST /ack/retire: the marker version's number; POST /ack/unretire: the confirmations current after the switch. */
  rev?: number | null;
  current?: number;
}

/** The props every routed portal page takes from its server page. */
export interface PortalPageProps {
  licensed: boolean;
  /** Whether the viewer can open Settings → License (the gate's button). Passed from the server. */
  canManageLicense?: boolean;
}

export function pageOf<T>(rows: T[], page: number, size: number): T[] {
  return rows.slice(page * size, (page + 1) * size);
}

export function usePortal(licensed: boolean) {
  const { run, isBusy, busy } = useAction();
  const [data, setData] = useState<CompliancePayload | null>(null);
  const [loadError, setLoadError] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [rosters, setRosters] = useState<Record<number, RosterRow[]>>({});
  const [rosterPage, setRosterPage] = useState(0);
  const [candidate, setCandidate] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/compliance");
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d?.error || "Couldn't load the compliance portal.");
      setData(d as CompliancePayload);
      setLoadError("");
    } catch (e) {
      setLoadError(e instanceof Error && e.message ? e.message : "Couldn't load the compliance portal.");
    }
  }, []);
  useEffect(() => {
    if (licensed) void load();
  }, [licensed, load]);

  /** Forget a policy's cached roster so the next expand reloads it. */
  const dropRoster = useCallback((docId: number) => {
    setRosters((prev) => {
      if (!(docId in prev)) return prev;
      const next = { ...prev };
      delete next[docId];
      return next;
    });
  }, []);

  /** One POST through useAction: the server's error or the fallback is toasted; the body comes back on success. */
  async function postTo(key: string, url: string, body: Record<string, unknown>, fallback: string): Promise<PostResult | null> {
    const box: { result?: PostResult } = {};
    const ok = await run(
      key,
      async () => {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.ok) box.result = (await res.clone().json().catch(() => ({}))) as PostResult;
        return res;
      },
      { fallback, refresh: false }
    );
    return ok ? (box.result ?? {}) : null;
  }

  /** The portal's own POST (request, remind, stop). */
  function post(key: string, body: Record<string, unknown>, fallback: string): Promise<PostResult | null> {
    return postTo(key, "/api/admin/compliance", body, fallback);
  }

  async function requestConfirmation() {
    if (candidate == null || !data) return;
    const doc = data.candidates.find((c) => c.id === candidate);
    if (!doc) return;
    // The count shown is the audience at that moment.
    setPreviewing(true);
    let eligible = 0;
    try {
      const res = await fetch(`/api/admin/compliance?preview=${doc.id}`);
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast("error", d?.error || "Couldn't count who would be asked.");
        return;
      }
      eligible = Number(d?.eligible ?? 0);
    } catch {
      toast("error", "Couldn't count who would be asked.");
      return;
    } finally {
      setPreviewing(false);
    }
    const choice = await requireAckDialog({ title: doc.title, count: eligible });
    if (!choice) return;
    const r = await post(
      `request-${doc.id}`,
      { docId: doc.id, action: "request", notify: choice === "notify" },
      "Couldn't request a read confirmation."
    );
    if (!r) return;
    toast(
      "ok",
      choice === "notify"
        ? `Read confirmation required: ${people(r.queued ?? eligible)} will be notified.`
        : `Read confirmation required for "${doc.title}". No notice sent.`
    );
    setCandidate(null);
    dropRoster(doc.id);
    await load();
  }

  async function remind(d: DocRow) {
    const pending = Math.max(0, d.required - d.acked);
    const answer = await confirmDialog({
      title: `Remind ${people(pending)}?`,
      body: `Everyone who has not confirmed "${d.title}" yet gets a notice and, unless they opted out, an email. This cannot be undone.`,
      confirmLabel: "Send reminders",
    });
    if (answer !== true) return;
    const r = await post(`remind-${d.id}`, { docId: d.id, action: "remind" }, "Couldn't send reminders.");
    if (!r) return;
    toast("ok", `Reminders queued for ${people(r.queued ?? pending)}.`);
    dropRoster(d.id);
    await load();
  }

  // Reversible, so it tells rather than asks (STYLEGUIDE §Feedback): the
  // record is kept, and Undo re-requests quietly.
  async function stopRequiring(d: DocRow) {
    const r = await post(
      `stop-${d.id}`,
      { docId: d.id, action: "stop" },
      "Couldn't stop requiring a read confirmation."
    );
    if (!r) return;
    dropRoster(d.id);
    toast("ok", `Read confirmation no longer required for "${d.title}"`, {
      action: { label: "Undo", onClick: () => void undoStop(d) },
    });
    await load();
  }

  async function undoStop(d: DocRow) {
    const r = await post(
      `request-${d.id}`,
      { docId: d.id, action: "request", notify: false },
      "Couldn't restore the requirement."
    );
    if (!r) return;
    dropRoster(d.id);
    toast("ok", `Read confirmation required again for "${d.title}". No notice sent.`);
    await load();
  }

  // Retire (G3): the question carries the standing (the row's counts and the
  // marker's version) and one required reason, awaited before anything is
  // busy so Cancel leaves the row idle (STYLEGUIDE §Overlays). The server
  // freezes the counts, keeps every confirmation and moves the policy to
  // the Retired group on the next load; the toast says what is on record.
  async function retire(d: DocRow) {
    const version = d.ack_rev ? `version ${d.ack_rev}` : "the current version";
    const values = await formDialog({
      title: `Retire "${d.title}"?`,
      body: `${d.acked} of ${d.required} people have confirmed ${version}. Retiring stops asking anyone to confirm, keeps every confirmation on record, and lists the policy under Retired in Compliance. The document itself stays as it is; unpublish it separately if people should no longer read it.`,
      fields: [
        {
          key: "reason",
          label: "Why is this policy being retired?",
          type: "textarea",
          required: true,
          help: "Shown on the compliance record and in exports",
          validate: (v) => (v.trim().length < 10 ? RECONFIRM_REASON_TOO_SHORT : undefined),
        },
      ],
      confirmLabel: "Retire policy",
    });
    if (!values) return;
    const r = await postTo(
      `retire-${d.id}`,
      `/api/documents/${d.id}/ack/retire`,
      { reason: values.reason.trim() },
      "Couldn't retire the policy."
    );
    if (!r) return;
    dropRoster(d.id);
    toast("ok", `Policy retired: ${r.acked ?? d.acked} of ${r.required ?? d.required} confirmations on record`);
    await load();
  }

  // Un-retire (G3): one question, because resuming puts the policy back on
  // everyone's list; the toast carries the standing the server answers
  // with. The spec's "Ask everyone to re-confirm…" toast action is not
  // wired here: the A7 question lives inside ReconfirmButton, which exports
  // no callable; once it does, pass it as the toast's `action`.
  async function unretire(d: DocRow) {
    const answer = await confirmDialog({
      title: `Resume read confirmation for "${d.title}"?`,
      body: "Confirmations made before it was retired stay on record. If the text changed while it was retired, people whose confirmation is older than the current version are asked again.",
      confirmLabel: "Resume",
    });
    if (answer !== true) return;
    const r = await postTo(`unretire-${d.id}`, `/api/documents/${d.id}/ack/unretire`, {}, "Couldn't resume the policy.");
    if (!r) return;
    dropRoster(d.id);
    toast("ok", `Policy resumed: ${r.current ?? 0} of ${r.eligible ?? 0} confirmations still current`);
    await load();
  }

  async function toggleRoster(docId: number) {
    if (open === docId) {
      setOpen(null);
      return;
    }
    setOpen(docId);
    setRosterPage(0);
    if (rosters[docId]) return;
    try {
      const res = await fetch(`/api/documents/${docId}/acknowledgements`);
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d?.error || "");
      setRosters((prev) => ({ ...prev, [docId]: (d?.rows ?? []) as RosterRow[] }));
    } catch (e) {
      // Never a permanent spinner: say why, and fold the row back.
      toast("error", (e instanceof Error && e.message) || "Couldn't load the roster.");
      setOpen((cur) => (cur === docId ? null : cur));
    }
  }

  return {
    data,
    loadError,
    load,
    isBusy,
    busy,
    open,
    rosters,
    rosterPage,
    setRosterPage,
    candidate,
    setCandidate,
    previewing,
    dropRoster,
    requestConfirmation,
    remind,
    stopRequiring,
    retire,
    unretire,
    toggleRoster,
  };
}

export type Portal = ReturnType<typeof usePortal>;
