"use client";

// The directory settings are five jobs — people, fields, offices, export,
// sync — and one page holding all of them ran to several screens with a save
// button in every card. Each job gets a page under /admin/directory and this
// row switches between them; the section header above stays the same. The
// tabs are the section's `pages` in lib/settings-sections, rendered by the
// shared SubNav.

import { SubNav } from "@/components/SubNav";

export function DirectorySubnav() {
  return <SubNav label="Directory settings" section="/admin/directory" />;
}
