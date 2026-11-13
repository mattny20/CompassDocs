import { redirect } from "next/navigation";
import { preload } from "react-dom";
import { currentSession } from "@/lib/auth";
import { getAllSettings } from "@/lib/db";
import { duoSettingsFrom, isDeskPath } from "@/lib/duo-policy";
import { loginHref, safeReturnPath } from "@/lib/return-to";
import { normalizeSettings } from "@/lib/settings";
import { getSignInLook } from "@/lib/sign-in-art";
import { ART_SIZES } from "@/lib/sign-in-text";
import { AuthShell } from "@/components/auth/AuthShell";
import { AuthHeading } from "@/components/auth/AuthHeading";
import { DuoStep, type DuoStepProblem } from "@/components/auth/DuoStep";
import { signInLinks } from "@/components/auth/SignInLinksBar";

export const dynamic = "force-dynamic";
export const metadata = { title: "Confirm with Duo", robots: { index: false, follow: false } };

// The Duo step (1.20.5, STYLEGUIDE §Sign-in surfaces): the page a signed-in
// session lands on while it still owes a Duo approval (lib/duo-policy),
// either right after signing in or when opening the desk. It says why, has
// one button and a way out (Sign out). It wears the sign-in shell because it
// is the second half of signing in.
//
// It reads currentSession, not requireUser: the session it is for has not
// passed yet. Someone with nothing owed is sent on to where they were going.

const PROBLEMS: DuoStepProblem[] = ["denied", "expired", "unreachable", "refused", "limited"];

export default async function DuoStepPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; e?: string; for?: string; done?: string; scope?: string }>;
}) {
  const params = await searchParams;
  const next = safeReturnPath(params.next);
  const session = await currentSession();
  if (!session) redirect(loginHref(next));

  // Asked from inside the desk (a second tab, components/helpdesk/desk/DuoDeskPrompt), or on the way to a desk page.
  const fromDesk = params.for === "desk";
  // scope=desk: on the way to a page outside /desk that shows desk-side data (lib/duo-policy duoStepHref).
  const deskScope = params.scope === "desk";
  const desk = fromDesk || deskScope || isDeskPath(next);
  const owed = session.duo.signIn || (desk && session.duo.desk);
  if (!owed && !fromDesk) redirect(next);

  const [raw, look, links] = await Promise.all([getAllSettings(), getSignInLook(), signInLinks()]);
  const settings = normalizeSettings(raw);
  if (look.art) {
    preload(look.art.src, { as: "image", imageSrcSet: look.art.srcSet, imageSizes: ART_SIZES, fetchPriority: "high" });
  }
  const shell = (children: React.ReactNode) => (
    <AuthShell look={look} company={settings.company_name} logoUrl={settings.logo_url || undefined} links={links}>
      {children}
    </AuthShell>
  );

  if (!owed) {
    return shell(
      <>
        <AuthHeading title="You're confirmed" subtitle="Duo approved it. You can close this tab and go back to your work." />
        <DuoStep done next="/desk" account={session.user.email || session.user.username} />
      </>
    );
  }

  const hours = duoSettingsFrom(raw).deskHours;
  const why = session.duo.signIn
    ? `${settings.company_name} asks for a Duo approval after you sign in.`
    : `The desk asks for a Duo approval every ${hours} ${hours === 1 ? "hour" : "hours"}.`;
  const problem = PROBLEMS.find((p) => p === params.e) ?? null;
  // Duo being down is a state of its own, with its own heading; the other problems are a line above the button.
  const down = problem === "unreachable";
  return shell(
    <>
      <AuthHeading
        title={down ? "Duo can't be reached" : "Confirm it's you"}
        subtitle={down ? "CompassDocs couldn't reach Duo, so it can't confirm it's you right now. Wait a minute, then try again." : why}
      />
      <DuoStep next={next} fromDesk={fromDesk} deskScope={deskScope} problem={problem} account={session.user.email || session.user.username} />
    </>
  );
}
