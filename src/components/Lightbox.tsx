"use client";

// Full-screen zoom viewer for images and rendered diagrams. Real zoom, not
// just fit-to-screen: scroll wheel / +− buttons / double-click to zoom
// (0.25×–8×), drag to pan, Esc or backdrop click to close. Body scroll is
// locked while open.

import { useCallback, useEffect, useRef, useState } from "react";
import { Minus, Plus, RotateCcw, X } from "lucide-react";

const MIN_SCALE = 0.25;
const MAX_SCALE = 8;

export function Lightbox({
  open,
  onClose,
  label,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  children: React.ReactNode;
}) {
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const moved = useRef(false);

  const reset = useCallback(() => {
    setScale(1);
    setTx(0);
    setTy(0);
  }, []);

  useEffect(() => {
    if (!open) return;
    reset();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "+" || e.key === "=") setScale((s) => Math.min(MAX_SCALE, s * 1.25));
      if (e.key === "-") setScale((s) => Math.max(MIN_SCALE, s / 1.25));
      if (e.key === "0") reset();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose, reset]);

  if (!open) return null;

  const zoomBy = (factor: number) =>
    setScale((s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s * factor)));

  return (
    <div
      role="dialog"
      aria-label={label}
      className="fixed inset-0 z-50 overflow-hidden bg-slate-900/90"
      onWheel={(e) => zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15)}
      onPointerDown={(e) => {
        moved.current = false;
        drag.current = { x: e.clientX, y: e.clientY, tx, ty };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const dx = e.clientX - drag.current.x;
        const dy = e.clientY - drag.current.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) moved.current = true;
        setTx(drag.current.tx + dx);
        setTy(drag.current.ty + dy);
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onClick={() => {
        // A plain click (no drag) on the backdrop closes; a pan doesn't.
        if (!moved.current) onClose();
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setScale((s) => (s > 1.5 ? 1 : 2.5));
        if (scale > 1.5) {
          setTx(0);
          setTy(0);
        }
      }}
    >
      <div
        className="flex h-full w-full items-center justify-center"
        style={{
          transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
          transformOrigin: "center center",
          cursor: drag.current ? "grabbing" : "grab",
          transition: drag.current ? "none" : "transform 120ms ease-out",
        }}
        onClick={(e) => {
          // Clicking the content itself shouldn't close — only the backdrop.
          if (!moved.current) e.stopPropagation();
        }}
      >
        {children}
      </div>

      {/* Controls — stopPropagation so they don't close or pan the viewer. */}
      <div
        className="absolute bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-slate-800/90 px-2 py-1.5 shadow-lg ring-1 ring-white/10"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <button
          onClick={() => zoomBy(1 / 1.25)}
          data-tt="Zoom out (−)"
          aria-label="Zoom out"
          className="rounded-full p-2 text-slate-200 hover:bg-white/10"
        >
          <Minus className="h-4 w-4" />
        </button>
        <span className="min-w-12 select-none text-center text-xs font-medium tabular-nums text-slate-200">
          {Math.round(scale * 100)}%
        </span>
        <button
          onClick={() => zoomBy(1.25)}
          data-tt="Zoom in (+)"
          aria-label="Zoom in"
          className="rounded-full p-2 text-slate-200 hover:bg-white/10"
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          onClick={reset}
          data-tt="Reset (0)"
          aria-label="Reset zoom"
          className="rounded-full p-2 text-slate-200 hover:bg-white/10"
        >
          <RotateCcw className="h-4 w-4" />
        </button>
        <button
          onClick={onClose}
          data-tt="Close (Esc)"
          aria-label="Close"
          className="rounded-full p-2 text-slate-200 hover:bg-white/10"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <p className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 select-none text-xs text-white/50">
        Scroll to zoom · drag to pan · double-click to toggle · Esc to close
      </p>
    </div>
  );
}
