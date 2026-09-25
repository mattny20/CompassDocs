// Shared parsing for the field admin routes: which keys of a request body are
// field properties, coerced to the types the data layer expects. Validation of
// values (option shape, mapping shape, enums) happens in the data layer so a
// second caller can't skip it.

import type { FieldInput } from "@/lib/directory";

export function readFieldBody(body: Record<string, unknown>): FieldInput {
  const out: FieldInput = {};
  if (body.key !== undefined) out.key = String(body.key);
  if (body.label !== undefined) out.label = String(body.label);
  if (body.graph_path !== undefined) out.graph_path = String(body.graph_path ?? "");
  if (body.google_path !== undefined) out.google_path = String(body.google_path ?? "");
  if (body.show_in_card !== undefined) out.show_in_card = Boolean(body.show_in_card);
  if (body.display !== undefined) out.display = String(body.display) as FieldInput["display"];
  if (body.sort !== undefined) out.sort = Number(body.sort);
  if (body.kind !== undefined) out.kind = String(body.kind) as FieldInput["kind"];
  if (body.multi !== undefined) out.multi = Boolean(body.multi);
  if (body.group_by !== undefined) out.group_by = Boolean(body.group_by);
  if (body.options !== undefined) out.options = body.options;
  if (body.value_format !== undefined) out.value_format = String(body.value_format) as FieldInput["value_format"];
  if (body.show_with !== undefined) out.show_with = String(body.show_with ?? "");
  if (body.highlight !== undefined) out.highlight = Boolean(body.highlight);
  if (body.inverse_label !== undefined) out.inverse_label = String(body.inverse_label ?? "");
  if (body.link_direction !== undefined) out.link_direction = body.link_direction === "in" ? "in" : "out";
  if (body.mappings !== undefined) out.mappings = body.mappings;
  return out;
}
