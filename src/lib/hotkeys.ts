// Guards for global keyboard shortcuts. The whole point of this module is that
// a shortcut must never steal a keystroke the user meant for text they are
// writing — the rich-text editor, an input, a select, or any other overlay.

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

/** Modifier state that means "the browser or OS owns this keystroke". */
function hasForeignModifier(e: KeyboardEvent): boolean {
  return e.altKey || (e.ctrlKey && e.metaKey);
}

/**
 * Should a bare printable-key shortcut (c, /, @, g…) be ignored?
 * Bare keys are the riskiest class, so every reason to bail is checked here.
 */
export function blockBareKey(e: KeyboardEvent, overlayIsOpen: () => boolean): boolean {
  if (e.defaultPrevented || e.repeat) return true;
  if (e.metaKey || e.ctrlKey || hasForeignModifier(e)) return true;
  if (e.isComposing || e.keyCode === 229) return true; // IME composition
  if (isTypingTarget(e.target)) return true;
  return overlayIsOpen();
}

/** Should a Mod+key shortcut (⌘K) be ignored? Typing is fine — ⌘K still works. */
export function blockModKey(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.repeat) return true;
  if (!(e.metaKey || e.ctrlKey)) return true;
  if (e.altKey || e.shiftKey) return true;
  return e.isComposing || e.keyCode === 229;
}

/** True on Apple platforms, where the modifier renders as ⌘ rather than Ctrl. */
export function isApple(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

/** How long a `g` chord stays armed before it forgets itself. */
export const CHORD_TIMEOUT_MS = 1200;
