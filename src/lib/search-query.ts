// Search-query operators: `type:sop tag:release space:engineering
// author:"maya chen" status:draft deploy checklist` → structured filters plus
// the free-text remainder. Shared by the API (to filter SQL) and the search UI
// (to render active-filter chips). Unknown operators are left in the text.

export interface SearchFilters {
  space?: string; // slug or name, matched case-insensitively
  type?: string;
  tag?: string;
  author?: string;
  status?: "draft" | "published";
}

export interface ParsedSearchQuery {
  /** Free-text part with operators removed. */
  text: string;
  filters: SearchFilters;
  /** True when any operator was recognized. */
  hasFilters: boolean;
}

const OPERATORS = new Set(["space", "type", "tag", "author", "status"]);

export function parseSearchQuery(raw: string): ParsedSearchQuery {
  const filters: SearchFilters = {};
  // key:"quoted value" | key:bare-value
  const re = /(\w+):(?:"([^"]*)"|(\S+))/g;
  const text = raw
    .replace(re, (m, key: string, quoted: string | undefined, bare: string | undefined) => {
      const k = key.toLowerCase();
      if (!OPERATORS.has(k)) return m; // not ours — keep in the text
      const value = (quoted ?? bare ?? "").trim();
      if (!value) return "";
      switch (k) {
        case "space":
          filters.space = value;
          break;
        case "type":
          filters.type = value.toLowerCase();
          break;
        case "tag":
          filters.tag = value.toLowerCase();
          break;
        case "author":
          filters.author = value;
          break;
        case "status":
          if (value === "draft" || value === "published") filters.status = value;
          break;
      }
      return "";
    })
    .replace(/\s+/g, " ")
    .trim();
  return { text, filters, hasFilters: Object.keys(filters).length > 0 };
}
