"use client";

import { useState } from "react";
import { buttonClass } from "@/components/Button";
import { Chip, labelCase } from "@/components/Chip";
import { Table, Th, Td, TABLE_HEAD_ROW, TR } from "@/components/Table";
import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { ROLE_ORDER, ROLE_LABEL, ROLE_BLURB } from "@/lib/types";
import type { User, Role } from "@/lib/types";
import { toast } from "@/components/Toasts";

export function UsersClient({
  users,
  currentUserId,
  extraRoles,
}: {
  users: User[];
  currentUserId: number;
  /**
   * Roles each user holds beyond their ladder rung, by user id (0.97). The
   * dropdown below shows only `users.role`, which since 0.93 is one source of
   * someone's access rather than all of it — a Viewer can hold a custom role
   * that opens an admin section, and this page would have said "Viewer".
   */
  extraRoles?: Record<number, string[]>;
}) {
  // The search box lives in the table, but the heading count has to agree with
  // it — so the filter state sits here and the table receives the result.
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? users.filter((u) =>
        `${u.name} ${u.username} ${u.email} ${u.role}`.toLowerCase().includes(needle)
      )
    : users;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-slate-900">
          Users ({needle ? `${visible.length} of ${users.length}` : users.length})
        </h2>
        <AutoLinkButton />
      </div>
      <UserTable
        extraRoles={extraRoles}
        users={visible}
        currentUserId={currentUserId}
        query={query}
        onQueryChange={setQuery}
        filtered={needle.length > 0}
      />
      <CreateUser />
    </div>
  );
}

function UserTable({
  extraRoles,
  users,
  currentUserId,
  query,
  onQueryChange,
  filtered,
}: {
  extraRoles?: Record<number, string[]>;
  users: User[];
  currentUserId: number;
  query: string;
  onQueryChange: (q: string) => void;
  filtered: boolean;
}) {
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
      toast("error", data?.error || "Update failed.");
      return false;
    }
    router.refresh();
    return true;
  }

  async function changeRole(id: number, role: Role) {
    if (await patch(id, { role })) toast("ok", `Role changed to ${ROLE_LABEL[role]}.`);
  }

  async function toggleStatus(u: User) {
    const next = u.status === "active" ? "disabled" : "active";
    if (await patch(u.id, { status: next }))
      toast("ok", next === "active" ? "User enabled." : "User disabled.");
  }

  async function resetPassword(u: User) {
    const pw = prompt(`Set a temporary password for ${u.username} (they'll be asked to change it):`);
    if (!pw) return;
    if (await patch(u.id, { resetPassword: pw })) toast("ok", "Temporary password set.");
  }

  async function remove(u: User) {
    if (!confirm(`Delete user "${u.username}"? This cannot be undone.`)) return;
    setBusyId(u.id);
    const res = await fetch(`/api/admin/users/${u.id}`, { method: "DELETE" });
    setBusyId(null);
    if (res.ok) {
      toast("ok", `User "${u.username}" deleted.`);
      router.refresh();
    } else {
      const data = await res.json().catch(() => ({}));
      toast("error", data?.error || "Delete failed.");
    }
  }

  return (
    <div>
      <input
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Search by name, username, email, or role…"
        aria-label="Search users"
        className="mb-3 w-full max-w-sm rounded-lg border border-slate-200 bg-surface px-3 py-2 text-sm outline-hidden placeholder:text-slate-400 focus:border-compass-400"
      />
    {/* Scrolls rather than clips: below ~1180px the Status and Actions columns
        (Reset password / Disable / Delete) used to be unreachable entirely. */}
    <div className="rounded-xl border border-slate-200 bg-surface shadow-xs">
      <Table scroll minWidth="45rem" aria-busy={busyId !== null}>
        <thead className={TABLE_HEAD_ROW}>
          <tr>
            <Th>User</Th>
            <Th>Role</Th>
            <Th fit>Status</Th>
            <Th fit align="right">Actions</Th>
          </tr>
        </thead>
        <tbody>
          {users.length === 0 && (
            <tr>
              <td colSpan={4} className="px-4 py-10 text-center text-sm text-slate-500">
                {filtered ? "No users match your search." : "No users yet."}
              </td>
            </tr>
          )}
          {users.map((u) => (
            <tr key={u.id} className={`${TR} ${busyId === u.id ? "opacity-50" : ""}`.trim()}>
              <Td>
                <div className="font-medium text-slate-800">
                  {u.name || u.username}
                  {u.id === currentUserId && (
                    <span className="ml-2 text-xs font-normal text-slate-500">(you)</span>
                  )}
                </div>
                <div className="text-xs text-slate-500">@{u.username}</div>
              </Td>
              <Td>
                <select
                  value={u.role}
                  onChange={(e) => changeRole(u.id, e.target.value as Role)}
                  aria-label={`Role for ${u.name || u.username}`}
                  className="rounded-md border border-slate-200 bg-surface px-2 py-1 text-sm outline-hidden focus:border-compass-400"
                >
                  {ROLE_ORDER.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </select>
                {(extraRoles?.[u.id] ?? []).length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {extraRoles![u.id].map((label) => (
                      <span
                        key={label}
                        className="rounded bg-compass-50 px-1.5 py-0.5 text-2xs font-medium text-compass-700"
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                )}
              </Td>
              <Td fit>
                <Chip tone={u.status === "active" ? "ok" : "neutral"}>{labelCase(u.status)}</Chip>
              </Td>
              <Td fit>
                <div className="flex justify-end gap-1.5 text-xs">
                  <button
                    onClick={() => resetPassword(u)}
                    className={buttonClass("secondary", "sm")}
                  >
                    Reset password
                  </button>
                  {u.totp_enabled === 1 && (
                    <button
                      onClick={async () => {
                        if (!confirm(`Reset two-factor auth for ${u.username}? They'll sign in with just their password and can re-enroll.`)) return;
                        if (await patch(u.id, { reset2fa: true })) toast("ok", "Two-factor auth cleared.");
                      }}
                      data-tt="Clear this user's authenticator (lost-device recovery)"
                      className={buttonClass("secondary", "sm")}
                    >
                      Reset 2FA
                    </button>
                  )}
                  <button
                    onClick={() => toggleStatus(u)}
                    className={buttonClass("secondary", "sm")}
                  >
                    {u.status === "active" ? "Disable" : "Enable"}
                  </button>
                  {u.id !== currentUserId && (
                    <button
                      onClick={() => remove(u)}
                      className={buttonClass("danger", "sm")}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
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
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, name, email, role, password }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) {
      toast("error", data?.error || "Could not create user.");
      return;
    }
    toast("ok", `User "${username}" created.`);
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
        className={buttonClass("primary", "md", "mt-4")}
      >
        <Plus className="h-4 w-4" aria-hidden /> Add user
      </button>
    );
  }

  const field =
    "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-hidden focus:border-compass-400 focus:ring-2 focus:ring-compass-100";

  return (
    <form onSubmit={submit} className="mt-4 rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
      <h3 className="mb-3 font-semibold text-slate-900">Add a user</h3>
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
          className={buttonClass("primary")}
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


function AutoLinkButton() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      onClick={async () => {
        setBusy(true);
        const res = await fetch("/api/admin/users/link-directory", { method: "POST" });
        setBusy(false);
        if (res.ok) {
          const d = await res.json();
          toast("ok", d.linked === 0 ? "All accounts already linked." : `Linked ${d.linked} account${d.linked === 1 ? "" : "s"}.`);
        } else {
          toast("error", "Auto-link failed.");
        }
      }}
      disabled={busy}
      title="Match accounts to people-directory entries by SSO identity or email — powers profile links and article bylines."
      className={buttonClass("secondary")}
    >
      {busy ? "Linking…" : "Auto-link directory"}
    </button>
  );
}
