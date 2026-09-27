import "server-only";

// Directory photos in two sizes from one input. A provider hands us whatever
// it has (Graph 240px, Google's thumbnail, an admin's 3 MB phone picture);
// every row keeps a 48px thumbnail for lists and cards, and a 240px copy for
// the profile page, the contact card and the QR code. Both are JPEG data
// URLs, square, cropped to the centre — a photo is a face, not a landscape.

import sharp from "sharp";
import { sniffImage } from "./uploads";

export const PHOTO_THUMB = 48;
export const PHOTO_LARGE = 240;
const MAX_INPUT = 6 * 1024 * 1024;

export interface PhotoSet {
  /** 48px JPEG data: URL. */
  thumb: string;
  /** 240px JPEG data: URL. */
  large: string;
}

const DATA_URL = /^data:([^;,]+);base64,([\s\S]*)$/;

function toBuffer(input: string | Buffer): Buffer | null {
  if (Buffer.isBuffer(input)) return input;
  const m = DATA_URL.exec(input);
  if (!m) return null;
  try {
    return Buffer.from(m[2], "base64");
  } catch {
    return null;
  }
}

/**
 * Both sizes from a data: URL or raw bytes, or null when the input is not an
 * image we serve (magic bytes decide, never the declared type) or is too big.
 */
export async function normalizePhoto(input: string | Buffer): Promise<PhotoSet | null> {
  const buf = toBuffer(input);
  if (!buf || buf.length === 0 || buf.length > MAX_INPUT) return null;
  if (!sniffImage(buf)) return null;
  try {
    const base = sharp(buf, { failOn: "none", animated: false }).rotate();
    const [thumb, large] = await Promise.all([
      base.clone().resize(PHOTO_THUMB, PHOTO_THUMB, { fit: "cover", position: "attention" }).jpeg({ quality: 82 }).toBuffer(),
      base.clone().resize(PHOTO_LARGE, PHOTO_LARGE, { fit: "cover", position: "attention" }).jpeg({ quality: 86 }).toBuffer(),
    ]);
    return {
      thumb: `data:image/jpeg;base64,${thumb.toString("base64")}`,
      large: `data:image/jpeg;base64,${large.toString("base64")}`,
    };
  } catch {
    return null;
  }
}

/** The bytes and type of a stored data: URL, for serving or embedding. */
export function decodeDataUrl(url: string): { mime: string; bytes: Buffer } | null {
  const m = DATA_URL.exec(url);
  if (!m) return null;
  const bytes = Buffer.from(m[2], "base64");
  return bytes.length ? { mime: m[1].toLowerCase(), bytes } : null;
}
