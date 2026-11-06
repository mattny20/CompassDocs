// /desk/tickets/[number]: a ticket open beside its queue. The pane loads
// the ticket from GET /api/helpdesk/tickets/[number], so a deep link and a
// click in the list render the same thing.

import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { TicketPane } from "@/components/helpdesk/desk/ticket/TicketPane";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ number: string }> };

function ticketNumber(raw: string): number | null {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const n = ticketNumber((await params).number);
  return { title: n ? `Ticket #${n}` : "Ticket" };
}

export default async function TicketPage({ params }: Props) {
  const n = ticketNumber((await params).number);
  if (!n) notFound();
  return <TicketPane number={n} />;
}
