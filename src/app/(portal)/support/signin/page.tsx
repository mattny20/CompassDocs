// /support/signin?token=…: opening a sign-in link (Helpdesk 1.19.1). Shows
// who it signs in and one Continue button; only that button's POST spends
// the link (mail scanners that open links sign nobody in). A spent,
// expired or unknown link says so and offers a new one.

import { notFound } from "next/navigation";
import { getPortalSettings, peekSignInLink, portalBrand, portalOpen } from "@/lib/helpdesk/portal";
import { Button } from "@/components/Button";
import { PortalContinue } from "@/components/helpdesk/portal/PortalContinue";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

export default async function PortalSignInLink({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const settings = await getPortalSettings();
  if (!(await portalOpen(settings))) notFound();
  const sp = await searchParams;
  const token = typeof sp.token === "string" ? sp.token : "";
  const link = token ? await peekSignInLink(token) : null;
  const brand = await portalBrand(settings);
  return (
    <div className="mx-auto mt-10 w-full max-w-md rounded-2xl border border-slate-200 bg-surface p-6 shadow-xs sm:mt-20 sm:p-7">
      {link ? (
        <>
          <h1 className="text-2xl font-bold text-slate-900">Sign in to {brand.name}</h1>
          <p className="mt-1.5 text-sm text-slate-600">
            You&apos;re signing in as <span className="font-medium text-slate-800">{link.email}</span>.
          </p>
          <PortalContinue token={token} />
        </>
      ) : (
        <>
          <h1 className="text-2xl font-bold text-slate-900">This link has expired</h1>
          <p className="mt-1.5 text-sm text-slate-600">Sign-in links work once and for 15 minutes. Ask for a new one and use it straight away.</p>
          <Button href="/support?signin=1" size="lg" className="mt-5 w-full">
            Ask for a new link
          </Button>
        </>
      )}
    </div>
  );
}
