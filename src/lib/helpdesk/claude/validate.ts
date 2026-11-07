// Helpdesk 1.20.0: validate a tool input against its JSON schema before the
// tool runs. With eager input streaming the API no longer validates client
// tool inputs and the SDK's tolerant parser can hand back a silently cut
// object, so every parsed input is checked here; a failure goes back to
// Claude as an INVALID_JSON error result and the tool does not run. Covers
// exactly what lib/helpdesk/claude/prompt's schemas use: object (required,
// additionalProperties false), string (enum), integer, number, boolean,
// array (items), null, anyOf. Client-safe and dependency-free.

type Schema = Record<string, unknown>;

/** null when `value` matches `schema`; else a short reason naming the path. */
export function schemaError(schema: Schema, value: unknown, path = "input"): string | null {
  if (Array.isArray(schema.anyOf)) {
    for (const s of schema.anyOf as Schema[]) if (schemaError(s, value, path) === null) return null;
    return `${path} does not match any allowed form`;
  }
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) return `${path} must be one of ${(schema.enum as unknown[]).map((v) => JSON.stringify(v)).join(", ")}`;
  switch (schema.type) {
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return `${path} must be an object`;
      const o = value as Record<string, unknown>;
      const props = (schema.properties ?? {}) as Record<string, Schema>;
      for (const k of (schema.required ?? []) as string[]) if (!(k in o)) return `${path}.${k} is missing`;
      for (const [k, v] of Object.entries(o)) {
        const p = props[k];
        if (!p) {
          if (schema.additionalProperties === false) return `${path}.${k} is not allowed`;
          continue;
        }
        const e = schemaError(p, v, `${path}.${k}`);
        if (e) return e;
      }
      return null;
    }
    case "array": {
      if (!Array.isArray(value)) return `${path} must be a list`;
      const items = schema.items as Schema | undefined;
      if (items) for (let i = 0; i < value.length; i++) {
        const e = schemaError(items, value[i], `${path}[${i}]`);
        if (e) return e;
      }
      return null;
    }
    case "string":
      return typeof value === "string" ? null : `${path} must be text`;
    case "integer":
      return typeof value === "number" && Number.isInteger(value) ? null : `${path} must be a whole number`;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : `${path} must be a number`;
    case "boolean":
      return typeof value === "boolean" ? null : `${path} must be true or false`;
    case "null":
      return value === null ? null : `${path} must be null`;
    default:
      return null;
  }
}
