// Loading and saving office profiles: one JSON setting, like the export
// presets — a workspace has a handful of offices, edited as a set.

import { getSetting, setSetting } from "./db";
import { DEFAULT_OFFICE_FIELDS, sanitizeOfficeConfig, type OfficeConfig } from "./directory-offices";

const SETTING = "directory_offices";

export async function getOfficeConfig(): Promise<OfficeConfig> {
  const raw = await getSetting(SETTING);
  if (!raw) return { fields: [...DEFAULT_OFFICE_FIELDS], profiles: [] };
  try {
    return sanitizeOfficeConfig(JSON.parse(raw));
  } catch {
    return { fields: [...DEFAULT_OFFICE_FIELDS], profiles: [] };
  }
}

export async function saveOfficeConfig(raw: unknown): Promise<OfficeConfig> {
  const config = sanitizeOfficeConfig(raw);
  if (config.fields.length === 0) throw new Error("At least one office field is required.");
  await setSetting(SETTING, JSON.stringify(config));
  return config;
}
