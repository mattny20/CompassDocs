import { requireUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { templatesAccess } from "@/components/email-templates/access";
import { TemplatesSubNav } from "@/components/email-templates/TemplatesSubNav";

export const dynamic = "force-dynamic";

// Settings → Notifications → Email templates (1.19.0): the compositions and
// the four part libraries they are built from, one routed tab each, under
// the Notifications header and tab row (the section's layout). Template
// readers may look; template managers may change anything (each page
// asks again, the settings convention).
export default async function EmailTemplatesLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const access = await templatesAccess(user);
  if (!access.read) redirect("/");
  return (
    <>
      <TemplatesSubNav base="/admin/notifications/templates" className="-mt-2" />
      {children}
    </>
  );
}
