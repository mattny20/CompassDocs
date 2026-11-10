"use client";

// Keeps every data-tt tooltip on screen (1.20.2; STYLEGUIDE §Tooltips). The
// bubble is a CSS ::after above its control, centred. Just before one shows
// (pointer over, or keyboard focus) this measures the room it has inside
// the viewport and inside every ancestor that clips (a scrolling pane, an
// overflow-hidden card) and:
//
//   - flips it below (data-tt-auto="bottom") when there is no room above
//     and more below: the buttons at the top of the ticket pane, a list
//     header, a top bar. An explicit data-tt-pos always wins;
//   - slides it sideways (--tt-shift) so it ends inside the right and left
//     edges: a control flush with the edge of a pane or of a phone.
//
// One listener pair on the document, nothing per control; mounted once in
// the root layout. Renders nothing.

import { useEffect } from "react";

/** The gap between a control and its bubble (0.4375rem at the default root), plus a hair. */
const GAP = 9;
/** How close to an edge a bubble may sit. */
const EDGE = 4;

/** The box a bubble of `el` can be seen in: the viewport, cut down by every clipping ancestor. */
function visibleBox(el: Element): { top: number; left: number; right: number; bottom: number } {
  const box = { top: 0, left: 0, right: document.documentElement.clientWidth, bottom: window.innerHeight };
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (!/auto|scroll|hidden|clip/.test(`${cs.overflowX} ${cs.overflowY}`)) continue;
    const r = p.getBoundingClientRect();
    box.top = Math.max(box.top, r.top);
    box.left = Math.max(box.left, r.left);
    box.right = Math.min(box.right, r.right);
    box.bottom = Math.min(box.bottom, r.bottom);
  }
  return box;
}

export function placeTooltip(el: HTMLElement): void {
  const pos = el.getAttribute("data-tt-pos");
  // The collapsed rail's bubble is position: fixed beside its icon: nothing to place.
  if (pos === "right" || !el.getAttribute("data-tt")) return;
  const after = getComputedStyle(el, "::after");
  const w = parseFloat(after.width);
  const h = parseFloat(after.height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0) return;
  const r = el.getBoundingClientRect();
  const box = visibleBox(el);

  if (!pos) {
    const above = r.top - box.top;
    const below = box.bottom - r.bottom;
    if (above < h + GAP && below > above) el.setAttribute("data-tt-auto", "bottom");
    else el.removeAttribute("data-tt-auto");
  }

  const left = el.getAttribute("data-tt-align") === "start" ? r.left : r.left + r.width / 2 - w / 2;
  let shift = 0;
  if (left + w > box.right - EDGE) shift = box.right - EDGE - (left + w);
  if (left + shift < box.left + EDGE) shift = box.left + EDGE - left;
  if (Math.abs(shift) >= 1) el.style.setProperty("--tt-shift", `${Math.round(shift)}px`);
  else el.style.removeProperty("--tt-shift");
}

export function TooltipPlacer() {
  useEffect(() => {
    let last: Element | null = null;
    const on = (e: Event) => {
      const el = (e.target as Element | null)?.closest?.("[data-tt]");
      if (!(el instanceof HTMLElement)) {
        last = null;
        return;
      }
      // Moving within one control (its icon, its label) measures once; focus always does.
      if (el === last && e.type === "pointerover") return;
      last = el;
      placeTooltip(el);
    };
    document.addEventListener("pointerover", on, true);
    document.addEventListener("focusin", on, true);
    return () => {
      document.removeEventListener("pointerover", on, true);
      document.removeEventListener("focusin", on, true);
    };
  }, []);
  return null;
}
