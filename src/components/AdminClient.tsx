"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ROLE_ORDER, ROLE_LABEL, ROLE_BLURB } from "@/lib/types";
import type { User, Role, ApprovalMode } from "@/lib/types";

export function AdminClient({
  users,
  currentUserId,
  approvalMode,
}: {
  users: User[];
  currentUserId: number;
  approvalMode: ApprovalMode;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<ApprovalMode>(approvalMode);
  const [savingMode, setSavingMode] = useState(false);

  async function saveMode(next: ApprovalMode) {
    setMode(next);
    setSavingMode(true);
    await fetch("/api/admin/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approval_mode: next }),
    });
    setSavingMode(false);
    router.refresh();
  }

  return (
    <div className="space-y-10">
      {/* Approval workflow setting */}
      <section>
        <h2 className="mb-3 text-lg font-semibold text-slate-900">Approval workflow</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <ModeCard
            active={mode === "strict"}
            disabled={savingMode}
            onClick={() => saveMode("strict")}
            title="Strict (review required)"
            desc="Editors' changes to published docs and new publishes go to the review queue. Approvers/Admins publish."
          />
          <ModeCard
            active={mode === "open"}
            disabled={savingMode}
            onClick={() => saveMode("open")}
            title="Open (edit freely)"
            desc="Editors can publish and update live docs directly, with no review step. Approvers still handle suggestions."
          />
        </div>
      </section>

      {/* Users */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">Users ({users.length})</h2>
        </div>
        <UserTable users={users} currentUserId={currentUserId} />
        <CreateUser />
      </section>
    </div>
  );
}

function ModeCard({
  active,
  disabled,
  onClick,
  title,
  desc,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  title: string;
  desc: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-xl border p-4 text-left transition ${
        active
          ? "border-compass-400 bg-compass-50 ring-2 ring-compass-100"
          : "border-slate-200 bg-white hover:border-slate-300"
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`grid h-4 w-4 place-items-center rounded-full border ${
            active ? "border-compass-600 bg-compass-600" : "border-slate-300"
          }`}
        >
          {active && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
        </span>
        <span className="font-semibold text-slate-900">{title}</span>
      </div>
      <p className="mt-1 pl-6 text-sm text-slate-500">{desc}</p>
    </button>
  );
}

function UserTable({ users, currentUserId }: { users: User[]; currentUserId: number }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<number | null>(null);

  async function patch(id: number, body: any) {
    setBusyId(id);
    const res = await fetch(`/api/admin/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusyId(null);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data?.error || "Update failed.");
      return false;
    }
    router.refresh();
    return true;
  }

  async function changeRole(id: number, role: Role) {
    await patch(id, { role });
  }

  async function toggleStatus(u: User) {
    await patch(u.id, { status: u.status === "active" ? "disabled" : "active" });
  }

  async function resetPassword(u: User) {
    const pw = prompt(`Set a temporary password for ${u.username} (they'll be asked to change it):`);
    if (!pw) return;
    if (await patch(u.id, { resetPassword: pw })) alert("Temporary password set.");
  }

  async function remove(u: User) {
    if (!confirm(`Delete user "${u.username}"? This cannot be undone.`)) return;
    setBusyId(u.id);
    const res = await fetch(`/api/admin/users/${u.id}`, { method: "DELETE" });
    setBusyId(null);
    if (res.ok) router.refresh();
    else {
      const data = await res.json().catch(() => ({}));
      alert(data?.error || "Delete failed.");
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-400">
          <tr>
            <th className="px-4 py-2 font-medium">User</th>
            <th className="px-4 py-2 font-medium">Role</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {users.map((u) => (
            <tr key={u.id} className={busyId === u.id ? "opacity-50" : ""}>
              <td className="px-4 py-3">
                <div className="font-medium text-slate-800">
                  {u.name || u.username}
                  {u.id === currentUserId && (
                    <span className="ml-2 text-xs font-normal text-slate-400">(you)</span>
                  )}
                </div>
                <div className="text-xs text-slate-400">@{u.username}</div>
              </td>
              <td className="px-4 py-3">
                <select
                  value={u.role}
                  onChange={(e) => changeRole(u.id, e.target.value as Role)}
                  className="rounded-md border border-slate-200 bg-white px-2 py-1 text-sm outline-none focus:border-compass-400"
                >
                  {ROLE_ORDER.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </select>
              </td>
              <td className="px-4 py-3">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    u.status === "active"
                      ? "bg-green-100 text-green-700"
                      : "bg-slate-200 text-slate-600"
                  }`}
                >
                  {u.status}
                </span>
              </td>
              <td className="px-4 py-3">
                <div className="flex justify-end gap-1.5 text-xs">
                  <button
                    onClick={() => resetPassword(u)}
                    className="rounded-md border border-slate-200 px-2 py-1 text-slate-600 hover:bg-slate-50"
                  >
                    Reset password
                  </button>
                  <button
                    onClick={() => toggleStatus(u)}
                    className="rounded-md border border-slate-200 px-2 py-1 text-slate-600 hover:bg-slate-50"
                  >
                    {u.status === "active" ? "Disable" : "Enable"}
                  </button>
                  {u.id !== currentUserId && (
                    <button
                      onClick={() => remove(u)}
                      className="rounded-md border border-red-200 px-2 py-1 text-red-600 hover:bg-red-50"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CreateUser() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, name, email, role, password }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) {
      setError(data?.error || "Could not create user.");
      return;
    }
    setUsername("");
    setName("");
    setEmail("");
    setPassword("");
    setRole("viewer");
    setOpen(false);
    router.refresh();
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-4 rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-compass-700"
      >
        ＋ Add user
      </button>
    );
  }

  const field =
    "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-compass-400 focus:ring-2 focus:ring-compass-100";

  return (
    <form onSubmit={submit} className="mt-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="mb-3 font-semibold text-slate-900">Add a user</h3>
      {error && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">Username</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} className={field} placeholder="jdoe" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">Full name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className={field} placeholder="Jane Doe" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">Email</span>
          <input value={email} onChange={(e) => setEmail(e.target.value)} className={field} placeholder="jane@company.com" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)} className={field}>
            {ROLE_ORDER.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]} — {ROLE_BLURB[r]}
              </option>
            ))}
          </select>
        </label>
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-xs font-medium text-slate-500">Temporary password</span>
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={field}
            placeholder="At least 6 characters — user changes it on first login"
          />
        </label>
      </div>
      <div className="mt-3 flex gap-2">
        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60"
        >
          {saving ? "Creating…" : "Create user"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-lg px-4 py-2 text-sm text-slate-500 hover:bg-slate-100"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
