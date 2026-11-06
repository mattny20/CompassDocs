"use client";

// Settings → Roles (agent J): what each desk role can do. The five roles
// are columns, the capabilities grouped rows of checkboxes. Admin's column
// is locked on; a cell the rules forbid (Managers only, a capability the
// editor doesn't hold, a role at or above the editor's) is disabled with
// the reason as its tooltip. "Reply to the requester" and "Reply after
// review" are one choice per role, so ticking one clears the other. One
// Save row for the page (SaveRow, unsaved-changes guard), and Reset to
// defaults. The server checks the same rules (roles-shared checkMatrix).

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { RotateCcw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { confirmDialog } from "@/components/Dialog";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { SaveRow } from "@/components/SaveRow";
import { LoadingRow } from "@/components/Spinner";
import { Table, Td, Th, TABLE_HEAD_ROW } from "@/components/Table";
import { toast } from "@/components/Toasts";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import {
  HD_CAPABILITIES,
  HD_CAP_KEYS,
  HD_CAP_SECTIONS,
  HD_CAP_SECTION_LABEL,
  HD_EXCLUSIVE_CAPS,
  HD_ROLES,
  HD_ROLE_DESCRIPTION,
  HD_ROLE_LABEL,
  cellLockedReason,
  type HdCap,
  type HdCapsView,
  type HdRole,
  type HdRoleMatrix,
} from "@/lib/helpdesk/roles-shared";
import { getJson, sendJson } from "../api";
import { ROLE_ICON } from "./role-ui";

interface RolesData {
  matrix: HdRoleMatrix;
  defaults: HdRoleMatrix;
  me: HdCapsView;
}

const snapshotOf = (m: HdRoleMatrix | null) => JSON.stringify(m ? HD_ROLES.map((r) => [...m[r]].sort()) : null);

export function RolesMatrix() {
  const [data, setData] = useState<RolesData | null>(null);
  const [matrix, setMatrix] = useState<HdRoleMatrix | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(snapshotOf(matrix));
  useLeaveGuard(dirty, hasUnsavedChanges);

  const load = useCallback(() => {
    getJson<RolesData>("/api/helpdesk/admin/roles", "Couldn't load the roles.")
      .then((d) => {
        setData(d);
        setMatrix(d.matrix);
        setError("");
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => load(), [load]);

  const me = data?.me;
  const atDefaults = useMemo(() => Boolean(data && matrix && snapshotOf(matrix) === snapshotOf(data.defaults)), [data, matrix]);

  function toggle(role: HdRole, cap: HdCap, on: boolean) {
    if (!matrix) return;
    let caps = matrix[role].filter((c) => c !== cap);
    if (on) {
      caps.push(cap);
      for (const [a, b] of HD_EXCLUSIVE_CAPS) {
        if (cap === a) caps = caps.filter((c) => c !== b);
        if (cap === b) caps = caps.filter((c) => c !== a);
      }
    }
    markDirty();
    setMatrix({ ...matrix, [role]: HD_CAP_KEYS.filter((c) => caps.includes(c)) });
  }

  async function save() {
    if (!matrix) return;
    setBusy(true);
    try {
      const body = { matrix: Object.fromEntries(HD_ROLES.filter((r) => r !== "admin").map((r) => [r, matrix[r]])) };
      const d = await sendJson<{ matrix: HdRoleMatrix }>("/api/helpdesk/admin/roles", "PUT", body, "Couldn't save the roles.");
      setMatrix(d.matrix);
      markClean(snapshotOf(d.matrix));
      toast("ok", "Roles saved. They apply from each person's next action.");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    const ok = await confirmDialog({
      title: "Reset roles to their defaults?",
      body: "Every role you can change goes back to what it could do out of the box. Your other unsaved changes here are discarded.",
      confirmLabel: "Reset to defaults",
      danger: true,
    });
    if (ok !== true) return;
    setBusy(true);
    try {
      const d = await sendJson<{ matrix: HdRoleMatrix }>("/api/helpdesk/admin/roles", "POST", {}, "Couldn't reset the roles.");
      setMatrix(d.matrix);
      markClean(snapshotOf(d.matrix));
      toast("ok", "Roles are back to their defaults.");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageContainer>
      <PageHeader icon={<ShieldCheck />} title="Roles" subtitle="What each desk level can do. Admin always has everything and replies directly." />
      {error && <p className="notice-error mb-4 rounded-lg border px-3 py-2 text-sm">{error}</p>}
      {!matrix && !error && <LoadingRow className="py-10" />}
      {matrix && me && (
        <>
          <ul className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            {HD_ROLES.map((r) => {
              const Icon = ROLE_ICON[r];
              return (
                <li key={r} className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
                  <p className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                    <Icon className="h-4 w-4 text-compass-600" aria-hidden />
                    {HD_ROLE_LABEL[r]}
                  </p>
                  <p className="mt-1 text-xs text-slate-600">{HD_ROLE_DESCRIPTION[r]}</p>
                </li>
              );
            })}
          </ul>
          <Card padding="none">
            <Table scroll minWidth="44rem">
              <caption className="sr-only">Capabilities of each desk role</caption>
              <thead className={TABLE_HEAD_ROW}>
                <tr>
                  <Th>Capability</Th>
                  {HD_ROLES.map((r) => (
                    <Th key={r} fit align="center">
                      {HD_ROLE_LABEL[r]}
                    </Th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {HD_CAP_SECTIONS.map((section) => {
                  const caps = HD_CAP_KEYS.filter((c) => HD_CAPABILITIES[c].section === section);
                  return (
                    <Fragment key={section}>
                      <tr className="border-b border-slate-100 bg-canvas">
                        <th scope="colgroup" colSpan={HD_ROLES.length + 1} className="px-4 py-2 text-left text-xs font-semibold text-slate-700">
                          {HD_CAP_SECTION_LABEL[section]}
                        </th>
                      </tr>
                      {caps.map((cap) => (
                        <tr key={cap} className="border-b border-slate-100 last:border-b-0">
                          <Th scope="row" className="text-left font-normal">
                            <span className="block text-sm font-medium text-slate-800">{HD_CAPABILITIES[cap].label}</span>
                            <span className="block text-xs font-normal normal-case tracking-normal text-slate-500">{HD_CAPABILITIES[cap].hint}</span>
                          </Th>
                          {HD_ROLES.map((r) => (
                            <Td key={r} fit align="center">
                              <Cell
                                role={r}
                                cap={cap}
                                checked={matrix[r].includes(cap)}
                                lockedReason={cellLockedReason(r, cap, me.role, me.caps)}
                                onChange={(on) => toggle(r, cap, on)}
                              />
                            </Td>
                          ))}
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </Table>
          </Card>
          <p className="mt-2 text-xs text-slate-500">
            Greyed boxes can&rsquo;t change here: Admin always has everything (its replies never wait for review), assigning roles and this page stay with Managers and Admins, and you can only
            change roles below your own, with capabilities you have yourself. A role replies directly or after review, never both.
          </p>
          <SaveRow dirty={dirty} busy={busy} onSave={save} label="Save roles" className="mt-4">
            <Button variant="secondary" icon={<RotateCcw />} disabled={busy || (atDefaults && !dirty)} onClick={reset}>
              Reset to defaults
            </Button>
          </SaveRow>
        </>
      )}
    </PageContainer>
  );
}

function Cell({
  role,
  cap,
  checked,
  lockedReason,
  onChange,
}: {
  role: HdRole;
  cap: HdCap;
  checked: boolean;
  lockedReason: string | null;
  onChange: (on: boolean) => void;
}) {
  const name = `${HD_ROLE_LABEL[role]}: ${HD_CAPABILITIES[cap].label}`;
  const box = (
    <input
      type="checkbox"
      className="h-4 w-4"
      checked={checked}
      disabled={Boolean(lockedReason)}
      aria-label={name}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
  if (!lockedReason) return box;
  // A disabled checkbox can't take focus or hover: its wrapper carries the reason.
  return (
    <span className="inline-flex" tabIndex={0} role="note" aria-label={`${name}. ${lockedReason}`} data-tt={lockedReason} data-tt-wrap="">
      {box}
    </span>
  );
}
