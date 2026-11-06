import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { settingsMetadata } from "@/lib/settings-sections";
import { templatesAccess } from "@/components/email-templates/access";
import { LibraryPage, libraryTitle } from "@/components/email-templates/LibraryPage";
import { kindFromSegment, type Surface } from "@/components/email-templates/types";

export const dynamic = "force-dynamic";

const SURFACE: Surface = { base: "/admin/notifications/templates", mode: "admin" };

type Props = { params: Promise<{ kind: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params }: Props) {
  return settingsMetadata("/admin/notifications", libraryTitle((await params).kind));
}

export default async function EmailPartsPage({ params, searchParams }: Props) {
  const kind = kindFromSegment((await params).kind);
  if (!kind) notFound();
  const user = await requireUser();
  const access = await templatesAccess(user);
  if (!access.read) redirect("/");
  return <LibraryPage surface={SURFACE} kind={kind} canEdit={access.manage} searchParams={await searchParams} />;
}
