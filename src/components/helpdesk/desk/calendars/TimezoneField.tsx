"use client";

// An IANA time zone, typed with suggestions: a TextInput over a datalist of
// every zone the browser knows (Intl.supportedValuesOf), so "lond" finds
// Europe/London. A name the browser can't use is a field error.

import { useId, useMemo } from "react";
import { Field, TextInput } from "@/components/form";
import { validTimeZone } from "@/lib/helpdesk/calendars-shared";

const FALLBACK = ["UTC", "Europe/London", "Europe/Dublin", "Europe/Paris", "Europe/Berlin", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Asia/Tokyo", "Asia/Singapore", "Australia/Sydney"];

function zones(): string[] {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone");
    return list?.length ? (list.includes("UTC") ? list : ["UTC", ...list]) : FALLBACK;
  } catch {
    return FALLBACK;
  }
}

export function TimezoneField({ value, onChange, error }: { value: string; onChange: (tz: string) => void; error?: string }) {
  const id = useId();
  const list = useMemo(zones, []);
  const bad = value.trim() !== "" && !validTimeZone(value.trim());
  return (
    <Field
      label="Time zone"
      size="md"
      help="Type to search, for example London or New York. Times on this calendar are wall-clock times in this zone, so summer time is handled."
      error={error ?? (bad ? "That isn't a time zone this browser knows. Pick one from the list." : undefined)}
    >
      <TextInput list={`${id}-zones`} value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" spellCheck={false} placeholder="Europe/London" />
      <datalist id={`${id}-zones`}>
        {list.map((z) => (
          <option key={z} value={z} />
        ))}
      </datalist>
    </Field>
  );
}
