import { redirect } from "next/navigation";

// Compliance moved to the main navigation (0.50) — keep old links working.
export default function MovedCompliance() {
  redirect("/compliance");
}
