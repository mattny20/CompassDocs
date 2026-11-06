import { requireUser } from "@/lib/auth";
import { loadTemplatesList } from "@/components/email-templates/load";
import { TemplatesList } from "@/components/email-templates/TemplatesList";
import type { Surface } from "@/components/email-templates/types";
import { deskTemplatesAccess } from "./access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Email templates" };

const SURFACE: Surface = { base: "/desk/settings/email-templates", mode: "desk" };

export default async function DeskEmailTemplatesPage() {
  const access = await deskTemplatesAccess(await requireUser());
  if (!access.licensed || !access.open) return null;
  const data = await loadTemplatesList(SURFACE);
  return <TemplatesList surface={SURFACE} {...data} />;
}
