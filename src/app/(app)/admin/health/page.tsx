import Link from "next/link";
import { knowledgeHealthReport, type HealthDoc } from "@/lib/health";

export const dynamic = "force-dynamic";

// Content health: where the knowledge base is quietly rotting — broken links,
// orphans, overdue and stale docs, unread docs, likely duplicates, and
// documents with no active owner. Computed on demand from existing signals.
export default async function HealthPage() {
  const r = await knowledgeHealthReport();

  const sections: {
    key: string;
    title: string;
    blurb: string;
    count: number;
    empty: string;
  }[] = [
    {
      key: "broken",
      title: "Broken internal links",
      blurb: "Documents linking to a page that no longer exists — readers hit a dead end.",
      count: r.broken_links.length,
      empty: "No broken /doc links found.",
    },
    {
      key: "overdue",
      title: "Overdue reviews",
      blurb: "The review cycle says these are due and nobody has re-reviewed them yet.",
      count: r.overdue_reviews.length,
      empty: "Nothing is overdue for review.",
    },
    {
      key: "stale",
      title: "Stale documents",
      blurb: "Published, unedited for 180+ days, and on no review cycle — no one is scheduled to notice if they're wrong.",
      count: r.stale.length,
      empty: "No stale documents.",
    },
    {
      key: "orphans",
      title: "Orphaned documents",
      blurb: "Published pages nothing links to — no backlinks, relations, or page tree. Only browsing finds them.",
      count: r.orphans.length,
      empty: "Every published document is linked from somewhere.",
    },
    {
      key: "unread",
      title: "Unread documents",
      blurb: "Published over a month ago with zero views in the last 90 days.",
      count: r.unread.length,
      empty: "Everything published has recent readers.",
    },
    {
      key: "dups",
      title: "Possible duplicates",
      blurb: r.duplicates_checked
        ? "Document pairs whose openings are near-identical by embedding similarity — candidates to merge."
        : "Needs semantic search (pgvector + an embedding provider under Settings → AI) to run.",
      count: r.duplicates.length,
      empty: r.duplicates_checked ? "No near-duplicate pairs found." : "Not checked.",
    },
    {
      key: "lowrated",
      title: "Poorly rated",
      blurb: "Readers voted: three or more votes and mostly \u201cnot helpful.\u201d",
      count: r.low_rated.length,
      empty: "Nothing is rated poorly.",
    },
    {
      key: "ownerless",
      title: "No active owner",
      blurb: "The author is no longer an active user — nobody obvious to ask when these need updating.",
      count: r.ownerless.length,
      empty: "Every published document's author is still active.",
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">Content health</h2>
        <p className="mt-1 text-sm text-slate-500">
          {r.totals.published} published of {r.totals.documents} documents. Signals refresh every
          time you open this page.
        </p>
      </div>

      {/* Scorecards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
        {sections.map((s) => (
          <a
            key={s.key}
            href={`#${s.key}`}
            className={`rounded-xl border p-3 text-center shadow-xs ${
              s.count > 0 ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-surface"
            }`}
          >
            <div className={`text-2xl font-bold ${s.count > 0 ? "text-amber-700" : "text-slate-400"}`}>
              {s.key === "dups" && !r.duplicates_checked ? "—" : s.count}
            </div>
            {/* Amber tiles keep light backgrounds in dark mode, so the label
                must use a static amber ink there rather than themed slate. */}
            <div
              className={`mt-1 text-[11px] font-medium leading-tight ${
                s.count > 0 ? "text-amber-800" : "text-slate-600"
              }`}
            >
              {s.title}
            </div>
          </a>
        ))}
      </div>

      <Section id="broken" title="Broken internal links" blurb={sections[0].blurb} empty={sections[0].empty} count={r.broken_links.length}>
        {r.broken_links.map((b) => (
          <Row key={b.from.id} doc={b.from}>
            <span className="text-xs text-red-600">
              → missing doc {b.missing_ids.map((id) => `#${id}`).join(", ")}
            </span>
          </Row>
        ))}
      </Section>

      <Section id="overdue" title="Overdue reviews" blurb={sections[1].blurb} empty={sections[1].empty} count={r.overdue_reviews.length}>
        {r.overdue_reviews.map((d) => (
          <Row key={d.id} doc={d} />
        ))}
      </Section>

      <Section id="stale" title="Stale documents" blurb={sections[2].blurb} empty={sections[2].empty} count={r.stale.length}>
        {r.stale.map((d) => (
          <Row key={d.id} doc={d} />
        ))}
      </Section>

      <Section id="orphans" title="Orphaned documents" blurb={sections[3].blurb} empty={sections[3].empty} count={r.orphans.length}>
        {r.orphans.map((d) => (
          <Row key={d.id} doc={d} />
        ))}
      </Section>

      <Section id="unread" title="Unread documents" blurb={sections[4].blurb} empty={sections[4].empty} count={r.unread.length}>
        {r.unread.map((d) => (
          <Row key={d.id} doc={d} />
        ))}
      </Section>

      <Section id="dups" title="Possible duplicates" blurb={sections[5].blurb} empty={sections[5].empty} count={r.duplicates.length}>
        {r.duplicates.map((p) => (
          <div key={`${p.a.id}-${p.b.id}`} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
            <DocLink doc={p.a} />
            <span className="text-slate-400">≈</span>
            <DocLink doc={p.b} />
            <span className="ml-auto rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
              {(p.similarity * 100).toFixed(1)}%
            </span>
          </div>
        ))}
      </Section>

      <Section id="lowrated" title="Poorly rated" blurb={sections[6].blurb} empty={sections[6].empty} count={r.low_rated.length}>
        {r.low_rated.map((d) => (
          <div key={d.id}>
            <Row doc={d}>
              <span className="text-xs text-slate-500">
                {d.up} helpful / {d.down} not
              </span>
            </Row>
            {d.notes.length > 0 && (
              <ul className="px-4 pb-2 pl-8 text-xs text-slate-500">
                {d.notes.map((n, i) => (
                  <li key={i} className="list-disc">&ldquo;{n}&rdquo;</li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </Section>

      <Section id="ownerless" title="No active owner" blurb={sections[7].blurb} empty={sections[7].empty} count={r.ownerless.length}>
        {r.ownerless.map((d) => (
          <Row key={d.id} doc={d}>
            <span className="text-xs text-slate-500">author: {d.author || "(none)"}</span>
          </Row>
        ))}
      </Section>
    </div>
  );
}

function Section({
  id,
  title,
  blurb,
  empty,
  count,
  children,
}: {
  id: string;
  title: string;
  blurb: string;
  empty: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="rounded-xl border border-slate-200 bg-surface shadow-xs">
      <div className="border-b border-slate-100 px-4 py-3">
        <h3 className="font-semibold text-slate-900">
          {title}
          {count > 0 && (
            <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
              {count}
            </span>
          )}
        </h3>
        <p className="mt-0.5 text-xs text-slate-500">{blurb}</p>
      </div>
      {count === 0 ? (
        <p className="px-4 py-3 text-sm text-slate-500">{empty}</p>
      ) : (
        <div className="divide-y divide-slate-50">{children}</div>
      )}
    </section>
  );
}

function DocLink({ doc }: { doc: HealthDoc }) {
  return (
    <Link href={`/doc/${doc.id}`} className="font-medium text-compass-700 hover:underline">
      {doc.title}
    </Link>
  );
}

function Row({ doc, children }: { doc: HealthDoc; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
      <DocLink doc={doc} />
      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
        {doc.space_name}
      </span>
      {doc.status !== "published" && (
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">{doc.status}</span>
      )}
      {children}
      <span className="ml-auto text-xs text-slate-500">updated {doc.updated_at}</span>
    </div>
  );
}
