import { requireUser } from "@/lib/auth";
import { canAccessSection } from "@/lib/section-access";
import { featureEnabled } from "@/lib/ee";
import { TrainingPanel } from "@/components/TrainingPanel";
import { PageContainer } from "@/components/PageWidth";

export const dynamic = "force-dynamic";

// Training home: everyone sees their own assignments; admins plus anyone
// granted the Training section (Settings → Section access) also get the
// deck builder and the progress dashboard.

export default async function TrainingPage() {
  const user = await requireUser();
  const [licensed, manager] = await Promise.all([
    featureEnabled("training"),
    canAccessSection(user, "training"),
  ]);
  return (
    <PageContainer>
      <TrainingPanel licensed={licensed} manager={manager} />
    </PageContainer>
  );
}
