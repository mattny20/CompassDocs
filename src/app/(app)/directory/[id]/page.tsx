import Link from "next/link";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { Mail, Phone, Smartphone, MapPin, UserRound, Users, FileText, Building2, CalendarDays } from "lucide-react";
import { BackLink } from "@/components/BackLink";
import { requireUser } from "@/lib/auth";
import { getPersonById, listFields, listPeople, personPhotoLarge } from "@/lib/directory";
import { buildOrgChart, chainAbove, managerField, peersOf, teamBelow } from "@/lib/directory-org";
import { TeamBlock } from "@/components/directory/TeamBlock";
import { peopleForViewer, personForViewer, viewerScope } from "@/lib/directory-viewer";
import { PresenceBadge } from "@/components/directory/Presence";
import { getDirectoryGraphConfig } from "@/lib/directory-config";
import { eePresent, featureEnabled } from "@/lib/ee";
import { getOfficeConfig } from "@/lib/directory-offices-store";
import { officeBlock, officeKeyOf, officeProfileFor } from "@/lib/directory-offices";
import { listDocumentsByAuthor, listLinkedUserNames, getSetting } from "@/lib/db";
import { getAppSettings } from "@/lib/settings-store";
import { canSeeDrafts, spaceScopeFor } from "@/lib/access";
import { DocCard } from "@/components/DocCard";
import { FieldChips } from "@/components/TagBadges";
import { EmptyState } from "@/components/form";
import { PageContainer } from "@/components/PageWidth";
import { displayValue, initialsOf, formatDateValue, parseDateValue } from "@/lib/directory-display";
import { buildVCard } from "@/lib/vcard";
import { ProfileActions } from "@/components/directory/ProfileActions";

import type { Metadata } from "next";
import { cachedPerson } from "@/lib/page-data";
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const id = Number((await params).id);
  const person = Number.isInteger(id) ? await cachedPerson(id).catch(() => undefined) : undefined;
  return { title: person?.name ? `${person.name}` : "Person" };
}

export default async function PersonProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const id = Number((await params).id);
  const stored = Number.isInteger(id) ? await cachedPerson(id) : undefined;
  if (!stored || stored.hidden) notFound();
  const scope = await viewerScope(user, await listFields());
  const person = personForViewer(scope, stored);

  const spaces = await spaceScopeFor(user);
  const isEditor = await canSeeDrafts(user);
  const aliases = [...new Set([person.name, ...(await listLinkedUserNames(person.id))])];
  const [docs, offices, settings, domain, large, allPeople] = await Promise.all([
    listDocumentsByAuthor(aliases, isEditor, spaces),
    getOfficeConfig(),
    getAppSettings(),
    getSetting("custom_domain"),
    personPhotoLarge(person.id),
    listPeople(),
  ]);
  const fields = scope.fields;
  const everyone = peopleForViewer(scope, allPeople);
  // Where they sit in the org chart, when the directory has one.
  const mf = managerField(fields);
  const chart = mf ? buildOrgChart(everyone, fields) : null;
  const chain = chart ? chainAbove(chart, person.id) : [];
  const teamLevels = chart ? teamBelow(chart, person.id) : [];
  const reports = teamLevels[0]?.people ?? [];
  const teamSize = teamLevels.reduce((n, l) => n + l.people.length, 0);
  const peers = chart ? peersOf(chart, person.id) : [];
  const officeField = fields.find((f) => f.key === "office");
  const office = officeField ? displayValue(officeField, person.office) : person.office;
  const profile = officeProfileFor(offices, officeKeyOf(person.office, officeField));
  const block = profile ? officeBlock(profile, offices.fields, officeField) : null;
  const pick = (re: RegExp) => block?.rows.find((r) => re.test(r.label))?.value;

  // Custom values, with option labels applied; people fields render from links.
  const custom = fields
    .filter((f) => !f.builtin && f.kind !== "people")
    .map((f) => ({ field: f, value: person.custom?.[f.key] ?? "" }))
    .filter((f) => f.value);
  // The manager field renders as the Team block below, not as a line here.
  const peopleFields = fields.filter((f) => f.kind === "people" && !(mf && f.key === mf.key));
  const startField = fields.find((f) => f.kind === "date" && f.date_role === "start");
  const start = startField ? parseDateValue(person.custom?.[startField.key] ?? "") : null;
  const tenure = start && start.y ? tenureLabel(start.y, start.m, start.d) : "";

  // The QR code carries the card itself (no photo — it would not scan), so a
  // phone camera adds the contact with no app and no account.
  const origin = domain?.trim() ? `https://${domain.trim()}` : "";
  const qrCard = buildVCard({
    person,
    fields,
    company: settings.company_name || "",
    profileUrl: origin ? `${origin}/directory/${person.id}` : "",
    office: block ? { name: block.name, address: pick(/address/i), phone: pick(/main|phone|line/i), fax: pick(/fax/i) } : null,
    photo: false,
  });
  const qr = await QRCode.toDataURL(qrCard, { margin: 1, width: 220, errorCorrectionLevel: "M" }).catch(() => "");
  const photoUrl = person.photo ? `/api/directory/${person.id}/photo?size=large&v=${Math.floor((Date.parse(person.updated_at) || 0) / 1000)}` : "";
  const isMicrosoft = person.source === "graph";
  const presence = isMicrosoft && eePresent() && (await featureEnabled("directory_sync")) && (await getDirectoryGraphConfig()).presence;

  return (
    <PageContainer>
      <BackLink href="/directory" label="Directory" />

      <div className="rounded-xl border border-slate-200 bg-surface p-6 shadow-xs">
        <div className="flex flex-wrap items-start gap-5">
          {photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={photoUrl}
              alt=""
              width={large ? 120 : 80}
              height={large ? 120 : 80}
              className={`${large ? "h-28 w-28" : "h-20 w-20"} rounded-full object-cover ring-2 ring-slate-100`}
            />
          ) : (
            <div className="grid h-28 w-28 place-items-center rounded-full bg-compass-100 text-3xl font-semibold text-compass-700">
              {initialsOf(person.name)}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h1 className="flex flex-wrap items-center gap-2 text-2xl font-bold text-slate-900">
                  {person.name}
                  {presence && <PresenceBadge personId={person.id} enabled name={person.name} />}
                </h1>
                <p className="text-slate-500">
                  {[person.title, person.department].filter(Boolean).join(" · ") || "—"}
                </p>
              </div>
              <ProfileActions
                personId={person.id}
                name={person.name}
                email={person.email}
                microsoft={isMicrosoft}
                qr={qr}
              />
            </div>
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
              {tenure && (
                <span className="inline-flex items-center gap-1.5 text-slate-500" data-tt={`Started ${formatDateValue(person.custom?.[startField!.key] ?? "")}`}>
                  <CalendarDays className="h-3.5 w-3.5" /> {tenure}
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
                    <dt className="shrink-0 text-slate-500">{field.label}:</dt>
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

        {mf && (
          <TeamBlock
            person={person}
            chain={chain}
            reports={reports}
            teamSize={teamSize}
            peers={peers}
            labels={{ manager: mf.label, reports: mf.inverse_label || "Direct reports" }}
          />
        )}

        {block && block.rows.length > 0 && (
          <div className="mt-5 rounded-lg border border-slate-100 bg-slate-50 p-4">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">
              <Building2 className="h-3.5 w-3.5 text-compass-600" aria-hidden /> {block.name} office
            </p>
            <dl className="grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
              {block.rows.map((r) => (
                <div key={r.label} className={`flex gap-2 ${r.multiline ? "sm:col-span-2" : ""}`}>
                  <dt className="shrink-0 text-slate-500">{r.label}:</dt>
                  <dd className="whitespace-pre-line text-slate-700">{r.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>

      <h2 className="mb-3 mt-8 text-xs font-semibold uppercase tracking-wider text-slate-500">
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

/** "Since May 2020 · 6 years" — or "Started this month" for a new hire. */
function tenureLabel(y: number, m: number, d: number): string {
  const now = new Date();
  const months = (now.getFullYear() - y) * 12 + (now.getMonth() + 1 - m) - (now.getDate() < d ? 1 : 0);
  if (months < 0) return "";
  const since = `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${y}`;
  if (months < 1) return "Started this month";
  const years = Math.floor(months / 12);
  return years >= 1 ? `Since ${since} · ${years} ${years === 1 ? "year" : "years"}` : `Since ${since} · ${months} ${months === 1 ? "month" : "months"}`;
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
