"use client";

// Desk settings → Canned responses (1.19.2, agent W4; design d2): the
// library of text-only snippets agents insert with ";" in a reply or note.
// Filter tabs (All, Workspace, each team, Mine), a search, and a table with
// who it's shared with, its folder and its uses in the last 30 days. The
// pencil opens the editor card under the table; the text's placeholders
// show as chips (CannedBodyEditor). Who may edit what is the server's
// answer (can_edit, share_options): an agent their own, a team's leads the
// team's, a manager everyone's.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Eye, Folder, MessageSquareText, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { Card, CARD_CLASS } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { EmptyState, Field, FormError, SectionEmpty, Select, TextInput } from "@/components/form";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { Segmented } from "@/components/Segmented";
import { LoadingRow } from "@/components/Spinner";
import { Table, TABLE_HEAD_ROW, Td, Th, TR } from "@/components/Table";
import { EYEBROW_TEXT } from "@/components/Heading";
import { confirmDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { CANNED_LIMITS, cannedMatches, shareOf, sharedWithLabel, type HdCanned } from "@/lib/helpdesk/canned-shared";
import { getJson, listOf, sendJson } from "../api";
import { CannedBodyEditor, PlaceholderButtons } from "./CannedBodyEditor";

type Row = HdCanned & { can_edit?: boolean };
type ShareOption = { value: string; label: string };
type InactiveOwner = { owner_id: number; name: string; count: number };

const SUBTITLE = "Text you reuse in replies and notes. Type ; in the reply box to insert one at the cursor. They never change the ticket.";

export function CannedSettings() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [shares, setShares] = useState<ShareOption[]>([]);
  // Managers only: deactivated people who still own personal responses (who and how many, never the text).
  const [inactive, setInactive] = useState<InactiveOwner[]>([]);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("all");
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<Row | "new" | null>(null);

  const load = () =>
    getJson<{ canned: Row[]; share_options?: ShareOption[]; inactive_owners?: InactiveOwner[] }>("/api/helpdesk/admin/canned", "Couldn't load the canned responses.")
      .then((d) => {
        setRows(listOf<Row>(d, "canned"));
        setShares(Array.isArray(d.share_options) ? d.share_options : []);
        setInactive(Array.isArray(d.inactive_owners) ? d.inactive_owners : []);
      })
      .catch((e: Error) => setError(e.message));
  useEffect(() => void load(), []);

  // Tabs: All, Workspace, each team that has responses, Mine.
  const tabs = useMemo(() => {
    const teams = new Map<string, string>();
    for (const r of rows ?? []) if (r.scope === "team" && r.team_id) teams.set(`team:${r.team_id}`, r.team_name || "Team");
    return [
      { value: "all", label: "All" },
      { value: "workspace", label: "Workspace" },
      ...[...teams.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label })),
      { value: "mine", label: "Mine" },
    ];
  }, [rows]);
  useEffect(() => {
    if (!tabs.some((t) => t.value === tab)) setTab("all");
  }, [tabs, tab]);

  const shown = useMemo(() => {
    const list = (rows ?? []).filter((r) => {
      if (tab === "all") return true;
      if (tab === "mine") return r.scope === "personal";
      if (tab === "workspace") return r.scope === "workspace";
      return shareOf(r) === tab;
    });
    return list.filter((r) => cannedMatches(r, q)).sort((a, b) => b.uses_30d - a.uses_30d || a.title.localeCompare(b.title));
  }, [rows, tab, q]);

  const canCreate = shares.length > 0;

  async function remove(r: Row) {
    const ok = await confirmDialog({
      title: `Delete ${r.title}?`,
      body: "Agents can no longer insert it. Replies already sent keep their text. This cannot be undone.",
      confirmLabel: "Delete canned response",
      danger: true,
    });
    if (ok !== true) return;
    try {
      await sendJson(`/api/helpdesk/admin/canned/${r.id}`, "DELETE", undefined, "Couldn't delete the canned response.");
      toast("ok", "Canned response deleted.");
      setEditing(null);
      void load();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  return (
    <PageContainer>
      <PageHeader icon={<MessageSquareText />} title="Canned responses" subtitle={SUBTITLE} />
      {error && <p className="notice-error mb-4 rounded-lg border px-3 py-2 text-sm">{error}</p>}
      {rows === null && !error && <LoadingRow className="py-10" />}
      {rows && rows.length === 0 && editing === null && (
        <EmptyState
          icon={<MessageSquareText />}
          title="No canned responses yet"
          body="Write the text once, with placeholders for the requester's name and the ticket number, and insert it in any reply or note by typing ;."
          action={canCreate ? { onClick: () => setEditing("new"), label: "New canned response", icon: <Plus /> } : undefined}
        />
      )}
      {rows && (rows.length > 0 || editing !== null) && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {tabs.length <= 5 ? (
              <Segmented label="Show" value={tab} onChange={setTab} options={tabs} />
            ) : (
              <Select aria-label="Show" value={tab} onChange={(e) => setTab(e.target.value)} className="w-auto">
                {tabs.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </Select>
            )}
            <div className="relative ml-auto min-w-48 flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
              <TextInput
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && q) {
                    e.preventDefault();
                    setQ("");
                  }
                }}
                aria-label="Search canned responses"
                placeholder="Search"
                className="pl-9"
              />
            </div>
            {canCreate && (
              <Button icon={<Plus />} onClick={() => setEditing("new")}>
                New
              </Button>
            )}
          </div>
          <Card padding="none" className="mt-3">
            {shown.length === 0 ? (
              <SectionEmpty className="px-4 py-6">{q.trim() ? `No canned responses match "${q.trim()}".` : "None here yet."}</SectionEmpty>
            ) : (
              <Table>
                <thead className={TABLE_HEAD_ROW}>
                  <tr>
                    <Th>Name</Th>
                    <Th fit>Shared with</Th>
                    <Th fit className="hidden sm:table-cell">
                      Folder
                    </Th>
                    <Th fit className="hidden sm:table-cell">
                      Used (30 days)
                    </Th>
                    <Th fit>
                      <span className="sr-only">Actions</span>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.id} className={`${TR} ${editing !== "new" && editing?.id === r.id ? "bg-compass-50/60" : ""}`}>
                      <Td>
                        <span className="flex min-w-0 items-start gap-2">
                          <MessageSquareText className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                          <span className="min-w-0 font-semibold text-slate-900">{r.title}</span>
                        </span>
                      </Td>
                      <Td fit>
                        <Chip tone="neutral">{sharedWithLabel(r)}</Chip>
                      </Td>
                      <Td fit className="hidden text-slate-600 sm:table-cell">
                        {r.folder && (
                          <span className="inline-flex items-center gap-1.5">
                            <Folder className="h-3.5 w-3.5 text-slate-400" aria-hidden />
                            {r.folder}
                          </span>
                        )}
                      </Td>
                      <Td fit className="hidden sm:table-cell">
                        {r.uses_30d.toLocaleString("en")}
                      </Td>
                      <Td fit>
                        <button
                          type="button"
                          onClick={() => setEditing(r)}
                          aria-label={`${r.can_edit ? "Edit" : "View"} ${r.title}`}
                          data-tt={r.can_edit ? "Edit" : "View"}
                          className={iconButtonClass("quiet", "sm")}
                        >
                          {r.can_edit ? <Pencil aria-hidden /> : <Eye aria-hidden />}
                        </button>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      )}
      {inactive.length > 0 && <InactiveOwners owners={inactive} onChanged={() => void load()} />}
      {editing !== null && (
        <CannedEditor
          key={editing === "new" ? "new" : editing.id}
          row={editing === "new" ? null : editing}
          shares={shares}
          folders={[...new Set((rows ?? []).map((r) => r.folder).filter(Boolean))].sort()}
          defaultShare={tab !== "all" && shares.some((s) => s.value === (tab === "mine" ? "me" : tab)) ? (tab === "mine" ? "me" : tab) : shares[0]?.value ?? "me"}
          onClose={() => setEditing(null)}
          onDelete={remove}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </PageContainer>
  );
}

function CannedEditor({
  row,
  shares,
  folders,
  defaultShare,
  onClose,
  onDelete,
  onSaved,
}: {
  row: Row | null;
  shares: ShareOption[];
  folders: string[];
  defaultShare: string;
  onClose: () => void;
  onDelete: (r: Row) => void;
  onSaved: () => void;
}) {
  const headingId = useId();
  const bodyLabelId = useId();
  const helpId = useId();
  const folderList = useId();
  const card = useRef<HTMLElement>(null);
  const editable = row ? row.can_edit === true : true;
  const start = { title: row?.title ?? "", body: row?.body ?? "", folder: row?.folder ?? "", share: row ? shareOf(row) : defaultShare };
  const [title, setTitle] = useState(start.title);
  const [body, setBody] = useState(start.body);
  const [folder, setFolder] = useState(start.folder);
  const [share, setShare] = useState<string>(start.share);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const editor = useRef<{ insert: (tag: string) => void } | null>(null);

  useEffect(() => {
    card.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    if (!row) card.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [row]);

  const dirty = title !== start.title || body !== start.body || folder !== start.folder || share !== start.share;
  const errs = { title: !title.trim() ? "Give it a name." : undefined, body: !body.trim() ? "Write the text to insert." : undefined };
  // The current sharing stays choosable even when it is not one you could pick for a new one.
  const options = row && !shares.some((s) => s.value === start.share) ? [{ value: start.share, label: sharedWithLabel(row) }, ...shares] : shares;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    if (errs.title || errs.body) return;
    setBusy(true);
    setError("");
    try {
      const payload = { title: title.trim(), body, folder: folder.trim(), share };
      if (row) await sendJson(`/api/helpdesk/admin/canned/${row.id}`, "PATCH", payload, "Couldn't save the canned response.");
      else await sendJson("/api/helpdesk/admin/canned", "POST", payload, "Couldn't create the canned response.");
      toast("ok", row ? "Canned response saved." : "Canned response created.");
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section ref={card} className={`${CARD_CLASS} mt-4 scroll-mt-6 p-5`} aria-labelledby={headingId}>
      <form onSubmit={save} noValidate>
        <div className="flex items-start justify-between gap-3">
          <h2 id={headingId} className={`${EYEBROW_TEXT} min-w-0`}>
            {row ? `${editable ? "Editing" : "Viewing"} · ${row.title}` : "New canned response"}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close the editor" data-tt="Close" className={iconButtonClass("quiet", "sm", "-mr-1 -mt-1")}>
            <X aria-hidden />
          </button>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_14rem_12rem]">
          <Field label="Name" error={tried ? errs.title : undefined}>
            <TextInput value={title} onChange={(e) => setTitle(e.target.value)} maxLength={CANNED_LIMITS.title} placeholder="VPN: re-pair after a phone change" disabled={!editable} />
          </Field>
          <Field label="Shared with">
            <Select value={share} onChange={(e) => setShare(e.target.value)} disabled={!editable}>
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Folder">
            <TextInput value={folder} onChange={(e) => setFolder(e.target.value)} maxLength={CANNED_LIMITS.folder} list={folderList} placeholder="None" disabled={!editable} />
            <datalist id={folderList}>
              {folders.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </Field>
        </div>
        <p id={bodyLabelId} className="mb-1 mt-3 block text-xs font-medium text-slate-500">
          Text
        </p>
        <CannedBodyEditor
          handle={editor}
          value={body}
          onChange={setBody}
          readOnly={!editable}
          labelledBy={bodyLabelId}
          describedBy={helpId}
          invalid={tried && !!errs.body}
        />
        {tried && errs.body && (
          <p role="alert" className="mt-1 text-xs text-red-600">
            {errs.body}
          </p>
        )}
        {editable && <PlaceholderButtons onInsert={(tag) => editor.current?.insert(tag)} />}
        <p id={helpId} className="mt-2 text-xs text-slate-500">
          Placeholders: requester&apos;s name, ticket number, team, your name. Shared with a team: its team leads can edit it.
        </p>
        <FormError>{error}</FormError>
        {editable && (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button type="submit" busy={busy}>
              {row ? "Save" : "Create"}
            </Button>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            {dirty && <span className="text-xs text-amber-600">Unsaved changes</span>}
            {row && (
              <Button variant="ghost" icon={<Trash2 />} className="ml-auto hover-danger" onClick={() => onDelete(row)}>
                Delete
              </Button>
            )}
          </div>
        )}
      </form>
    </section>
  );
}

/**
 * Managers: deactivated people's personal responses still count against
 * their owner's limit and nobody else can open them. Delete them without
 * reading them (DELETE /api/helpdesk/admin/canned/inactive).
 */
function InactiveOwners({ owners, onChanged }: { owners: InactiveOwner[]; onChanged: () => void }) {
  async function purge(o: InactiveOwner) {
    const n = o.count === 1 ? "1 personal canned response" : `${o.count.toLocaleString("en")} personal canned responses`;
    const ok = await confirmDialog({
      title: `Delete ${o.name}'s canned responses?`,
      body: `${o.name} is deactivated. Their ${n} only they could see are deleted unread. This cannot be undone.`,
      confirmLabel: "Delete them",
      danger: true,
    });
    if (ok !== true) return;
    try {
      await sendJson("/api/helpdesk/admin/canned/inactive", "DELETE", { owner_id: o.owner_id }, "Couldn't delete them.");
      toast("ok", `${o.name}'s canned responses deleted.`);
      onChanged();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }
  return (
    <Card
      className="mt-4"
      title="Deactivated people's personal responses"
      description="Only their owner can read these. Delete them to tidy up; you won't see their text."
    >
      <ul className="divide-y divide-slate-100">
        {owners.map((o) => (
          <li key={o.owner_id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
            <span className="min-w-0 flex-1 font-medium text-slate-900">{o.name}</span>
            <span className="text-slate-600">{o.count === 1 ? "1 response" : `${o.count.toLocaleString("en")} responses`}</span>
            <Button variant="ghost" size="sm" icon={<Trash2 />} className="hover-danger" onClick={() => purge(o)}>
              Delete
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
