import { requireUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { settingsMetadata } from "@/lib/settings-sections";
import { templatesAccess } from "@/components/email-templates/access";
import { loadTemplatesList } from "@/components/email-templates/load";
import { TemplatesList } from "@/components/email-templates/TemplatesList";
import type { Surface } from "@/components/email-templates/types";

export const dynamic = "force-dynamic";
export const metadata = settingsMetadata("/admin/notifications", "Email templates");

const SURFACE: Surface = { base: "/admin/notifications/templates", mode: "admin" };

export default async function EmailTemplatesPage() {
  const user = await requireUser();
  if (!(await templatesAccess(user)).read) redirect("/");
  const data = await loadTemplatesList(SURFACE);
  return <TemplatesList surface={SURFACE} {...data} />;
}
