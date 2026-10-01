// Route skeletons (STYLEGUIDE §Loading): the shape of the page while its
// data loads, so a click shows something at once instead of nothing until
// the next page renders. No real heading inside — the login helper and
// every spec wait on the real h1 — and the whole block is one status
// message. Each skeleton sits in a PageContainer so it honours the width
// preference and nothing shifts when the page arrives. Server-safe.

import { PageContainer } from "./PageWidth";

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-slate-200/70 ${className}`} aria-hidden />;
}

function Frame({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <PageContainer>
      <div role="status" aria-label={label}>
        <span className="sr-only">{label}</span>
        <div aria-hidden>{children}</div>
      </div>
    </PageContainer>
  );
}

/** Title + subtitle, the top of every page. */
function Title() {
  return (
    <div className="mb-6">
      <Skeleton className="h-7 w-56" />
      <Skeleton className="mt-2 h-4 w-80" />
    </div>
  );
}

function CardRow({ n = 3, h = "h-24" }: { n?: number; h?: string }) {
  return (
    <div className="card-grid [--card-min:16rem] gap-3">
      {Array.from({ length: n }, (_, i) => (
        <Skeleton key={i} className={`${h} rounded-xl`} />
      ))}
    </div>
  );
}

function List({ n = 6 }: { n?: number }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-surface p-2 shadow-xs">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-3">
          <Skeleton className="h-5 w-5 rounded-full" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="ml-auto h-3 w-20" />
        </div>
      ))}
    </div>
  );
}

export function DashboardSkeleton() {
  return (
    <Frame label="Loading the dashboard">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Skeleton className="h-8 w-72" />
          <Skeleton className="mt-2 h-4 w-40" />
        </div>
        <Skeleton className="h-12 w-full rounded-xl sm:w-96" />
      </div>
      <Skeleton className="mb-3 h-5 w-48" />
      <CardRow n={3} />
      <Skeleton className="mb-3 mt-8 h-5 w-48" />
      <List n={5} />
    </Frame>
  );
}

export function SpaceSkeleton() {
  return (
    <Frame label="Loading the space">
      <div className="mb-6 flex items-center gap-4">
        <Skeleton className="h-12 w-12 rounded-xl" />
        <div>
          <Skeleton className="h-7 w-48" />
          <Skeleton className="mt-2 h-4 w-72" />
        </div>
      </div>
      <Skeleton className="mb-6 h-11 w-full rounded-xl" />
      <CardRow n={6} h="h-32" />
    </Frame>
  );
}

export function DirectorySkeleton() {
  return (
    <Frame label="Loading the directory">
      <Title />
      <Skeleton className="mb-4 h-10 w-full rounded-lg" />
      <div className="card-grid [--card-min:16rem] gap-3">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex gap-3 rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
            <Skeleton className="h-12 w-12 rounded-full" />
            <div className="flex-1">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="mt-2 h-3 w-1/2" />
              <Skeleton className="mt-3 h-3 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    </Frame>
  );
}

export function AnalyticsSkeleton() {
  return (
    <Frame label="Loading analytics">
      <Title />
      <div className="mb-5 flex gap-2">
        <Skeleton className="h-9 w-28 rounded-lg" />
        <Skeleton className="h-9 w-28 rounded-lg" />
        <Skeleton className="h-9 w-28 rounded-lg" />
      </div>
      <CardRow n={4} h="h-20" />
      <Skeleton className="mt-6 h-64 w-full rounded-xl" />
    </Frame>
  );
}
