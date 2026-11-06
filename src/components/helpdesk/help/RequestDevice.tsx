"use client";

// Get help's optional Device picker (1.19.3, lib/helpdesk/assets): the
// requester's own devices from Snipe-IT (assigned to their address), so
// they can say which one has the problem. Only theirs, ever (GET
// /api/helpdesk/assets/mine); nothing renders when they have none or no
// asset source is set up. The request route checks the choice again.

import { useEffect, useState } from "react";
import { Field, Select } from "@/components/form";

type Mine = { id: number; name: string; tag: string };

export function RequestDevice({ value, onChange }: { value: number | null; onChange: (id: number | null) => void }) {
  const [mine, setMine] = useState<Mine[]>([]);
  useEffect(() => {
    let live = true;
    fetch("/api/helpdesk/assets/mine", { headers: { accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : { assets: [] }))
      .then((d: { assets?: Mine[] }) => live && setMine(Array.isArray(d.assets) ? d.assets : []))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  if (!mine.length) return null;
  return (
    <Field label="Device" help="Optional: the one with the problem, so the helpdesk can see its history.">
      <Select value={value ?? ""} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)} data-testid="request-device">
        <option value="">Not about one of my devices</option>
        {mine.map((a) => (
          <option key={a.id} value={a.id}>
            {[a.name, a.tag].filter(Boolean).join(" · ")}
          </option>
        ))}
      </Select>
    </Field>
  );
}
