// The printed handbook (1.18.0, /handbooks/{id}/print): a print-optimised
// page that is also the on-screen preview of the paper copy. `?print=1`
// opens the browser's print dialog once it has loaded; `?paper=a4|letter`
// picks the @page size (default: Letter for a US date format, else A4).
//
// It lives in its own (print) route group, outside the app shell: a printed
// handbook carries no sidebar, palette or skip link, and the cover has to
// start at the top-left corner of the paper. It is still a signed-in page,
// so it does what the (app) layout does before anything else — sign-in and
// the forced password change — and the handbook's own read check decides
// the rest (a 404 for anyone outside the audience, like the reader).

import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { requireUser, currentPagePath } from "@/lib/auth";
import { safeReturnPath } from "@/lib/return-to";
import { getHandbook } from "@/lib/handbooks";
import { HandbookPrint } from "@/components/handbooks/print/HandbookPrint";
import { PrintToolbar } from "@/components/handbooks/print/PrintToolbar";
import type { PaperSize } from "@/components/handbooks/print/print-model";
import { loadPrintHandbook } from "./print-data";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ print?: string; paper?: string }>;
};

function handbookId(raw: string): number | null {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function paperOf(raw: string | undefined): PaperSize | null {
  return raw === "a4" || raw === "letter" ? raw : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const id = handbookId((await params).id);
  const user = await requireUser();
  const hb = id ? await getHandbook(user, id).catch(() => undefined) : undefined;
  return {
    title: hb ? `${hb.title} (print)` : "Handbook",
    robots: { index: false, follow: false },
  };
}

export default async function HandbookPrintPage({ params, searchParams }: Props) {
  const user = await requireUser();
  if (user.must_change_password) {
    const back = safeReturnPath(await currentPagePath());
    redirect(back === "/" ? "/account/password" : `/account/password?next=${encodeURIComponent(back)}`);
  }
  const [{ id: raw }, sp] = await Promise.all([params, searchParams]);
  const id = handbookId(raw);
  if (!id) notFound();
  const data = await loadPrintHandbook(user, id, paperOf(sp.paper));
  if (!data) notFound();
  const { print } = data;

  return (
    <main id="main" tabIndex={-1} className="min-h-screen bg-canvas outline-none print:bg-transparent">
      <HandbookPrint
        hb={print}
        toolbar={
          <PrintToolbar handbookId={print.id} title={print.title} paper={print.paper} autoPrint={sp.print === "1"} />
        }
      />
    </main>
  );
}
