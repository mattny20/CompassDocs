"use client";

// Attachments on a request or a reply (1.19.0): files go up one by one to
// the helpdesk's upload route (the existing uploads store, with its size
// and type limits) as soon as they are picked, show as chips with a
// remove control while the message is being written, and travel with it as
// [{id, name, size, type}] (POST /api/helpdesk/attachments, unbound until
// a request or reply carries the id; GET …/[id] is the access-checked
// download). Sending waits for every upload to land; a refusal (413 too
// big, 415 a type the store refuses) is an inline line under the files.

import { useRef, useState } from "react";
import { FileText, Paperclip, X } from "lucide-react";
import { iconButtonClass } from "@/components/Button";
import { chipClass } from "@/components/Chip";
import { Spinner } from "@/components/Spinner";
import type { HdAttachment } from "@/lib/helpdesk/types";
import { fetchJson } from "./shared";

/** One message carries at most this many files (the API's own cap is the authority). */
export const MAX_FILES = 10;

interface Item {
  key: string;
  name: string;
  /** Set once the upload has landed. */
  attachment?: HdAttachment;
}

export interface Uploads {
  items: Item[];
  busy: boolean;
  done: HdAttachment[];
  /** The last refusal, shown inline under the files (too big, a type the store refuses). */
  error: string;
  add: (files: FileList | null) => void;
  remove: (key: string) => void;
  clear: () => void;
}

let seq = 0;

/** What a refused upload says: the server's sentence, else one that names the file and the reason. */
function uploadError(status: number, serverError: string, name: string): string {
  if (status === 413) return `“${name}” is too big to attach.${serverError && !/too (big|large)/i.test(serverError) ? ` ${serverError}` : ""}`;
  if (status === 415) return `“${name}” is a kind of file that can't be attached.`;
  return serverError || `Couldn't attach “${name}”.`;
}

export function useUploads(): Uploads {
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState("");

  function add(files: FileList | null) {
    if (!files) return;
    setError("");
    const room = MAX_FILES - items.length;
    const picked = Array.from(files).slice(0, Math.max(0, room));
    if (files.length > picked.length) setError(`Up to ${MAX_FILES} files on one message.`);
    for (const file of picked) {
      const key = `u${++seq}`;
      setItems((xs) => [...xs, { key, name: file.name }]);
      const form = new FormData();
      form.append("file", file);
      void fetchJson<HdAttachment & { attachment?: HdAttachment }>(
        "/api/helpdesk/attachments",
        { method: "POST", body: form },
        ""
      ).then((res) => {
        // The route answers the attachment itself; tolerate a wrapped one.
        const attachment = res.ok ? (res.data.attachment ?? (typeof res.data.id === "number" ? res.data : undefined)) : undefined;
        if (attachment) {
          const a: HdAttachment = { id: attachment.id, name: attachment.name, size: attachment.size, type: attachment.type };
          setItems((xs) => xs.map((x) => (x.key === key ? { ...x, attachment: a } : x)));
        } else {
          setItems((xs) => xs.filter((x) => x.key !== key));
          setError(res.ok ? `Couldn't attach “${file.name}”.` : uploadError(res.status, res.error, file.name));
        }
      });
    }
  }

  return {
    items,
    busy: items.some((x) => !x.attachment),
    done: items.flatMap((x) => (x.attachment ? [x.attachment] : [])),
    error,
    add,
    remove: (key) => setItems((xs) => xs.filter((x) => x.key !== key)),
    clear: () => {
      setItems([]);
      setError("");
    },
  };
}

/** The paperclip: an icon button over a hidden file input. */
export function AttachButton({ uploads }: { uploads: Uploads }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          uploads.add(e.target.files);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        onClick={() => input.current?.click()}
        data-tt="Attach files"
        aria-label="Attach files"
        className={iconButtonClass("bordered", "md")}
      >
        <Paperclip />
      </button>
    </>
  );
}

/** The files on a message being written, each removable. Renders nothing when there are none. */
export function AttachmentChips({ uploads }: { uploads: Uploads }) {
  if (uploads.items.length === 0 && !uploads.error) return null;
  return (
    <div className="flex flex-col gap-1.5">
    {uploads.error && (
      <p role="alert" className="text-xs text-red-600">
        {uploads.error}
      </p>
    )}
    {uploads.items.length > 0 && (
    <ul className="flex flex-wrap gap-2" aria-label="Attached files">
      {uploads.items.map((x) => (
        <li key={x.key} className={chipClass("neutral", "md", "max-w-full gap-1.5 py-1 pl-2.5 pr-1")}>
          {x.attachment ? <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <Spinner size="sm" label={`Uploading ${x.name}`} />}
          <span className="min-w-0 truncate">{x.name}</span>
          <button
            type="button"
            onClick={() => uploads.remove(x.key)}
            data-tt="Remove"
            aria-label={`Remove ${x.name}`}
            className={iconButtonClass("quiet", "sm", "h-5! w-5! [&>svg]:h-3! [&>svg]:w-3!")}
          >
            <X />
          </button>
        </li>
      ))}
    </ul>
    )}
    </div>
  );
}

/** A sent file, as a download link (the route checks the viewer may see the ticket). */
export function AttachmentLinks({ files }: { files: HdAttachment[] }) {
  if (!files?.length) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-2">
      {files.map((f) => (
        <li key={f.id}>
          <a
            href={`/api/helpdesk/attachments/${f.id}`}
            className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-slate-200 bg-surface px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            <Paperclip className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
            <span className="truncate">{f.name}</span>
            <span className="shrink-0 text-slate-500">{formatSize(f.size)}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

function formatSize(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
