// Who owns Escape. A module-level LIFO stack of the overlays currently on
// screen, so one dispatcher can close the top-most layer and only that layer —
// closing a lightboxed image on a training slide must not also fire the deck's
// Escape-to-exit sitting behind it.
//
// Deliberately React-free, and it touches no `window`/`document` at module
// scope: this module is imported transitively by components that also render
// on the server, so every DOM access is inside a function and guarded.

/** One overlay on screen. `onEscape` is what the Escape dispatcher calls. */
export interface OverlayEntry {
  onEscape: () => void;
}

const stack: OverlayEntry[] = [];

/**
 * Register an overlay as the new top-most layer. Pass the close callback, or a
 * full entry. Returns the unregister function — call it on close or unmount;
 * calling it twice is harmless, and it removes *its own* layer even if a
 * shallower overlay closed out of order.
 */
export function pushOverlay(close: (() => void) | OverlayEntry): () => void {
  const entry: OverlayEntry = typeof close === "function" ? { onEscape: close } : close;
  stack.push(entry);
  return () => {
    const i = stack.lastIndexOf(entry);
    if (i !== -1) stack.splice(i, 1);
  };
}

/** The overlay that owns Escape right now, if any. */
export function topOverlay(): OverlayEntry | undefined {
  return stack.length > 0 ? stack[stack.length - 1] : undefined;
}

// The dispatcher that makes the stack mean something. Registered once, on the
// capture phase, and reference-counted so the listener exists exactly while at
// least one overlay does.
//
// Capture, not bubble, is load-bearing: a layer that closes on the bubble phase
// unmounts synchronously, so a later handler would look at an already-empty DOM
// and swallow the same keypress for the layer underneath — closing two overlays
// with one Escape.
let listeners = 0;
let bound: ((e: KeyboardEvent) => void) | null = null;

function dispatchEscape(e: KeyboardEvent): void {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  const top = topOverlay();
  if (!top) return;
  e.preventDefault();
  e.stopPropagation();
  top.onEscape();
}

/**
 * Start routing Escape to the top-most overlay. Returns the teardown. Called
 * by `useModalOverlay`, so individual overlays never bind Escape themselves —
 * that's what let two layers close on one keypress before this existed.
 */
export function bindEscapeDispatcher(): () => void {
  if (typeof document === "undefined") return () => {};
  if (listeners === 0) {
    bound = dispatchEscape;
    document.addEventListener("keydown", bound, true);
  }
  listeners++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    listeners--;
    if (listeners === 0 && bound) {
      document.removeEventListener("keydown", bound, true);
      bound = null;
    }
  };
}

/**
 * True when any overlay is on screen. Checks the registry first, then falls
 * back to a DOM probe so overlays that haven't moved onto the stack yet
 * (Lightbox, VideoPlayer, VideoInsertDialog, the analytics drill-down) still
 * suppress bare-key shortcuts and TrainingPlayer's Escape-to-exit. All of them
 * unmount when closed, so a hit means genuinely open.
 */
export function overlayOpen(): boolean {
  if (stack.length > 0) return true;
  if (typeof document === "undefined") return false;
  return document.querySelector('[role="dialog"]') !== null;
}
