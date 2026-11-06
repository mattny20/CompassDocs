import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { LibraryPage, libraryTitle } from "@/components/email-templates/LibraryPage";
import { kindFromSegment, type Surface } from "@/components/email-templates/types";
import { deskTemplatesAccess } from "../access";

export const dynamic = "force-dynamic";

const SURFACE: Surface = { base: "/desk/settings/email-templates", mode: "desk" };

type Props = { params: Promise<{ kind: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params }: Props) {
  return { title: libraryTitle((await params).kind) };
}

export default async function DeskEmailPartsPage({ params, searchParams }: Props) {
  const kind = kindFromSegment((await params).kind);
  if (!kind) notFound();
  const access = await deskTemplatesAccess(await requireUser());
  if (!access.licensed || !access.open) return null;
  return <LibraryPage surface={SURFACE} kind={kind} canEdit={access.editParts} searchParams={await searchParams} />;
}
