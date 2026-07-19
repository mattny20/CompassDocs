import { redirect } from "next/navigation";

// Announcements moved to the main navigation (0.50) — keep old links working.
export default function MovedAnnouncements() {
  redirect("/announcements");
}
