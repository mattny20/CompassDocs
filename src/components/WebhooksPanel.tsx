"use client";

// Settings › Notifications: outgoing webhooks to chat platforms (Webex, Teams,
// Slack, generic JSON) for approval-workflow events. URLs are write-only —
// they embed the channel secret — so the list shows a masked preview.

import { useState } from "react";

const field =
  "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-compass-400 focus:ring-2 focus:ring-compass-100";

const FORMATS = [
  { value: "webex", label: "Webex (incoming webhook)" },
  { value: "teams", label: "Microsoft Teams (Workflows webhook)" },
  { value: "slack", label: "Slack (incoming webhook)" },
  { value: "email", label: "Email (via SMTP)" },
  { value: "generic", label: "Generic JSON" },
];

const EVENTS = [
  { value: "change_request.submitted", label: "Change submitted for review" },
  { value: "change_request.approved", label: "Change approved" },
  { value: "change_request.rejected", label: "Change rejected" },
  { value: "document.published", label: "Document published" },
  { value: "suggestion.created", label: "Suggestion left" },
];

interface HookView {
  id: number;
  name: string;
  url_preview: string;
  format: string;
  events: string[];
  space_ids: number[];
  enabled: boolean;
  last_sent_at: string | null;
  last_status: string | null;
}

interface SpaceLite {
  id: number;
  name: string;
}

export function WebhooksPanel({
  initial,
  spaces = [],
}: {
  initial: HookView[];
  spaces?: SpaceLite[];
}) {
  const [hooks, setHooks] = useState(initial);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [format, setFormat] = useState("webex");
  const [events, setEvents] = useState<string[]>(["change_request.submitted"]);
  const [spaceIds, setSpaceIds] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [testResult, setTestResult] = useState<Record<number, string>>({});

  async function reload() {
    const res = await fetch("/api/admin/webhooks");
    if (res.ok) setHooks((await res.json()).webhooks);
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/admin/webhooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, url, format, events, space_ids: spaceIds }),
    });
    setBusy(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data?.error || "Could not add the webhook.");
      return;
    }
    setHooks(data.webhooks);
    setName("");
    setUrl("");
  }

  async function test(id: number) {
    setTestResult({ ...testResult, [id]: "sending…" });
    const res = await fetch(`/api/admin/webhooks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "test" }),
    });
    const data = await res.json().catch(() => ({}));
    setTestResult({ ...testResult, [id]: data?.status || "failed" });
    reload();
  }

  async function toggle(h: HookView) {
    await fetch(`/api/admin/webhooks/${h.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !h.enabled }),
    });
    reload();
  }

  async function remove(id: number) {
    if (!confirm("Delete this webhook?")) return;
    await fetch(`/api/admin/webhooks/${id}`, { method: "DELETE" });
    setHooks(hooks.filter((h) => h.id !== id));
  }

  return (
    <div className="max-w-3xl">
      <h2 className="text-lg font-semibold text-slate-900">Notifications</h2>
      <p className="mb-4 text-sm text-slate-500">
        Send approval-workflow events to your chat tools or by email. Create an incoming webhook
        in Webex, Teams (via Workflows), or Slack — or configure SMTP below and add an email
        channel.
      </p>

      <form onSubmit={add} className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">Name</span>
            <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="#doc-reviews channel" maxLength={80} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">Platform</span>
            <select className={field} value={format} onChange={(e) => setFormat(e.target.value)}>
              {FORMATS.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="mt-3 block">
          <span className="mb-1 block text-xs font-medium text-slate-500">
            {format === "email" ? (
              <>Recipients <span className="text-slate-400">(comma-separated addresses)</span></>
            ) : (
              <>Webhook URL <span className="text-slate-400">(stored write-only — shown masked afterwards)</span></>
            )}
          </span>
          <input
            className={field}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={format === "email" ? "approvers@acme.com, docs-team@acme.com" : "https://…"}
            spellCheck={false}
          />
        </label>
        <div className="mt-3 flex flex-wrap gap-4 text-sm text-slate-600">
          {EVENTS.map((ev) => (
            <label key={ev.value} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={events.includes(ev.value)}
                onChange={(e) =>
                  setEvents(e.target.checked ? [...events, ev.value] : events.filter((x) => x !== ev.value))
                }
              />
              {ev.label}
            </label>
          ))}
        </div>
        {spaces.length > 0 && (
          <div className="mt-3">
            <span className="mb-1 block text-xs font-medium text-slate-500">
              Only for these spaces <span className="text-slate-400">(none checked = all spaces)</span>
            </span>
            <div className="flex flex-wrap gap-3 text-sm text-slate-600">
              {spaces.map((sp) => (
                <label key={sp.id} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={spaceIds.includes(sp.id)}
                    onChange={(e) =>
                      setSpaceIds(
                        e.target.checked ? [...spaceIds, sp.id] : spaceIds.filter((x) => x !== sp.id)
                      )
                    }
                  />
                  {sp.name}
                </label>
              ))}
            </div>
          </div>
        )}
        <div className="mt-4 flex items-center gap-3">
          <button type="submit" disabled={busy || !url} className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60">
            {busy ? "Adding…" : "Add webhook"}
          </button>
          {error && <span className="text-sm text-red-600">{error}</span>}
        </div>
      </form>

      <ul className="mt-4 space-y-2">
        {hooks.length === 0 && <li className="text-sm text-slate-400">No webhooks yet.</li>}
        {hooks.map((h) => (
          <li key={h.id} className="rounded-xl border border-slate-200 bg-surface p-3 shadow-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-slate-800">{h.name || "Unnamed"}</span>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                {FORMATS.find((f) => f.value === h.format)?.label.split(" ")[0] || h.format}
              </span>
              {!h.enabled && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">off</span>
              )}
              <span className="min-w-0 flex-1 truncate text-xs text-slate-400">{h.url_preview}</span>
              <button onClick={() => test(h.id)} className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50">
                Test
              </button>
              <button onClick={() => toggle(h)} className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50">
                {h.enabled ? "Disable" : "Enable"}
              </button>
              <button onClick={() => remove(h.id)} className="rounded-lg border border-red-200 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50">
                Delete
              </button>
            </div>
            <div className="mt-1 text-xs text-slate-400">
              {h.events.map((ev) => EVENTS.find((x) => x.value === ev)?.label || ev).join(" · ")}
              {h.space_ids.length > 0 && (
                <>
                  {" — spaces: "}
                  {h.space_ids.map((id) => spaces.find((sp) => sp.id === id)?.name || `#${id}`).join(", ")}
                </>
              )}
              {h.last_sent_at && (
                <>
                  {" — last delivery "}
                  {new Date(h.last_sent_at).toLocaleString()}:{" "}
                  <span className={h.last_status?.startsWith("ok") ? "text-green-600" : "text-red-500"}>
                    {h.last_status}
                  </span>
                </>
              )}
              {testResult[h.id] && <span className="ml-2 font-medium">test: {testResult[h.id]}</span>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// --- SMTP settings (for the Email channel) --------------------------------------

export interface SmtpState {
  host: string;
  port: number;
  secure: string;
  user: string;
  has_pass: boolean;
  from: string;
  configured: boolean;
}

export function SmtpPanel({ initial }: { initial: SmtpState }) {
  const [s, setS] = useState(initial);
  const [pass, setPass] = useState("");
  const [testTo, setTestTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  async function save() {
    setBusy(true);
    setError("");
    setMsg("");
    const res = await fetch("/api/admin/smtp", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        host: s.host,
        port: s.port,
        secure: s.secure,
        user: s.user,
        ...(pass ? { pass } : {}),
        from: s.from,
      }),
    });
    setBusy(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data?.error || "Could not save.");
      return;
    }
    if (data?.state) setS(data.state);
    setPass("");
    setMsg("Saved.");
  }

  async function test() {
    setBusy(true);
    setError("");
    setMsg("");
    const res = await fetch("/api/admin/smtp", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "test", to: testTo }),
    });
    setBusy(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data?.error || "Test failed.");
      return;
    }
    setMsg(`Test email ${data.status}.`);
  }

  return (
    <div className="mt-6 rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
      <div className="mb-1 flex items-center gap-2">
        <h3 className="font-semibold text-slate-900">Email (SMTP)</h3>
        {s.configured ? (
          <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700">
            configured
          </span>
        ) : (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-500">
            not set up
          </span>
        )}
      </div>
      <p className="mb-3 text-sm text-slate-500">
        Needed for Email channels. Any SMTP relay works — Microsoft 365, Google Workspace, SES,
        Postmark, or your own server.
      </p>
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-xs font-medium text-slate-500">SMTP host</span>
          <input className={field} value={s.host} onChange={(e) => setS({ ...s, host: e.target.value })} placeholder="smtp.office365.com" spellCheck={false} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">Port</span>
          <input className={field} type="number" value={s.port} onChange={(e) => setS({ ...s, port: Number(e.target.value) })} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">Encryption</span>
          <select className={field} value={s.secure} onChange={(e) => setS({ ...s, secure: e.target.value })}>
            <option value="starttls">STARTTLS (587)</option>
            <option value="tls">TLS (465)</option>
            <option value="none">None</option>
          </select>
        </label>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">Username <span className="text-slate-400">(optional)</span></span>
          <input className={field} value={s.user} onChange={(e) => setS({ ...s, user: e.target.value })} spellCheck={false} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">
            Password {s.has_pass && !pass ? <span className="text-green-600">(stored ✓)</span> : ""}
          </span>
          <input className={field} type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder={s.has_pass ? "••••••••" : ""} autoComplete="off" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">From address</span>
          <input className={field} value={s.from} onChange={(e) => setS({ ...s, from: e.target.value })} placeholder="compassdocs@acme.com" spellCheck={false} />
        </label>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button onClick={save} disabled={busy} className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60">
          {busy ? "Working…" : "Save"}
        </button>
        <input className={`${field} max-w-[220px]`} value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@acme.com" spellCheck={false} />
        <button onClick={test} disabled={busy || !testTo || !s.configured} className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
          Send test email
        </button>
        {msg && <span className="text-sm text-green-600">{msg}</span>}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}
