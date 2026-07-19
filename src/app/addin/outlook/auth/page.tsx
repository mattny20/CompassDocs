import { getCurrentUser } from "@/lib/auth";
import { AddinAuthClient } from "@/components/OutlookPane";

// Sign-in target for the Office dialog (displayDialogAsync). The dialog shares
// the task pane's cookie jar, so a login here signs the pane in too. Once a
// session exists this page messages the parent pane and the dialog closes.

export const dynamic = "force-dynamic";

export default async function AddinAuthPage() {
  const user = await getCurrentUser();
  return <AddinAuthClient authed={Boolean(user)} />;
}
