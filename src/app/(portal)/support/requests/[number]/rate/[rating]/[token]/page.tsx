// /support/requests/[number]/rate/[rating]/[token]: a rating link from the
// solved email (Helpdesk 1.19.2, lib/helpdesk/portal-csat). It rates
// nothing itself: signed in, it opens the request with the rating
// preselected (the person still presses Send, so a mail scanner that
// follows links rates nothing); signed out, it asks for a sign-in link that
// comes back here (the whole path is the link's `next`). The rating is a
// slug ("not-good") and the token hex, so the link has no "_" for a
// plain-text mail to swallow (portal-csat-shared).

import { notFound, redirect } from "next/navigation";
import { currentPortalContact, getPortalSettings, portalOpen } from "@/lib/helpdesk/portal";
import { portalRatingFromSlug, tokenFromHex } from "@/lib/helpdesk/portal-csat-shared";

export const dynamic = "force-dynamic";
export const metadata = { title: "Rate your request" };

type Params = { number: string; rating: string; token: string };

export default async function PortalRateLink({ params }: { params: Promise<Params> }) {
  const settings = await getPortalSettings();
  if (!(await portalOpen(settings))) notFound();
  const p = await params;
  const rating = portalRatingFromSlug(p.rating);
  const token = tokenFromHex(p.token);
  if (!/^\d{1,10}$/.test(p.number) || !rating || !token) notFound();
  if (!(await currentPortalContact(settings))) redirect(`/support?next=/support/requests/${p.number}/rate/${p.rating}/${p.token}`);
  redirect(`/support/requests/${p.number}?rate=${rating}&t=${encodeURIComponent(token)}`);
}
