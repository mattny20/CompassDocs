// The dashboard's route skeleton. The page lives in its own route group so
// this file covers only "/": a loading.tsx at (app)/ would also flash under
// /admin, where a permission redirect would replace it a moment later.
//
// The 1.17.0 shape (STYLEGUIDE §Dashboard tiles): greeting and Ask, the
// status strip, then the tile columns, split where the page splits them
// (a 56rem content column) so nothing jumps when the page arrives. No real
// heading inside: the login helper and every spec wait on the real h1.
import { PageContainer } from "@/components/PageWidth";
import { Skeleton } from "@/components/Skeleton";

function Tile({ rows, h = "h-4" }: { rows: number; h?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
      <Skeleton className="h-5 w-40" />
      <div className="mt-4 space-y-3.5">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-7 w-7 shrink-0 rounded-lg" />
            <Skeleton className={`${h} flex-1`} />
            <Skeleton className="h-3 w-12 shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Loading() {
  return (
    <PageContainer>
      <div role="status" aria-label="Loading the dashboard">
        <span className="sr-only">Loading the dashboard</span>
        <div aria-hidden>
          <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <Skeleton className="h-8 w-72" />
              <Skeleton className="mt-2 h-4 w-56" />
            </div>
            <Skeleton className="h-12 w-full rounded-xl sm:w-96" />
          </div>
          <Skeleton className="mb-6 h-10 w-full rounded-xl" />
          <div className="@container">
            <div className="flex flex-col gap-6 @4xl:flex-row @4xl:items-start">
              <div className="flex min-w-0 flex-1 flex-col gap-6">
                <Tile rows={8} />
                <Tile rows={5} />
              </div>
              <div className="flex min-w-0 flex-col gap-6 @4xl:w-[19rem] @4xl:shrink-0">
                <Tile rows={6} />
                <Tile rows={4} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
