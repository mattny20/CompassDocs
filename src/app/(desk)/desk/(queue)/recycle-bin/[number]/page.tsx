// /desk/recycle-bin/[number] (1.19.4, area C7; mock-up v3): a deleted
// ticket, read-only, beside the bin's list, with Restore. The pane loads
// GET /api/helpdesk/recycle-bin/[number] (an agent who works the ticket).

import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { RecycleBinSplit } from "@/components/helpdesk/desk/recycle-bin/RecycleBinSplit";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ number: string }> };

function ticketNumber(raw: string): number | null {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const n = ticketNumber((await params).number);
  return { title: n ? `Deleted ticket #${n}` : "Recycle bin" };
}

export default async function BinnedTicketPage({ params }: Props) {
  const n = ticketNumber((await params).number);
  if (!n) notFound();
  return <RecycleBinSplit number={n} />;
}
