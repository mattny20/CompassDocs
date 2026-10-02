"use client";

// The interactive half of a ::video block: renders the player (iframe
// provider or native <video>), an optional poster, and a theater-mode
// expand that fills the screen — deliberately simpler than the image
// Lightbox (no zoom/pan; wheel and drag belong to the player). The theater
// is a <Modal>, which owns Escape, the scroll lock and focus return.

import { useState } from "react";
import { Maximize2, X } from "lucide-react";
import { Modal } from "./Modal";

function safePoster(url?: string): string | undefined {
  const t = (url || "").trim();
  if (!t) return undefined;
  if (t.startsWith("/api/attachments/")) return t;
  try {
    if (new URL(t).protocol === "https:") return t;
  } catch {
    /* not a URL */
  }
  return undefined;
}

export function VideoPlayer({
  embed,
  title,
  poster,
}: {
  embed: { kind: "iframe" | "file"; url: string };
  title?: string;
  poster?: string;
}) {
  const [theater, setTheater] = useState(false);

  const player = (large: boolean) =>
    embed.kind === "iframe" ? (
      <div
        className={`relative w-full overflow-hidden ${large ? "rounded-xl" : "rounded-lg border border-slate-200"}`}
        style={{ paddingTop: "56.25%" }}
      >
        <iframe
          src={embed.url}
          title={title || "Embedded video"}
          loading="lazy"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          className="absolute inset-0 h-full w-full border-0"
        />
      </div>
    ) : (
      // eslint-disable-next-line jsx-a11y/media-has-caption
      <video
        src={embed.url}
        controls
        preload="metadata"
        poster={safePoster(poster)}
        className={`w-full ${large ? "max-h-[85vh] rounded-xl" : "rounded-lg border border-slate-200"}`}
      />
    );

  return (
    <figure className="doc-wide my-4">
      <div className="group relative">
        {player(false)}
        <button
          onClick={() => setTheater(true)}
          data-tt="Theater mode"
          aria-label="Open video in theater mode"
          className="absolute right-2 top-2 rounded-md bg-[#0f172a]/60 p-1.5 text-white opacity-0 transition focus:opacity-100 group-hover:opacity-100"
        >
          <Maximize2 className="h-4 w-4" aria-hidden />
        </button>
      </div>
      {title && <figcaption className="mt-1.5 text-center text-sm text-slate-500">{title}</figcaption>}

      {/* Hard-coded scrim: a themed bg-slate-950 inverts to a near-white wash in dark mode. */}
      <Modal
        open={theater}
        onClose={() => setTheater(false)}
        label={title || "Video"}
        scrim="bg-black/90"
        className="w-[min(92vw,1400px)]"
      >
        {player(true)}
        {title && <p className="mt-2 text-center text-sm text-white/60">{title}</p>}
        <button
          onClick={() => setTheater(false)}
          data-autofocus
          data-tt="Close (Esc)"
          aria-label="Close theater mode"
          className="fixed right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
        >
          <X className="h-5 w-5" aria-hidden />
        </button>
      </Modal>
    </figure>
  );
}
