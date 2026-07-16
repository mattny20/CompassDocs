import { redirect } from "next/navigation";

// Folded into the unified account page.
export default function ApiTokensPage() {
  redirect("/account#api");
}
