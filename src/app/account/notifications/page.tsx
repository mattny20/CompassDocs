import { redirect } from "next/navigation";

// Folded into the unified account page.
export default function NotificationsPage() {
  redirect("/account#notifications");
}
