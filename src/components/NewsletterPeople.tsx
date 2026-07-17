"use client";

// Settings → Newsletter: who can use the module. A per-user capability, not a
// new org role — None (no access), Contributor (write + submit drafts), or
// Approver (review, approve, send). Admins always have full access.

import { useRef, useState } from "react";
import Link from "next/link";
import { Mail, Plus, X, Image as ImageIcon } from "lucide-react";

interface PersonRow {
  id: number;
  username: string;
  name: string;
  email: string;
  role: string;
  status: string;
  newsletter_role: string;
}

interface Appearance {
  width: number;
  header_image: string;
  header_scale: number;
  header_bg: string;
  body_bg: string;
  body_texture: string;
}

const DEFAULT_APPEARANCE: Appearance = {
  width: 640,
  header_image: "",
  header_scale: 100,
  header_bg: "",
  body_bg: "#f1f5f9",
  body_texture: "none",
};

export function NewsletterPeople({
  initial,
  initialSenders = [],
  initialAppearance = DEFAULT_APPEARANCE,
}: {
  initial: PersonRow[];
  initialSenders?: string[];
  initialAppearance?: Appearance;
}) {
  const [rows, setRows] = useState(initial);
  const [busyId, setBusyId] = useState(0);
  const [error, setError] = useState("");
  const [senders, setSenders] = useState<string[]>(initialSenders);
  const [newSender, setNewSender] = useState("");
  const [senderBusy, setSenderBusy] = useState(false);
  const [senderError, setSenderError] = useState("");

  const [appearance, setAppearance] = useState(initialAppearance);
  const [widthDraft, setWidthDraft] = useState(String(initialAppearance.width));
  const [appearanceBusy, setAppearanceBusy] = useState(false);
  const [appearanceError, setAppearanceError] = useState("");
  const headerFileRef = useRef<HTMLInputElement>(null);

  async function saveAppearance(patch: Partial<Appearance>) {
    setAppearanceBusy(true);
    setAppearanceError("");
    const res = await fetch("/api/admin/newsletter/appearance", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => ({}));
    setAppearanceBusy(false);
    if (!res.ok) {
      setAppearanceError(data?.error || "Couldn't save.");
      return;
    }
    setAppearance(data);
    setWidthDraft(String(data.width));
  }

  async function uploadHeader(file: File) {
    setAppearanceBusy(true);
    setAppearanceError("");
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/newsletter/assets", { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setAppearanceBusy(false);
      setAppearanceError(data?.error || "Upload failed.");
      return;
    }
    await saveAppearance({ header_image: data.url });
  }

  async function saveSenders(next: string[]) {
    setSenderBusy(true);
    setSenderError("");
    const res = await fetch("/api/admin/newsletter/senders", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from_addresses: next }),
    });
    const data = await res.json().catch(() => ({}));
    setSenderBusy(false);
    if (!res.ok) {
      setSenderError(data?.error || "Couldn't save the sender list.");
      return;
    }
    setSenders(data.from_addresses);
    setNewSender("");
  }

  async function setRole(userId: number, role: string) {
    setBusyId(userId);
    setError("");
    const res = await fetch("/api/admin/newsletter/people", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, newsletter_role: role }),
    });
    setBusyId(0);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data?.error || "Couldn't update.");
      return;
    }
    setRows((prev) => prev.map((r) => (r.id === userId ? { ...r, newsletter_role: role } : r)));
  }

  const contributors = rows.filter((r) => r.newsletter_role === "contributor").length;
  const approvers = rows.filter((r) => r.newsletter_role === "approver").length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Newsletter</h1>
        <p className="mt-1 text-sm text-slate-500">
          Grant people access to the newsletter module without a new org role.
          Contributors write drafts and submit them for review; approvers also review,
          approve, and send. Admins always have full access.
        </p>
      </div>

      <div className="flex items-center justify-between rounded-lg border border-compass-200 bg-compass-50 px-3 py-2 text-sm text-compass-800">
        <span>
          {approvers} approver{approvers === 1 ? "" : "s"} · {contributors} contributor
          {contributors === 1 ? "" : "s"} (plus all admins)
        </span>
        <Link
          href="/newsletter"
          className="inline-flex items-center gap-1.5 font-medium text-compass-700 underline hover:text-compass-900"
        >
          <Mail className="h-4 w-4" /> Open the newsletter workspace
        </Link>
      </div>

      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
        <h2 className="font-semibold text-slate-900">Email appearance</h2>
        <p className="mt-1 text-sm text-slate-500">
          How newsletter emails look in the inbox: the content width, and an optional
          header banner that replaces the default logo bar.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-6">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">
              Email width (480–900 px)
            </span>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={480}
                max={900}
                step={10}
                value={widthDraft}
                onChange={(e) => setWidthDraft(e.target.value)}
                className="w-28 rounded-lg border border-slate-200 px-3 py-1.5 text-sm outline-none focus:border-compass-400"
              />
              <button
                onClick={() => saveAppearance({ width: Number(widthDraft) })}
                disabled={appearanceBusy || Number(widthDraft) === appearance.width}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </label>
          <div>
            <span className="mb-1 block text-xs font-medium text-slate-500">Header image</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => headerFileRef.current?.click()}
                disabled={appearanceBusy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                <ImageIcon className="h-4 w-4" />
                {appearance.header_image ? "Replace…" : "Upload…"}
              </button>
              {appearance.header_image && (
                <button
                  onClick={() => saveAppearance({ header_image: "" })}
                  disabled={appearanceBusy}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-500/10"
                >
                  Use default
                </button>
              )}
              <input
                ref={headerFileRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadHeader(f);
                  e.target.value = "";
                }}
              />
            </div>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-6">
          <div>
            <span className="mb-1 block text-xs font-medium text-slate-500">
              Header background
            </span>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={appearance.header_bg || "#ffffff"}
                onChange={(e) => setAppearance((a) => ({ ...a, header_bg: e.target.value }))}
                onBlur={(e) => saveAppearance({ header_bg: e.target.value })}
                title="Header background color"
                aria-label="Header background color"
                className="h-8 w-12 cursor-pointer rounded-md border border-slate-200 bg-surface p-0.5"
              />
              {appearance.header_bg && (
                <button
                  onClick={() => saveAppearance({ header_bg: "" })}
                  disabled={appearanceBusy}
                  className="rounded-lg border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                >
                  Clear
                </button>
              )}
            </div>
          </div>
          <div>
            <span className="mb-1 block text-xs font-medium text-slate-500">
              Outer background (around the content)
            </span>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={appearance.body_bg}
                onChange={(e) => setAppearance((a) => ({ ...a, body_bg: e.target.value }))}
                onBlur={(e) => saveAppearance({ body_bg: e.target.value })}
                title="Outer background color"
                aria-label="Outer background color"
                className="h-8 w-12 cursor-pointer rounded-md border border-slate-200 bg-surface p-0.5"
              />
              <select
                value={appearance.body_texture}
                onChange={(e) => saveAppearance({ body_texture: e.target.value })}
                title="Outer background texture"
                aria-label="Outer background texture"
                className="rounded-lg border border-slate-200 bg-surface px-2 py-1.5 text-sm outline-none focus:border-compass-400"
              >
                <option value="none">No texture</option>
                <option value="dots">Dots</option>
                <option value="grid">Grid</option>
                <option value="stripes">Stripes</option>
              </select>
              {(appearance.body_bg !== "#f1f5f9" || appearance.body_texture !== "none") && (
                <button
                  onClick={() => saveAppearance({ body_bg: "#f1f5f9", body_texture: "none" })}
                  disabled={appearanceBusy}
                  className="rounded-lg border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                >
                  Reset
                </button>
              )}
            </div>
          </div>
          {appearance.header_image && (
            <div>
              <span className="mb-1 block text-xs font-medium text-slate-500">
                Header image scale
              </span>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={20}
                  max={100}
                  step={5}
                  value={appearance.header_scale}
                  onChange={(e) =>
                    setAppearance((a) => ({ ...a, header_scale: Number(e.target.value) }))
                  }
                  onPointerUp={() => saveAppearance({ header_scale: appearance.header_scale })}
                  onKeyUp={() => saveAppearance({ header_scale: appearance.header_scale })}
                  title="Header image display width"
                  aria-label="Header image scale"
                  className="h-1.5 w-32 cursor-pointer accent-compass-600"
                />
                <span className="w-10 text-xs tabular-nums text-slate-500">
                  {appearance.header_scale}%
                </span>
              </div>
            </div>
          )}
        </div>
        {/* Mini preview: outer bg + texture behind the (scaled) header. */}
        <div
          className="mt-3 max-w-lg rounded-lg border border-slate-200 p-4"
          style={{
            backgroundColor: appearance.body_bg,
            backgroundImage:
              appearance.body_texture !== "none"
                ? `url(/nl-textures/${appearance.body_texture}.png)`
                : undefined,
          }}
        >
          <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
            {appearance.header_image ? (
              <div style={{ backgroundColor: appearance.header_bg || "#ffffff", textAlign: "center" }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={appearance.header_image}
                  alt="Newsletter header preview"
                  style={{ width: `${appearance.header_scale}%` }}
                  className="inline-block align-top"
                />
              </div>
            ) : (
              <div
                className="px-4 py-2 text-sm font-bold"
                style={{
                  backgroundColor: appearance.header_bg || "#ffffff",
                  color: "#0f172a",
                  borderBottom: "3px solid #2e75bd",
                }}
              >
                Default header bar
              </div>
            )}
            <div className="px-4 py-3 text-xs text-slate-400">Newsletter content…</div>
          </div>
        </div>
        {!appearance.header_image && (
          <p className="mt-2 text-xs text-slate-400">
            No custom header — emails use the default bar (workspace logo + name, accent
            underline).
          </p>
        )}
        {appearanceError && (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">{appearanceError}</p>
        )}
      </div>

      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
        <h2 className="font-semibold text-slate-900">From addresses</h2>
        <p className="mt-1 text-sm text-slate-500">
          Senders a newsletter can go out as — composers pick one per newsletter, or leave
          the workspace default from Settings → Notifications. Use{" "}
          <code className="rounded bg-slate-100 px-1 text-xs">address@domain</code> or{" "}
          <code className="rounded bg-slate-100 px-1 text-xs">Name &lt;address@domain&gt;</code>.
        </p>
        {senders.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-2">
            {senders.map((s) => (
              <li
                key={s}
                className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-sm text-slate-700"
              >
                {s}
                <button
                  onClick={() => saveSenders(senders.filter((x) => x !== s))}
                  disabled={senderBusy}
                  title="Remove this sender"
                  aria-label={`Remove ${s}`}
                  className="rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-600"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex items-center gap-2">
          <input
            value={newSender}
            onChange={(e) => setNewSender(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newSender.trim()) saveSenders([...senders, newSender]);
            }}
            placeholder="Team News <news@acme.com>"
            className="w-full max-w-sm rounded-lg border border-slate-200 px-3 py-1.5 text-sm outline-none focus:border-compass-400"
          />
          <button
            onClick={() => saveSenders([...senders, newSender])}
            disabled={senderBusy || !newSender.trim()}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" /> Add
          </button>
        </div>
        {senderError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{senderError}</p>}
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-surface shadow-sm">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-xs uppercase tracking-wider text-slate-400">
              <th className="px-4 py-3 font-medium">Person</th>
              <th className="px-4 py-3 font-medium">Org role</th>
              <th className="px-4 py-3 font-medium">Newsletter access</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.id} className={r.status !== "active" ? "opacity-50" : ""}>
                <td className="px-4 py-2.5">
                  <p className="font-medium text-slate-800">{r.name}</p>
                  <p className="text-xs text-slate-400">
                    {r.username}
                    {r.status !== "active" ? " · disabled" : ""}
                  </p>
                </td>
                <td className="px-4 py-2.5 capitalize text-slate-600">{r.role}</td>
                <td className="px-4 py-2.5">
                  {r.role === "admin" ? (
                    <span className="text-slate-500">Full access (admin)</span>
                  ) : (
                    <select
                      value={r.newsletter_role}
                      disabled={busyId === r.id}
                      onChange={(e) => setRole(r.id, e.target.value)}
                      className="rounded-lg border border-slate-200 bg-surface px-2 py-1.5 text-sm outline-none focus:border-compass-400"
                    >
                      <option value="none">None</option>
                      <option value="contributor">Contributor</option>
                      <option value="approver">Approver</option>
                    </select>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
