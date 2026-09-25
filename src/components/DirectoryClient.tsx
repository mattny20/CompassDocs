"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  LayoutGrid,
  List as ListIcon,
  Building2,
  Phone,
  Smartphone,
  MapPin,
  BookUser,
  Settings,
  UserSearch,
  Star,
  Pin,
  Download,
  Printer,
  FileText,
  Table2,
  ChevronDown,
} from "lucide-react";
import type { DirectoryPerson, DirectoryField } from "@/lib/directory";
import {
  availableColumns,
  cellValue,
  columnLabel,
  comparePeople,
  displayValue,
  groupPeople,
  initialsOf,
  pinnedFirst,
  rawValue,
  resolveValues,
} from "@/lib/directory-display";
import { EmptyState } from "./form";
import { FieldChips } from "./TagBadges";
import { toast } from "./Toasts";

const field =
  "rounded-lg border border-slate-200 px-3 py-2 text-sm outline-hidden focus:border-compass-400 focus:ring-2 focus:ring-compass-100";
const menuBtn =
  "rounded-lg border border-slate-200 bg-surface px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50";

type View = "cards" | "list" | "groups";
const VIEWS: { id: View; label: string; icon: React.ReactNode }[] = [
  { id: "cards", label: "Cards", icon: <LayoutGrid className="h-4 w-4" /> },
  { id: "list", label: "List", icon: <ListIcon className="h-4 w-4" /> },
  { id: "groups", label: "Groups", icon: <Building2 className="h-4 w-4" /> },
];

// Storage keys. Columns got a new key in 1.2: the old hard-coded default was
// title-first, and a browser that had merely opened the list once would keep
// it forever, hiding the admin's new default from the people it was set for.
const LS_VIEW = "compass_dir_view";
const LS_COLS = "compass_dir_cols_v2";
const LS_GROUP = "compass_dir_group";
const LS_CARDS_GROUP = "compass_dir_cards_group";
const LS_MY_PINS = "compass_dir_mypins";
const LS_OFFICE_INFO = "compass_dir_office_info";

export interface ExportPresetSummary {
  id: string;
  name: string;
  is_default: boolean;
}

function Avatar({ p, size = 12 }: { p: DirectoryPerson; size?: 10 | 12 }) {
  const cls = size === 12 ? "h-12 w-12" : "h-10 w-10";
  return p.photo ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={p.photo} alt="" className={`${cls} flex-none rounded-full object-cover`} />
  ) : (
    <div
      className={`${cls} flex flex-none items-center justify-center rounded-full bg-compass-100 font-semibold text-compass-700`}
    >
      {initialsOf(p.name)}
    </div>
  );
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

export function DirectoryClient({
  initialPeople,
  fields,
  defaultColumns,
  defaultGroupBy,
  presets,
  isAdmin = false,
}: {
  initialPeople: DirectoryPerson[];
  fields: DirectoryField[];
  /** Admin-chosen default list columns. */
  defaultColumns: string[];
  /** The group_by field key the grouped view opens on. */
  defaultGroupBy: string;
  presets: ExportPresetSummary[];
  /** Admins get a link to Settings → Directory from the empty state. */
  isAdmin?: boolean;
}) {
  const [q, setQ] = useState("");
  const [filterValue, setFilterValue] = useState("");
  const [view, setView] = useState<View>("cards");
  const [cols, setCols] = useState<string[]>(defaultColumns);
  const [colsOpen, setColsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [sortBy, setSortBy] = useState("name");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [groupBy, setGroupBy] = useState(defaultGroupBy);
  const [cardsGroupBy, setCardsGroupBy] = useState("");
  const [myPins, setMyPins] = useState<number[]>([]);
  const [officeInfo, setOfficeInfo] = useState(true);
  const [exporting, setExporting] = useState(false);

  const groupFields = useMemo(() => fields.filter((f) => f.group_by), [fields]);
  const groupField = useMemo(
    () => groupFields.find((f) => f.key === groupBy) ?? groupFields[0],
    [groupFields, groupBy]
  );
  const cardsGroupField = useMemo(
    () => (cardsGroupBy ? groupFields.find((f) => f.key === cardsGroupBy) : undefined),
    [groupFields, cardsGroupBy]
  );
  const titleField = useMemo(() => fields.find((f) => f.key === "title"), [fields]);

  // Restore per-user preferences.
  useEffect(() => {
    try {
      const v = localStorage.getItem(LS_VIEW);
      if (v && VIEWS.some((x) => x.id === v)) setView(v as View);
      else if (v === "departments") setView("groups");
      const c = readJson<string[] | null>(LS_COLS, null);
      if (Array.isArray(c) && c.length) setCols(c);
      const g = localStorage.getItem(LS_GROUP);
      if (g && groupFields.some((f) => f.key === g)) setGroupBy(g);
      const cg = localStorage.getItem(LS_CARDS_GROUP);
      if (cg !== null && (cg === "" || groupFields.some((f) => f.key === cg))) setCardsGroupBy(cg);
      setMyPins(readJson<number[]>(LS_MY_PINS, []).filter((n) => Number.isInteger(n)));
      setOfficeInfo(readJson<boolean>(LS_OFFICE_INFO, true) !== false);
    } catch {
      /* first visit */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function saveView(v: View) {
    setView(v);
    // A sort clicked in the list must not leak into the grouped views (it
    // used to: "attorneys first" would randomly become "by title").
    setSortBy("name");
    setSortDir(1);
    try {
      localStorage.setItem(LS_VIEW, v);
    } catch {}
  }
  function saveCols(next: string[]) {
    setCols(next);
    writeJson(LS_COLS, next);
  }
  function saveGroupBy(key: string) {
    setGroupBy(key);
    setFilterValue("");
    try {
      localStorage.setItem(LS_GROUP, key);
    } catch {}
  }
  function saveCardsGroupBy(key: string) {
    setCardsGroupBy(key);
    try {
      localStorage.setItem(LS_CARDS_GROUP, key);
    } catch {}
  }
  function toggleMyPin(id: number) {
    const next = myPins.includes(id) ? myPins.filter((x) => x !== id) : [...myPins, id];
    setMyPins(next);
    writeJson(LS_MY_PINS, next);
  }

  const allColumns = useMemo(() => availableColumns(fields), [fields]);
  const activeColumns = useMemo(
    () => cols.map((k) => allColumns.find((c) => c.key === k)).filter((c): c is { key: string; label: string } => !!c),
    [allColumns, cols]
  );
  const cardFields = useMemo(() => fields.filter((f) => f.show_in_card && !f.builtin && f.kind !== "people"), [fields]);
  const peopleFields = useMemo(() => fields.filter((f) => f.kind === "people"), [fields]);
  const fieldByKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);

  // The filter menu offers the grouped field's values, in the admin's order.
  const filterOptions = useMemo(() => {
    if (!groupField) return [];
    return groupPeople(initialPeople, groupField)
      .filter((g) => g.key !== "")
      .map((g) => ({ key: g.key, label: g.label, count: g.members.length }));
  }, [initialPeople, groupField]);

  const people = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = initialPeople.filter((p) => {
      if (filterValue && groupField) {
        const hit = resolveValues(groupField, rawValue(p, groupField.key)).some(
          (r) => r.value.toLowerCase() === filterValue.toLowerCase()
        );
        if (!hit) return false;
      }
      if (!needle) return true;
      return [
        p.name, p.title, p.department, p.email, p.phone, p.mobile, p.office,
        ...Object.values(p.links ?? {}).flat().map((l) => l.name),
        ...Object.values(p.linked_by ?? {}).flat().map((l) => l.name),
        ...Object.values(p.custom ?? {}),
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
    return [...filtered].sort(comparePeople(fields, sortBy, sortDir));
  }, [initialPeople, q, filterValue, groupField, sortBy, sortDir, fields]);

  // Within a group: title order (the admin's, e.g. attorneys first), then name.
  const withinGroup = useMemo(
    () => (titleField && titleField.options.length ? comparePeople(fields, "title") : comparePeople(fields, "name")),
    [fields, titleField]
  );

  const grouped = useMemo(() => {
    const f = view === "groups" ? groupField : cardsGroupField;
    if (!f) return null;
    return groupPeople(people, f).map((g) => ({ ...g, members: [...g.members].sort(withinGroup) }));
  }, [people, view, groupField, cardsGroupField, withinGroup]);

  const { pinned } = useMemo(() => pinnedFirst(people), [people]);
  const mine = useMemo(() => people.filter((p) => myPins.includes(p.id)), [people, myPins]);

  function clickSort(id: string) {
    if (sortBy === id) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortBy(id);
      setSortDir(1);
    }
  }

  async function exportNow(body: Record<string, unknown>, format: "pdf" | "csv") {
    setExportOpen(false);
    setExporting(true);
    try {
      const res = await fetch("/api/directory/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, format }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast("error", data?.error || "The export failed.");
        return;
      }
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") || "")?.[1] || `directory.${format}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      toast("error", "The export failed — check your connection and try again.");
    } finally {
      setExporting(false);
    }
  }

  /** "What I see": the people on screen, with the screen's columns and grouping. */
  function whatISee(format: "pdf" | "csv") {
    const groupedField = view === "groups" ? groupField : view === "cards" ? cardsGroupField : undefined;
    return exportNow(
      {
        ids: people.map((p) => p.id),
        columns: view === "list" ? cols : undefined,
        group_by: groupedField?.key ?? "",
        sort: sortBy,
        sort_dir: sortDir === 1 ? "asc" : "desc",
        pinned_first: view !== "list" && pinned.length > 0,
        office_info: officeInfo,
      },
      format
    );
  }

  const renderCell = (p: DirectoryPerson, key: string) => {
    if (key === "name") {
      return (
        <Link href={`/directory/${p.id}`} className="flex items-center gap-2 font-medium text-slate-900 hover:text-compass-700">
          <Avatar p={p} size={10} />
          {p.name}
        </Link>
      );
    }
    const f = fieldByKey.get(key);
    const value = cellValue(p, key, fields);
    let body: React.ReactNode;
    if (key === "email" && p.email) {
      body = <a href={`mailto:${p.email}`} className="text-compass-600 hover:underline">{p.email}</a>;
    } else if ((key === "phone" || key === "mobile" || f?.display === "phone") && value) {
      body = <a href={`tel:${value}`} className="text-slate-600 hover:underline">{value}</a>;
    } else if (f?.kind === "people" || key === "assists" || key.endsWith(":in")) {
      const refs = key === "assists" ? p.linked_by.assistant ?? [] : key.endsWith(":in") ? p.linked_by[key.slice(0, -3)] ?? [] : p.links[key] ?? [];
      body = refs.length ? (
        <span className="text-slate-600">
          {refs.map((r, i) => (
            <span key={r.id}>
              <Link href={`/directory/${r.id}`} className="hover:text-compass-700 hover:underline">{r.name}</Link>
              {i < refs.length - 1 ? ", " : ""}
            </span>
          ))}
        </span>
      ) : null;
    } else if (f?.display === "tag" && value) {
      body = <FieldChips field={f} value={rawValue(p, key)} />;
    } else {
      body = <span className="text-slate-600">{value}</span>;
    }
    // Fields that ride along under another column ("Legal group" beneath
    // Department) — only when the field is not a column of its own.
    const riders = fields.filter((x) => x.show_with === key && !cols.includes(x.key) && rawValue(p, x.key));
    if (riders.length === 0) return body;
    return (
      <div className="space-y-1">
        {body}
        {riders.map((r) => (
          <FieldChips key={r.key} field={r} value={rawValue(p, r.key)} />
        ))}
      </div>
    );
  };

  const PinButton = ({ p, size = "h-3.5 w-3.5" }: { p: DirectoryPerson; size?: string }) => {
    const on = myPins.includes(p.id);
    return (
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          toggleMyPin(p.id);
        }}
        data-tt={on ? "Unpin from my pins" : "Pin to my pins"}
        aria-label={on ? `Unpin ${p.name}` : `Pin ${p.name}`}
        aria-pressed={on}
        className={`rounded-sm p-1 ${on ? "text-amber-500" : "text-slate-300 hover:text-slate-500"}`}
      >
        <Star className={size} fill={on ? "currentColor" : "none"} />
      </button>
    );
  };

  const Card = ({ p }: { p: DirectoryPerson }) => {
    const officeField = fieldByKey.get("office");
    const office = officeField ? displayValue(officeField, p.office) : p.office;
    const phoneExtras = cardFields.filter((f) => f.display === "phone" && p.custom?.[f.key]);
    return (
      <div className="relative flex min-w-0 gap-3 rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
        <div className="absolute right-2 top-2 flex items-center gap-0.5">
          {p.pin_order != null && <Pin className="h-3.5 w-3.5 text-compass-500" aria-label="Pinned by an admin" />}
          <PinButton p={p} />
        </div>
        <Avatar p={p} />
        <div className="min-w-0 pr-8">
          <Link href={`/directory/${p.id}`} className="block truncate font-semibold text-slate-900 hover:text-compass-700">
            {p.name}
          </Link>
          {(p.title || p.department) && (
            <p className="truncate text-sm text-slate-500">
              {p.title}
              {p.title && p.department ? " · " : ""}
              {p.department}
            </p>
          )}
          <div className="mt-1 space-y-0.5 text-sm">
            {p.email && (
              <a href={`mailto:${p.email}`} className="block truncate text-compass-600 hover:underline">{p.email}</a>
            )}
            {(p.phone || phoneExtras.length > 0) && (
              <p className="flex flex-wrap items-center gap-x-2 text-slate-600">
                {p.phone && (
                  <a href={`tel:${p.phone}`} className="inline-flex items-center gap-1.5 hover:underline">
                    <Phone className="h-3.5 w-3.5 text-slate-400" /> {p.phone}
                  </a>
                )}
                {phoneExtras.map((f) => (
                  <span key={f.key} className="text-slate-500">
                    {f.label} <a href={`tel:${p.custom[f.key]}`} className="text-slate-600 hover:underline">{p.custom[f.key]}</a>
                  </span>
                ))}
              </p>
            )}
            {p.mobile && (
              <a href={`tel:${p.mobile}`} className="flex items-center gap-1.5 text-slate-600 hover:underline">
                <Smartphone className="h-3.5 w-3.5 text-slate-400" /> {p.mobile}
              </a>
            )}
            {office && (
              <p className="flex items-center gap-1.5 text-slate-500">
                <MapPin className="h-3.5 w-3.5" /> {office}
              </p>
            )}
            {peopleFields.map((f) => {
              const out = p.links[f.key] ?? [];
              const inn = p.linked_by[f.key] ?? [];
              return (
                <div key={f.key}>
                  {out.length > 0 && (
                    <p className="text-slate-500">
                      <span className="text-slate-400">{f.label}:</span> {out.map((r) => r.name).join(", ")}
                    </p>
                  )}
                  {inn.length > 0 && (
                    <p className="text-slate-500">
                      <span className="text-slate-400">{f.inverse_label || `${f.label} to`}:</span>{" "}
                      {inn.length > 3 ? `${inn.slice(0, 3).map((r) => r.name).join(", ")} and ${inn.length - 3} more` : inn.map((r) => r.name).join(", ")}
                    </p>
                  )}
                </div>
              );
            })}
            {cardFields
              .filter((f) => f.display !== "phone")
              .map((f) =>
                p.custom?.[f.key] ? (
                  f.display === "tag" ? (
                    <div key={f.key} className="flex flex-wrap items-center gap-1.5 pt-1">
                      <span className="text-xs text-slate-400">{f.label}</span>
                      <FieldChips field={f} value={p.custom[f.key]} />
                    </div>
                  ) : (
                    <p key={f.key} className="text-slate-500">
                      <span className="text-slate-400">{f.label}:</span> {displayValue(f, p.custom[f.key])}
                    </p>
                  )
                ) : null
              )}
          </div>
        </div>
      </div>
    );
  };

  const Tile = ({ p }: { p: DirectoryPerson }) => {
    const assistants = p.links.assistant ?? [];
    return (
      <Link
        href={`/directory/${p.id}`}
        className="flex min-w-0 items-center gap-3 rounded-lg border border-slate-200 bg-surface px-3 py-2 hover:border-compass-300"
      >
        <Avatar p={p} size={10} />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-slate-900">{p.name}</p>
          <p className="truncate text-xs text-slate-500">
            {p.title}
            {p.title && (p.phone || p.mobile) ? " · " : ""}
            {p.phone || p.mobile}
          </p>
          {assistants.length > 0 && (
            <p className="truncate text-xs text-slate-400">
              {fieldByKey.get("assistant")?.label ?? "Assistant"}: {assistants.map((a) => a.name).join(", ")}
            </p>
          )}
        </div>
      </Link>
    );
  };

  const SectionHeader = ({ label, count, icon }: { label: string; count: number; icon?: React.ReactNode }) => (
    <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
      {icon}
      {label}
      <span className="text-xs font-normal text-slate-400">({count})</span>
    </h2>
  );

  const tileGrid = "grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5";
  const cardGrid = "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5";

  const pinnedSections = (Item: ({ p }: { p: DirectoryPerson }) => React.ReactElement, grid: string) => (
    <>
      {mine.length > 0 && (
        <div>
          <SectionHeader label="My pins" count={mine.length} icon={<Star className="h-3.5 w-3.5 text-amber-500" />} />
          <div className={grid}>{mine.map((p) => <Item key={`mine-${p.id}`} p={p} />)}</div>
        </div>
      )}
      {pinned.length > 0 && (
        <div>
          <SectionHeader label="Pinned" count={pinned.length} icon={<Pin className="h-3.5 w-3.5 text-compass-500" />} />
          <div className={grid}>{pinned.map((p) => <Item key={`pin-${p.id}`} p={p} />)}</div>
        </div>
      )}
    </>
  );

  return (
    <div>
      {/* Toolbar */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search people…"
          aria-label="Search people"
          className={`${field} w-64`}
          autoFocus
        />
        {groupFields.length > 0 && (
          <select
            aria-label={view === "list" ? "Filter by" : "Group by"}
            value={groupField?.key ?? ""}
            onChange={(e) => saveGroupBy(e.target.value)}
            className={field}
            data-tt={view === "list" ? "Which field the filter menu offers" : "Which field the sections follow"}
          >
            {groupFields.map((f) => (
              <option key={f.key} value={f.key}>
                {view === "groups" ? "Group by: " : "By "}{f.label}
              </option>
            ))}
          </select>
        )}
        {filterOptions.length > 0 && (
          <select aria-label={`Filter by ${groupField?.label ?? ""}`} value={filterValue} onChange={(e) => setFilterValue(e.target.value)} className={field}>
            <option value="">All {groupField?.label.toLowerCase()}s</option>
            {filterOptions.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label} ({o.count})
              </option>
            ))}
          </select>
        )}
        {view === "cards" && groupFields.length > 0 && (
          <select aria-label="Group cards" value={cardsGroupBy} onChange={(e) => saveCardsGroupBy(e.target.value)} className={field}>
            <option value="">No sections</option>
            {groupFields.map((f) => (
              <option key={f.key} value={f.key}>
                Sections by {f.label}
              </option>
            ))}
          </select>
        )}

        <div className="flex overflow-hidden rounded-lg border border-slate-200">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              onClick={() => saveView(v.id)}
              className={`px-3 py-2 text-sm font-medium ${
                view === v.id ? "bg-compass-600 text-white" : "bg-surface text-slate-600 hover:bg-slate-50"
              }`}
              data-tt={v.label}
              aria-label={v.label}
              aria-pressed={view === v.id}
            >
              <span className="inline-flex items-center gap-1.5">
                {v.icon}
                <span className="hidden sm:inline">{v.label}</span>
              </span>
            </button>
          ))}
        </div>

        {view === "list" && (
          <div className="relative">
            <button onClick={() => { setColsOpen((o) => !o); setExportOpen(false); }} className={menuBtn} aria-expanded={colsOpen}>
              Columns <ChevronDown className="inline h-3.5 w-3.5" aria-hidden />
            </button>
            {colsOpen && (
              <div className="absolute z-20 mt-1 max-h-96 w-64 overflow-y-auto rounded-lg border border-slate-200 bg-surface p-2 shadow-lg">
                {allColumns.map((c) => (
                  <label key={c.key} className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
                    <input
                      type="checkbox"
                      checked={cols.includes(c.key)}
                      onChange={(e) =>
                        saveCols(e.target.checked ? [...cols, c.key] : cols.length > 1 ? cols.filter((x) => x !== c.key) : cols)
                      }
                    />
                    <span className="flex-1">{c.label}</span>
                    <span className="text-xs text-slate-400" data-tt="How many people have a value">
                      {initialPeople.filter((p) => cellValue(p, c.key, fields)).length}
                    </span>
                  </label>
                ))}
                <button className="mt-1 w-full rounded-sm px-2 py-1.5 text-left text-xs font-medium text-compass-600 hover:bg-slate-50" onClick={() => saveCols(defaultColumns)}>
                  Reset to defaults
                </button>
              </div>
            )}
          </div>
        )}

        <div className="relative">
          <button
            onClick={() => { setExportOpen((o) => !o); setColsOpen(false); }}
            className={menuBtn}
            aria-expanded={exportOpen}
            disabled={exporting}
          >
            <span className="inline-flex items-center gap-1.5">
              <Download className="h-4 w-4" aria-hidden /> {exporting ? "Exporting…" : "Export"} <ChevronDown className="h-3.5 w-3.5" aria-hidden />
            </span>
          </button>
          {exportOpen && (
            <div className="absolute right-0 z-20 mt-1 w-64 rounded-lg border border-slate-200 bg-surface p-1 shadow-lg">
              {presets.map((pr) => (
                <button key={pr.id} className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50" onClick={() => exportNow({ preset: pr.id }, "pdf")}>
                  <FileText className="h-4 w-4 text-slate-400" aria-hidden />
                  <span className="flex-1 truncate">{pr.name}</span>
                  <span className="text-[11px] uppercase text-slate-400">PDF</span>
                </button>
              ))}
              <div className="my-1 border-t border-slate-100" />
              <button className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50" onClick={() => whatISee("pdf")}>
                <FileText className="h-4 w-4 text-slate-400" aria-hidden /> <span className="flex-1">What I see</span>
                <span className="text-[11px] uppercase text-slate-400">PDF</span>
              </button>
              <button className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50" onClick={() => whatISee("csv")}>
                <Table2 className="h-4 w-4 text-slate-400" aria-hidden /> <span className="flex-1">What I see</span>
                <span className="text-[11px] uppercase text-slate-400">CSV</span>
              </button>
              <label className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50">
                <input
                  type="checkbox"
                  checked={officeInfo}
                  onChange={(e) => { setOfficeInfo(e.target.checked); writeJson(LS_OFFICE_INFO, e.target.checked); }}
                  className="h-3.5 w-3.5 accent-compass-600"
                />
                <span className="flex-1">Office information</span>
                <span className="text-[11px] uppercase text-slate-400">PDF</span>
              </label>
              <div className="my-1 border-t border-slate-100" />
              <button className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50" onClick={() => { setExportOpen(false); window.print(); }}>
                <Printer className="h-4 w-4 text-slate-400" aria-hidden /> Print…
              </button>
            </div>
          )}
        </div>

        <span className="ml-auto text-sm text-slate-500">
          {people.length} {people.length === 1 ? "person" : "people"}
        </span>
      </div>

      {people.length === 0 ? (
        initialPeople.length === 0 ? (
          <EmptyState
            icon={<BookUser />}
            title="The directory is empty"
            body={
              isAdmin
                ? "Add people, or connect Microsoft 365 or Google Workspace to sync them, under Settings → Directory."
                : "Admins can add people (or connect a directory sync) under Settings → Directory."
            }
            action={isAdmin ? { href: "/admin/directory", label: "Directory settings", icon: <Settings /> } : undefined}
          />
        ) : (
          <EmptyState icon={<UserSearch />} title="No one matches your search" body="Try a shorter name, or clear the filter." />
        )
      ) : view === "list" ? (
        /* ------------------------------ LIST ------------------------------ */
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-surface shadow-xs">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="w-8 px-2 py-2.5" aria-label="Pin" />
                {activeColumns.map((c) => (
                  <th key={c.key} className="select-none px-4 py-2.5" aria-sort={sortBy === c.key ? (sortDir === 1 ? "ascending" : "descending") : "none"}>
                    <button type="button" onClick={() => clickSort(c.key)} className="inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wide hover:text-slate-600">
                      {columnLabel(c.key, fields)}
                      <span aria-hidden>{sortBy === c.key ? (sortDir === 1 ? "↑" : "↓") : ""}</span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...pinned, ...people.filter((p) => p.pin_order == null)].map((p) => (
                <tr key={p.id} className={`border-b border-slate-50 hover:bg-slate-50/60 ${p.pin_order != null ? "bg-compass-50/30" : ""}`}>
                  <td className="px-2 py-2.5"><PinButton p={p} /></td>
                  {activeColumns.map((c) => (
                    <td key={c.key} className="px-4 py-2.5 align-top">{renderCell(p, c.key)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : view === "groups" ? (
        /* ------------------------------ GROUPS ---------------------------- */
        <div className="space-y-6">
          {pinnedSections(Tile, tileGrid)}
          {(grouped ?? []).map((g) => (
            <div key={g.key || "__none"}>
              <SectionHeader label={g.label} count={g.members.length} />
              <div className={tileGrid}>{g.members.map((p) => <Tile key={p.id} p={p} />)}</div>
            </div>
          ))}
        </div>
      ) : grouped ? (
        /* --------------------------- CARDS, IN SECTIONS ------------------- */
        <div className="space-y-6">
          {pinnedSections(Card, cardGrid)}
          {grouped.map((g) => (
            <div key={g.key || "__none"}>
              <SectionHeader label={g.label} count={g.members.length} />
              <div className={cardGrid}>{g.members.map((p) => <Card key={p.id} p={p} />)}</div>
            </div>
          ))}
        </div>
      ) : (
        /* ------------------------------ CARDS ----------------------------- */
        <div className="space-y-6">
          {pinnedSections(Card, cardGrid)}
          <div>
            {(mine.length > 0 || pinned.length > 0) && <SectionHeader label="Everyone" count={people.length} />}
            {/* grid-cols-1 is not redundant: without an explicit track the
                implicit auto column sizes to the card's content and overflows
                a phone. */}
            <div className={cardGrid}>{people.map((p) => <Card key={p.id} p={p} />)}</div>
          </div>
        </div>
      )}
    </div>
  );
}
