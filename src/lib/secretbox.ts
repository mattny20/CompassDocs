import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { uploadDir } from "./uploads";

// Envelope encryption for secrets at rest (AES-256-GCM). The master key never
// touches the database: it comes from the COMPASSDOCS_SECRET_KEY env var
// (recommended — 64 hex or 44 base64 chars for 32 bytes), or from a key file
// that is auto-generated on first boot. The default key-file location is
// inside the uploads volume so it persists across container recreates on a
// standard Docker install.
//
// Sealed values are stored as "enc:v1:<base64(iv | tag | ciphertext)>", so
// plaintext written by older versions passes through reads untouched and is
// migrated in place on boot.

const PREFIX = "enc:v1:";
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey: Buffer | null = null;

function parseKeyMaterial(raw: string): Buffer | null {
  const s = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, "hex");
  try {
    const b = Buffer.from(s, "base64");
    if (b.length === 32) return b;
  } catch {
    /* fall through */
  }
  return null;
}

function keyFilePath(): string {
  return process.env.COMPASSDOCS_KEY_FILE || join(uploadDir(), ".secret.key");
}

/** The 32-byte master key. Env var wins; otherwise a key file is read or
 * created (0600). Throws only if the key file can't be read *or* written. */
export function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const env = process.env.COMPASSDOCS_SECRET_KEY;
  if (env) {
    const parsed = parseKeyMaterial(env);
    if (!parsed) {
      throw new Error(
        "COMPASSDOCS_SECRET_KEY must be 32 bytes, as 64 hex chars or 44 base64 chars."
      );
    }
    cachedKey = parsed;
    return cachedKey;
  }
  const path = keyFilePath();
  try {
    const parsed = parseKeyMaterial(readFileSync(path, "utf8"));
    if (parsed) {
      cachedKey = parsed;
      return cachedKey;
    }
    throw new Error(`Key file ${path} exists but does not contain a valid 32-byte key.`);
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
  }
  const fresh = randomBytes(32);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, fresh.toString("hex") + "\n", { mode: 0o600, flag: "wx" });
  cachedKey = fresh;
  return cachedKey;
}

/** Short key identifier for diagnostics (never reveals the key). */
export function keyFingerprint(): string {
  return createHash("sha256").update(getMasterKey()).digest("hex").slice(0, 12);
}

export function isSealed(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** Encrypt a settings value. Empty stays empty; sealing is idempotent. */
export function sealSecret(plain: string): string {
  if (!plain || isSealed(plain)) return plain;
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", getMasterKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
}

// --- File encryption (backups) ----------------------------------------------
//
// Format: 8-byte magic "CDOCENC1" | 12-byte IV | ciphertext | 16-byte GCM tag.
// Streamed, so dump size doesn't matter; the tag lands at the end of the file
// and is verified on decrypt.

const FILE_MAGIC = Buffer.from("CDOCENC1");

export async function encryptFile(src: string, dest: string): Promise<void> {
  const { createReadStream, createWriteStream } = await import("node:fs");
  const { pipeline } = await import("node:stream/promises");
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", getMasterKey(), iv);
  const out = createWriteStream(dest, { mode: 0o600 });
  out.write(FILE_MAGIC);
  out.write(iv);
  await pipeline(createReadStream(src), cipher, out, { end: false });
  out.end(cipher.getAuthTag());
  await new Promise<void>((resolve, reject) => {
    out.on("finish", resolve);
    out.on("error", reject);
  });
}

export async function isEncryptedFile(path: string): Promise<boolean> {
  const { open } = await import("node:fs/promises");
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(FILE_MAGIC.length);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return bytesRead === FILE_MAGIC.length && buf.equals(FILE_MAGIC);
  } finally {
    await fh.close();
  }
}

export async function decryptFile(src: string, dest: string): Promise<void> {
  const { createReadStream, createWriteStream } = await import("node:fs");
  const { open, stat } = await import("node:fs/promises");
  const { pipeline } = await import("node:stream/promises");
  const size = (await stat(src)).size;
  const headerLen = FILE_MAGIC.length + IV_LEN;
  if (size < headerLen + TAG_LEN) throw new Error("Encrypted file is truncated.");

  const fh = await open(src, "r");
  let iv: Buffer;
  let tag: Buffer;
  try {
    const header = Buffer.alloc(headerLen);
    await fh.read(header, 0, headerLen, 0);
    if (!header.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)) {
      throw new Error("Not a CompassDocs-encrypted file.");
    }
    iv = header.subarray(FILE_MAGIC.length);
    tag = Buffer.alloc(TAG_LEN);
    await fh.read(tag, 0, TAG_LEN, size - TAG_LEN);
  } finally {
    await fh.close();
  }

  const decipher = createDecipheriv("aes-256-gcm", getMasterKey(), iv);
  decipher.setAuthTag(tag);
  await pipeline(
    createReadStream(src, { start: headerLen, end: size - TAG_LEN - 1 }),
    decipher,
    createWriteStream(dest, { mode: 0o600 })
  );
}

/**
 * Decrypt a stored value. Plaintext (pre-migration) passes through unchanged.
 * A sealed value that fails to decrypt (wrong/lost master key) returns "" so
 * the dependent feature degrades to "not configured" instead of crashing —
 * with a loud log line, since that's an operator problem to fix.
 */
export function openSecret(stored: string): string {
  if (!stored || !isSealed(stored)) return stored;
  try {
    const raw = Buffer.from(stored.slice(PREFIX.length), "base64");
    const iv = raw.subarray(0, IV_LEN);
    const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = raw.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv("aes-256-gcm", getMasterKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    console.error(
      "[secretbox] Failed to decrypt a stored secret — the master key " +
        "(COMPASSDOCS_SECRET_KEY or the key file) does not match the one that " +
        "encrypted it. Re-enter the affected credential in Settings."
    );
    return "";
  }
}
