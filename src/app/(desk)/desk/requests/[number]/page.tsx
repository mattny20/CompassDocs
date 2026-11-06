// /desk/requests/[number]: a workflow request, read-only, for a team that
// has a task on it (1.19.0 multi-team workflows). `?from=<task number>` is
// the task the agent came from; the API decides what they may see. Agents
// who may work the request itself are sent to /desk/tickets/[number].

import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { RequestView } from "@/components/helpdesk/desk/workflow-multi/RequestView";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ number: string }>; searchParams: Promise<{ from?: string }> };

function ticketNumber(raw: string | undefined): number | null {
  const n = Number(raw);
  return raw && Number.isSafeInteger(n) && n > 0 ? n : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const n = ticketNumber((await params).number);
  return { title: n ? `Request #${n} (read-only)` : "Request" };
}

export default async function RequestReadOnlyPage({ params, searchParams }: Props) {
  const n = ticketNumber((await params).number);
  if (!n) notFound();
  const from = ticketNumber((await searchParams).from);
  return <RequestView number={n} from={from} />;
}
