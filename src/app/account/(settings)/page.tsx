import { requireUser } from "@/lib/auth";
import { getUserById } from "@/lib/db";
import { ProfileForm } from "@/components/ProfileForm";

export const dynamic = "force-dynamic";

const PROVIDER_LABEL: Record<string, string> = {
  saml: "your single sign-on provider",
  scim: "your identity provider",
};

export default async function ProfilePage() {
  const user = await requireUser();
  const me = await getUserById(user.id);
  const provider = me?.auth_provider ?? "local";

  return (
    <section>
      <h2 className="mb-1 font-semibold text-slate-900">Profile</h2>
      <p className="mb-3 text-sm text-slate-500">Who you are across the workspace.</p>
      <ProfileForm
        initialName={me?.name ?? ""}
        initialEmail={me?.email ?? ""}
        initialAvatar={me?.avatar ?? ""}
        username={user.username}
        managed={provider !== "local"}
        providerLabel={PROVIDER_LABEL[provider] ?? "your identity provider"}
      />
    </section>
  );
}
