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

export function uploadReadStream(storedName: string, range?: { start: number; end: number }) {
  if (!isValidStoredName(storedName)) return null;
  return createReadStream(join(uploadDir(), storedName), range);
}

/** Mime types the attachment endpoint serves inline as playable video. */
export function isInlineVideo(mime: string): boolean {
  return /^video\/(mp4|webm|ogg|quicktime)$/.test(mime);
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

/**
 * Identify an image by its magic bytes — never by a client-supplied mime or
 * filename. Returns the mime + canonical extension for exactly the four
 * inline-servable types above, or null for anything else (SVG deliberately
 * excluded: it can carry script, so it is never accepted as an "image").
 */
export function sniffImage(buf: Buffer): { mime: string; ext: string } | null {
  if (buf.length >= 8 && buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) {
    return { mime: "image/png", ext: ".png" };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: "image/jpeg", ext: ".jpg" };
  }
  if (buf.length >= 4 && buf.subarray(0, 4).toString("latin1") === "GIF8") {
    return { mime: "image/gif", ext: ".gif" };
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("latin1") === "RIFF" &&
    buf.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return { mime: "image/webp", ext: ".webp" };
  }
  return null;
}
