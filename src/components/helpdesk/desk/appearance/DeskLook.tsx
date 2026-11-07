"use client";

// The desk's background artwork on screen (1.19.4; STYLEGUIDE §Helpdesk:
// desk background; mock-ups t1 to t3). DeskLookRoot is the desk shell's
// root element: it carries the look as CSS variables (desk-look.css paints
// the picture, the scrim and the frosted panels from them) and shares it,
// so "My desk background" can change it and the Appearance page can preview
// unsaved choices, without a reload.
//
// The picture loads lazily: the first paint is the plain desk, then, only
// if the device allows it, the picture for the current mode is fetched in
// the background (the stored width that fits the screen) and the desk turns
// see-through once it has arrived. Nothing moves: the picture is a fixed
// layer behind everything. Reduce transparency, Increase contrast and a
// data saver all keep the plain desk (the picture is never requested), and
// so does printing. The other mode's picture loads only when the theme
// switches to it.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { HdDeskLook, HdDeskLookSide, HdDeskTheme } from "@/lib/helpdesk/appearance-shared";
import "./desk-look.css";

interface DeskLookCtx {
  /** The saved look (null: the plain desk). */
  look: HdDeskLook | null;
  setLook: (look: HdDeskLook | null) => void;
  /** An unsaved look shown instead (the Appearance page's Preview); undefined when none. */
  setPreview: (look: HdDeskLook | null | undefined) => void;
  /** The user menu offers "Desk background". */
  menu: boolean;
  /** "My desk background" is open. */
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  /** The device keeps the plain desk (Reduce transparency, Increase contrast, data saver). */
  plainOnly: boolean;
}

const Ctx = createContext<DeskLookCtx | null>(null);

export function useDeskLook(): DeskLookCtx | null {
  return useContext(Ctx);
}

/** The stored width that fits this screen. */
export function pickArtUrl(side: HdDeskLookSide): string {
  if (!side.srcset?.length) return side.src;
  const want = (typeof window === "undefined" ? 1920 : window.innerWidth * (window.devicePixelRatio || 1)) * 0.9;
  const sorted = [...side.srcset].sort((a, b) => a.w - b.w);
  return (sorted.find((s) => s.w >= want) ?? sorted[sorted.length - 1]).url;
}

function readTheme(): HdDeskTheme {
  return typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

/** The html element's data-theme, followed live. */
function useTheme(): HdDeskTheme {
  const [theme, setTheme] = useState<HdDeskTheme>("light");
  useEffect(() => {
    setTheme(readTheme());
    const mo = new MutationObserver(() => setTheme(readTheme()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);
  return theme;
}

const PLAIN_QUERIES = ["(prefers-reduced-transparency: reduce)", "(prefers-contrast: more)", "(prefers-reduced-data: reduce)", "(forced-colors: active)"];

/** True while the device asks for no see-through surfaces or less data. Starts true (the server can't know). */
function usePlainOnly(): boolean {
  const [plain, setPlain] = useState(true);
  useEffect(() => {
    const mqs = PLAIN_QUERIES.map((q) => window.matchMedia(q));
    const conn = (navigator as Navigator & { connection?: { saveData?: boolean; addEventListener?: (t: string, f: () => void) => void; removeEventListener?: (t: string, f: () => void) => void } }).connection;
    const read = () => setPlain(mqs.some((m) => m.matches) || conn?.saveData === true);
    read();
    for (const m of mqs) m.addEventListener("change", read);
    conn?.addEventListener?.("change", read);
    return () => {
      for (const m of mqs) m.removeEventListener("change", read);
      conn?.removeEventListener?.("change", read);
    };
  }, []);
  return plain;
}

const cssUrl = (u: string) => `url("${u.replace(/["\\\n\r]/g, encodeURIComponent)}")`;

export function DeskLookRoot({
  look: saved,
  menu,
  className,
  children,
}: {
  look: HdDeskLook | null;
  menu: boolean;
  className: string;
  children: ReactNode;
}) {
  const [look, setLook] = useState<HdDeskLook | null>(saved);
  const [preview, setPreview] = useState<HdDeskLook | null | undefined>(undefined);
  const [panelOpen, setPanelOpen] = useState(false);
  // Loaded picture URLs, per mode.
  const [ready, setReady] = useState<Partial<Record<HdDeskTheme, string>>>({});
  const theme = useTheme();
  const plainOnly = usePlainOnly();

  // A server refresh (after the Appearance page saves) brings a new saved look.
  useEffect(() => setLook(saved), [saved]);

  const active = preview !== undefined ? preview : look;
  const want = useMemo(
    () => ({ light: active?.light ? pickArtUrl(active.light) : null, dark: active?.dark ? pickArtUrl(active.dark) : null }),
    [active]
  );

  // Fetch the current mode's picture once the device allows it; the desk turns see-through when it arrives.
  const url = want[theme];
  const have = ready[theme];
  useEffect(() => {
    if (plainOnly || !url || have === url) return;
    let live = true;
    const img = new Image();
    img.decoding = "async";
    img.onload = () => live && setReady((r) => ({ ...r, [theme]: url }));
    img.src = url;
    return () => {
      live = false;
    };
  }, [plainOnly, url, have, theme]);

  const on = (t: HdDeskTheme) => !plainOnly && !!active?.[t] && !!want[t] && ready[t] === want[t];
  const style: Record<string, string | number> = {};
  if (active) {
    style["--desk-p"] = active.panel;
    style["--desk-filter"] = `blur(${active.blur}px) saturate(1.35)`;
    for (const [t, k] of [["light", "l"], ["dark", "d"]] as const) {
      const s = active[t];
      if (!s) continue;
      style[`--desk-tint-${k}`] = s.tint;
      style[`--desk-s-${k}`] = s.scrim;
      if (on(t)) style[`--desk-img-${k}`] = cssUrl(ready[t]!);
    }
  }

  const setPreviewCb = useCallback((l: HdDeskLook | null | undefined) => setPreview(l), []);
  const value = useMemo<DeskLookCtx>(
    () => ({ look, setLook, setPreview: setPreviewCb, menu, panelOpen, setPanelOpen, plainOnly }),
    [look, setPreviewCb, menu, panelOpen, plainOnly]
  );

  return (
    <Ctx.Provider value={value}>
      <div
        className={`desk-art ${className}`}
        style={style as CSSProperties}
        data-art-light={on("light") ? "" : undefined}
        data-art-dark={on("dark") ? "" : undefined}
        data-testid="desk-root"
      >
        <div className="desk-art-layer" aria-hidden />
        {children}
      </div>
    </Ctx.Provider>
  );
}
