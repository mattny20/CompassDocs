import { UserRound } from "lucide-react";
import { AccountNav } from "@/components/AccountNav";
import { PageContainer } from "@/components/PageWidth";
import { RAIL_GROUP_TEXT } from "@/components/RailLink";

export const dynamic = "force-dynamic";

// The account settings pages live inside the app shell (1.5.2): the sidebar,
// palette, toasts and width preference all stay, and the frame is the same
// as the settings console — an eyebrow, a rail, one section at a time. The
// (app) layout already signs the user in and sends a forced password change
// to /account/password, which stays standalone so it keeps its focus.
export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return (
    <PageContainer>
      <p className={`mb-4 flex items-center gap-1.5 ${RAIL_GROUP_TEXT}`}>
        <UserRound className="h-3.5 w-3.5" aria-hidden /> Account
      </p>
      <div className="flex flex-col gap-6 sm:flex-row sm:gap-8">
        <div className="shrink-0 sm:sticky sm:top-6 sm:self-start">
          <AccountNav />
        </div>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </PageContainer>
  );
}
