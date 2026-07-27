// Path-suffixed variant (RFC 9728 lookup for the /api/mcp resource).
// Route segment config must be a literal in THIS file (Turbopack parses it
// statically; a re-export is rejected), so `dynamic` is declared here rather
// than re-exported from ../../route.
export const dynamic = "force-dynamic";
export { GET, OPTIONS } from "../../route";
