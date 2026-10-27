// The remembered identifier (1.16.0, lib/remembered-identifier): the last
// email or username used to sign in on this browser, offered back on the
// next visit. It lives in localStorage only, as {"id", "at"}, for 180 days,
// and every access is guarded: storage can be missing, blocked (Safari's
// private mode throws on any access), full or hand-edited. A stored value
// the page could not have written (too long, control characters, corrupt
// JSON) is dropped rather than shown. window.localStorage is stubbed here.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/remembered-identifier.test.ts

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { forgetIdentifier, readRememberedIdentifier, rememberIdentifier } from "../src/lib/remembered-identifier";

const KEY = "compass-sign-in-identifier";
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);

/** A Storage with the three methods the module uses, backed by a Map. */
class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.has(k) ? this.data.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, String(v));
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

/** Storage that refuses every access, as a blocked or sandboxed one does. */
class ThrowingStorage {
  calls = 0;
  getItem(): string | null {
    this.calls++;
    throw new DOMException("The operation is insecure.", "SecurityError");
  }
  setItem(): void {
    this.calls++;
    throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
  }
  removeItem(): void {
    this.calls++;
    throw new DOMException("The operation is insecure.", "SecurityError");
  }
}

const g = globalThis as unknown as { window?: unknown };
let storage: MemoryStorage;

function useStorage(s: unknown) {
  g.window = { localStorage: s };
}

beforeEach(() => {
  storage = new MemoryStorage();
  useStorage(storage);
});

afterEach(() => {
  delete g.window;
});

describe("remember and read back", () => {
  test("what was remembered reads back, stored as {id, at} under one key", () => {
    rememberIdentifier("jane@acme.example", NOW);
    assert.equal(readRememberedIdentifier(NOW), "jane@acme.example");
    assert.deepEqual([...storage.data.keys()], [KEY]);
    assert.deepEqual(JSON.parse(storage.data.get(KEY)!), { id: "jane@acme.example", at: NOW });
  });

  test("the last one wins", () => {
    rememberIdentifier("jane@acme.example", NOW);
    rememberIdentifier("jdoe", NOW + 1000);
    assert.equal(readRememberedIdentifier(NOW + 2000), "jdoe");
  });

  test("nothing stored reads as null", () => {
    assert.equal(readRememberedIdentifier(NOW), null);
  });

  test("forget removes it", () => {
    rememberIdentifier("jane@acme.example", NOW);
    forgetIdentifier();
    assert.equal(storage.data.has(KEY), false);
    assert.equal(readRememberedIdentifier(NOW), null);
  });

  test("it is a plain string: no trimming or case change happens here", () => {
    rememberIdentifier("Jane.Doe@Acme.Example", NOW);
    assert.equal(readRememberedIdentifier(NOW), "Jane.Doe@Acme.Example");
  });
});

describe("expiry (180 days)", () => {
  test("still offered at exactly 180 days", () => {
    rememberIdentifier("jane@acme.example", NOW);
    assert.equal(readRememberedIdentifier(NOW + 180 * DAY), "jane@acme.example");
  });

  test("dropped, and removed from storage, a millisecond later", () => {
    rememberIdentifier("jane@acme.example", NOW);
    assert.equal(readRememberedIdentifier(NOW + 180 * DAY + 1), null);
    assert.equal(storage.data.has(KEY), false, "an expired entry is cleaned up");
  });

  test("an entry with no time, or a time that is not a number, is dropped", () => {
    for (const raw of [{ id: "jane" }, { id: "jane", at: "2026-10-27" }, { id: "jane", at: null }]) {
      storage.data.set(KEY, JSON.stringify(raw));
      assert.equal(readRememberedIdentifier(NOW), null, JSON.stringify(raw));
      assert.equal(storage.data.has(KEY), false);
    }
  });
});

describe("corrupt or hand-edited entries", () => {
  test("JSON that does not parse reads as null and never throws", () => {
    for (const raw of ["{", "jane@acme.example", "{'id':'jane'}", "undefined"]) {
      storage.data.set(KEY, raw);
      assert.doesNotThrow(() => readRememberedIdentifier(NOW));
      assert.equal(readRememberedIdentifier(NOW), null, raw);
    }
  });

  test("JSON of the wrong shape is dropped and removed", () => {
    for (const raw of ["null", "42", '"jane"', "[]", '{"id":42,"at":0}', '{"id":"","at":0}', '{"id":["jane"],"at":0}']) {
      storage.data.set(KEY, raw);
      assert.equal(readRememberedIdentifier(NOW), null, raw);
      assert.equal(storage.data.has(KEY), false, raw);
    }
  });

  test("an empty string in storage reads as nothing", () => {
    storage.data.set(KEY, "");
    assert.equal(readRememberedIdentifier(NOW), null);
  });
});

describe("length and character guard", () => {
  test("254 characters are remembered; 255 are not written", () => {
    const ok = `${"a".repeat(241)}@acme.example`;
    assert.equal(ok.length, 254);
    rememberIdentifier(ok, NOW);
    assert.equal(readRememberedIdentifier(NOW), ok);

    forgetIdentifier();
    rememberIdentifier("a".repeat(255), NOW);
    assert.equal(storage.data.has(KEY), false);
  });

  test("an over-long value put in storage by hand is dropped and removed", () => {
    storage.data.set(KEY, JSON.stringify({ id: "a".repeat(255), at: NOW }));
    assert.equal(readRememberedIdentifier(NOW), null);
    assert.equal(storage.data.has(KEY), false);
  });

  test("control characters are refused on write and on read", () => {
    for (const id of ["jane\u0000", "jane\ndoe", "jane\tdoe", "jane\u001b[31m", "jane\u007f"]) {
      rememberIdentifier(id, NOW);
      assert.equal(storage.data.has(KEY), false, JSON.stringify(id));
      storage.data.set(KEY, JSON.stringify({ id, at: NOW }));
      assert.equal(readRememberedIdentifier(NOW), null, JSON.stringify(id));
      assert.equal(storage.data.has(KEY), false);
    }
  });

  test("an empty identifier is never remembered", () => {
    rememberIdentifier("", NOW);
    assert.equal(storage.data.has(KEY), false);
  });
});

describe("storage that throws or is missing", () => {
  test("blocked storage: reading is null, remembering and forgetting are no-ops, nothing throws", () => {
    const blocked = new ThrowingStorage();
    useStorage(blocked);
    assert.doesNotThrow(() => readRememberedIdentifier(NOW));
    assert.equal(readRememberedIdentifier(NOW), null);
    assert.doesNotThrow(() => rememberIdentifier("jane@acme.example", NOW));
    assert.doesNotThrow(() => forgetIdentifier());
    assert.ok(blocked.calls >= 4, "each call did reach storage");
  });

  test("storage that reads but cannot remove: a corrupt entry still reads as null", () => {
    storage.data.set(KEY, JSON.stringify({ id: "jane", at: 0 }));
    storage.removeItem = () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
    assert.equal(readRememberedIdentifier(NOW), null);
  });

  test("a full store: remembering is a silent no-op", () => {
    storage.setItem = () => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    };
    assert.doesNotThrow(() => rememberIdentifier("jane@acme.example", NOW));
    assert.equal(readRememberedIdentifier(NOW), null);
  });

  test("a getter that throws (localStorage itself blocked) behaves like blocked storage", () => {
    g.window = {
      get localStorage(): Storage {
        throw new DOMException("Access is denied for this document.", "SecurityError");
      },
    };
    assert.equal(readRememberedIdentifier(NOW), null);
    assert.doesNotThrow(() => rememberIdentifier("jane@acme.example", NOW));
    assert.doesNotThrow(() => forgetIdentifier());
  });

  test("no window at all (a server render) is not an error", () => {
    delete g.window;
    assert.equal(readRememberedIdentifier(NOW), null);
    assert.doesNotThrow(() => rememberIdentifier("jane@acme.example", NOW));
    assert.doesNotThrow(() => forgetIdentifier());
  });
});
