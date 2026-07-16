import { createReadStream } from "fs";
import { mkdir, stat, unlink, writeFile } from "fs/promises";
import { join, extname } from "path";
import { randomBytes } from "crypto";

// Local storage for document attachments. Files are written to a mounted
// volume with an opaque random name; the original filename is kept in the DB.

export function uploadDir(): string {
  return process.env.COMPASSDOCS_UPLOAD_DIR || "/uploads";
}

// Stored names are 32 hex chars + an optional short extension — validated on
// every read to block path traversal.
const STORED_RE = /^[a-f0-9]{32}(\.[a-z0-9]{1,12})?$/;
export function isValidStoredName(n: string): boolean {
  return STORED_RE.test(n);
}

export function safeExt(filename: string): string {
  const e = extname(filename).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(e) ? e : "";
}

export async function saveUpload(buf: Buffer, ext: string): Promise<string> {
  const dir = uploadDir();
  await mkdir(dir, { recursive: true });
  const name = randomBytes(16).toString("hex") + (ext || "");
  await writeFile(join(dir, name), buf);
  return name;
}

export function uploadReadStream(storedName: string) {
  if (!isValidStoredName(storedName)) return null;
  return createReadStream(join(uploadDir(), storedName));
}

/** Whether the stored file actually exists (streams error mid-response otherwise). */
export async function uploadExists(storedName: string): Promise<boolean> {
  if (!isValidStoredName(storedName)) return false;
  try {
    return (await stat(join(uploadDir(), storedName))).isFile();
  } catch {
    return false;
  }
}

export async function deleteUpload(storedName: string): Promise<void> {
  if (!isValidStoredName(storedName)) return;
  try {
    await unlink(join(uploadDir(), storedName));
  } catch {
    /* already gone */
  }
}

// Only these image types are served inline; everything else (incl. SVG, HTML,
// PDFs) is served as a download to prevent any script execution on our origin.
const INLINE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export function isInlineImage(mime: string): boolean {
  return INLINE_MIME.has(mime);
}
