import "server-only";

// Every exported person as one .vcf — what "Export → Contacts" hands a phone
// or Outlook to import in one go. Same filter, sort and sections as the PDF
// (prepareExport), so the cards arrive in the order the sheet reads.

import type { ExportPreset } from "./directory-export-config";
import type { DirectoryField, DirectoryPerson } from "./directory";
import { prepareExport } from "./directory-export";
import { getOfficeConfig } from "./directory-offices-store";
import { officeBlock, officeKeyOf, officeProfileFor } from "./directory-offices";
import { personPhotoLarge } from "./directory";
import { buildVCard } from "./vcard";

export async function renderDirectoryVcf(input: {
  preset: ExportPreset;
  people: DirectoryPerson[];
  fields: DirectoryField[];
  company: string;
  origin: string;
}): Promise<string> {
  const prepared = prepareExport(input);
  const offices = await getOfficeConfig();
  const officeField = input.fields.find((f) => f.key === "office");
  const blocks = new Map<string, ReturnType<typeof officeBlock>>();
  const cards: string[] = [];
  // One card per person, where their own value puts them: a section's head
  // rows (the first `heads` of its rows) are skipped when the person also
  // prints as an ordinary row elsewhere, so the file is the one it was
  // before sections had heads. A head who sits in the section they head
  // prints only as its head row, and keeps that one.
  const own = new Set<number>();
  for (const s of prepared.sections) s.rows.slice(s.heads.length).forEach((p) => own.add(p.id));
  for (const s of prepared.sections) {
    for (const [i, p] of s.rows.entries()) {
      if (i < s.heads.length && own.has(p.id)) continue;
      const key = officeKeyOf(p.office, officeField).toLowerCase();
      let block = blocks.get(key);
      if (block === undefined && key) {
        const profile = officeProfileFor(offices, key);
        block = profile ? officeBlock(profile, offices.fields, officeField) : undefined;
        if (block) blocks.set(key, block);
      }
      const pick = (re: RegExp) => block?.rows.find((r) => re.test(r.label))?.value;
      cards.push(
        buildVCard({
          person: { ...p, photo_large: input.preset.photos ? await personPhotoLarge(p.id) : "" },
          fields: input.fields,
          company: input.company,
          profileUrl: input.origin ? `${input.origin}/directory/${p.id}` : "",
          office: block ? { name: block.name, address: pick(/address/i), phone: pick(/main|phone|line/i), fax: pick(/fax/i) } : null,
          photo: input.preset.photos,
        })
      );
    }
  }
  return cards.join("");
}
