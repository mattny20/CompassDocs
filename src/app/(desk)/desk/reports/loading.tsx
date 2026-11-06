// /desk/reports while the page loads (STYLEGUIDE §Loading): the header and
// the widget grid's shape, no real heading.

import { Skeleton } from "@/components/Skeleton";
import { PageContainer } from "@/components/PageWidth";

export default function Loading() {
  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <PageContainer>
        <div role="status" aria-label="Loading reports">
          <span className="sr-only">Loading reports</span>
          <div aria-hidden>
            <div className="mb-6">
              <Skeleton className="h-7 w-48" />
              <Skeleton className="mt-2 h-4 w-96 max-w-full" />
            </div>
            <Skeleton className="mb-5 h-9 w-full max-w-xl" />
            <div className="@container">
              <div className="grid grid-cols-2 gap-3 @2xl:gap-4 @5xl:grid-cols-4">
                {[1, 1, 1, 1, 2, 2].map((s, i) => (
                  <Skeleton key={i} className={`rounded-xl ${s === 2 ? "h-64 col-span-2" : "h-36"}`} />
                ))}
              </div>
            </div>
          </div>
        </div>
      </PageContainer>
    </div>
  );
}
