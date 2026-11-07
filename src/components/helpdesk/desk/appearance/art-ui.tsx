"use client";

// Pieces the Appearance page and "My desk background" share (1.19.4;
// STYLEGUIDE §Helpdesk: desk background): an artwork's thumbnail, the
// dashed upload tile, and the upload itself.

import { useRef, type ReactNode } from "react";
import { Upload } from "lucide-react";
import { busyClass } from "@/components/Spinner";
import { HD_ART_ACCEPT, type HdArtView } from "@/lib/helpdesk/appearance-shared";
import { ApiError } from "../api";

/** POST one picture as multipart; throws ApiError with the server's sentence. */
export async function uploadArt<T>(url: string, file: File): Promise<T> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(url, { method: "POST", body: form, headers: { accept: "application/json" } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error || "Couldn't upload the picture.", res.status);
  return data as T;
}

/** The picture, cropped to the box (its 480px copy, loaded lazily over its average colour). */
export function ArtThumb({ art, selected = false, className = "" }: { art: HdArtView; selected?: boolean; className?: string }) {
  return (
    <span
      className={`block overflow-hidden rounded-lg ${selected ? "border-2 border-compass-600 ring-4 ring-compass-100" : "border border-slate-200"} ${className}`.trim()}
      style={{ background: art.tint }}
    >
      {/* Decorative: the label beside it names the picture. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={art.thumb} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
    </span>
  );
}

/** A dashed tile that opens the file picker (JPG, PNG, WebP). */
export function UploadTile({
  onFile,
  busy = false,
  label,
  children,
  className = "",
  ...a11y
}: {
  onFile: (file: File) => void;
  busy?: boolean;
  /** The accessible name, when the tile shows only an icon. */
  label?: string;
  children?: ReactNode;
  className?: string;
  "data-tt"?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={busy}
        aria-label={label}
        aria-busy={busy || undefined}
        {...a11y}
        className={`grid place-items-center rounded-lg border-[1.5px] border-dashed border-slate-300 text-compass-600 transition hover:border-compass-400 hover:bg-compass-50/40 disabled:cursor-wait ${busyClass(busy)} ${className}`.trim()}
      >
        {children ?? <Upload className="h-4 w-4" aria-hidden />}
      </button>
      <input
        ref={input}
        type="file"
        accept={HD_ART_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) onFile(f);
        }}
      />
    </>
  );
}

/** The upload tile's content on the Appearance page: the icon over the words. */
export function UploadTileLabel({ children }: { children: ReactNode }) {
  return (
    <span className="flex flex-col items-center gap-1.5 text-sm font-medium">
      <Upload className="h-4 w-4" aria-hidden />
      {children}
    </span>
  );
}
