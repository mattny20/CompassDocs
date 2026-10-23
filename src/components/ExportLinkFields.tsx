"use client";

// A preset's download link, ready to copy (1.15.0): the file type, the link
// itself as read-only text (so it can also be selected by hand), Copy, and
// an icon to try it in a new tab. Shared by the admin preset editor's
// Download link card and the Directory page's "Copy download link…" dialog,
// so both hand out the same URL for the same choice (lib/directory-export-link).
// The buttons sit beside the Link field, not inside it: Field wraps its
// control in a <label>, which must hold one control.

import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { Field, Select, TextInput } from "@/components/form";
import { CopyButton } from "@/components/CopyButton";
import { iconButtonClass } from "@/components/Button";
import { exportLinkFormatOptions, exportLinkUrl, type ExportLinkFormat } from "@/lib/directory-export-link";

/**
 * The origin a link is built on: the workspace's custom domain when one is
 * set (passed from the server page), else this browser's origin, read after
 * mount so the server render and the first client render agree.
 */
export function useLinkOrigin(configured?: string): string {
  const [origin, setOrigin] = useState(configured ?? "");
  useEffect(() => {
    if (!configured) setOrigin(window.location.origin);
  }, [configured]);
  return origin;
}

export function ExportLinkFields({
  presetId,
  split = false,
  origin,
  format,
  onFormat,
}: {
  presetId: string;
  /** The preset splits into one file per section: its PDF and CSV arrive as ZIPs. */
  split?: boolean;
  /** From useLinkOrigin. */
  origin: string;
  format: ExportLinkFormat;
  onFormat: (f: ExportLinkFormat) => void;
}) {
  const url = origin ? exportLinkUrl(origin, presetId, format) : "";
  return (
    <div className="space-y-3">
      <Field label="File" size="sm">
        <Select value={format} onChange={(e) => onFormat(e.target.value as ExportLinkFormat)} className="w-full">
          {exportLinkFormatOptions(split).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex min-w-0 flex-wrap items-end gap-2">
        <Field label="Link" className="min-w-0 flex-1 basis-64">
          <TextInput value={url} readOnly onFocus={(e) => e.currentTarget.select()} className="w-full font-mono text-xs" />
        </Field>
        <div className="flex items-center gap-2">
          <CopyButton text={url} label="Copy link" size="md" />
          <a
            href={url || undefined}
            target="_blank"
            rel="noopener"
            className={iconButtonClass("bordered", "md")}
            data-tt="Open the link in a new tab"
            aria-label="Open the link in a new tab"
          >
            <ExternalLink aria-hidden />
          </a>
        </div>
      </div>
    </div>
  );
}
