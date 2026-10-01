// The dashboard's route skeleton. The page lives in its own route group so
// this file covers only "/": a loading.tsx at (app)/ would also flash under
// /admin, where a permission redirect would replace it a moment later.
import { DashboardSkeleton } from "@/components/Skeleton";

export default function Loading() {
  return <DashboardSkeleton />;
}
