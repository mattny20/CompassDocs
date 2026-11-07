import "server-only";

// Helpdesk 1.19.4: turning an uploaded picture into desk background
// artwork (lib/helpdesk/appearance). sharp is already the app's image
// library (the sign-in artwork, directory photos), so no new dependency.
//
// Uploaded bytes are never served as they came. The type is read from the
// magic bytes (JPEG, PNG or WebP only: no SVG, no GIF), the size from the
// header before anything is decoded (100 megapixels at most, and sharp's
// own limitInputPixels set to the same cap), the camera's rotation is
// applied before the checks (at least 1920 × 1080, landscape, at most
// 4:1). Then the picture is decoded ONCE, into a 2560-wide master; the WebP
// copies (480 for thumbnails, 1280, 1920 and 2560 for screens) and the
// contrast probe all come from that master, so a huge upload costs one
// decode, never five. Re-encoding drops every piece of metadata (EXIF with
// GPS, XMP, IPTC). At most two pictures are processed at a time in the
// process; a third is told the server is busy (503), so uploads can't tie
// up the thread pool sharp shares with file and crypto work.
//
// The probe measures what the desk shows (review C5 finding 6): the
// picture scaled to cover a 2560 × 1440 screen, blurred exactly as the
// desk's layer is (CSS blur(8px), a Gaussian with σ 8 px), then cut into
// 64 × 40 cells keeping each cell's darkest and brightest pixel, never an
// average, so a thin bright line on a dark picture counts at full strength.
// lib/helpdesk/appearance-contrast turns that into the scrim each mode needs.

import sharp from "sharp";
import { sniffImage } from "../uploads";
import { HD_DESK_PROBE, luminance, measureNeed, probeCells } from "./appearance-contrast";
import {
  DeskArtError,
  HD_ART_MAX_ASPECT,
  HD_ART_MAX_BYTES,
  HD_ART_MAX_PIXELS,
  HD_ART_MIN,
  HD_ART_WIDTHS,
  type HdArtWidth,
} from "./appearance-shared";

export { DeskArtError } from "./appearance-shared";

export interface ProcessedDeskArt {
  /** One WebP per width, in HD_ART_WIDTHS order. */
  files: { width: HdArtWidth; buf: Buffer }[];
  width: number;
  height: number;
  /** "#rrggbb": the picture's average colour, painted while it loads. */
  tint: string;
  need: { light: number; dark: number };
}

const TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

type SharpImage = ReturnType<typeof sharp>;

/** The screen the probe measures for: the largest common desk, where the picture is least blurred relative to its features. */
export const HD_DESK_PROBE_SCREEN = { width: 2560, height: 1440 } as const;
/** The desk layer's CSS blur(8px) as a Gaussian σ, in screen pixels. */
export const HD_DESK_PROBE_SIGMA = 8;

// --- One picture at a time (well, two) ---------------------------------------------------

/** Pictures processed at once in this process. */
export const HD_ART_SLOTS = 2;
let busy = 0;

/** Run `fn` in one of the process's picture slots, or refuse with 503 when both are taken. */
export async function withDeskArtSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (busy >= HD_ART_SLOTS) throw new DeskArtError("The server is busy with other pictures. Try again in a minute.", 503);
  busy++;
  try {
    return await fn();
  } finally {
    busy--;
  }
}

// --- The probe ----------------------------------------------------------------------------

/**
 * The probe for a picture (any input sharp reads, SVG included): for each of
 * the 64 × 40 cells its darkest then its brightest pixel, as raw RGB bytes
 * (2 × 64 × 40 × 3), measured on the picture as the desk paints it.
 */
export async function deskArtProbe(input: Buffer | SharpImage): Promise<Buffer> {
  const img = Buffer.isBuffer(input) ? sharp(input, { limitInputPixels: HD_ART_MAX_PIXELS }) : input.clone();
  const { data, info } = await img
    .resize(HD_DESK_PROBE_SCREEN.width, HD_DESK_PROBE_SCREEN.height, { fit: "outside" })
    .blur(HD_DESK_PROBE_SIGMA)
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;
  const { width: PW, height: PH } = HD_DESK_PROBE;
  // Linear light per channel value, once: the scan below reads millions of pixels.
  const lin = new Float64Array(256);
  for (let v = 0; v < 256; v++) lin[v] = luminance([v, 0, 0]) / 0.2126;
  const out = Buffer.alloc(PW * PH * 2 * 3);
  for (let cy = 0; cy < PH; cy++) {
    const y0 = Math.floor((cy * H) / PH);
    const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * H) / PH));
    for (let cx = 0; cx < PW; cx++) {
      const x0 = Math.floor((cx * W) / PW);
      const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * W) / PW));
      let lo = Infinity;
      let hi = -Infinity;
      let loAt = 0;
      let hiAt = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0, i = (y * W + x0) * C; x < x1; x++, i += C) {
          const l = 0.2126 * lin[data[i]] + 0.7152 * lin[data[i + 1]] + 0.0722 * lin[data[i + 2]];
          if (l < lo) {
            lo = l;
            loAt = i;
          }
          if (l > hi) {
            hi = l;
            hiAt = i;
          }
        }
      }
      const o = (cy * PW + cx) * 6;
      data.copy(out, o, loAt, loAt + 3);
      data.copy(out, o + 3, hiAt, hiAt + 3);
    }
  }
  return out;
}

/** The scrim each mode needs on a picture (lib/helpdesk/appearance-contrast). */
export async function deskArtNeed(input: Buffer | SharpImage): Promise<{ light: number; dark: number }> {
  const cells = probeCells(await deskArtProbe(input));
  return { light: measureNeed(cells, "light"), dark: measureNeed(cells, "dark") };
}

// --- The upload ---------------------------------------------------------------------------

/** Check, re-encode and measure an upload. Throws DeskArtError with a sentence for the person. */
export async function processDeskArt(input: Buffer): Promise<ProcessedDeskArt> {
  if (input.length === 0) throw new DeskArtError("The file is empty.", 400);
  if (input.length > HD_ART_MAX_BYTES) throw new DeskArtError("Artwork is limited to 8 MB.", 413);
  const kind = sniffImage(input);
  if (!kind || !TYPES.has(kind.mime)) throw new DeskArtError("Use a JPG, PNG or WebP image.", 415);
  return withDeskArtSlot(async () => {
    try {
      // "truncated" refuses a part-written file; the pixel limit is the cap, so a header that
      // lies about its size still can't make sharp decode more than 100 MP.
      const src = sharp(input, { failOn: "truncated", animated: false, limitInputPixels: HD_ART_MAX_PIXELS });
      const meta = await src.metadata();
      const shown = meta.autoOrient ?? { width: meta.width ?? 0, height: meta.height ?? 0 };
      const { width, height } = shown;
      // From the header alone: nothing is decoded until these pass.
      if (width * height > HD_ART_MAX_PIXELS) {
        throw new DeskArtError(`That image is ${width} × ${height} pixels. Use one with no more than 100 megapixels.`);
      }
      if (width < HD_ART_MIN.width || height < HD_ART_MIN.height) {
        throw new DeskArtError(`That image is ${width} × ${height} pixels. Use one at least ${HD_ART_MIN.width} × ${HD_ART_MIN.height}.`);
      }
      if (height > width || width > height * HD_ART_MAX_ASPECT) {
        throw new DeskArtError(`That image is ${width} × ${height} pixels. Use a landscape picture, no more than four times as wide as it is tall.`);
      }
      // The one decode: a 2560-wide master (at most 2560 × 2560, so at most about 20 MB raw).
      const { data, info } = await src
        .rotate()
        .resize({ width: 2560, withoutEnlargement: true })
        .flatten({ background: "#808080" })
        .toColourspace("srgb")
        .raw()
        .toBuffer({ resolveWithObject: true });
      const master = () => sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });
      // One after another: each copy is small work on the master, and a slot stays about one core's worth.
      const files: { width: HdArtWidth; buf: Buffer }[] = [];
      for (const w of HD_ART_WIDTHS) {
        files.push({ width: w, buf: await master().resize({ width: w, withoutEnlargement: true }).webp({ quality: w === 480 ? 70 : 80 }).toBuffer() });
      }
      const cells = probeCells(await deskArtProbe(master()));
      const { channels } = await master().stats();
      const hex = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
      return {
        files,
        width,
        height,
        tint: `#${hex(channels[0].mean)}${hex(channels[1].mean)}${hex(channels[2].mean)}`,
        need: { light: measureNeed(cells, "light"), dark: measureNeed(cells, "dark") },
      };
    } catch (e) {
      if (e instanceof DeskArtError) throw e;
      throw new DeskArtError("That image could not be read. Try saving it as a JPG or PNG.");
    }
  });
}
