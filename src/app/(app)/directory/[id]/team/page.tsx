// A person's whole team: everyone below them in the org chart, level by
// level, with the chain above for context and an export of exactly these
// people.

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Network, Users } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getPersonById, listFields, listPeople } from "@/lib/directory";
import { buildOrgChart, chainAbove, managerField, teamBelow } from "@/lib/directory-org";
import { PageContainer } from "@/components/PageWidth";
import { EmptyState } from "@/components/form";
import { ChainLine, PersonTile } from "@/components/directory/TeamBlock";
import { ExportPeopleButtons } from "@/components/directory/ExportPeopleButtons";
import { peopleForViewer, personForViewer, viewerScope } from "@/lib/directory-viewer";

export const dynamic = "force-dynamic";

export default async function TeamPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const id = Number((await params).id);
  const stored = Number.isInteger(id) ? await getPersonById(id) : undefined;
  if (!stored || stored.hidden) notFound();
  const scope = await viewerScope(user, await listFields());
  const fields = scope.fields;
  const person = personForViewer(scope, stored);
  const people = peopleForViewer(scope, await listPeople());
  const mf = managerField(fields);
  const chart = mf ? buildOrgChart(people, fields) : null;
  const chain = chart ? chainAbove(chart, id) : [];
  const levels = chart ? teamBelow(chart, id) : [];
  const total = levels.reduce((n, l) => n + l.people.length, 0);
  const first = person.name.split(" ")[0];
  const levelLabel = (level: number) =>
    level === 1 ? (mf?.inverse_label || "Direct reports") : level === 2 ? "Their reports" : `${level} levels down`;

  return (
    <PageContainer>
      <Link href={`/directory/${person.id}`} className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-600">
        <ArrowLeft className="h-3.5 w-3.5" /> {person.name}
      </Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900">
            <Users className="h-6 w-6 text-compass-600" aria-hidden /> {first}&rsquo;s team
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {total === 0
              ? `Nobody reports to ${person.name} in the directory.`
              : `${total} ${total === 1 ? "person" : "people"} across ${levels.length} ${levels.length === 1 ? "level" : "levels"}, from the org chart.`}
          </p>
          {chain.length > 0 && (
            <div className="mt-2">
              <ChainLine chain={[person, ...chain]} label="Reporting line" />
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-2">
          <Link href={`/directory?view=org&focus=${person.id}`} className="inline-flex items-center gap-1.5 text-sm font-medium text-compass-600 hover:underline">
            <Network className="h-4 w-4" aria-hidden /> Open in org chart
          </Link>
          {total > 0 && <ExportPeopleButtons ids={[person.id, ...levels.flatMap((l) => l.people.map((p) => p.id))]} title={`${person.name} — team`} />}
        </div>
      </div>

      {!mf ? (
        <EmptyState icon={<Network />} title="No org chart yet" body="The directory has no Reports to field. An admin can add it under Settings → Directory → Fields." />
      ) : total === 0 ? (
        <EmptyState icon={<Users />} title="No reports" body={`Nobody lists ${person.name} as the person they report to.`} />
      ) : (
        <div className="space-y-6">
          {levels.map((l) => (
            <section key={l.level}>
              <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
                {levelLabel(l.level)} <span className="text-xs font-normal text-slate-400">({l.people.length})</span>
              </h2>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {l.people.map((p) => (
                  <PersonTile key={p.id} p={p} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </PageContainer>
  );
}
