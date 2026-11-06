// /desk/reports/explore (1.19.0, agent K): any measure by any split, then
// keep it on a dashboard.

import { Suspense } from "react";
import { Explore } from "@/components/helpdesk/desk/reports/Explore";

export const dynamic = "force-dynamic";
export const metadata = { title: "Explore reports" };

export default function DeskExplorePage() {
  return (
    <Suspense>
      <Explore />
    </Suspense>
  );
}
