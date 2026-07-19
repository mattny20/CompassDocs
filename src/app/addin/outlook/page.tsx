import type { Metadata } from "next";
import { OutlookPane } from "@/components/OutlookPane";

// The Outlook task pane. Deliberately chrome-less (no sidebar/topbar) — it
// renders inside Outlook's webview at ~320-450px wide. Auth is handled inside
// the pane (401 from the bootstrap API → sign-in state), never by redirect.

export const metadata: Metadata = {
  title: "CompassDocs for Outlook",
  robots: { index: false },
};

export const dynamic = "force-dynamic";

export default function OutlookAddinPage() {
  return <OutlookPane />;
}
