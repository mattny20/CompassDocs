"use client";

// The admin's sign-in preview (1.16.0, STYLEGUIDE §Settings pages, "preview
// iframe"): the real /login/preview page in an iframe at a real device
// viewport, scaled down to the card with a transform. rem, clamp(), cqi and
// the breakpoints then resolve exactly as they do on that screen, which a
// scaled component never could. The wrapper is `inert` (nothing in the
// frame takes focus or a click; the full-size preview is the one to try
// out) and a leaf: it holds no overlay. Only the chosen size is mounted,
// and its address follows the form 400ms behind, so typing does not reload
// it on every key.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { busyClass } from "@/components/Spinner";

export type PreviewPreset = "laptop" | "ultrawide" | "phone";

/** Device viewports in CSS pixels (STYLEGUIDE §Scaling allows them in an inline style). */
export const PREVIEW_VIEWPORTS: Record<PreviewPreset, { width: number; height: number }> = {
  laptop: { width: 1440, height: 900 },
  ultrawide: { width: 3440, height: 1440 },
  phone: { width: 390, height: 844 },
};

/** The phone frame is fitted to this height rather than the card's width. */
const PHONE_MAX_REM = 32;
const DEBOUNCE_MS = 400;

export function PreviewFrame({ src, preset }: { src: string; preset: PreviewPreset }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, rem: 16 });
  const [shown, setShown] = useState(src);
  const [loading, setLoading] = useState(true);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setBox({ width: el.clientWidth, rem });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A new size is a new frame: dim it until it has loaded.
  useEffect(() => setLoading(true), [preset]);

  useEffect(() => {
    if (src === shown) return;
    const t = window.setTimeout(() => {
      setShown(src);
      setLoading(true);
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [src, shown]);

  const { width: W, height: H } = PREVIEW_VIEWPORTS[preset];
  const scale = box.width
    ? preset === "phone"
      ? Math.min(box.width / W, (PHONE_MAX_REM * box.rem) / H)
      : box.width / W
    : 0;
  const left = preset === "phone" ? Math.max(0, (box.width - W * scale) / 2) : 0;

  return (
    <div
      ref={wrapRef}
      inert
      aria-busy={loading}
      className="relative w-full overflow-hidden rounded-lg bg-canvas ring-1 ring-slate-200"
      style={{ height: H * scale }}
    >
      {scale > 0 && (
        <iframe
          key={preset}
          title="Sign-in page preview"
          tabIndex={-1}
          loading="lazy"
          src={shown}
          onLoad={() => setLoading(false)}
          className={`absolute top-0 ${busyClass(loading)}`}
          style={{
            left,
            width: W,
            height: H,
            border: 0,
            transform: `scale(${scale})`,
            transformOrigin: "0 0",
          }}
        />
      )}
    </div>
  );
}
