"use client";

// Inline document image: honors an author-chosen display width and zooms to a
// full-screen lightbox on click. The width travels in the markdown image
// *title* as "w=NN%" (e.g. ![shot](/api/attachments/3 "w=50%")) — still plain
// CommonMark, so the content renders sanely in any other markdown tool.

import { useState } from "react";
import { Lightbox } from "./Lightbox";

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
      <Lightbox open={open} onClose={() => setOpen(false)} label={alt || "Image"}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt || ""}
          draggable={false}
          className="max-h-[90vh] max-w-[90vw] select-none rounded-lg shadow-2xl"
        />
      </Lightbox>
    </>
  );
}
