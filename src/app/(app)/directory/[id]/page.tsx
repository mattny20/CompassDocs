import Link from "next/link";
import { notFound } from "next/navigation";
import { Mail, Phone, Smartphone, MapPin, UserRound, ArrowLeft } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getPersonById, listFields } from "@/lib/directory";
import { listDocumentsByAuthor, listLinkedUserNames } from "@/lib/db";
import { spaceScopeFor } from "@/lib/access";
import { roleAtLeast } from "@/lib/types";
import { DocCard } from "@/components/DocCard";
import { PageContainer } from "@/components/PageWidth";

export const dynamic = "force-dynamic";

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

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
  const isEditor = roleAtLeast(user.role, "editor");
  const aliases = [...new Set([person.name, ...(await listLinkedUserNames(person.id))])];
  const [docs, fields] = await Promise.all([
    listDocumentsByAuthor(aliases, isEditor, scope),
    listFields(),
  ]);
  const custom = fields
    .map((f) => ({ label: f.label, value: (person.custom as Record<string, string>)?.[f.key] }))
    .filter((f) => f.value);

  return (
    <PageContainer>
      <Link
        href="/directory"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-600"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Directory
      </Link>

      <div className="rounded-xl border border-slate-200 bg-surface p-6 shadow-sm">
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
              {initials(person.name)}
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
              {person.office && (
                <span className="inline-flex items-center gap-1.5 text-slate-600">
                  <MapPin className="h-3.5 w-3.5" /> {person.office}
                </span>
              )}
              {person.assistant_name && (
                <span className="inline-flex items-center gap-1.5 text-slate-600">
                  <UserRound className="h-3.5 w-3.5" /> Assistant: {person.assistant_name}
                </span>
              )}
            </div>
            {custom.length > 0 && (
              <dl className="mt-3 grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
                {custom.map((f) => (
                  <div key={f.label} className="flex gap-2">
                    <dt className="text-slate-400">{f.label}:</dt>
                    <dd className="text-slate-700">{f.value}</dd>
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
        <p className="rounded-xl border border-dashed border-slate-200 bg-surface p-8 text-center text-sm text-slate-400">
          No documents credited to {person.name} yet (in the spaces you can see).
        </p>
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
