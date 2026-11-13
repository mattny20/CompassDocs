// A ticket on paper (1.19.4, area C6; mock-up u5): /desk/tickets/[number]/print.
// The ticket's … menu (and Ctrl/Cmd+P on a ticket) opens the print dialog,
// which opens this page with the chosen parts (?include=details,notes,…)
// and ?print=1, so the browser's print dialog comes up once it has loaded;
// "Save as PDF" is the browser's own.
//
// Like the printed handbook it lives in the (print) route group, outside
// the desk shell: the paper starts at its corner and no desk artwork or
// chrome reaches it. It is still a desk page, so it does what the desk
// layout does first (sign-in, the forced password change, the licence) and
// the ticket's own check decides the rest: an agent who works the ticket
// (the desk's GET /api/helpdesk/tickets/[number] rule), else a 404.
//
// Rendering the sheet is what the audit records (helpdesk.ticket.printed,
// lib/helpdesk/share recordPrintView): the parts come from this request's
// own query as the server parsed and rendered them, never from a list the
// browser reports, so Save page or a fetch of the HTML is recorded as a
// print is.

import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { requireUser, currentPagePath } from "@/lib/auth";
import { ipFrom } from "@/lib/audit";
import { safeReturnPath } from "@/lib/return-to";
import { canWorkTicket, helpdeskLicensed, isAgent } from "@/lib/helpdesk/access";
import { getTicketByNumber } from "@/lib/helpdesk/tickets";
import { recordPrintView, ticketPrintView } from "@/lib/helpdesk/share";
import { parsePrintInclude } from "@/lib/helpdesk/share-shared";
import { TicketPrint } from "@/components/helpdesk/desk/share/TicketPrint";
import { PrintTicketToolbar } from "@/components/helpdesk/desk/share/PrintTicketToolbar";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ number: string }>;
  searchParams: Promise<{ include?: string | string[]; print?: string }>;
};

function ticketNumber(raw: string): number | null {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const n = ticketNumber((await params).number);
  return { title: n ? `Print #${n} · Desk` : "Print · Desk", robots: { index: false, follow: false } };
}

export default async function TicketPrintPage({ params, searchParams }: Props) {
  const user = await requireUser("desk"); // 1.20.5: a desk page outside the desk's layout, so it asks for the Duo desk rule itself
  if (user.must_change_password) {
    const back = safeReturnPath(await currentPagePath());
    redirect(back === "/" ? "/account/password" : `/account/password?next=${encodeURIComponent(back)}`);
  }
  const [{ number: raw }, sp] = await Promise.all([params, searchParams]);
  const n = ticketNumber(raw);
  if (!n) notFound();
  if (!(await helpdeskLicensed()) || !(await isAgent(user))) notFound();
  const ticket = await getTicketByNumber(n);
  if (!ticket || !(await canWorkTicket(user, ticket))) notFound();

  const options = parsePrintInclude(sp.include);
  const view = await ticketPrintView(user, ticket, options);
  const ip = ipFrom(new Request("http://print.local/", { headers: await headers() }));
  await recordPrintView({ id: user.id, role: user.role, name: user.name || user.username }, ticket, options, ip);

  return (
    <main id="main" tabIndex={-1} className="min-h-screen bg-canvas outline-none print:bg-transparent">
      <TicketPrint t={view} toolbar={<PrintTicketToolbar number={view.number} notes={options.notes} autoPrint={sp.print === "1"} />} />
    </main>
  );
}
