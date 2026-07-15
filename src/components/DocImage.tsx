"use client";

// Inline document image: honors an author-chosen display width and zooms to a
// full-screen lightbox on click. The width travels in the markdown image
// *title* as "w=NN%" (e.g. ![shot](/api/attachments/3 "w=50%")) — still plain
// CommonMark, so the content renders sanely in any other markdown tool.

import { useEffect, useState } from "react";

export function parseImageWidth(title?: string | null): string | undefined {
  const m = /^w=(\d{1,3})%$/.exec(title ?? "");
  if (!m) return undefined;
  const pct = Math.min(100, Math.max(5, Number(m[1])));
  return `${pct}%`;
}

export function DocImage({
  src,
  alt,
  title,
}: {
  src: string;
  alt?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const width = parseImageWidth(title);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt || ""}
        title={width ? undefined : title || undefined}
        style={width ? { width } : undefined}
        className="cursor-zoom-in"
        onClick={() => setOpen(true)}
      />
      {open && (
        <div
          role="dialog"
          aria-label={alt || "Image"}
          className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-slate-900/85 p-6"
          onClick={() => setOpen(false)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={alt || ""}
            className="max-h-full max-w-full rounded-lg shadow-2xl"
          />
          <span className="absolute right-4 top-3 text-2xl text-white/70">✕</span>
        </div>
      )}
    </>
  );
}
