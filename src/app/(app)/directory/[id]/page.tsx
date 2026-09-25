import Link from "next/link";
import { notFound } from "next/navigation";
import { Mail, Phone, Smartphone, MapPin, UserRound, Users, ArrowLeft, FileText } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getPersonById, listFields } from "@/lib/directory";
import { listDocumentsByAuthor, listLinkedUserNames } from "@/lib/db";
import { canSeeDrafts, spaceScopeFor } from "@/lib/access";
import { DocCard } from "@/components/DocCard";
import { FieldChips } from "@/components/TagBadges";
import { EmptyState } from "@/components/form";
import { PageContainer } from "@/components/PageWidth";
import { displayValue, initialsOf } from "@/lib/directory-display";

export const dynamic = "force-dynamic";

export default async function PersonProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const id = Number((await params).id);
  const person = Number.isInteger(id) ? await getPersonById(id) : undefined;
  if (!person || person.hidden) notFound();

  const scope = await spaceScopeFor(user);
  const isEditor = await canSeeDrafts(user);
  const aliases = [...new Set([person.name, ...(await listLinkedUserNames(person.id))])];
  const [docs, fields] = await Promise.all([
    listDocumentsByAuthor(aliases, isEditor, scope),
    listFields(),
  ]);
  const officeField = fields.find((f) => f.key === "office");
  const office = officeField ? displayValue(officeField, person.office) : person.office;

  // Custom values, with option labels applied; people fields render from links.
  const custom = fields
    .filter((f) => !f.builtin && f.kind !== "people")
    .map((f) => ({ field: f, value: person.custom?.[f.key] ?? "" }))
    .filter((f) => f.value);
  const peopleFields = fields.filter((f) => f.kind === "people");

  return (
    <PageContainer>
      <Link
        href="/directory"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-600"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Directory
      </Link>

      <div className="rounded-xl border border-slate-200 bg-surface p-6 shadow-xs">
        <div className="flex flex-wrap items-start gap-5">
          {person.photo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={person.photo}
              alt=""
              className="h-20 w-20 rounded-full object-cover ring-2 ring-slate-100"
            />
          ) : (
            <div className="grid h-20 w-20 place-items-center rounded-full bg-compass-100 text-2xl font-semibold text-compass-700">
              {initialsOf(person.name)}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold text-slate-900">{person.name}</h1>
            <p className="text-slate-500">
              {[person.title, person.department].filter(Boolean).join(" · ") || "—"}
            </p>
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
              {person.email && (
                <a href={`mailto:${person.email}`} className="inline-flex items-center gap-1.5 text-compass-700 hover:underline">
                  <Mail className="h-3.5 w-3.5" /> {person.email}
                </a>
              )}
              {person.phone && (
                <a href={`tel:${person.phone}`} className="inline-flex items-center gap-1.5 text-slate-600 hover:underline">
                  <Phone className="h-3.5 w-3.5" /> {person.phone}
                </a>
              )}
              {person.mobile && (
                <a href={`tel:${person.mobile}`} className="inline-flex items-center gap-1.5 text-slate-600 hover:underline">
                  <Smartphone className="h-3.5 w-3.5" /> {person.mobile}
                </a>
              )}
              {office && (
                <span className="inline-flex items-center gap-1.5 text-slate-600">
                  <MapPin className="h-3.5 w-3.5" /> {office}
                </span>
              )}
            </div>

            {/* People fields, both directions: "Assistant: Dana" on the
                attorney, "Assists: Amy, Bob" on Dana. */}
            {peopleFields.some((f) => (person.links[f.key] ?? []).length || (person.linked_by[f.key] ?? []).length) && (
              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
                {peopleFields.map((f) => (
                  <PeopleLine key={`out-${f.key}`} icon={<UserRound className="h-3.5 w-3.5" />} label={f.label} refs={person.links[f.key] ?? []} />
                ))}
                {peopleFields.map((f) => (
                  <PeopleLine key={`in-${f.key}`} icon={<Users className="h-3.5 w-3.5" />} label={f.inverse_label || `${f.label} to`} refs={person.linked_by[f.key] ?? []} />
                ))}
              </div>
            )}

            {custom.length > 0 && (
              <dl className="mt-3 grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
                {custom.map(({ field, value }) => (
                  <div key={field.key} className="flex gap-2">
                    <dt className="shrink-0 text-slate-400">{field.label}:</dt>
                    <dd className="text-slate-700">
                      {field.display === "tag" ? (
                        <FieldChips field={field} value={value} size="md" />
                      ) : field.display === "phone" ? (
                        <a href={`tel:${value}`} className="hover:underline">{displayValue(field, value)}</a>
                      ) : (
                        displayValue(field, value)
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </div>
      </div>

      <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wide text-slate-400">
        Documents by {person.name.split(" ")[0]} ({docs.length})
      </h2>
      {docs.length === 0 ? (
        <EmptyState
          icon={<FileText />}
          title="No documents yet"
          body={`Nothing is credited to ${person.name} in the spaces you can see.`}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {docs.map((d) => (
            <DocCard key={d.id} doc={d} />
          ))}
        </div>
      )}
    </PageContainer>
  );
}

function PeopleLine({ icon, label, refs }: { icon: React.ReactNode; label: string; refs: { id: number; name: string }[] }) {
  if (refs.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-slate-600">
      {icon} {label}:{" "}
      {refs.map((r, i) => (
        <span key={r.id}>
          <Link href={`/directory/${r.id}`} className="font-medium text-compass-700 hover:underline">
            {r.name}
          </Link>
          {i < refs.length - 1 ? "," : ""}
        </span>
      ))}
    </span>
  );
}
