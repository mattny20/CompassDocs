"use client";

// The Directory page's Export → "Copy download link…" (1.15.0): pick an
// export and a file type, copy the link. Anyone who can export can hand a
// link out: it carries no rights of its own, and whoever opens it signs in
// and gets the file their own account can see (lib/directory-export-link).
// Settings → Directory → Export has the same fields per preset.

import { useId, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/Button";
import { Field, Select } from "@/components/form";
import { ExportLinkFields, useLinkOrigin } from "@/components/ExportLinkFields";
import type { ExportLinkFormat } from "@/lib/directory-export-link";

export interface LinkPreset {
  id: string;
  name: string;
  is_default: boolean;
  split_by?: string;
}

export function ExportLinkDialog({
  open,
  onClose,
  presets,
  linkOrigin,
}: {
  open: boolean;
  onClose: () => void;
  presets: LinkPreset[];
  /** The custom domain's origin, when one is set. */
  linkOrigin?: string;
}) {
  const titleId = useId();
  const bodyId = useId();
  const fallback = presets.find((p) => p.is_default) ?? presets[0];
  const [presetId, setPresetId] = useState(fallback?.id ?? "");
  const [format, setFormat] = useState<ExportLinkFormat>("pdf");
  const origin = useLinkOrigin(linkOrigin);
  const preset = presets.find((p) => p.id === presetId) ?? fallback;
  if (!preset) return null;
  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      describedBy={bodyId}
      className="w-full max-w-lg rounded-xl border border-slate-200 bg-surface p-5 shadow-modal"
    >
      <h2 id={titleId} className="text-base font-semibold text-slate-900">
        Copy a download link
      </h2>
      <p id={bodyId} className="mt-1 text-sm text-slate-600">
        Paste it into an email or an intranet page. Whoever opens it signs in, and the file downloads straight away,
        made from what their own account can see.
      </p>
      <div className="mt-4 space-y-3">
        <Field label="Export" size="sm">
          <Select value={preset.id} onChange={(e) => setPresetId(e.target.value)} className="w-full">
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <ExportLinkFields
          presetId={preset.id}
          split={Boolean(preset.split_by)}
          origin={origin}
          format={format}
          onFormat={setFormat}
        />
      </div>
      <div className="mt-5 flex justify-end">
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
      </div>
    </Modal>
  );
}
