"use client";

// The ticket side panel's "Custom fields" card (1.20.6, lib/helpdesk/
// custom-fields): the fields assigned to the ticket's team, in the settings
// page's order, each edited in place like the properties above it. A row is
// the label over its value (an admin's label may be long, and a value such as
// a date or a serial number is never cut short beside it). A choice
// and a yes/no are picker menus (one click, one PATCH); text, a number and a
// date open the house prompt; a person opens a small dialog with the request
// form's people picker. Each change goes through the ticket's PATCH
// (`custom_fields`), so it needs what changing the category needs (an agent
// who works the ticket) and leaves an agents-only timeline line.
//
// No field assigned to the ticket's team: the card is not rendered. A field
// the requester also sees ("Public") carries an eye, explained once under
// the rows.

import { useId, useRef, useState } from "react";
import { ChevronDown, Eye, Pencil } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { CARD_CLASS } from "@/components/Card";
import { EYEBROW_TEXT } from "@/components/Heading";
import { Modal } from "@/components/Modal";
import { promptDialog } from "@/components/Dialog";
import { useFormatDate } from "@/components/SettingsProvider";
import { FormFieldControl } from "@/components/helpdesk/help/RequestForm";
import type { HdTicketDetail, HdTicketPatch } from "@/lib/helpdesk/types";
import { customFieldAsFormField, isChoiceKind, type HdCustomValue, type HdTicketCustomField } from "@/lib/helpdesk/custom-fields-shared";
import { PickMenu } from "../PickMenu";

const ROW = "border-b border-slate-100 py-1.5 last:border-b-0";
const VALUE_BTN =
  "-ml-1.5 inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm font-medium text-slate-800 transition hover:bg-slate-100 disabled:hover:bg-transparent";

const TEXT_MAX = 500;
const LONG_MAX = 10_000;

export function CustomFieldsCard({ d, onPatch }: { d: HdTicketDetail; onPatch: (patch: HdTicketPatch, ok?: string) => void }) {
  const fields = d.custom_fields ?? [];
  const fmt = useFormatDate();
  const [person, setPerson] = useState<HdTicketCustomField | null>(null);
  if (fields.length === 0) return null;
  const can = d.can_work;

  const save = (f: HdTicketCustomField, value: HdCustomValue) =>
    onPatch({ custom_fields: { [f.key]: value } }, value === null ? `${f.label} cleared.` : `${f.label} saved.`);

  /** The value as the row shows it. */
  const shown = (f: HdTicketCustomField) => {
    if (f.type === "date" && typeof f.value === "string") return fmt.day(f.value) || f.text;
    // A date and time (the kind the event calendar added): the day as the workspace writes it, then the clock time.
    if (f.type === "datetime" && typeof f.value === "string") return `${fmt.day(f.value.slice(0, 10)) || f.value.slice(0, 10)}, ${f.value.slice(11, 16)}`;
    return f.text;
  };

  async function editText(f: HdTicketCustomField) {
    const long = f.type === "textarea";
    const max = long ? LONG_MAX : TEXT_MAX;
    const v = await promptDialog({
      title: f.label,
      label: f.label,
      help: f.help || undefined,
      initial: f.value === null || f.value === undefined ? "" : String(f.value),
      type: long ? "textarea" : f.type === "number" ? "number" : f.type === "date" ? "date" : f.type === "datetime" ? "datetime-local" : "text",
      required: false,
      confirmLabel: "Save",
      validate: (s) => {
        if (f.type === "number" && s.trim() && !Number.isFinite(Number(s))) return "Enter a number.";
        if ((f.type === "text" || long) && s.trim().length > max) return `Up to ${max} characters.`;
        return undefined;
      },
    });
    if (v === null) return;
    const t = v.trim();
    const next: HdCustomValue = t === "" ? null : f.type === "number" ? Number(t) : t;
    if ((next ?? null) === (f.value ?? null)) return;
    save(f, next);
  }

  const anyPublic = fields.some((f) => f.visibility === "public");

  return (
    <section aria-labelledby="custom-fields-h" className={`${CARD_CLASS} px-4 pb-1 pt-3`} data-testid="custom-fields">
      <h3 id="custom-fields-h" className={EYEBROW_TEXT}>
        Custom fields
      </h3>
      <div className="mt-1">
        {fields.map((f) => {
          const label = (
            <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-slate-500">
              <span className="min-w-0 break-words">{f.label}</span>
              {f.visibility === "public" && (
                <>
                  <Eye className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
                  <span className="sr-only">(the requester sees this)</span>
                </>
              )}
            </span>
          );
          const text = shown(f);
          if (f.type === "textarea") {
            // A long answer reads under its label, as the request's answers do.
            return (
              <div key={f.id} className={ROW} data-testid={`custom-field-${f.key}`}>
                <div className="flex min-h-7 items-center justify-between gap-3">
                  {label}
                  {can && (
                    <button type="button" onClick={() => editText(f)} aria-label={`${f.label}. Change`} data-tt="Edit" className={iconButtonClass("quiet", "sm")}>
                      <Pencil aria-hidden />
                    </button>
                  )}
                </div>
                <p className={`whitespace-pre-wrap break-words pb-1 text-sm ${text ? "font-medium text-slate-800" : "text-slate-500"}`}>{text || "None"}</p>
              </div>
            );
          }
          const name = `${f.label}: ${text || "None"}`;
          const face = (
            <>
              <span className="truncate">{text || "None"}</span>
              {can && <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />}
            </>
          );
          return (
            <div key={f.id} className={ROW} data-testid={`custom-field-${f.key}`}>
              <div className="flex pt-1">{label}</div>
              {isChoiceKind(f.type) ? (
                <div>
                  <PickMenu
                    label={f.label}
                    align="start"
                    width="w-56"
                    value={f.value === null || f.value === undefined ? "" : String(f.value)}
                    options={[
                      { value: "", label: "None" },
                      ...f.options.map((o) => ({ value: o.value, label: o.label, hint: o.hint })),
                      // A value whose option was removed since stays listed, so the menu shows what the ticket holds.
                      ...(f.value !== null && !f.options.some((o) => o.value === String(f.value)) ? [{ value: String(f.value), label: f.text || String(f.value) }] : []),
                    ]}
                    onPick={(v) => save(f, v === "" ? null : v)}
                    trigger={(p) => (
                      <button {...p} type="button" disabled={!can} aria-label={name} className={VALUE_BTN}>
                        {face}
                      </button>
                    )}
                  />
                </div>
              ) : f.type === "checkbox" ? (
                <div>
                  <PickMenu
                    label={f.label}
                    align="start"
                    width="w-56"
                    value={f.value === true ? "yes" : f.value === false ? "no" : ""}
                    options={[
                      { value: "", label: "None" },
                      { value: "yes", label: "Yes" },
                      { value: "no", label: "No" },
                    ]}
                    onPick={(v) => save(f, v === "" ? null : v === "yes")}
                    trigger={(p) => (
                      <button {...p} type="button" disabled={!can} aria-label={name} className={VALUE_BTN}>
                        {face}
                      </button>
                    )}
                  />
                </div>
              ) : (
                <button type="button" disabled={!can} onClick={() => (f.type === "user" ? setPerson(f) : void editText(f))} aria-label={`${name}. Change`} className={VALUE_BTN}>
                  {face}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {anyPublic && (
        <p className="flex items-center gap-1.5 border-t border-slate-100 py-2 text-xs text-slate-500">
          <Eye className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
          The requester sees these once they are filled in.
        </p>
      )}
      {person && (
        <PersonDialog
          key={person.id}
          field={person}
          onClose={() => setPerson(null)}
          onSave={(v) => {
            setPerson(null);
            if ((v ?? null) !== (person.value ?? null)) save(person, v);
          }}
        />
      )}
    </section>
  );
}

/** "A person": the request form's people picker in a small dialog. Saved by its button; clearing the person and saving clears the field. */
function PersonDialog({ field, onClose, onSave }: { field: HdTicketCustomField; onClose: () => void; onSave: (v: HdCustomValue) => void }) {
  const titleId = useId();
  const refs = useRef(new Map<string, HTMLElement | null>());
  const [value, setValue] = useState<HdCustomValue>(field.value);
  return (
    <Modal open onClose={onClose} labelledBy={titleId} className="w-full max-w-md rounded-xl border border-slate-200 bg-surface p-5 shadow-modal">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(typeof value === "number" ? value : null);
        }}
      >
        <h2 id={titleId} className="text-base font-semibold text-slate-900">
          {field.label}
        </h2>
        <div className="mt-4">
          <FormFieldControl field={customFieldAsFormField(field, true)} value={value} onChange={setValue} refs={refs} prefilled={false} />
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit">Save</Button>
        </div>
      </form>
    </Modal>
  );
}
