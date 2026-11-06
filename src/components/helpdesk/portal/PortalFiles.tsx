"use client";

// Files on a portal request or reply: picked here, kept until the message
// is sent (they travel with it, nothing is uploaded ahead), shown as chips
// with a remove control. Five files of up to 10 MB; the server checks the
// same and the contact's daily quota, and its refusal shows under the box.

import { useRef } from "react";
import { FileText, Paperclip, X } from "lucide-react";
import { iconButtonClass } from "@/components/Button";
import { chipClass } from "@/components/Chip";

export const PORTAL_MAX_FILES = 5;
export const PORTAL_MAX_MB = 10;

export function PortalAttachButton({ files, onChange, onError }: { files: File[]; onChange: (f: File[]) => void; onError: (msg: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  function add(list: FileList | null) {
    if (!list) return;
    const picked = Array.from(list);
    const big = picked.find((f) => f.size > PORTAL_MAX_MB * 1024 * 1024);
    if (big) onError(`“${big.name}” is too big. Files can be up to ${PORTAL_MAX_MB} MB.`);
    const ok = picked.filter((f) => f.size <= PORTAL_MAX_MB * 1024 * 1024);
    const room = PORTAL_MAX_FILES - files.length;
    if (ok.length > room) onError(`Attach up to ${PORTAL_MAX_FILES} files at a time.`);
    onChange([...files, ...ok.slice(0, Math.max(0, room))]);
    if (ref.current) ref.current.value = "";
  }
  return (
    <>
      <input ref={ref} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => add(e.target.files)} />
      <button type="button" className={iconButtonClass("bordered", "md")} aria-label="Attach files" data-tt="Attach files" onClick={() => ref.current?.click()}>
        <Paperclip className="h-4 w-4" aria-hidden />
      </button>
    </>
  );
}

export function PortalFileChips({ files, onChange }: { files: File[]; onChange: (f: File[]) => void }) {
  if (!files.length) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Files to send">
      {files.map((f, i) => (
        <li key={`${f.name}-${i}`} className={chipClass("neutral", "md", "max-w-full pr-1")}>
          <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">{f.name}</span>
          <button
            type="button"
            className="ml-0.5 rounded-full p-0.5 hover:bg-slate-200"
            aria-label={`Remove ${f.name}`}
            data-tt="Remove"
            onClick={() => onChange(files.filter((_, j) => j !== i))}
          >
            <X className="h-3 w-3" aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}
