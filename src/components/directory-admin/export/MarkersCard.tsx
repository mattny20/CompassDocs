"use client";

// The Markers card on the Export page: the workspace's definitions of the
// symbols an export may print in front of a name (a notary, a partner, a
// first-aider), one table row each, saved on their own. Each preset picks
// which of these it prints (the Columns card's "Mark people with"); the key
// goes in the PDF's footer. The rules are lib/directory-marker-rules, the
// same the PUT route refuses with, so what is typed is what is saved: Save
// waits the moment a row is wrong, and the message waits until the row's
// control has been left, so a name still being typed is not shouted at.

import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Card } from "@/components/Card";
import { Button, iconButtonClass } from "@/components/Button";
import { SaveRow } from "@/components/SaveRow";
import { SectionEmpty, Select, TextInput } from "@/components/form";
import { TABLE_HEAD_ROW, TR, Table, Td, Th } from "@/components/Table";
import { toast } from "@/components/Toasts";
import { useUnsavedChanges } from "@/lib/use-unsaved";
import {
  MARKER_LABEL_MAX,
  MARKER_LIMIT,
  MARKER_SYMBOLS,
  MARKER_SYMBOL_MAX,
  MARKER_VALUE_MAX,
  markerProblem,
  type ExportMarker,
} from "@/lib/directory-marker-rules";
import { jsonFetch, type KeyOption } from "../shared";

/** The symbols by name, so the select reads "† dagger" rather than a lone glyph. */
const SYMBOL_NAMES: Record<(typeof MARKER_SYMBOLS)[number], string> = {
  "*": "asterisk",
  "†": "dagger",
  "‡": "double dagger",
  "§": "section sign",
  "¶": "pilcrow",
  "•": "bullet",
  "°": "degree",
  "¹": "superscript 1",
  "²": "superscript 2",
  "³": "superscript 3",
  "^": "caret",
  "~": "tilde",
  "+": "plus",
  "#": "hash",
};

/** The select's value for a symbol typed by hand. */
const OTHER = "other";

const VALUE_HELP = "Value: leave blank to mark everyone who has any value.";

/** A marker as edited; `uid` keys the row while a new marker has no id yet. */
interface Row extends ExportMarker {
  uid: string;
}

const strip = (r: Row): ExportMarker => ({ id: r.id, label: r.label, symbol: r.symbol, key: r.key, value: r.value });
const toRows = (markers: ExportMarker[]): Row[] => markers.map((m) => ({ ...m, uid: m.id }));
const listed = (symbol: string) => (MARKER_SYMBOLS as readonly string[]).includes(symbol);

export function MarkersCard({
  fieldOptions,
  initialMarkers,
  onSaved,
  onDirty,
}: {
  /** The fields a marker may read, labelled as the columns are. */
  fieldOptions: KeyOption[];
  initialMarkers: ExportMarker[];
  /** The set as the server saved it: what the preset editor's list now offers. */
  onSaved: (markers: ExportMarker[]) => void;
  /** Unsaved rows here, for the page's leave guard. */
  onDirty?: (dirty: boolean) => void;
}) {
  const seq = useRef(0);
  const [rows, setRows] = useState<Row[]>(() => toRows(initialMarkers));
  /** Rows whose symbol is typed rather than picked, by uid. */
  const [other, setOther] = useState<ReadonlySet<string>>(new Set());
  /** Rows a control has been left in, by uid: the ones whose problem is shown. */
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const { dirty, markDirty, markClean } = useUnsavedChanges(JSON.stringify(rows.map(strip)));
  useEffect(() => {
    onDirty?.(dirty);
  }, [dirty, onDirty]);

  const keys = useMemo(() => new Set(fieldOptions.map((f) => f.key)), [fieldOptions]);
  const problems = rows.flatMap((r, i) => {
    const problem = markerProblem(r, i, keys);
    return problem ? [{ uid: r.uid, ...problem }] : [];
  });
  const invalid = problems.length > 0;
  const shown = problems.find((p) => touched.has(p.uid));

  function patch(uid: string, changes: Partial<ExportMarker>) {
    setRows((rs) => rs.map((r) => (r.uid === uid ? { ...r, ...changes } : r)));
    markDirty();
  }
  function touch(uid: string) {
    setTouched((t) => new Set(t).add(uid));
  }
  function add() {
    if (rows.length >= MARKER_LIMIT) return;
    const uid = `new-${++seq.current}`;
    setRows((rs) => [...rs, { uid, id: "", label: "", symbol: "*", key: fieldOptions[0]?.key ?? "", value: "" }]);
    markDirty();
  }
  function remove(uid: string) {
    setRows((rs) => rs.filter((r) => r.uid !== uid));
    markDirty();
  }
  function pickSymbol(uid: string, choice: string) {
    if (choice === OTHER) {
      setOther((o) => new Set(o).add(uid));
      patch(uid, { symbol: "" });
      return;
    }
    setOther((o) => {
      const next = new Set(o);
      next.delete(uid);
      return next;
    });
    patch(uid, { symbol: choice });
  }

  async function save() {
    setSaving(true);
    const r = await jsonFetch("/api/admin/directory/markers", { method: "PUT", body: JSON.stringify({ markers: rows.map(strip) }) });
    setSaving(false);
    if (!r.ok) {
      toast("error", r.data?.error || "Could not save the markers.");
      return;
    }
    markClean();
    // The rows now show what was saved: new markers carry their ids.
    setRows(toRows(r.data.markers));
    setOther(new Set());
    setTouched(new Set());
    onSaved(r.data.markers);
    toast("ok", "Markers saved.");
  }

  return (
    <Card
      id="markers"
      className="scroll-mt-6"
      padding="none"
      title="Markers"
      description="A symbol in front of a person's name on exports, for people who match a field value: a notary, a partner, a first-aider. Each preset chooses which markers it prints; the key prints in the footer."
    >
      {rows.length === 0 ? (
        <SectionEmpty className="px-4 py-4">A marker you add here appears in every preset's Mark people with list.</SectionEmpty>
      ) : (
        <>
          <Table scroll minWidth="40rem">
            <thead className={TABLE_HEAD_ROW}>
              <tr>
                <Th fit>Symbol</Th>
                <Th>Name</Th>
                <Th>Field</Th>
                <Th>Value</Th>
                <Th fit>
                  <span className="sr-only">Remove</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const who = r.label.trim() || `marker ${i + 1}`;
                const problem = touched.has(r.uid) ? problems.find((p) => p.uid === r.uid) : undefined;
                const isOther = other.has(r.uid) || !listed(r.symbol);
                return (
                  <tr key={r.uid} className={TR}>
                    <Td fit>
                      <div className="flex items-center gap-1">
                        <Select
                          dense
                          className="w-auto"
                          value={isOther ? OTHER : r.symbol}
                          onChange={(e) => pickSymbol(r.uid, e.target.value)}
                          onBlur={() => touch(r.uid)}
                          hasError={problem?.field === "symbol"}
                          aria-label={`Symbol for ${who}`}
                        >
                          {MARKER_SYMBOLS.map((s) => (
                            <option key={s} value={s}>
                              {s} {SYMBOL_NAMES[s]}
                            </option>
                          ))}
                          <option value={OTHER}>Other…</option>
                        </Select>
                        {isOther && (
                          <TextInput
                            dense
                            className="w-14"
                            maxLength={MARKER_SYMBOL_MAX}
                            value={r.symbol}
                            onChange={(e) => patch(r.uid, { symbol: e.target.value })}
                            onBlur={() => touch(r.uid)}
                            hasError={problem?.field === "symbol"}
                            aria-label={`Other symbol for ${who}`}
                          />
                        )}
                      </div>
                    </Td>
                    <Td>
                      <TextInput
                        dense
                        maxLength={MARKER_LABEL_MAX}
                        value={r.label}
                        placeholder="Public notary"
                        onChange={(e) => patch(r.uid, { label: e.target.value })}
                        onBlur={() => touch(r.uid)}
                        hasError={problem?.field === "label"}
                        aria-label={`Name of ${who}`}
                      />
                    </Td>
                    <Td>
                      <Select
                        dense
                        className="w-full"
                        value={r.key}
                        onChange={(e) => patch(r.uid, { key: e.target.value })}
                        onBlur={() => touch(r.uid)}
                        hasError={problem?.field === "key"}
                        aria-label={`Field for ${who}`}
                      >
                        {fieldOptions.map((f) => (
                          <option key={f.key} value={f.key}>
                            {f.label}
                          </option>
                        ))}
                      </Select>
                    </Td>
                    <Td>
                      <TextInput
                        dense
                        maxLength={MARKER_VALUE_MAX}
                        value={r.value}
                        placeholder="Any value"
                        onChange={(e) => patch(r.uid, { value: e.target.value })}
                        onBlur={() => touch(r.uid)}
                        hasError={problem?.field === "value"}
                        aria-label={`Value for ${who}`}
                      />
                    </Td>
                    <Td fit>
                      <button
                        type="button"
                        className={iconButtonClass("quiet", "sm")}
                        onClick={() => remove(r.uid)}
                        data-tt="Remove"
                        aria-label={`Remove ${who}`}
                      >
                        <Trash2 />
                      </button>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          {/* The shared help, or the first touched row's problem, in one line
              under the table (the OrderedKeyList rule: the offending row's
              control alone takes hasError). */}
          <p role={shown ? "alert" : undefined} className={shown ? "px-4 py-2 text-xs text-red-600" : "px-4 py-2 text-xs text-slate-500"}>
            {shown ? shown.message : VALUE_HELP}
          </p>
        </>
      )}
      <div className="border-t border-slate-100 px-4 py-3">
        <SaveRow dirty={dirty} busy={saving} onSave={save} label="Save markers" sticky={false} disabled={invalid}>
          <Button variant="secondary" icon={<Plus />} onClick={add} disabled={rows.length >= MARKER_LIMIT}>
            Add a marker
          </Button>
        </SaveRow>
      </div>
    </Card>
  );
}
