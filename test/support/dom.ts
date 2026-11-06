// A jsdom window on the globals, for tests that run the rich editor headless
// (editor-roundtrip.test.ts). Import it before anything that loads Tiptap or
// ProseMirror: prosemirror-view reads `navigator` and `document` when it is
// first loaded.
import { JSDOM } from "jsdom";

export const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});

const w = dom.window as any;
const GLOBALS = [
  "window", "document", "navigator", "Node", "Element", "HTMLElement", "Text", "DocumentFragment",
  "DOMParser", "XMLSerializer", "MutationObserver", "getComputedStyle", "requestAnimationFrame",
  "cancelAnimationFrame", "Event", "KeyboardEvent", "MouseEvent", "ClipboardEvent", "DragEvent",
  "InputEvent", "FocusEvent", "CustomEvent", "Range", "Selection", "HTMLInputElement",
];
for (const name of GLOBALS) {
  const value = name === "window" ? w : w[name];
  if (value === undefined) continue;
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

// Layout measurement ProseMirror calls that jsdom doesn't implement.
w.HTMLElement.prototype.scrollIntoView = () => {};
w.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
w.Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] });
w.document.elementFromPoint = () => null;
