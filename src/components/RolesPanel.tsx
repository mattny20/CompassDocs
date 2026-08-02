"use client";

// Settings → Roles & permissions: the console for the permission model.
//
// Four views, in the order an admin actually needs them:
//   Roles       — what each role can do, edited as a matrix of 200-odd keys
//   Assignments — who holds which role, and where
//   Explain     — "why can this person do that?", traced to the assignment
//   Health      — is anyone still able to let everyone back in, and do the
//                 legacy ladder and the permission model still agree
//
// The matrix is the hard part of the UI: a flat list of 200 checkboxes is
// unusable, so permissions are grouped by resource family, families collapse,
// and a search box filters across key, label, and description at once.

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Copy,
  KeyRound,
  Lock,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  UserSearch,
  X,
} from "lucide-react";
import { EntityPicker } from "@/components/EntityPicker";
import { toast } from "@/components/Toasts";
import { DangerAction, DangerZone, Field, SectionEmpty, TextInput, controlClass } from "@/components/form";

interface Role {
  id: number;
  key: string;
  name: string;
  description: string;
  is_builtin: boolean;
  permission_count: number;
}
interface PermissionDef {
  key: string;
  label: string;
  description: string;
  scope: string;
  principal?: string;
}
interface Assignment {
  id: number;
  role_id: number;
  role_name: string;
  user_id: number | null;
  group_id: number | null;
  subject: string;
  subject_kind: "user" | "group";
  scope_type: string;
  space_id: number | null;
  space_name: string | null;
}
interface PickPerson {
  id: number;
  name: string;
  username: string;
  role: string;
}
interface PickGroup {
  id: number;
  name: string;
  member_count: number;
}
interface PickSpace {
  id: number;
  name: string;
}

type Tab = "roles" | "assignments" | "explain" | "health";

const TABS: { key: Tab; label: string }[] = [
  { key: "roles", label: "Roles" },
  { key: "assignments", label: "Assignments" },
  { key: "explain", label: "Explain access" },
  { key: "health", label: "Health" },
];

const primary =
  "inline-flex items-center gap-1.5 rounded-lg bg-compass-600 px-3 py-1.5 text-sm font-semibold text-white shadow-xs hover:bg-compass-700 disabled:opacity-50";
const secondary =
  "inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50";

function family(key: string): string {
  return key.split(".")[0];
}

/** "change_request" → "Change request" — the family headings in the matrix. */
function familyLabel(f: string): string {
  const words = f.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function RolesPanel({
  roles: initialRoles,
  assignments: initialAssignments,
  permissions,
  users,
  groups,
  spaces,
  legacyEnforcement,
}: {
  roles: Role[];
  assignments: Assignment[];
  permissions: PermissionDef[];
  users: PickPerson[];
  groups: PickGroup[];
  spaces: PickSpace[];
  /** True when COMPASSDOCS_AUTHZ_LEGACY=1 has parked the model in read-only. */
  legacyEnforcement: boolean;
}) {
  const [tab, setTab] = useState<Tab>("roles");
  const [roles, setRoles] = useState(initialRoles);
  const [assignments, setAssignments] = useState(initialAssignments);

  async function reload() {
    const res = await fetch("/api/admin/rbac/roles");
    if (!res.ok) return;
    const data = await res.json();
    setRoles(data.roles);
    setAssignments(data.assignments);
  }

  return (
    <div className="space-y-4">
      {legacyEnforcement && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>
            <strong className="font-semibold">Permissions aren&rsquo;t being enforced.</strong>{" "}
            <code className="rounded bg-amber-100 px-1 dark:bg-amber-900/60">
              COMPASSDOCS_AUTHZ_LEGACY=1
            </code>{" "}
            is set, so access is decided by the four built-in roles and edits below have no effect
            until it is removed and the app restarts.
          </p>
        </div>
      )}

      <div className="flex gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition ${
              tab === t.key
                ? "border-compass-600 text-compass-700"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "roles" && (
        <RolesTab roles={roles} permissions={permissions} assignments={assignments} onChanged={reload} />
      )}
      {tab === "assignments" && (
        <AssignmentsTab
          roles={roles}
          assignments={assignments}
          users={users}
          groups={groups}
          spaces={spaces}
          onChanged={reload}
        />
      )}
      {tab === "explain" && <ExplainTab users={users} spaces={spaces} />}
      {tab === "health" && <HealthTab />}
    </div>
  );
}

// --- Roles + the permission matrix -----------------------------------------

function RolesTab({
  roles,
  permissions,
  assignments,
  onChanged,
}: {
  roles: Role[];
  permissions: PermissionDef[];
  assignments: Assignment[];
  onChanged: () => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState<number | null>(roles[0]?.id ?? null);
  const [detail, setDetail] = useState<{ id: number; name: string; description: string; is_builtin: boolean; permissions: string[] } | null>(null);
  const [held, setHeld] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [openFamilies, setOpenFamilies] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  useEffect(() => {
    if (selectedId === null) return setDetail(null);
    let live = true;
    (async () => {
      const res = await fetch(`/api/admin/rbac/roles/${selectedId}`);
      if (!res.ok || !live) return;
      const { role } = await res.json();
      if (!live) return;
      setDetail(role);
      setHeld(new Set(role.permissions));
    })();
    return () => {
      live = false;
    };
  }, [selectedId]);

  const holders = useMemo(() => {
    const m = new Map<number, number>();
    for (const a of assignments) m.set(a.role_id, (m.get(a.role_id) ?? 0) + 1);
    return m;
  }, [assignments]);

  // Only role-grantable permissions belong in the matrix. The ones carrying a
  // `principal` are held by a kind of caller — an anonymous visitor, a SCIM
  // client — and ticking a box could never grant them.
  const grantable = useMemo(() => permissions.filter((p) => !p.principal), [permissions]);

  const needle = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      needle
        ? grantable.filter((p) =>
            `${p.key} ${p.label} ${p.description}`.toLowerCase().includes(needle)
          )
        : grantable,
    [grantable, needle]
  );

  const families = useMemo(() => {
    const m = new Map<string, PermissionDef[]>();
    for (const p of visible) {
      const f = family(p.key);
      if (!m.has(f)) m.set(f, []);
      m.get(f)!.push(p);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [visible]);

  const readOnly = detail?.is_builtin ?? true;
  const dirty =
    detail !== null &&
    (held.size !== detail.permissions.length ||
      detail.permissions.some((p) => !held.has(p)));

  function toggle(key: string, on: boolean) {
    setHeld((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  async function save() {
    if (!detail) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/rbac/roles/${detail.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissions: [...held] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) toast("error", data.error || "Save failed.");
      else {
        toast("ok", `${detail.name} saved — applies to the next request everyone makes.`);
        setDetail(data.role ?? detail);
        await onChanged();
      }
    } catch {
      toast("error", "Save failed.");
    }
    setBusy(false);
  }

  async function duplicate() {
    if (!detail) return;
    setBusy(true);
    try {
      const res = await fetch("/api/admin/rbac/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${detail.name} (copy)`,
          description: detail.description,
          copy_from: detail.id,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) toast("error", data.error || "Could not duplicate.");
      else {
        toast("ok", "Copied — edit the copy freely.");
        await onChanged();
        setSelectedId(data.id);
      }
    } catch {
      toast("error", "Could not duplicate.");
    }
    setBusy(false);
  }

  async function create() {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/admin/rbac/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName, permissions: [] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) toast("error", data.error || "Could not create the role.");
      else {
        toast("ok", `${newName.trim()} created — it grants nothing until you tick permissions.`);
        setNewName("");
        setCreating(false);
        await onChanged();
        setSelectedId(data.id);
      }
    } catch {
      toast("error", "Could not create the role.");
    }
    setBusy(false);
  }

  async function remove() {
    if (!detail) return;
    if (!confirm(`Delete "${detail.name}"? Everyone holding it loses those permissions.`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/rbac/roles/${detail.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) toast("error", data.error || "Could not delete.");
      else {
        toast("ok", "Role deleted.");
        setSelectedId(null);
        await onChanged();
      }
    } catch {
      toast("error", "Could not delete.");
    }
    setBusy(false);
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <div className="space-y-2">
        <div className="rounded-xl border border-slate-200 bg-surface shadow-xs">
          {roles.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setSelectedId(r.id)}
              className={`flex w-full items-center gap-2 border-b border-slate-100 px-3 py-2 text-left last:border-b-0 ${
                selectedId === r.id ? "bg-compass-50" : "hover:bg-slate-50"
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 truncate text-sm font-medium text-slate-800">
                  {r.is_builtin ? (
                    <Lock className="h-3 w-3 shrink-0 text-slate-400" aria-hidden />
                  ) : (
                    <KeyRound className="h-3 w-3 shrink-0 text-compass-500" aria-hidden />
                  )}
                  {r.name}
                </span>
                <span className="mt-0.5 block text-xs text-slate-400">
                  {r.permission_count} permission{r.permission_count === 1 ? "" : "s"}
                  {holders.get(r.id)
                    ? ` · ${holders.get(r.id)} holder${holders.get(r.id) === 1 ? "" : "s"}`
                    : ""}
                </span>
              </span>
            </button>
          ))}
        </div>

        {creating ? (
          <div className="space-y-2 rounded-xl border border-slate-200 bg-surface p-3 shadow-xs">
            <Field label="New role name">
              <TextInput
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Space owner"
                autoFocus
              />
            </Field>
            <div className="flex gap-2">
              <button type="button" className={primary} onClick={create} disabled={busy}>
                <Check className="h-4 w-4" aria-hidden /> Create
              </button>
              <button type="button" className={secondary} onClick={() => setCreating(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className={`${secondary} w-full justify-center`} onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" aria-hidden /> New role
          </button>
        )}
      </div>

      {detail ? (
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-lg font-semibold text-slate-900">{detail.name}</h3>
                <p className="mt-0.5 text-sm text-slate-500">
                  {detail.description || "No description."}
                </p>
              </div>
              <div className="flex gap-2">
                <button type="button" className={secondary} onClick={duplicate} disabled={busy}>
                  <Copy className="h-4 w-4" aria-hidden /> Duplicate
                </button>
                {!readOnly && (
                  <button type="button" className={primary} onClick={save} disabled={busy || !dirty}>
                    <Check className="h-4 w-4" aria-hidden /> Save
                  </button>
                )}
              </div>
            </div>
            {readOnly && (
              <p className="mt-3 flex items-start gap-1.5 rounded-lg bg-slate-50 p-2 text-xs text-slate-500 dark:bg-slate-800/60">
                <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                Built-in roles are re-derived from the catalog on every upgrade, so an upgrade that
                adds a permission grants it without anyone having to notice. That also means edits
                here wouldn&rsquo;t survive a restart — duplicate it and edit the copy instead.
              </p>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 bg-surface shadow-xs">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 p-3">
              <p className="text-sm text-slate-500">
                <strong className="font-semibold text-slate-700">{held.size}</strong> of{" "}
                {permissions.filter((p) => !p.principal).length} permissions
              </p>
              <label className="relative">
                <Search
                  className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400"
                  aria-hidden
                />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter permissions…"
                  aria-label="Filter permissions"
                  className={controlClass(false, "!w-56 !py-1.5 !pl-8")}
                />
              </label>
            </div>

            {families.length === 0 ? (
              <SectionEmpty className="px-4 py-6">
                No permission matches &ldquo;{query}&rdquo;.
              </SectionEmpty>
            ) : (
              <ul>
                {families.map(([f, perms]) => {
                  const open = needle !== "" || openFamilies.has(f);
                  const on = perms.filter((p) => held.has(p.key)).length;
                  return (
                    <li key={f} className="border-b border-slate-100 last:border-b-0">
                      <div className="flex items-center gap-2 px-3 py-2">
                        <button
                          type="button"
                          onClick={() =>
                            setOpenFamilies((prev) => {
                              const next = new Set(prev);
                              if (next.has(f)) next.delete(f);
                              else next.add(f);
                              return next;
                            })
                          }
                          aria-expanded={open}
                          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm font-medium text-slate-700"
                        >
                          <ChevronRight
                            className={`h-4 w-4 shrink-0 text-slate-400 transition ${open ? "rotate-90" : ""}`}
                            aria-hidden
                          />
                          {familyLabel(f)}
                          <span className="text-xs font-normal text-slate-400">
                            {on}/{perms.length}
                          </span>
                        </button>
                        {!readOnly && (
                          <button
                            type="button"
                            className="text-xs font-medium text-compass-600 hover:underline"
                            onClick={() =>
                              setHeld((prev) => {
                                const next = new Set(prev);
                                const all = on === perms.length;
                                for (const p of perms) {
                                  if (all) next.delete(p.key);
                                  else next.add(p.key);
                                }
                                return next;
                              })
                            }
                          >
                            {on === perms.length ? "Clear all" : "Select all"}
                          </button>
                        )}
                      </div>
                      {open && (
                        <ul className="border-t border-slate-100 bg-slate-50/60 dark:bg-slate-800/30">
                          {perms.map((p) => (
                            <li key={p.key} className="border-b border-slate-100 last:border-b-0">
                              <label className="flex cursor-pointer items-start gap-2.5 px-4 py-2">
                                <input
                                  type="checkbox"
                                  checked={held.has(p.key)}
                                  disabled={readOnly}
                                  onChange={(e) => toggle(p.key, e.target.checked)}
                                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-compass-600 focus:ring-compass-400 disabled:opacity-50"
                                />
                                <span className="min-w-0">
                                  <span className="block text-sm text-slate-800">
                                    {p.label}
                                    {p.scope === "space" && (
                                      <span className="ml-1.5 rounded bg-slate-200 px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                                        per space
                                      </span>
                                    )}
                                  </span>
                                  <span className="block text-xs text-slate-400">
                                    {p.description} · <code>{p.key}</code>
                                  </span>
                                </span>
                              </label>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {!readOnly && (
            <DangerZone>
              <DangerAction
                label="Delete this role"
                description="Everyone holding it loses those permissions immediately. Refused if it would leave nobody able to manage users."
              >
                <button
                  type="button"
                  onClick={remove}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4" aria-hidden /> Delete role
                </button>
              </DangerAction>
            </DangerZone>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
          <SectionEmpty>Pick a role on the left to see what it can do.</SectionEmpty>
        </div>
      )}
    </div>
  );
}

// --- Assignments ------------------------------------------------------------

function AssignmentsTab({
  roles,
  assignments,
  users,
  groups,
  spaces,
  onChanged,
}: {
  roles: Role[];
  assignments: Assignment[];
  users: PickPerson[];
  groups: PickGroup[];
  spaces: PickSpace[];
  onChanged: () => Promise<void>;
}) {
  const [roleId, setRoleId] = useState<number>(roles.find((r) => !r.is_builtin)?.id ?? roles[0]?.id ?? 0);
  const [kind, setKind] = useState<"user" | "group">("user");
  const [subjectId, setSubjectId] = useState<number | null>(null);
  const [spaceId, setSpaceId] = useState<number | "">("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");

  const shown = useMemo(() => {
    const n = filter.trim().toLowerCase();
    if (!n) return assignments;
    return assignments.filter((a) =>
      `${a.subject} ${a.role_name} ${a.space_name ?? ""}`.toLowerCase().includes(n)
    );
  }, [assignments, filter]);

  async function grant() {
    if (!roleId || subjectId === null) return;
    setBusy(true);
    try {
      const res = await fetch("/api/admin/rbac/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role_id: roleId,
          user_id: kind === "user" ? subjectId : null,
          group_id: kind === "group" ? subjectId : null,
          space_id: spaceId === "" ? null : spaceId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) toast("error", data.error || "Could not grant that role.");
      else {
        toast("ok", "Role granted.");
        setSubjectId(null);
        await onChanged();
      }
    } catch {
      toast("error", "Could not grant that role.");
    }
    setBusy(false);
  }

  async function revoke(a: Assignment) {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/rbac/assignments/${a.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) toast("error", data.error || "Could not revoke.");
      else {
        toast("ok", "Revoked.");
        await onChanged();
      }
    } catch {
      toast("error", "Could not revoke.");
    }
    setBusy(false);
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
        <h3 className="mb-3 text-lg font-semibold text-slate-900">Grant a role</h3>
        <p className="mb-3 max-w-2xl text-sm text-slate-500">
          Roles granted to a group apply to everyone in it, so membership changes take effect
          without anyone revisiting this page. Leave the space blank to grant everywhere; naming a
          space limits the role&rsquo;s per-space permissions to it.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Role">
            <select
              value={roleId}
              onChange={(e) => setRoleId(Number(e.target.value))}
              className={controlClass()}
            >
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Grant to">
            <select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as "user" | "group");
                setSubjectId(null);
              }}
              className={controlClass()}
            >
              <option value="user">A person</option>
              <option value="group">A group</option>
            </select>
          </Field>
          <Field
            label={kind === "user" ? "Person" : "Group"}
            help={subjectId === null ? "Search and pick one." : undefined}
          >
            <EntityPicker
              options={
                kind === "user"
                  ? users.map((u) => ({ id: u.id, label: u.name, sublabel: u.username }))
                  : groups.map((g) => ({
                      id: g.id,
                      label: g.name,
                      sublabel: `${g.member_count} member${g.member_count === 1 ? "" : "s"}`,
                    }))
              }
              value={subjectId === null ? [] : [subjectId]}
              onChange={(ids) => setSubjectId(ids.length ? ids[ids.length - 1] : null)}
              placeholder={kind === "user" ? "Search people…" : "Search groups…"}
            />
          </Field>
          <Field label="Space" help="Blank grants across the whole workspace.">
            <select
              value={spaceId}
              onChange={(e) => setSpaceId(e.target.value === "" ? "" : Number(e.target.value))}
              className={controlClass()}
            >
              <option value="">Whole workspace</option>
              {spaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <button type="button" className={`${primary} mt-3`} onClick={grant} disabled={busy || subjectId === null}>
          <Plus className="h-4 w-4" aria-hidden /> Grant
        </button>
      </div>

      <div className="rounded-xl border border-slate-200 bg-surface shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 p-3">
          <h3 className="text-lg font-semibold text-slate-900">Who holds what</h3>
          <label className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400"
              aria-hidden
            />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter…"
              aria-label="Filter assignments"
              className={controlClass(false, "!w-56 !py-1.5 !pl-8")}
            />
          </label>
        </div>
        {shown.length === 0 ? (
          <SectionEmpty className="px-4 py-6">
            {assignments.length === 0
              ? "Nobody holds a role yet — grant one above."
              : "Nothing matches that filter."}
          </SectionEmpty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-4 py-2 font-medium">Who</th>
                  <th className="px-4 py-2 font-medium">Role</th>
                  <th className="px-4 py-2 font-medium">Where</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {shown.map((a) => (
                  <tr key={a.id} className="border-b border-slate-100 last:border-b-0">
                    <td className="px-4 py-2">
                      <span className="text-slate-800">{a.subject}</span>
                      <span className="ml-1.5 rounded bg-slate-100 px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:bg-slate-700 dark:text-slate-300">
                        {a.subject_kind}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-slate-600">{a.role_name}</td>
                    <td className="px-4 py-2 text-slate-500">
                      {a.scope_type === "global" ? "Whole workspace" : a.space_name ?? "(deleted space)"}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => revoke(a)}
                        disabled={busy}
                        title="Revoke"
                        aria-label={`Revoke ${a.role_name} from ${a.subject}`}
                        className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                      >
                        <X className="h-4 w-4" aria-hidden />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Explain ----------------------------------------------------------------

interface Effective {
  permission: string;
  label: string;
  scope: "global" | number[];
  via: { role: string; group: string | null; spaceId: number | null }[];
}

function ExplainTab({ users, spaces }: { users: PickPerson[]; spaces: PickSpace[] }) {
  const [userId, setUserId] = useState<number | null>(null);
  const [result, setResult] = useState<Effective[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (userId === null) return setResult(null);
    let live = true;
    setLoading(true);
    (async () => {
      const res = await fetch(`/api/admin/rbac/explain?user_id=${userId}`);
      const data = await res.json().catch(() => ({}));
      if (!live) return;
      setResult(res.ok ? data.permissions : []);
      setLoading(false);
    })();
    return () => {
      live = false;
    };
  }, [userId]);

  const spaceName = (id: number) => spaces.find((s) => s.id === id)?.name ?? `space ${id}`;
  const needle = query.trim().toLowerCase();
  const shown = (result ?? []).filter((e) =>
    needle ? `${e.permission} ${e.label}`.toLowerCase().includes(needle) : true
  );

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
        <h3 className="mb-1 text-lg font-semibold text-slate-900">Explain someone&rsquo;s access</h3>
        <p className="mb-3 max-w-2xl text-sm text-slate-500">
          Everything this person effectively holds, and the assignment each one came from — the
          answer to &ldquo;why can they do that?&rdquo; without reading the role table by hand.
        </p>
        <div className="max-w-md">
          <EntityPicker
            options={users.map((u) => ({ id: u.id, label: u.name, sublabel: u.username }))}
            value={userId === null ? [] : [userId]}
            onChange={(ids) => setUserId(ids.length ? ids[ids.length - 1] : null)}
            placeholder="Search people…"
          />
        </div>
      </div>

      {loading && <p className="text-sm text-slate-500">Resolving…</p>}

      {result !== null && !loading && (
        <div className="rounded-xl border border-slate-200 bg-surface shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 p-3">
            <p className="text-sm text-slate-500">
              <strong className="font-semibold text-slate-700">{result.length}</strong> permission
              {result.length === 1 ? "" : "s"} held
            </p>
            <label className="relative">
              <Search
                className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400"
                aria-hidden
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter…"
                aria-label="Filter permissions"
                className={controlClass(false, "!w-56 !py-1.5 !pl-8")}
              />
            </label>
          </div>
          {shown.length === 0 ? (
            <SectionEmpty className="px-4 py-6">
              {result.length === 0
                ? "This person holds no permissions — they have no role assignment."
                : "Nothing matches that filter."}
            </SectionEmpty>
          ) : (
            <ul>
              {shown.map((e) => (
                <li key={e.permission} className="border-b border-slate-100 px-4 py-2 last:border-b-0">
                  <p className="text-sm text-slate-800">
                    {e.label} <code className="text-xs text-slate-400">{e.permission}</code>
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {e.scope === "global"
                      ? "Everywhere"
                      : `In ${e.scope.map(spaceName).join(", ")}`}{" "}
                    · via{" "}
                    {[
                      ...new Set(
                        e.via.map((v) => (v.group ? `${v.role} (group ${v.group})` : v.role))
                      ),
                    ].join(", ")}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {result === null && !loading && (
        <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
          <SectionEmpty>
            <span className="inline-flex items-center gap-1.5">
              <UserSearch className="h-4 w-4 text-slate-400" aria-hidden />
              Pick someone to see exactly what they can do.
            </span>
          </SectionEmpty>
        </div>
      )}
    </div>
  );
}

// --- Health -----------------------------------------------------------------

function HealthTab() {
  const [recovery, setRecovery] = useState<{ count: number; holders: { id: number; username: string; name: string }[] } | null>(null);
  const [shadow, setShadow] = useState<{ agreements: number; disagreements: number; rows: any[] } | null>(null);
  const [migration, setMigration] = useState<{ users: number; users_without_assignment: number; mismatched: number } | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const [r, s, m] = await Promise.all([
        fetch("/api/admin/rbac/recovery").then((x) => (x.ok ? x.json() : null)),
        fetch("/api/admin/rbac/shadow").then((x) => (x.ok ? x.json() : null)),
        fetch("/api/admin/rbac/audit").then((x) => (x.ok ? x.json() : null)),
      ]);
      if (!live) return;
      setRecovery(r);
      setShadow(s);
      setMigration(m);
    })();
    return () => {
      live = false;
    };
  }, []);

  const disagreements = shadow?.rows.filter((r) => r.legacy_allowed !== r.rbac_allowed) ?? [];

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
        <h3 className="mb-1 flex items-center gap-2 text-lg font-semibold text-slate-900">
          <ShieldCheck className="h-4 w-4 text-compass-600" aria-hidden /> Can anyone let people back in?
        </h3>
        <p className="mb-3 max-w-2xl text-sm text-slate-500">
          The one invariant this model has to hold: at least one active person can still change
          other people&rsquo;s access. Every role edit and revocation is rolled back if it would
          make this zero.
        </p>
        {recovery === null ? (
          <SectionEmpty>Checking…</SectionEmpty>
        ) : (
          <>
            <p
              className={`text-sm font-semibold ${
                recovery.count === 0 ? "text-red-600" : "text-slate-800"
              }`}
            >
              {recovery.count} {recovery.count === 1 ? "person" : "people"}
            </p>
            <p className="mt-1 text-sm text-slate-500">
              {recovery.holders.map((h) => h.name || h.username).join(", ") || "—"}
            </p>
          </>
        )}
      </div>

      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
        <h3 className="mb-1 text-lg font-semibold text-slate-900">
          Does the model agree with the old role ladder?
        </h3>
        <p className="mb-3 max-w-2xl text-sm text-slate-500">
          Every guarded request still evaluates both, enforces the permission, and records whether
          the two matched. Disagreements are where a custom role has genuinely changed someone&rsquo;s
          access — expected once you start editing roles, and worth a look if you haven&rsquo;t.
        </p>
        {shadow === null ? (
          <SectionEmpty>Checking…</SectionEmpty>
        ) : (
          <>
            <p className="text-sm text-slate-700">
              <strong className="font-semibold">{shadow.agreements}</strong> agreeing ·{" "}
              <strong
                className={`font-semibold ${
                  shadow.disagreements ? "text-amber-600" : ""
                }`}
              >
                {shadow.disagreements}
              </strong>{" "}
              differing route/permission pairs
            </p>
            {disagreements.length > 0 && (
              <ul className="mt-3 space-y-1 text-xs text-slate-500">
                {disagreements.slice(0, 20).map((r, i) => (
                  <li key={i}>
                    <code>{r.permission}</code> — ladder {r.legacy_allowed ? "allowed" : "denied"},
                    permissions {r.rbac_allowed ? "allow" : "deny"} ({r.hits} hits)
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
        <h3 className="mb-1 text-lg font-semibold text-slate-900">Does everyone have a role?</h3>
        <p className="mb-3 max-w-2xl text-sm text-slate-500">
          A user with no assignment can do nothing at all, so this is checked and repaired on every
          boot. It should read zero.
        </p>
        {migration === null ? (
          <SectionEmpty>Checking…</SectionEmpty>
        ) : (
          <p className="text-sm text-slate-700">
            {migration.users} users ·{" "}
            <strong
              className={`font-semibold ${
                migration.users_without_assignment ? "text-red-600" : ""
              }`}
            >
              {migration.users_without_assignment}
            </strong>{" "}
            without an assignment ·{" "}
            <strong className={`font-semibold ${migration.mismatched ? "text-amber-600" : ""}`}>
              {migration.mismatched}
            </strong>{" "}
            whose built-in role doesn&rsquo;t match their ladder rung
          </p>
        )}
      </div>
    </div>
  );
}
