import type { ReactNode } from "react";
import { ShieldCheck } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { canAccessSection } from "@/lib/section-access";
import { userHolds } from "@/lib/access";
import { PageContainer } from "@/components/PageWidth";
import { PageHeader } from "@/components/PageHeader";
import { EnterpriseBadge } from "@/components/Chip";
import { ComplianceSubNav } from "./ComplianceSubNav";

export const dynamic = "force-dynamic";

// The Compliance section (B4, 1.12.0): one header and one sub-navigation
// row over My policies (everyone the sidebar shows the section to), the
// portal's Overview, Policies and People (compliance.program_read, each
// page answering notFound() without it, as /training/person does) and
// Settings (E4's own guard: the section and compliance.program_manage).
// The row lists only the tabs the viewer may open. The subtitle is the
// portal's documented sentence for someone who runs the programme and the
// reader's own for everyone else.

export default async function ComplianceLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const section = await canAccessSection(user, "compliance");
  const settings = section && (await userHolds(user, "compliance.program_manage", { legacyMin: "admin" }));
  return (
    <PageContainer>
      <PageHeader
        icon={<ShieldCheck />}
        title={
          <>
            Compliance <EnterpriseBadge />
          </>
        }
        subtitle={
          section
            ? "Read-confirmation progress across every policy: who has confirmed what, and who still owes a confirmation."
            : "The policies you are asked to read and confirm, and where you stand on each."
        }
        className="mb-5"
      />
      <ComplianceSubNav section={section} settings={settings} />
      {children}
    </PageContainer>
  );
}
