import { redirect } from "next/navigation";

// Section access folded into Roles & permissions (0.98).
//
// The three sections have been backed by real roles since 0.94, so this page
// was a second surface onto one model — and a partial one: it could only list
// holders of the seeded role, never anyone reaching a section through a custom
// role, which meant it stated someone's access and was sometimes wrong. That is
// the shape of problem this whole rewrite existed to remove, so it goes.
//
// A redirect rather than a deletion: the path is in older documentation, in
// people's bookmarks, and in muscle memory.
export default function MovedSectionAccess() {
  redirect("/admin/roles?delegate=1");
}
