// The audit log never prints a raw action key (STYLEGUIDE §Vocabulary):
// every `audit({ action: "x.y" })` the codebase emits has a verb-first label
// in lib/audit-labels, and the fallback is a readable "Family · Action".
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/audit-labels.test.ts

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { actionLabel, hasActionLabel, humanise } from "../src/lib/audit-labels";

const ROOT = join(__dirname, "..", "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(name)) out.push(p);
  }
  return out;
}

// Dynamic prefixes: the route appends the bulk verb at runtime. Each concrete
// key it can produce is listed and labelled here instead.
const DYNAMIC: Record<string, string[]> = {
  "document.bulk_": ["move", "status", "type", "add_tag", "remove_tag"],
};

/** Every dot-namespaced `action: "…"` literal under src/ — the same grep the
 *  proposal used. Un-dotted keys (`action: "read_all"`) are API verbs, not
 *  audit actions, and are skipped. */
function emittedActions(): string[] {
  const keys = new Set<string>();
  for (const file of walk(ROOT)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/action: "([a-z_.]+)"/g)) {
      const key = m[1];
      if (!key.includes(".")) continue;
      const dynamic = DYNAMIC[key];
      if (dynamic) dynamic.forEach((suffix) => keys.add(key + suffix));
      else keys.add(key);
    }
  }
  return [...keys].sort();
}

describe("audit labels", () => {
  test("a known key gets its verb-first label", () => {
    assert.equal(actionLabel("user.create"), "Created user");
    assert.equal(actionLabel("directory.person_updated"), "Updated person");
    assert.equal(actionLabel("training.assigned"), "Assigned training");
  });

  test("an unknown key is humanised as Family · Action, never printed raw", () => {
    assert.equal(actionLabel("directory.person_bulk_merged"), "Directory · Person bulk merged");
    assert.equal(actionLabel("widget.frobbed"), "Widget · Frobbed");
    assert.equal(actionLabel("widget"), "Widget");
    assert.equal(actionLabel("widget."), "Widget");
    assert.equal(actionLabel(""), "Unknown action");
    assert.equal(humanise("ai_key_set"), "Ai key set");
    assert.equal(humanise("Already Cased"), "Already cased");
  });

  test("every audit action the codebase emits has an explicit label", () => {
    const keys = emittedActions();
    assert.ok(keys.length > 100, `expected the grep to find the audit calls, got ${keys.length}`);
    const missing = keys.filter((k) => !hasActionLabel(k));
    assert.deepEqual(missing, [], `add these to src/lib/audit-labels.ts:\n${missing.join("\n")}`);
  });

  test("no label is a raw key and every label is a sentence", () => {
    for (const key of emittedActions()) {
      const label = actionLabel(key);
      assert.notEqual(label, key, `${key} renders its own key`);
      assert.match(label, /^[A-Z]/, `${key}: "${label}" should start with a capital`);
      assert.doesNotMatch(label, /[_.]\w/, `${key}: "${label}" still looks like an identifier`);
    }
  });
});
