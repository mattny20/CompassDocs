import { redirect } from "next/navigation";
import { preload } from "react-dom";
import { requireUser } from "@/lib/auth";
import { getAppSettings } from "@/lib/settings-store";
import { getSignInLook } from "@/lib/sign-in-art";
import { ART_SIZES } from "@/lib/sign-in-text";
import { AuthShell } from "@/components/auth/AuthShell";
import { AuthHeading } from "@/components/auth/AuthHeading";
import { ChangePasswordForm } from "@/components/ChangePasswordForm";
import { safeReturnPath } from "@/lib/return-to";

export const dynamic = "force-dynamic";
export const metadata = { title: "Set a new password", robots: { index: false, follow: false } };

// The forced first-login / admin-reset flow. Routine password changes live
// in Account → Security, so anyone who is not forced is sent there — this
// page has exactly one job. It wears the sign-in shell (1.16.0, STYLEGUIDE
// §Sign-in surfaces): it is the second half of signing in.
export default async function ChangePasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const user = await requireUser();
  if (!user.must_change_password) redirect("/account/security");
  // Where sign-in was headed before the forced change interrupted it.
  const next = safeReturnPath((await searchParams).next);
  const [settings, look] = await Promise.all([getAppSettings(), getSignInLook()]);
  if (look.art) {
    preload(look.art.src, { as: "image", imageSrcSet: look.art.srcSet, imageSizes: ART_SIZES, fetchPriority: "high" });
  }

  return (
    <AuthShell look={look} company={settings.company_name} logoUrl={settings.logo_url || undefined}>
      <AuthHeading title="Set a new password" subtitle={`Choose a new password to continue to ${settings.company_name}.`} />
      <ChangePasswordForm forced next={next} account={user.username} />
    </AuthShell>
  );
}
