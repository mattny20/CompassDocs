// Contact cards and dates — pure rules.
//
// Run: npm run test:integration (this file needs no DATABASE_URL).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildVCard, splitName, vcardEscape, vcardFilename } from "../src/lib/vcard";
import { formatDateValue, milestonesFor, parseDateValue, type FieldLike, type PersonLike } from "../src/lib/directory-display";

const field = (key: string, extra: Partial<FieldLike> = {}): FieldLike =>
  ({ key, label: key, kind: "text", multi: 0, builtin: 0, group_by: 0, options: [], value_format: "raw", display: "field", show_with: "", highlight: 0, inverse_label: "", show_in_card: 1, ...extra }) as FieldLike;
const person = (name: string, custom: Record<string, string> = {}, extra: Partial<PersonLike> = {}): PersonLike =>
  ({ id: name.length, name, title: "Partner", department: "Litigation", email: "a@b.test", phone: "602-555-0100 x218", mobile: "", office: "PHX1", custom, links: {}, linked_by: {}, ...extra }) as PersonLike;

describe("vCard", () => {
  test("names split either way, suffixes kept with the family name", () => {
    assert.deepEqual(splitName("Smith, Jane"), { family: "Smith", given: "Jane" });
    assert.deepEqual(splitName("Jane Q. Smith"), { family: "Smith", given: "Jane Q." });
    assert.deepEqual(splitName("Robert Downey Jr."), { family: "Downey Jr.", given: "Robert" });
    assert.deepEqual(splitName("Cher"), { family: "", given: "Cher" });
    assert.equal(vcardEscape("a,b;c\nd\\e"), "a\\,b\\;c\\nd\\\\e");
    assert.equal(vcardFilename("Jane Q. Smith"), "jane-q-smith.vcf");
  });

  test("the card carries contact details, the office address, notes, a folded photo and CRLF endings", () => {
    const fields = [field("office", { builtin: 1 }), field("bar", { label: "Bar number" }), field("direct", { label: "Direct", display: "phone" }), field("assistant", { kind: "people", label: "Assistant" })];
    const p = person("Jane Smith", { bar: "12345", direct: "602-555-0199" }, { links: { assistant: [{ id: 9, name: "Dana Ruiz" }] } } as any);
    const card = buildVCard({
      person: { ...p, photo_large: `data:image/jpeg;base64,${"A".repeat(200)}` },
      fields,
      company: "Firm LLP",
      profileUrl: "https://docs.firm.test/directory/10",
      office: { name: "Phoenix", address: "1 N Central Ave\nPhoenix, AZ 85004", phone: "602-555-0100", fax: "602-555-0101" },
    });
    const lines = card.split("\r\n");
    assert.equal(lines[0], "BEGIN:VCARD");
    assert.ok(lines.includes("N:Smith;Jane;;;"));
    assert.ok(lines.includes("FN:Jane Smith"));
    assert.ok(lines.includes("ORG:Firm LLP;Litigation"));
    assert.ok(lines.includes("TEL;TYPE=WORK,VOICE:602-555-0100 x218"), "the number stays as typed, extension included");
    assert.ok(lines.includes("ADR;TYPE=WORK:;;1 N Central Ave\\nPhoenix\\, AZ 85004;;;;"));
    assert.ok(lines.includes("TEL;TYPE=WORK,FAX:602-555-0101"));
    assert.ok(lines.includes("URL:https://docs.firm.test/directory/10"));
    assert.ok(lines.some((l) => l.startsWith("NOTE:Office: PHX1\\nBar number: 12345\\nAssistant: Dana Ruiz")));
    assert.ok(lines.some((l) => l.startsWith("PHOTO;ENCODING=b;TYPE=JPEG:")));
    assert.ok(lines.every((l) => Buffer.byteLength(l) <= 75), "every line folded to 75 octets");
    assert.ok(lines.some((l) => l.startsWith(" ")), "the photo line is continued");
    assert.equal(lines[lines.length - 2], "END:VCARD");
    assert.equal(lines[lines.length - 1], "");
  });

  test("no photo when asked (QR), no ADR without an office, no ORG without company or department", () => {
    const card = buildVCard({ person: { ...person("Solo Person"), department: "" }, fields: [], company: "", profileUrl: "", photo: false });
    assert.ok(!card.includes("PHOTO"));
    assert.ok(!card.includes("ADR"));
    assert.ok(!card.includes("ORG:"));
    assert.ok(!card.includes("URL:"));
  });
});

describe("dates", () => {
  test("parses ISO, Graph timestamps, US and long forms; formats readably", () => {
    assert.deepEqual(parseDateValue("2020-05-01"), { y: 2020, m: 5, d: 1 });
    assert.deepEqual(parseDateValue("2020-05-01T00:00:00Z"), { y: 2020, m: 5, d: 1 });
    assert.deepEqual(parseDateValue("5/1/2020"), { y: 2020, m: 5, d: 1 });
    assert.deepEqual(parseDateValue("May 1, 2020"), { y: 2020, m: 5, d: 1 });
    assert.deepEqual(parseDateValue("05-01"), { y: 0, m: 5, d: 1 }, "year-less birthday");
    assert.equal(parseDateValue("2020-13-01"), null);
    assert.equal(parseDateValue("soon"), null);
    assert.equal(formatDateValue("2020-05-01T00:00:00Z"), "May 1, 2020");
    assert.equal(formatDateValue("05-01"), "May 1");
    assert.equal(formatDateValue("tbd"), "tbd");
  });

  test("milestones: started this month, anniversaries with years, birthdays; ordered by day", () => {
    const fields = [field("hired", { kind: "date", date_role: "start" }), field("bday", { kind: "date", date_role: "birthday" }), field("other", { kind: "date" })];
    const people = [
      person("New Hire", { hired: "2026-09-20" }),
      person("Five Years", { hired: "2021-09-03" }),
      person("Next Year", { hired: "2027-09-03" }),
      person("Other Month", { hired: "2021-08-03" }),
      person("Birthday", { bday: "1990-09-12" }),
      person("Year-less", { bday: "09-02" }),
      person("Ignored", { other: "2026-09-01" }),
    ];
    const m = milestonesFor(people, fields, new Date(2026, 8, 25));
    assert.deepEqual(m.started.map((x) => x.person.name), ["New Hire"]);
    assert.deepEqual(m.anniversaries.map((x) => [x.person.name, x.years]), [["Five Years", 5]]);
    assert.deepEqual(m.birthdays.map((x) => x.person.name), ["Year-less", "Birthday"]);
  });
});
