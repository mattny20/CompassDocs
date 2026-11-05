"use client";

// Edit dashboard (1.17.0): the link beside the date and the dialog it opens,
// one switch per dashboard section. Save stores the hidden set for this
// person (PUT /api/account/dashboard) and refreshes the page, which then
// neither renders a hidden section nor fetches its data. The sections and
// their labels come from the server (lib/dashboard-sections), filtered to the
// ones this workspace offers.

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/Button";
import { Toggle } from "@/components/form";
import { toast } from "@/components/Toasts";

export interface EditableSection {
  key: string;
  label: string;
  help: string;
}

export function EditDashboardButton({ sections, hidden }: { sections: EditableSection[]; hidden: string[] }) {
  const router = useRouter();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [off, setOff] = useState<Set<string>>(() => new Set(hidden));
  const [saving, setSaving] = useState(false);

  function start() {
    // Every opening starts from what is stored, not from an abandoned edit.
    setOff(new Set(hidden));
    setOpen(true);
  }

  async function save() {
    setSaving(true);
    try {
      // Keys this workspace does not offer (a feature switched off since)
      // keep their stored state.
      const offered = new Set(sections.map((s) => s.key));
      const next = [...off, ...hidden.filter((k) => !offered.has(k))];
      const res = await fetch("/api/account/dashboard", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hidden: [...new Set(next)] }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast("error", (data as { error?: string }).error || "Couldn't save your dashboard.");
        return;
      }
      setOpen(false);
      toast("ok", "Dashboard saved.");
      router.refresh();
    } catch {
      toast("error", "Couldn't save your dashboard.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={start}
        aria-haspopup="dialog"
        className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm font-medium text-compass-700 hover:text-compass-800 print:hidden"
      >
        <Pencil className="h-3.5 w-3.5" aria-hidden />
        Edit dashboard
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        labelledBy={titleId}
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col rounded-xl border border-slate-200 bg-surface shadow-modal"
      >
        <div className="px-5 pt-5">
          <h2 id={titleId} className="text-base font-semibold text-slate-900">
            Edit dashboard
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Choose what your dashboard shows. Only you see this change.
          </p>
        </div>
        <div className="mt-4 min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pb-1">
          {sections.map((s) => (
            <Toggle
              key={s.key}
              size="full"
              label={s.label}
              help={s.help}
              checked={!off.has(s.key)}
              onChange={(show) =>
                setOff((cur) => {
                  const next = new Set(cur);
                  if (show) next.delete(s.key);
                  else next.add(s.key);
                  return next;
                })
              }
            />
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 px-5 py-4">
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="button" busy={saving} onClick={save}>
            Save
          </Button>
        </div>
      </Modal>
    </>
  );
}
