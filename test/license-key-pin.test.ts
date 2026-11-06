// The licence verification key is the vendor's. A build that ships any
// other key rejects every customer licence (and accepts licences signed by
// whoever holds the other key's private half). Local verification rigs swap
// in a throwaway key while they build; this test makes sure a swapped key
// can never be committed or released unnoticed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, createPublicKey } from "node:crypto";
import path from "node:path";

const VENDOR_KEY_BODY = "MCowBQYDK2VwAyEA3zj2D3VLyIij/SovtpZWwY1xFrX8F6n876GPISVnxE0=";
const VENDOR_KEY_SHA256 = createHash("sha256").update(VENDOR_KEY_BODY).digest("hex");

test("license.ts verifies licences with the vendor's public key, and only that key", () => {
  const src = readFileSync(path.join(__dirname, "..", "src", "lib", "license.ts"), "utf8");
  const blocks = [...src.matchAll(/-----BEGIN PUBLIC KEY-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END PUBLIC KEY-----/g)];
  assert.equal(blocks.length, 1, "exactly one public key block");
  const body = blocks[0][1].replace(/\s+/g, "");
  assert.equal(
    createHash("sha256").update(body).digest("hex"),
    VENDOR_KEY_SHA256,
    "the licence public key is not the vendor's (a test key left in place?)"
  );
  // And it parses as the Ed25519 key it should be.
  const key = createPublicKey(`-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----`);
  assert.equal(key.asymmetricKeyType, "ed25519");
});
