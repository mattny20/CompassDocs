// Guards for global keyboard shortcuts. The whole point of this module is that
// a shortcut must never steal a keystroke the user meant for text they are
// writing — the rich-text editor, an input, a select, or any other overlay.
//
// Everything here is layout- and platform-neutral: shortcuts are matched on
// the *character produced* (e.key), never on physical key codes, so a German,
// French, or Nordic keyboard reaches them the same way a US one does.

/** True when the event target is somewhere the user is typing. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  // tiptap's editable surface, including nested node views.
  return !!el.closest(".tiptap, [contenteditable='true']");
}

/**
 * AltGr, as Windows and Linux report it: Ctrl+Alt together. On the layouts
 * that need it, AltGr is how you *type* @ > # ? — so a Ctrl+Alt event that
 * produced a printable character is a plain keystroke, not a chord, and must
 * not be treated as "a modifier is held".
 */
function isAltGraph(e: KeyboardEvent): boolean {
  if (typeof e.getModifierState === "function" && e.getModifierState("AltGraph")) return true;
  return e.ctrlKey && e.altKey;
}

/** One printable character — as opposed to "Enter", "ArrowDown", "F5"… */
function isPrintable(key: string): boolean {
  return [...key].length === 1;
}

/**
 * Should a bare printable-key shortcut (c, /, @, g…) be ignored?
 * Bare keys are the riskiest class, so every reason to bail is checked here.
 */
export function blockBareKey(e: KeyboardEvent, overlayIsOpen: () => boolean): boolean {
  if (e.defaultPrevented || e.repeat) return true;
  if (e.isComposing || e.keyCode === 229) return true; // IME composition
  if (e.metaKey) return true; // ⌘ / Windows key

  // Ctrl and Alt normally mean "not for us" — except when they are AltGr
  // producing the character itself (AltGr+Q is @ on a German layout).
  const altGraph = isAltGraph(e);
  if ((e.ctrlKey || e.altKey) && !(altGraph && isPrintable(e.key))) return true;

  if (isTypingTarget(e.target)) return true;
  return overlayIsOpen();
}

/**
 * Should a Mod+key shortcut (⌘K / Ctrl+K) be ignored? Typing is deliberately
 * fine here — ⌘K still opens the palette from inside the editor.
 */
export function blockModKey(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.repeat) return true;
  if (!(e.metaKey || e.ctrlKey)) return true;
  // Ctrl+Alt is AltGr on Windows/Linux — a text keystroke, not Ctrl+key.
  if (isAltGraph(e)) return true;
  if (e.altKey || e.shiftKey) return true;
  return e.isComposing || e.keyCode === 229;
}

interface UADataLike {
  platform?: string;
}

/**
 * True on Apple platforms, where the modifier is ⌘ rather than Ctrl. Used only
 * for *labels* — the handlers accept either modifier everywhere, so a Mac
 * keyboard attached to Linux (or the reverse) still works.
 */
export function isApple(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = (navigator as Navigator & { userAgentData?: UADataLike }).userAgentData;
  if (ua?.platform) return /mac/i.test(ua.platform);
  const legacy = navigator.platform || "";
  return /Mac|iPhone|iPad|iPod/.test(legacy || navigator.userAgent);
}

/** How the Mod key should be spelled for this user: "⌘" or "Ctrl". */
export function modLabel(): string {
  return isApple() ? "⌘" : "Ctrl";
}

/** How long a `g` chord stays armed before it forgets itself. */
export const CHORD_TIMEOUT_MS = 1200;
