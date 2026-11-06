import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { settingsMetadata } from "@/lib/settings-sections";
import { templateDef } from "@/lib/email-templates";
import { templatesAccess } from "@/components/email-templates/access";
import { ComposerPage } from "@/components/email-templates/ComposerPage";
import type { Surface } from "@/components/email-templates/types";

export const dynamic = "force-dynamic";

const SURFACE: Surface = { base: "/admin/notifications/templates", mode: "admin" };

type Props = { params: Promise<{ key: string }>; searchParams: Promise<{ scope?: string }> };

export async function generateMetadata({ params }: Props) {
  const def = templateDef(decodeURIComponent((await params).key));
  return settingsMetadata("/admin/notifications", def ? `${def.label} email` : "Email template");
}

export default async function ComposeEmailPage({ params, searchParams }: Props) {
  const key = decodeURIComponent((await params).key);
  if (!templateDef(key)) notFound();
  const user = await requireUser();
  const access = await templatesAccess(user);
  if (!access.read) redirect("/");
  const canCompose = access.manage || (access.helpdesk && key.startsWith("hd_"));
  return (
    <ComposerPage
      surface={SURFACE}
      eventKey={key}
      scope={(await searchParams).scope ?? "all"}
      canCompose={canCompose}
      canEditParts={access.manage}
    />
  );
}
