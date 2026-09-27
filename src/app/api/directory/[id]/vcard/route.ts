// One person's contact card (.vcf) — any signed-in user who can read the
// directory. The card carries what the profile shows plus the office's
// address and main line, so a phone gets the whole picture in one tap.

import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { getSetting } from "@/lib/db";
import { getPersonById, listFields } from "@/lib/directory";
import { getOfficeConfig } from "@/lib/directory-offices-store";
import { officeBlock, officeKeyOf, officeProfileFor } from "@/lib/directory-offices";
import { getAppSettings } from "@/lib/settings-store";
import { buildVCard, vcardFilename } from "@/lib/vcard";
import { personPhotoLarge } from "@/lib/directory";
import { personForViewer, viewerScope } from "@/lib/directory-viewer";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("viewer", "directory.read");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  const personId = Number(id);
  const stored = Number.isInteger(personId) ? await getPersonById(personId) : undefined;
  if (!stored || stored.hidden) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const [allFields, offices, settings, domain, large] = await Promise.all([
    listFields(),
    getOfficeConfig(),
    getAppSettings(),
    getSetting("custom_domain"),
    personPhotoLarge(personId),
  ]);
  // The card carries only what this viewer may see on the profile.
  const scope = await viewerScope(gate, allFields);
  const fields = scope.fields;
  const person = personForViewer(scope, stored);
  const officeField = fields.find((f) => f.key === "office");
  const profile = officeProfileFor(offices, officeKeyOf(person.office, officeField));
  const block = profile ? officeBlock(profile, offices.fields, officeField) : null;
  const pick = (labelRe: RegExp) => block?.rows.find((r) => labelRe.test(r.label))?.value;
  const origin = domain?.trim() ? `https://${domain.trim()}` : new URL(req.url).origin;
  const withPhoto = new URL(req.url).searchParams.get("photo") !== "0";

  const text = buildVCard({
    person: { ...person, photo_large: large },
    fields,
    company: settings.company_name || "",
    profileUrl: `${origin}/directory/${person.id}`,
    office: block ? { name: block.name, address: pick(/address/i), phone: pick(/main|phone|line/i), fax: pick(/fax/i) } : null,
    photo: withPhoto,
  });
  return new Response(text, {
    headers: {
      "Content-Type": "text/vcard; charset=utf-8",
      "Content-Disposition": `attachment; filename="${vcardFilename(person.name)}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
