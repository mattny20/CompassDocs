"use client";

// Desk settings → Import (Helpdesk 1.19.1, agent V7): bring tickets across
// from a Zoho Desk export (a zip of CSVs) or a CSV file, in four steps
// (STYLEGUIDE §Helpdesk: import): Upload → Map → Dry run → Import. Nothing
// is created until the admin confirms after the dry run, a re-run updates
// instead of duplicating, and no email or notice goes out. The job runs in
// the background; this page polls it while it runs. The current job travels
// in the address (?job=12) so a reload comes back to it. 1.19.2 (agent W5,
// mock e1, lib/helpdesk/import-check): the dry run and the map step's
// rescan run in the background too ("checking"), with progress, counts so
// far and the time left; the page can be left, and the bell says when the
// check is ready.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  Bell,
  Check,
  Download,
  FileArchive,
  FileSpreadsheet,
  Pause,
  Play,
  Repeat,
  Trash2,
  TriangleAlert,
  Upload,
} from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { chipClass, type ChipTone } from "@/components/Chip";
import { Field, Select, SectionEmpty, TextInput } from "@/components/form";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { LoadingRow, Spinner } from "@/components/Spinner";
import { RelativeTime } from "@/components/RelativeTime";
import { confirmDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { EYEBROW_TEXT } from "@/components/Heading";
import { HD_PRIORITIES, HD_PRIORITY_LABEL, HD_STATUSES, HD_STATUS_LABEL } from "@/lib/helpdesk/types";
import type { HdPriority, HdStatus } from "@/lib/helpdesk/types";
import {
  IMPORT_FILE_LABEL,
  IMPORT_REF_PREFIX,
  IMPORT_SOURCE_LABEL,
  IMPORT_SOURCE_NAME_MAX,
  IMPORT_STATUS_LABEL,
  MESSAGE_FIELDS,
  importTimeLeft,
  MESSAGE_FIELD_LABEL,
  TICKET_FIELDS,
  TICKET_FIELD_LABEL,
} from "@/lib/helpdesk/import-shared";
import type { DepartmentTarget, ImportJobStatus, ImportJobView, ImportMapping, ImportSource } from "@/lib/helpdesk/import-shared";
import { ApiError, getJson, sendJson } from "../../api";

interface PageData {
  jobs: ImportJobView[];
  settings: { max_upload_mb: number };
  teams: { id: number; name: string }[];
  agents: { id: number; name: string; email: string }[];
}

type Step = 1 | 2 | 3 | 4;
const STEPS: { n: Step; label: string }[] = [
  { n: 1, label: "Upload" },
  { n: 2, label: "Map" },
  { n: 3, label: "Dry run" },
  { n: 4, label: "Import" },
];
const RUNNING: ImportJobStatus[] = ["queued", "running", "cancelling"];
/** Statuses the page polls: an import running, or a background check (1.19.2). */
const POLLED: ImportJobStatus[] = [...RUNNING, "checking"];
const fmt = (n: number) => n.toLocaleString("en-US");

function stepFor(job: ImportJobView | null): Step {
  if (!job) return 1;
  if (job.status === "uploaded") return 2;
  if (job.status === "ready") return 3;
  if (job.status === "checking") return job.check.kind === "rescan" ? 2 : 3;
  return 4;
}

const STATUS_TONE: Record<ImportJobStatus, ChipTone> = {
  uploaded: "neutral",
  ready: "info",
  checking: "accent",
  queued: "accent",
  running: "accent",
  cancelling: "warn",
  cancelled: "warn",
  completed: "ok",
  failed: "error",
  discarded: "neutral",
};

/** Upload a file's bytes as the request body (streamed to disk by the server). */
async function uploadFile(url: string, file: File): Promise<{ job: ImportJobView }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-filename": encodeURIComponent(file.name), accept: "application/json" },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error || "Couldn't upload that file.", res.status);
  return data as { job: ImportJobView };
}

export function ImportWizard() {
  const router = useRouter();
  const params = useSearchParams();
  const [data, setData] = useState<PageData | null>(null);
  const [error, setError] = useState("");
  const [job, setJob] = useState<ImportJobView | null>(null);
  /** "Back to mapping" from the dry run without changing anything yet. */
  const [backToMap, setBackToMap] = useState(false);

  const load = useCallback(async () => {
    const d = await getJson<PageData>("/api/helpdesk/admin/import", "Couldn't load the imports.");
    setData(d);
    return d;
  }, []);

  useEffect(() => {
    // The page and the job in the address load together, so step 1 never flashes first.
    const id = Number(params.get("job"));
    Promise.all([
      getJson<PageData>("/api/helpdesk/admin/import", "Couldn't load the imports."),
      id ? getJson<{ job: ImportJobView }>(`/api/helpdesk/admin/import/${id}`).catch(() => null) : Promise.resolve(null),
    ])
      .then(([d, r]) => {
        setJob(r?.job ?? (id ? null : d.jobs.find((j) => POLLED.includes(j.status)) ?? null));
        setData(d);
      })
      .catch((e: Error) => setError(e.message));
    // Only on first load: the address follows the job afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const show = useCallback(
    (next: ImportJobView | null) => {
      setJob(next);
      setBackToMap(false);
      router.replace(next ? `/desk/settings/import?job=${next.id}` : "/desk/settings/import", { scroll: false });
    },
    [router]
  );

  // While a job runs (or its export is being checked), poll it.
  const running = job && POLLED.includes(job.status);
  useEffect(() => {
    if (!running || !job) return;
    const t = setInterval(() => {
      getJson<{ job: ImportJobView }>(`/api/helpdesk/admin/import/${job.id}`)
        .then((r) => {
          setJob(r.job);
          if (!POLLED.includes(r.job.status)) void load();
        })
        .catch(() => {});
    }, 1500);
    return () => clearInterval(t);
  }, [running, job, load]);

  if (error && !data) return <PageContainer><p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p></PageContainer>;
  if (!data) return <PageContainer><LoadingRow className="py-10" /></PageContainer>;

  const step: Step = backToMap && job?.status === "ready" ? 2 : stepFor(job);

  return (
    <PageContainer>
      <PageHeader icon={<Upload />} title="Import" subtitle="Bring tickets across from Zoho Desk or a CSV file. Nothing is created until you confirm." />
      <Stepper step={step} />
      {step === 1 && <UploadStep data={data} onUploaded={(j) => { show(j); void load(); }} onSettings={(s) => setData({ ...data, settings: s })} onOpen={show} onChanged={load} />}
      {step === 2 && job && job.status === "checking" && <CheckStep job={job} onChanged={setJob} />}
      {step === 2 && job && job.status !== "checking" && <MapStep job={job} data={data} onSaved={(j) => show(j)} onCancel={() => show(null)} />}
      {step === 3 && job && job.status === "checking" && <CheckStep job={job} onChanged={setJob} />}
      {step === 3 && job && job.status !== "checking" && <DryRunStep job={job} data={data} onBack={() => setBackToMap(true)} onStarted={(j) => { show(j); void load(); }} />}
      {step === 4 && job && <RunStep job={job} onChanged={(j) => { setJob(j); void load(); }} onDone={() => show(null)} />}
    </PageContainer>
  );
}

// --- The stepper ---------------------------------------------------------------------------

function Stepper({ step }: { step: Step }) {
  return (
    <ol aria-label="Import steps" className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 print:hidden">
      {STEPS.map((s) => {
        const done = s.n < step;
        const current = s.n === step;
        return (
          <li key={s.n} aria-current={current ? "step" : undefined} className="flex items-center gap-2 text-sm">
            <span
              aria-hidden
              className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
                done ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300" : current ? "bg-compass-600 text-white" : "bg-slate-100 text-slate-600"
              }`}
            >
              {done ? <Check className="h-3.5 w-3.5" /> : s.n}
            </span>
            <span className={current ? "font-semibold text-slate-900" : "text-slate-600"}>
              {s.label}
              {done && <span className="sr-only"> (done)</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function summaryLine(job: ImportJobView): string {
  const s = job.scan;
  if (!s) return IMPORT_SOURCE_LABEL[job.source];
  const parts = [job.source === "zoho" ? "Zoho Desk export" : "CSV file", `${fmt(s.tickets)} tickets`];
  if (s.messages + s.comments) parts.push(`${fmt(s.messages + s.comments)} conversations`);
  if (s.contacts) parts.push(`${fmt(s.contacts)} contacts`);
  return parts.join(" · ");
}

// --- 1 Upload --------------------------------------------------------------------------------

function UploadStep({
  data,
  onUploaded,
  onSettings,
  onOpen,
  onChanged,
}: {
  data: PageData;
  onUploaded: (j: ImportJobView) => void;
  onSettings: (s: { max_upload_mb: number }) => void;
  onOpen: (j: ImportJobView) => void;
  onChanged: () => Promise<unknown>;
}) {
  const [source, setSource] = useState<ImportSource>("zoho");
  const [file, setFile] = useState<File | null>(null);
  const [messages, setMessages] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [limit, setLimit] = useState(String(data.settings.max_upload_mb));
  const [savingLimit, setSavingLimit] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const maxBytes = data.settings.max_upload_mb * 1024 * 1024;

  async function send() {
    if (!file) return;
    setErr("");
    if (file.size > maxBytes || (messages && messages.size > maxBytes)) {
      setErr(`That file is larger than the ${data.settings.max_upload_mb} MB limit.`);
      return;
    }
    setBusy(true);
    try {
      let { job } = await uploadFile(`/api/helpdesk/admin/import?source=${source}`, file);
      if (source === "csv" && messages) ({ job } = await uploadFile(`/api/helpdesk/admin/import/${job.id}/messages`, messages));
      onUploaded(job);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveLimit() {
    setSavingLimit(true);
    try {
      const r = await sendJson<{ settings: { max_upload_mb: number } }>("/api/helpdesk/admin/import/settings", "PUT", { max_upload_mb: Number(limit) }, "Couldn't save the limit.");
      onSettings(r.settings);
      toast("ok", `Uploads can be up to ${r.settings.max_upload_mb} MB.`);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setSavingLimit(false);
    }
  }

  const choices: { v: ImportSource; title: string; body: string; icon: React.ReactNode }[] = [
    { v: "zoho", title: "Zoho Desk export", body: "The .zip from Zoho Desk's data export: tickets, conversations, comments, contacts, agents and departments.", icon: <FileArchive /> },
    { v: "csv", title: "CSV file", body: "One row per ticket, with an optional second CSV of messages. You match the columns next.", icon: <FileSpreadsheet /> },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card title="Choose what you're importing">
        <div role="radiogroup" aria-label="Import from" className="grid gap-3 sm:grid-cols-2">
          {choices.map((c) => (
            <label
              key={c.v}
              className={`flex cursor-pointer gap-3 rounded-lg border p-3 transition ${source === c.v ? "border-compass-500 bg-compass-50 ring-2 ring-compass-500/20" : "border-slate-200 hover:bg-slate-50"}`}
            >
              <input type="radio" name="import-source" value={c.v} checked={source === c.v} onChange={() => { setSource(c.v); setFile(null); setMessages(null); }} className="sr-only" />
              <span className="mt-0.5 text-compass-600 [&>svg]:h-5 [&>svg]:w-5" aria-hidden>{c.icon}</span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-slate-900">{c.title}</span>
                <span className="mt-0.5 block text-sm text-slate-500">{c.body}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="mt-4 flex flex-col gap-3">
          <Field label={source === "zoho" ? "Export file (.zip)" : "Tickets file (.csv)"} help={`Up to ${data.settings.max_upload_mb} MB.`}>
            <input
              ref={fileRef}
              type="file"
              accept={source === "zoho" ? ".zip,application/zip" : ".csv,text/csv,.zip"}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm text-slate-700 file:mr-3 file:h-9 file:rounded-lg file:border file:border-slate-200 file:bg-surface file:px-4 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-50"
            />
          </Field>
          {source === "csv" && (
            <Field label="Messages file (.csv, optional)" help="One row per message, with the ticket id it belongs to.">
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => setMessages(e.target.files?.[0] ?? null)}
                className="block w-full text-sm text-slate-700 file:mr-3 file:h-9 file:rounded-lg file:border file:border-slate-200 file:bg-surface file:px-4 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-50"
              />
            </Field>
          )}
          {err && <p role="alert" className="notice-error rounded-lg border px-3 py-2 text-sm">{err}</p>}
          <div className="flex justify-end">
            <Button icon={<Upload />} busy={busy} disabled={!file || busy} onClick={send}>
              {busy ? "Uploading and reading…" : "Upload and continue"}
            </Button>
          </div>
        </div>
      </Card>

      <Card title="Recent imports" padding="none">
        {data.jobs.length === 0 ? (
          <SectionEmpty className="px-4 py-5">No imports yet.</SectionEmpty>
        ) : (
          <ul className="divide-y divide-slate-100">
            {data.jobs.map((j) => (
              <RecentRow key={j.id} job={j} onOpen={() => onOpen(j)} onChanged={onChanged} />
            ))}
          </ul>
        )}
      </Card>

      <Card title="Upload limit" description="The largest export anyone can upload here. Big exports are read as they stream, so memory stays low.">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Largest upload (MB)" size="xs">
            <TextInput type="number" min={1} max={2048} value={limit} onChange={(e) => setLimit(e.target.value)} />
          </Field>
          <Button variant="secondary" busy={savingLimit} disabled={Number(limit) === data.settings.max_upload_mb} onClick={saveLimit}>
            Save limit
          </Button>
        </div>
      </Card>
    </div>
  );
}

function RecentRow({ job, onOpen, onChanged }: { job: ImportJobView; onOpen: () => void; onChanged: () => Promise<unknown> }) {
  const counts = job.result ?? job.dry_run;
  async function discard() {
    const ok = await confirmDialog({
      title: "Discard this import?",
      body: "Its uploaded file is deleted. Tickets it already imported stay.",
      confirmLabel: "Discard",
      danger: true,
    });
    if (!ok) return;
    try {
      await sendJson(`/api/helpdesk/admin/import/${job.id}`, "DELETE", undefined, "Couldn't discard that import.");
      await onChanged();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }
  const canDiscard = !POLLED.includes(job.status);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-slate-900">{job.filename}</p>
        <p className="text-xs text-slate-500">
          {IMPORT_SOURCE_LABEL[job.source]} · {job.created_by_name} · <RelativeTime value={job.created_at} />
          {counts && ` · ${fmt(counts.tickets_create + counts.tickets_update)} tickets`}
        </p>
      </div>
      <span className={chipClass(STATUS_TONE[job.status], "sm")}>{IMPORT_STATUS_LABEL[job.status]}</span>
      <Button variant="secondary" size="sm" onClick={onOpen}>
        Open
      </Button>
      {canDiscard && (
        <button type="button" onClick={discard} aria-label={`Discard ${job.filename}`} data-tt="Discard" className={iconButtonClass("quiet", "sm")}>
          <Trash2 aria-hidden />
        </button>
      )}
    </li>
  );
}

// --- 2 Map -------------------------------------------------------------------------------------

function MapStep({ job, data, onSaved, onCancel }: { job: ImportJobView; data: PageData; onSaved: (j: ImportJobView) => void; onCancel: () => void }) {
  const [m, setM] = useState<ImportMapping>(() => structuredClone(job.mapping!));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const scan = job.scan!;
  useEffect(() => setM(structuredClone(job.mapping!)), [job]);
  const zoho = job.source === "zoho";
  const columnsOpen = !zoho || scan.warnings.length > 0;

  const agentOptions = useMemo(() => {
    const byId = new Map(data.agents.map((a) => [a.id, a]));
    for (const a of scan.agents) if (a.matched_user_id && !byId.has(a.matched_user_id)) byId.set(a.matched_user_id, { id: a.matched_user_id, name: a.matched_user_name, email: a.email });
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [data.agents, scan.agents]);

  async function saveAndDryRun() {
    setBusy(true);
    setErr("");
    try {
      const saved = await sendJson<{ job: ImportJobView }>(`/api/helpdesk/admin/import/${job.id}`, "PUT", m, "Couldn't save the mapping.");
      // New columns may bring new values to map: the export is read again in
      // the background (1.19.2), and this step shows them when it's done.
      if (saved.job.status === "checking") {
        onSaved(saved.job);
        return;
      }
      // The dry run runs in the background (1.19.2): the next step shows its progress.
      const r = await sendJson<{ job: ImportJobView }>(`/api/helpdesk/admin/import/${job.id}/dry-run`, "POST", {}, "Couldn't start the dry run.");
      onSaved(r.job);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    try {
      await sendJson(`/api/helpdesk/admin/import/${job.id}`, "DELETE", undefined, "Couldn't discard that import.");
      onCancel();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  const setDept = (name: string, value: string) => {
    const t: DepartmentTarget = value === "none" ? { action: "none" } : value === "create" ? { action: "create", name } : { action: "team", team_id: Number(value) };
    setM({ ...m, departments: { ...m.departments, [name]: t } });
  };

  return (
    <div className="flex flex-col gap-4">
      <Card title={job.filename} description={summaryLine(job)}>
        {job.check.error && (
          <p role="alert" className="notice-error mb-3 rounded-lg border px-3 py-2 text-sm">
            {job.check.error}
          </p>
        )}
        {scan.warnings.length > 0 && (
          <div className="notice-warn mb-3 flex gap-2 rounded-lg border px-3 py-2 text-sm">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <ul className="list-none">{scan.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          </div>
        )}
        {scan.files.length > 0 && (
          <p className="text-sm text-slate-500">
            Read:{" "}
            {scan.files
              .filter((f) => f.kind !== "ignored")
              .map((f) => `${f.name.split("/").pop()} (${f.kind === "attachment" ? "file" : IMPORT_FILE_LABEL[f.kind as keyof typeof IMPORT_FILE_LABEL]}${f.rows >= 0 ? `, ${fmt(f.rows)} ${f.rows === 1 ? "row" : "rows"}` : ""})`)
              .join(" · ")}
            {scan.attachments_in_zip > 0 && ` · ${fmt(scan.attachments_in_zip)} attachments`}
          </p>
        )}
        {!zoho && (
          <div className="mt-4 max-w-md">
            <Field
              label="Where these tickets come from"
              help="Ticket ids are kept per source. Use the same name when you import from this system again, so tickets are updated, not duplicated; a different name keeps another system's tickets apart."
            >
              <TextInput
                value={m.source_name ?? ""}
                maxLength={IMPORT_SOURCE_NAME_MAX}
                placeholder={job.mapping?.source_name ? undefined : "CSV (earlier imports)"}
                onChange={(e) => setM({ ...m, source_name: e.target.value })}
              />
            </Field>
          </div>
        )}
      </Card>

      <Card title="Columns" description={zoho ? "Recognised from the export's headers. Change one only if it picked the wrong column." : "Which column holds each part of a ticket."}>
        <details open={columnsOpen} className="group">
          <summary className="cursor-pointer text-sm font-medium text-compass-700">Show the columns</summary>
          <ColumnTable
            title="Tickets"
            headers={scan.headers.tickets}
            fields={TICKET_FIELDS}
            labels={TICKET_FIELD_LABEL}
            value={m.columns.tickets}
            onChange={(v) => setM({ ...m, columns: { ...m.columns, tickets: v } })}
          />
          {scan.headers.messages.length > 0 && (
            <ColumnTable
              title={zoho ? "Conversations" : "Messages"}
              headers={scan.headers.messages}
              fields={MESSAGE_FIELDS}
              labels={MESSAGE_FIELD_LABEL}
              value={m.columns.messages}
              onChange={(v) => setM({ ...m, columns: { ...m.columns, messages: v } })}
            />
          )}
          {scan.headers.comments.length > 0 && (
            <ColumnTable
              title="Comments"
              headers={scan.headers.comments}
              fields={MESSAGE_FIELDS}
              labels={MESSAGE_FIELD_LABEL}
              value={m.columns.comments}
              onChange={(v) => setM({ ...m, columns: { ...m.columns, comments: v } })}
            />
          )}
        </details>
      </Card>

      <Card title={zoho ? "Departments → teams" : "Teams"} description="Where each department's tickets go. A new team is created when the import runs.">
        {scan.departments.length === 0 ? (
          <SectionEmpty>No departments in the export. Tickets come in without a team.</SectionEmpty>
        ) : (
          <MapRows
            rows={scan.departments.map((d) => {
              const t = m.departments[d.name] ?? { action: "none" };
              const exists = data.teams.some((x) => x.name.toLowerCase() === d.name.toLowerCase());
              return {
                key: d.name,
                label: d.name,
                count: d.tickets,
                control: (
                  <Select aria-label={`Team for ${d.name}`} value={t.action === "team" ? String(t.team_id) : t.action} onChange={(e) => setDept(d.name, e.target.value)}>
                    {data.teams.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    {!exists && <option value="create">Create team “{d.name}”</option>}
                    <option value="none">No team</option>
                  </Select>
                ),
              };
            })}
          />
        )}
      </Card>

      <Card title="Statuses" description="Add a tag to keep what a status said (Escalated becomes Open with the tag “escalated”).">
        <MapRows
          rows={scan.statuses.map((s) => {
            const t = m.statuses[s.name] ?? { status: "open" as HdStatus, tag: "" };
            return {
              key: s.name,
              label: s.name || "(blank)",
              count: s.tickets,
              control: (
                <div className="flex gap-2">
                  <Select aria-label={`Status for ${s.name || "blank"}`} className="min-w-0 flex-1" value={t.status} onChange={(e) => setM({ ...m, statuses: { ...m.statuses, [s.name]: { ...t, status: e.target.value as HdStatus } } })}>
                    {HD_STATUSES.map((v) => <option key={v} value={v}>{HD_STATUS_LABEL[v]}</option>)}
                  </Select>
                  <TextInput aria-label={`Tag for ${s.name || "blank"}`} placeholder="Tag (optional)" className="w-32 shrink-0" value={t.tag} onChange={(e) => setM({ ...m, statuses: { ...m.statuses, [s.name]: { ...t, tag: e.target.value } } })} />
                </div>
              ),
            };
          })}
        />
      </Card>

      <Card title="Priorities">
        <MapRows
          rows={scan.priorities.map((p) => ({
            key: p.name,
            label: p.name || "(blank)",
            count: p.tickets,
            control: (
              <Select aria-label={`Priority for ${p.name || "blank"}`} className="w-auto" value={m.priorities[p.name] ?? "normal"} onChange={(e) => setM({ ...m, priorities: { ...m.priorities, [p.name]: e.target.value as HdPriority } })}>
                {HD_PRIORITIES.map((v) => <option key={v} value={v}>{HD_PRIORITY_LABEL[v]}</option>)}
              </Select>
            ),
          }))}
        />
      </Card>

      <Card title="Agents" description="Matched to accounts by email. Anyone without one is shown as “Former agent” on their replies, and their tickets come in unassigned.">
        {scan.agents.length === 0 ? (
          <SectionEmpty>No ticket owners in the export.</SectionEmpty>
        ) : (
          <MapRows
            rows={scan.agents.map((a) => ({
              key: a.key,
              label: a.name || a.email,
              sub: a.name && a.email ? a.email : undefined,
              count: a.tickets,
              control: (
                <Select
                  aria-label={`Account for ${a.name || a.email}`}
                  value={m.agents[a.key] === null || m.agents[a.key] === undefined ? "" : String(m.agents[a.key])}
                  onChange={(e) => setM({ ...m, agents: { ...m.agents, [a.key]: e.target.value ? Number(e.target.value) : null } })}
                >
                  <option value="">Former agent {a.name || a.email}</option>
                  {agentOptions.map((u) => <option key={u.id} value={u.id}>{u.name}{u.email ? ` (${u.email})` : ""}</option>)}
                </Select>
              ),
            }))}
          />
        )}
      </Card>

      <Card title="Requesters and dates">
        <p className="text-sm text-slate-700">
          {fmt(scan.contacts_matched)} {scan.contacts_matched === 1 ? "requester matches a person" : "requesters match people"} in the directory by email.{" "}
          {fmt(scan.contacts_kept)} {scan.contacts_kept === 1 ? "is" : "are"} kept as outside senders, with their name and email on the ticket.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label="Dates like 03/04/2026 mean" help="Used only for dates written with slashes.">
            <Select value={m.date_order} onChange={(e) => setM({ ...m, date_order: e.target.value === "dmy" ? "dmy" : "mdy" })}>
              <option value="mdy">Month first (March 4)</option>
              <option value="dmy">Day first (3 April)</option>
            </Select>
          </Field>
          <Field label="Time zone of the export's times" help="For times written without one, such as 2026-11-05 15:15.">
            <TextInput value={m.timezone} onChange={(e) => setM({ ...m, timezone: e.target.value })} />
          </Field>
        </div>
      </Card>

      {err && <p role="alert" className="notice-error rounded-lg border px-3 py-2 text-sm">{err}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={discard}>
          Start over
        </Button>
        <Button busy={busy} onClick={saveAndDryRun}>
          {busy ? "Starting the dry run…" : "Run the dry run"}
        </Button>
      </div>
    </div>
  );
}

function ColumnTable<F extends string>({
  title,
  headers,
  fields,
  labels,
  value,
  onChange,
}: {
  title: string;
  headers: string[];
  fields: readonly F[];
  labels: Record<F, string>;
  value: Partial<Record<F, string>>;
  onChange: (v: Partial<Record<F, string>>) => void;
}) {
  return (
    <div className="mt-4">
      <p className={`${EYEBROW_TEXT} mb-2`}>{title}</p>
      <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
        {fields.map((f) => (
          <Field key={f} label={labels[f]}>
            <Select dense value={value[f] ?? ""} onChange={(e) => onChange({ ...value, [f]: e.target.value })}>
              <option value="">Not in the file</option>
              {headers.map((h) => <option key={h} value={h}>{h}</option>)}
            </Select>
          </Field>
        ))}
      </div>
    </div>
  );
}

function MapRows({ rows }: { rows: { key: string; label: string; sub?: string; count: number; control: React.ReactNode }[] }) {
  return (
    <ul className="divide-y divide-slate-100">
      {rows.map((r) => (
        <li key={r.key} className="flex flex-col gap-2 py-2.5 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-slate-900">{r.label}</p>
            <p className="text-xs text-slate-500">
              {r.sub && `${r.sub} · `}
              {fmt(r.count)} {r.count === 1 ? "ticket" : "tickets"}
            </p>
          </div>
          <div className="sm:w-80 sm:shrink-0">{r.control}</div>
        </li>
      ))}
    </ul>
  );
}

// --- 3 Dry run -----------------------------------------------------------------------------------

function Tile({ value, label, children }: { value: number; label: string; children?: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-slate-200 bg-surface px-3 py-3 sm:px-4">
      <p className="text-2xl font-bold tabular-nums text-slate-900">{fmt(value)}</p>
      <p className="mt-0.5 text-sm text-slate-600">
        {label}
        {children}
      </p>
    </div>
  );
}

function DryRunStep({ job, data, onBack, onStarted }: { job: ImportJobView; data: PageData; onBack: () => void; onStarted: (j: ImportJobView) => void }) {
  const [busy, setBusy] = useState(false);
  const d = job.dry_run!;
  const m = job.mapping!;
  const total = d.tickets_create + d.tickets_update;
  const sourceName = IMPORT_SOURCE_LABEL[job.source];
  const teamName = (t: DepartmentTarget | undefined) =>
    !t || t.action === "none" ? "No team" : t.action === "create" ? `${t.name} (new team)` : data.teams.find((x) => x.id === t.team_id)?.name ?? "A team";

  async function start() {
    setBusy(true);
    try {
      const r = await sendJson<{ job: ImportJobView }>(`/api/helpdesk/admin/import/${job.id}/start`, "POST", {}, "Couldn't start the import.");
      onStarted(r.job);
    } catch (e) {
      toast("error", (e as Error).message);
      setBusy(false);
    }
  }

  const statusRows = Object.entries(m.statuses)
    .filter(([name]) => (job.scan?.statuses ?? []).some((s) => s.name === name))
    // A status that keeps its own name ("Open" → Open) says nothing: only the changes are listed.
    .filter(([name, t]) => t.tag || name.toLowerCase().replace(/\s+/g, "") !== HD_STATUS_LABEL[t.status].toLowerCase().replace(/\s+/g, ""))
    .map(([name, t]) => ({ name: name || "(blank)", to: `${HD_STATUS_LABEL[t.status]}${t.tag ? ` + tag “${t.tag}”` : ""}` }));

  return (
    <Card>
      <p className="text-base font-semibold text-slate-900">{job.filename}</p>
      <p className="text-sm text-slate-500">{summaryLine(job)}</p>
      <div className="mt-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Tile value={d.tickets_create} label="tickets to create">
          {d.tickets_update > 0 && (
            <span className="block text-xs text-slate-500">
              and {fmt(d.tickets_update)} already imported{m.source_name ? ` from “${m.source_name}”` : ""} to update
            </span>
          )}
        </Tile>
        <Tile value={d.contacts_matched} label="contacts matched to people in the directory" />
        <Tile value={d.contacts_kept} label="contacts kept as outside senders" />
        <Tile value={d.skipped} label="rows skipped">
          {d.skipped > 0 ? (
            <>
              {" "}(
              <a className="link" href={`/api/helpdesk/admin/import/${job.id}/skipped?of=dry_run`} download>
                see why
              </a>
              )
            </>
          ) : null}
        </Tile>
      </div>
      <p className="mt-3 text-sm text-slate-500">
        {fmt(d.messages)} {d.messages === 1 ? "reply" : "replies"} and {fmt(d.notes)} internal {d.notes === 1 ? "note" : "notes"}
        {d.attachments_import + d.attachments_missing + d.attachments_refused > 0 &&
          ` · ${fmt(d.attachments_import)} ${d.attachments_import === 1 ? "attachment" : "attachments"}${d.attachments_missing + d.attachments_refused ? ` (${fmt(d.attachments_missing + d.attachments_refused)} not imported, noted on their message)` : ""}`}
        {d.teams_create > 0 && ` · ${fmt(d.teams_create)} new ${d.teams_create === 1 ? "team" : "teams"}`}
      </p>

      <p className={`${EYEBROW_TEXT} mt-5 mb-2`}>Mapping</p>
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50">
            <tr className={`text-left ${EYEBROW_TEXT}`}>
              <th scope="col" className="px-4 py-2.5">{sourceName}</th>
              <th scope="col" className="px-4 py-2.5">CompassDocs</th>
            </tr>
          </thead>
          <tbody>
            {(job.scan?.departments ?? []).map((dep) => (
              <tr key={`d-${dep.name}`} className="border-t border-slate-100">
                <td className="px-4 py-2.5 text-slate-900">Department: {dep.name}</td>
                <td className="px-4 py-2.5 text-slate-900">{teamName(m.departments[dep.name])}</td>
              </tr>
            ))}
            {statusRows.map((s) => (
              <tr key={`s-${s.name}`} className="border-t border-slate-100">
                <td className="px-4 py-2.5 text-slate-900">Status: {s.name}</td>
                <td className="px-4 py-2.5 text-slate-900">{s.to}</td>
              </tr>
            ))}
            <tr className="border-t border-slate-100">
              <td className="px-4 py-2.5 text-slate-900">Ticket number</td>
              <td className="px-4 py-2.5 text-slate-900">
                Kept as “{IMPORT_REF_PREFIX[job.source]} #” on each ticket{job.next_number ? `; new numbers continue from #${job.next_number}` : ""}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-start gap-2 rounded-lg border border-compass-200 bg-compass-50 px-3 py-2.5 text-sm text-slate-800">
        <Repeat className="mt-0.5 h-4 w-4 shrink-0 text-compass-600" aria-hidden />
        <p>Safe to run again: tickets already imported are updated, not duplicated. No emails are sent to anyone during the import.</p>
      </div>

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" icon={<ArrowLeft />} onClick={onBack}>
          Back to mapping
        </Button>
        <Button busy={busy} disabled={total === 0} onClick={start}>
          Import {fmt(total)} {total === 1 ? "ticket" : "tickets"}
        </Button>
      </div>
    </Card>
  );
}

// --- A background check (1.19.2, mock e1) ----------------------------------------------------------

function CheckTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0 rounded-xl border border-slate-200 bg-surface px-3 py-2.5 sm:px-4">
      <p className="text-sm text-slate-600">{label}</p>
      <p className="text-xl font-bold tabular-nums text-slate-900">{fmt(value)}</p>
    </div>
  );
}

/**
 * The dry run (step 3) or the rescan after a column change (step 2) while
 * it runs in the background: a progress bar with rows checked and the time
 * left, the counts so far, the "you can leave" strip, Stop (dry run only)
 * and the Import button waiting, disabled, for the result.
 */
function CheckStep({ job, onChanged }: { job: ImportJobView; onChanged: (j: ImportJobView) => void }) {
  const [busy, setBusy] = useState(false);
  const dry = job.check.kind !== "rescan";
  const p = job.check.progress ?? {};
  const total = Math.max(p.total ?? 0, 0);
  const done = Math.min(p.done ?? 0, total || (p.done ?? 0));
  const pct = total ? Math.min(99, Math.floor((done / total) * 100)) : 0;
  const ticketsTotal = p.tickets_total ?? job.scan?.tickets ?? 0;
  const c = p.counts;
  const left = importTimeLeft(p.counting_at, done, total, Date.now(), p.counting_from ?? 0);
  const reading = !p.phase || p.phase === "queued" || p.phase === "reading";

  async function stop() {
    setBusy(true);
    try {
      const r = await sendJson<{ job: ImportJobView }>(`/api/helpdesk/admin/import/${job.id}/stop-check`, "POST", {}, "Couldn't stop the dry run.");
      onChanged(r.job);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  let line: string;
  if (reading) line = dry ? "Reading the export…" : "Reading the export with your columns…";
  else if (!dry) line = `${fmt(done)} of about ${fmt(total)} rows read`;
  else if (p.phase === "messages") line = `All ${fmt(ticketsTotal)} tickets checked · ${fmt(Math.max(0, done - ticketsTotal))} of ${fmt(Math.max(0, total - ticketsTotal))} conversations`;
  else line = `${fmt(p.tickets_done ?? done)} of ${fmt(ticketsTotal)} tickets checked`;
  const toImport = (c?.tickets_create ?? 0) + (c?.tickets_update ?? 0);

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Spinner className="text-compass-600" />
        <p className="text-base font-semibold text-slate-900">{dry ? "Checking your export" : "Reading your export again"}</p>
        <p className="min-w-0 truncate text-sm text-slate-500 sm:ml-auto">
          {job.filename}
          {ticketsTotal > 0 && ` · ${fmt(ticketsTotal)} tickets`}
        </p>
      </div>
      <div
        role="progressbar"
        aria-label={dry ? "Dry run progress" : "Reading progress"}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="mt-4 h-2 overflow-hidden rounded-full bg-slate-100"
      >
        <div className="h-full rounded-full bg-compass-600 transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1.5 flex justify-between gap-3 text-sm text-slate-500">
        <p aria-live="polite">
          {line}
          {left && ` · ${left}`}
        </p>
        <p className="tabular-nums">{pct}%</p>
      </div>
      {dry && (
        <div className="mt-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
          <CheckTile label="To create" value={c?.tickets_create ?? 0} />
          <CheckTile label="To update" value={c?.tickets_update ?? 0} />
          <CheckTile label="Contacts matched" value={c?.contacts_matched ?? 0} />
          <CheckTile label="Skipped so far" value={c?.skipped ?? 0} />
        </div>
      )}
      <div className="mt-4 flex items-start gap-2 rounded-lg border border-compass-200 bg-compass-50 px-3 py-2.5 text-sm text-slate-800">
        <Bell className="mt-0.5 h-4 w-4 shrink-0 text-compass-600" aria-hidden />
        <p>
          You can leave this page. We&apos;ll tell you in the bell when {dry ? "the dry run is ready" : "the export has been read"}.
        </p>
      </div>
      {dry && (
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" busy={busy} onClick={stop}>
            Stop
          </Button>
          <Button disabled>
            Import {fmt(toImport)} {toImport === 1 ? "ticket" : "tickets"}
          </Button>
        </div>
      )}
    </Card>
  );
}

// --- 4 Import ---------------------------------------------------------------------------------------

function RunStep({ job, onChanged, onDone }: { job: ImportJobView; onChanged: (j: ImportJobView) => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const p = job.progress ?? {};
  const totalTickets = job.scan?.tickets ?? 0;
  const totalMessages = (job.scan?.messages ?? 0) + (job.scan?.comments ?? 0);
  const inMessages = p.phase === "messages" || p.phase === "finalize" || p.phase === "done";
  const done = p.phase === "done" ? totalTickets + totalMessages : inMessages ? totalTickets + (p.done ?? 0) : p.done ?? 0;
  const all = Math.max(totalTickets + totalMessages, 1);
  const pct = Math.min(100, Math.round((done / all) * 100));
  const r = job.result;
  const running = RUNNING.includes(job.status);

  async function act(path: "cancel" | "start") {
    setBusy(true);
    try {
      const res = await sendJson<{ job: ImportJobView }>(`/api/helpdesk/admin/import/${job.id}/${path}`, "POST", {}, path === "cancel" ? "Couldn't stop the import." : "Couldn't resume the import.");
      onChanged(res.job);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const phaseText =
    job.status === "completed"
      ? "Import finished."
      : job.status === "cancelled"
        ? "Import stopped. What was imported stays; Resume carries on from there."
        : job.status === "failed"
          ? "Import stopped on an error."
          : job.status === "cancelling"
            ? "Stopping after the current batch…"
            : inMessages
              ? `Adding conversations: ${fmt(p.done ?? 0)} of ${fmt(totalMessages)}`
              : p.phase === "tickets"
                ? `Importing tickets: ${fmt(p.done ?? 0)} of ${fmt(totalTickets)}`
                : "Starting…";

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-base font-semibold text-slate-900">{job.filename}</p>
          <p className="text-sm text-slate-500">{summaryLine(job)}</p>
        </div>
        <span className={chipClass(STATUS_TONE[job.status])}>{IMPORT_STATUS_LABEL[job.status]}</span>
      </div>
      <div className="mt-4">
        <p className="text-sm text-slate-700" aria-live="polite">{phaseText}</p>
        <div
          role="progressbar"
          aria-label="Import progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={job.status === "completed" ? 100 : pct}
          className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100"
        >
          <div className={`h-full rounded-full ${job.status === "failed" ? "bg-red-500" : job.status === "completed" ? "bg-emerald-500" : "bg-compass-600"} transition-[width]`} style={{ width: `${job.status === "completed" ? 100 : pct}%` }} />
        </div>
      </div>
      {job.status === "failed" && job.error && <p role="alert" className="notice-error mt-3 rounded-lg border px-3 py-2 text-sm">{job.error}</p>}
      {r && (
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-slate-500">Tickets created</dt>
            <dd className="text-lg font-semibold tabular-nums text-slate-900">{fmt(r.tickets_create)}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Tickets updated</dt>
            <dd className="text-lg font-semibold tabular-nums text-slate-900">{fmt(r.tickets_update)}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Replies and notes</dt>
            <dd className="text-lg font-semibold tabular-nums text-slate-900">{fmt(r.messages + r.notes)}</dd>
          </div>
          {r.skipped > 0 && (
            <div className="sm:col-span-3">
              <dt className="sr-only">Skipped</dt>
              <dd className="text-slate-600">
                {fmt(r.skipped)} rows skipped.{" "}
                <a className="link inline-flex items-center gap-1" href={`/api/helpdesk/admin/import/${job.id}/skipped?of=result`} download>
                  <Download className="h-3.5 w-3.5" aria-hidden /> Download the list
                </a>
              </dd>
            </div>
          )}
        </dl>
      )}
      {job.status === "completed" && (
        <p className="notice-ok mt-4 rounded-lg border px-3 py-2 text-sm">
          The tickets are in the desk. Nobody was emailed or notified, and nothing was assigned or automated.
        </p>
      )}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {running && (
          <Button variant="danger" icon={<Pause />} busy={busy} disabled={job.status === "cancelling"} onClick={() => act("cancel")}>
            Stop import
          </Button>
        )}
        {(job.status === "cancelled" || job.status === "failed") && (
          <Button icon={<Play />} busy={busy} onClick={() => act("start")}>
            Resume import
          </Button>
        )}
        {job.status === "completed" && (
          <Button variant="secondary" href="/desk?view=all">
            Open the queue
          </Button>
        )}
        {!running && (
          <Button variant={job.status === "completed" ? "primary" : "secondary"} onClick={onDone}>
            {job.status === "completed" ? "Start another import" : "Back to imports"}
          </Button>
        )}
      </div>
    </Card>
  );
}
