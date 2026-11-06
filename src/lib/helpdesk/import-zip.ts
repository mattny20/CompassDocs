// Helpdesk 1.19.1 import: read a zip on disk one entry at a time, never the
// whole archive in memory. Reads the central directory (zip64 included),
// then streams an entry's bytes from the file through inflate. Pure Node:
// no database, no Next.
//
// Safety: entry names are only ever compared, never used as paths (nothing
// is extracted to disk under its own name); encrypted entries and methods
// other than stored (0) and deflate (8) are refused; every entry is capped
// at `maxBytes` of output as it inflates, so a zip bomb stops at the cap
// whatever its header claims.

import { open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Transform, pipeline, type Readable } from "node:stream";
import { createInflateRaw } from "node:zlib";

export class ZipError extends Error {}

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
  encrypted: boolean;
  directory: boolean;
}

export const ZIP_LIMITS = {
  /** Entries in one archive. */
  entries: 200_000,
  /** Central directory bytes. */
  directoryBytes: 64 * 1024 * 1024,
} as const;

function u64(buf: Buffer, at: number): number {
  const v = buf.readBigUInt64LE(at);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError("The zip is too large.");
  return Number(v);
}

/** Is this file a zip (local header signature first)? */
export async function isZipFile(path: string): Promise<boolean> {
  const fh = await open(path, "r");
  try {
    const b = Buffer.alloc(4);
    const { bytesRead } = await fh.read(b, 0, 4, 0);
    return bytesRead === 4 && b.readUInt32LE(0) === 0x04034b50;
  } finally {
    await fh.close();
  }
}

/** The archive's entries, from its central directory. */
export async function readZipDirectory(path: string): Promise<ZipEntry[]> {
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    if (size < 22) throw new ZipError("That isn't a zip file.");
    const tailLen = Math.min(size, 65_557 + 20);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ZipError("That isn't a zip file (or it was cut short).");
    let total = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = eocd - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new ZipError("The zip's directory can't be read.");
      const z64At = u64(tail, loc + 8);
      const z64 = Buffer.alloc(56);
      await fh.read(z64, 0, 56, z64At);
      if (z64.readUInt32LE(0) !== 0x06064b50) throw new ZipError("The zip's directory can't be read.");
      total = u64(z64, 32);
      cdSize = u64(z64, 40);
      cdOffset = u64(z64, 48);
    }
    if (total > ZIP_LIMITS.entries) throw new ZipError(`The zip has more than ${ZIP_LIMITS.entries} files.`);
    if (cdSize > ZIP_LIMITS.directoryBytes || cdOffset + cdSize > size) throw new ZipError("The zip's directory can't be read.");
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const out: ZipEntry[] = [];
    let p = 0;
    for (let n = 0; n < total; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new ZipError("The zip's directory is damaged.");
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      let compressedSize = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const nameBuf = cd.subarray(p + 46, p + 46 + nameLen);
      const name = flags & 0x800 ? nameBuf.toString("utf8") : nameBuf.toString("latin1");
      // zip64 extended information: the 0xFFFFFFFF fields, in order.
      let e = p + 46 + nameLen;
      const eEnd = e + extraLen;
      while (e + 4 <= eEnd) {
        const id = cd.readUInt16LE(e);
        const len = cd.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (usize === 0xffffffff && q + 8 <= e + 4 + len) (usize = u64(cd, q)), (q += 8);
          if (compressedSize === 0xffffffff && q + 8 <= e + 4 + len) (compressedSize = u64(cd, q)), (q += 8);
          if (offset === 0xffffffff && q + 8 <= e + 4 + len) offset = u64(cd, q);
        }
        e += 4 + len;
      }
      out.push({
        name,
        method,
        compressedSize,
        size: usize,
        localHeaderOffset: offset,
        encrypted: (flags & 0x1) === 1,
        directory: name.endsWith("/"),
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally {
    await fh.close();
  }
}

/** Where an entry's data starts (after its local header). */
async function dataStart(path: string, entry: ZipEntry): Promise<number> {
  const fh = await open(path, "r");
  try {
    const h = Buffer.alloc(30);
    const { bytesRead } = await fh.read(h, 0, 30, entry.localHeaderOffset);
    if (bytesRead < 30 || h.readUInt32LE(0) !== 0x04034b50) throw new ZipError(`The zip entry ${entry.name} is damaged.`);
    return entry.localHeaderOffset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  } finally {
    await fh.close();
  }
}

/** A stream of an entry's uncompressed bytes, stopped with a ZipError past `maxBytes`. */
export async function openZipEntry(path: string, entry: ZipEntry, maxBytes: number): Promise<Readable> {
  if (entry.encrypted) throw new ZipError(`${entry.name} is encrypted.`);
  if (entry.method !== 0 && entry.method !== 8) throw new ZipError(`${entry.name} uses a compression this import can't read.`);
  const start = await dataStart(path, entry);
  const src = createReadStream(path, entry.compressedSize > 0 ? { start, end: start + entry.compressedSize - 1 } : { start, end: start - 1 });
  let seen = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > maxBytes) cb(new ZipError(`${entry.name} is larger than this import allows.`));
      else cb(null, chunk);
    },
  });
  if (entry.compressedSize === 0) {
    src.destroy();
    limiter.end();
    return limiter;
  }
  if (entry.method === 8) pipeline(src, createInflateRaw(), limiter, () => {});
  else pipeline(src, limiter, () => {});
  return limiter;
}

/** An entry read whole (attachments): refused past `maxBytes`. */
export async function readZipEntry(path: string, entry: ZipEntry, maxBytes: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of await openZipEntry(path, entry, maxBytes)) parts.push(chunk as Buffer);
  return Buffer.concat(parts);
}
