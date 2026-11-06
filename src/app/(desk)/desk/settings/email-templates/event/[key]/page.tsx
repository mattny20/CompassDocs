import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { templateDef } from "@/lib/email-templates";
import { ComposerPage } from "@/components/email-templates/ComposerPage";
import type { Surface } from "@/components/email-templates/types";
import { deskTemplatesAccess } from "../../access";

export const dynamic = "force-dynamic";

const SURFACE: Surface = { base: "/desk/settings/email-templates", mode: "desk" };

type Props = { params: Promise<{ key: string }>; searchParams: Promise<{ scope?: string }> };

export async function generateMetadata({ params }: Props) {
  const def = templateDef(decodeURIComponent((await params).key));
  return { title: def ? `${def.label} email` : "Email template" };
}

export default async function DeskComposeEmailPage({ params, searchParams }: Props) {
  const key = decodeURIComponent((await params).key);
  if (!templateDef(key) || !key.startsWith("hd_")) notFound();
  const access = await deskTemplatesAccess(await requireUser());
  if (!access.licensed || !access.open) return null;
  return (
    <ComposerPage
      surface={SURFACE}
      eventKey={key}
      scope={(await searchParams).scope ?? "all"}
      canCompose={access.compose}
      canEditParts={access.editParts}
    />
  );
}
