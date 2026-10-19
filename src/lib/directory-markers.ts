// Directory export markers, the store: one JSON setting holding the
// workspace's definitions, the same pattern as the export presets (a handful,
// edited as a set). The rules, the matching and the prefix live in
// lib/directory-marker-rules so the Markers card and the renderer can read
// them without this module's database import.

import { getSetting, setSetting } from "./db";
import { listFields, type DirectoryField } from "./directory";
import { markersProblem, sanitizeMarkers, type ExportMarker } from "./directory-marker-rules";

export * from "./directory-marker-rules";

const SETTING = "directory_export_markers";

/** Every marker, sanitized against the fields that exist. */
export async function listMarkers(fields?: DirectoryField[]): Promise<ExportMarker[]> {
  const all = fields ?? (await listFields());
  const raw = await getSetting(SETTING);
  if (!raw) return [];
  try {
    return sanitizeMarkers(JSON.parse(raw), all);
  } catch {
    return [];
  }
}

/**
 * Replace the set. Refuses, naming the first problem, rather than saving a
 * marker short of what it was typed as: a symbol the PDF cannot print would
 * otherwise come out as a box on paper behind a "saved".
 */
export async function saveMarkers(raw: unknown, fields?: DirectoryField[]): Promise<ExportMarker[]> {
  const all = fields ?? (await listFields());
  const problem = markersProblem(raw, all);
  if (problem) throw new Error(problem);
  const markers = sanitizeMarkers(raw, all);
  await setSetting(SETTING, JSON.stringify(markers));
  return markers;
}
