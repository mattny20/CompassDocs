// What a people-field token can look like, and who it names.
//
// Run: npm run test:integration (this file needs no DATABASE_URL).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildPeopleIndex } from "../src/lib/directory-people-resolve";

const index = buildPeopleIndex([
  { id: 1, external_id: "11111111-aaaa", email: "dana.ruiz@firm.test", name: "Dana Ruiz", record: { userPrincipalName: "druiz@firm.onmicrosoft.com", mailNickname: "druiz", onPremisesSamAccountName: "DRUIZ", displayName: "Ruiz, Dana", proxyAddresses: ["SMTP:dana.ruiz@firm.test", "smtp:dana@firm.test"] } },
  { id: 2, external_id: "22222222-bbbb", email: "sam.chen@firm.test", name: "Sam Chen", record: { displayName: "Sam Chen" } },
  { id: 3, external_id: null, email: "", name: "Lee Park", record: null },
  { id: 4, external_id: "44444444-dddd", email: "lee.park2@firm.test", name: "Lee Park", record: { displayName: "Lee Park" } },
]);

describe("buildPeopleIndex", () => {
  test("object id, email, sign-in name, nickname, SAM account and aliases resolve exactly", () => {
    for (const t of ["11111111-AAAA", "Dana.Ruiz@firm.test", "druiz@firm.onmicrosoft.com", "druiz", "DRUIZ", "dana@firm.test", " dana.ruiz@firm.test "]) {
      assert.deepEqual(index.resolve(t), { id: 1 }, t);
    }
  });

  test("display names in either order, with honorifics, in a DN, or beside an address", () => {
    for (const t of ["Dana Ruiz", "ruiz, dana", "Ruiz,Dana", "Ms. Dana Ruiz", "CN=Dana Ruiz,OU=Staff,DC=firm,DC=test", "Dana Ruiz <dana.ruiz@firm.test>", "Someone Else <dana.ruiz@firm.test>"]) {
      assert.deepEqual(index.resolve(t), { id: 1 }, t);
    }
    assert.deepEqual(index.resolve("Sam Chen"), { id: 2 });
  });

  test("a whole value: semicolons separate people, commas only when the sides are not one name", () => {
    const ids = (v: string) => index.resolveList(v).map((r) => (r.hit && "id" in r.hit ? r.hit.id : r.token));
    assert.deepEqual(ids("Ruiz, Dana"), [1], "Last, First is one person");
    assert.deepEqual(ids("Dana Ruiz, Sam Chen"), [1, 2], "two names");
    assert.deepEqual(ids("Ruiz, Dana; Chen, Sam"), [1, 2], "two Last, First names");
    assert.deepEqual(ids("CN=Dana Ruiz,OU=Staff,DC=firm,DC=test; sam.chen@firm.test"), [1, 2], "a DN keeps its commas");
    assert.deepEqual(ids("druiz, nobody@firm.test"), [1, "nobody@firm.test"], "the unresolved piece is reported as typed");
    assert.deepEqual(ids(""), []);
  });

  test("a name two people share resolves to nobody and says so; nonsense resolves to nobody", () => {
    assert.deepEqual(index.resolve("Lee Park"), { ambiguous: 2 });
    assert.deepEqual(index.resolve("lee.park2@firm.test"), { id: 4 }, "their email still does");
    assert.equal(index.resolve("Nobody Here"), undefined);
    assert.equal(index.resolve(""), undefined);
  });
});

// 1.14.1: AD's assistant attribute holds a distinguished name, and a CN in
// the "Last, First" form is escaped in it. Letter case never matters.
describe("distinguished names and letter case (1.14.1)", () => {
  const ad = buildPeopleIndex([
    {
      id: 10,
      external_id: "aaaa-1010",
      email: "dana.ruiz@firm.test",
      name: "Dana Ruiz",
      record: {
        userPrincipalName: "dana.ruiz@firm.test",
        onPremisesUserPrincipalName: "DRuiz@firm.local",
        onPremisesSamAccountName: "DRUIZ",
        onPremisesDistinguishedName: "CN=Ruiz\\, Dana,OU=Finance,OU=Staff,DC=firm,DC=local",
        displayName: "Dana Ruiz",
      },
    },
    // Two people named Lee Park: a name cannot tell them apart, their DNs can.
    { id: 11, external_id: "aaaa-1111", email: "lee.park@firm.test", name: "Lee Park", record: { onPremisesDistinguishedName: "CN=Park\\, Lee,OU=Sales,DC=firm,DC=local", displayName: "Lee Park" } },
    { id: 12, external_id: "aaaa-1212", email: "lee.park2@firm.test", name: "Lee Park", record: { onPremisesDistinguishedName: "CN=Park\\, Lee (IT),OU=IT,DC=firm,DC=local", displayName: "Lee Park" } },
    // A CN that differs from the display name: only the DN names her.
    { id: 13, external_id: "aaaa-1313", email: "ana.lopez@firm.test", name: "Ana López", record: { onPremisesDistinguishedName: "CN=alopez,OU=Staff,DC=firm,DC=local", displayName: "Ana López" } },
    { id: 14, external_id: "aaaa-1414", email: "sam.chen@firm.test", name: "Chen, Sam", record: { displayName: "Chen, Sam" } },
  ]);
  const ids = (v: string) => ad.resolveList(v).map((r) => (r.hit && "id" in r.hit ? r.hit.id : r.hit ?? r.token));

  test("an escaped comma in the CN, as AD writes it, in every escape form and any letter case", () => {
    for (const t of [
      "CN=Ruiz\\, Dana,OU=Finance,OU=Staff,DC=firm,DC=local",
      "cn=ruiz\\, dana,ou=finance,ou=staff,dc=firm,dc=local",
      "CN=RUIZ\\, DANA, OU=Finance, OU=Staff, DC=firm, DC=local",
      "CN=Ruiz\\2C Dana,OU=Finance,OU=Staff,DC=firm,DC=local",
      'CN="Ruiz, Dana",OU=Finance,OU=Staff,DC=firm,DC=local',
      "CN = Ruiz\\, Dana , OU=Finance,OU=Staff,DC=firm,DC=local",
    ]) {
      assert.deepEqual(ad.resolve(t), { id: 10 }, t);
      assert.deepEqual(ids(t), [10], `${t} as a whole value`);
    }
  });

  test("a person's own DN names them exactly, even when the name is shared or the CN is not the display name", () => {
    assert.deepEqual(ad.resolve("Lee Park"), { ambiguous: 2 }, "the name alone is shared");
    assert.deepEqual(ad.resolve("CN=Park\\, Lee,OU=Sales,DC=firm,DC=local"), { id: 11 });
    assert.deepEqual(ad.resolve("cn=park\\, lee (it),ou=it,dc=firm,dc=local"), { id: 12 });
    assert.deepEqual(ad.resolve("CN=alopez,OU=Staff,DC=firm,DC=local"), { id: 13 }, "the CN is a SAM name, not her display name");
  });

  test("sign-in names differ only by case and still match: cloud UPN, on-premises UPN, SAM account", () => {
    for (const t of ["DANA.RUIZ@FIRM.TEST", "Dana.Ruiz@firm.test", "druiz@FIRM.LOCAL", "druiz", "DRuiz"]) {
      assert.deepEqual(ad.resolve(t), { id: 10 }, t);
    }
    assert.deepEqual(ad.resolve("CHEN, SAM"), { id: 14 });
  });

  test("an unresolved DN is reported whole, once, never as its RDN pieces", () => {
    const r = ad.resolveList("CN=Nobody\\, Known,OU=Staff,DC=firm,DC=local");
    assert.equal(r.length, 1);
    assert.equal(r[0].token, "CN=Nobody\\, Known,OU=Staff,DC=firm,DC=local");
    assert.equal(r[0].hit, undefined);
  });

  test("several DNs in one value split at semicolons, not at the commas inside them", () => {
    assert.deepEqual(ids("CN=Ruiz\\, Dana,OU=Finance,OU=Staff,DC=firm,DC=local; CN=Park\\, Lee,OU=Sales,DC=firm,DC=local"), [10, 11]);
    assert.deepEqual(ids("CN=Ruiz\\, Dana,OU=Finance,OU=Staff,DC=firm,DC=local\nsam.chen@firm.test"), [10, 14]);
  });
});

// 1.14.1 review: the customer's value before the first sync that fetches the
// on-premises DNs, every escape spelling against a shared name, a departed
// namesake's DN, shared SAM names across domains, several DNs in one value
// (as a multi-valued attribute arrives), and the separators.
describe("distinguished names: the review cases (1.14.1)", () => {
  test("no stored DN yet: the escaped CN resolves by name, as the first post-upgrade value does", () => {
    const before = buildPeopleIndex([{ id: 1, external_id: "x1", email: "dana.ruiz@firm.test", name: "Dana Ruiz", record: { displayName: "Dana Ruiz" } }]);
    for (const t of ["CN=Ruiz\\, Dana,OU=Staff,DC=firm,DC=local", "CN=Ruiz\\2C Dana,OU=Staff,DC=firm,DC=local", 'CN="Ruiz, Dana",OU=Staff,DC=firm,DC=local']) {
      assert.deepEqual(before.resolve(t), { id: 1 }, t);
      assert.deepEqual(before.resolveList(t).map((r) => r.hit), [{ id: 1 }], `${t} as a whole value`);
    }
  });

  const twins = buildPeopleIndex([
    { id: 21, external_id: "t21", email: "lee.park@firm.test", name: "Lee Park", record: { onPremisesDistinguishedName: "CN=Park\\, Lee,OU=Sales,DC=firm,DC=local", onPremisesSamAccountName: "lpark" } },
    { id: 22, external_id: "t22", email: "lee.park@emea.firm.test", name: "Lee Park", record: { onPremisesDistinguishedName: "CN=Park\\, Lee,OU=Sales,DC=emea,DC=firm,DC=local", onPremisesSamAccountName: "lpark" } },
    { id: 23, external_id: "t23", email: "jo.bell@firm.test", name: "Jo Bell", record: { onPremisesDistinguishedName: "CN=Bell\\, Jo,OU=Staff,DC=firm,DC=local", onPremisesSamAccountName: "jbell", mailNickname: "jo.bell" } },
  ]);

  test("every escape spelling of a person's own DN names them exactly, even with a shared name", () => {
    for (const t of ["CN=Park\\, Lee,OU=Sales,DC=firm,DC=local", "CN=Park\\2C Lee,OU=Sales,DC=firm,DC=local", 'CN="Park, Lee",OU=Sales,DC=firm,DC=local', "cn=park\\, lee, ou=sales, dc=firm, dc=local"]) {
      assert.deepEqual(twins.resolve(t), { id: 21 }, t);
    }
    assert.deepEqual(twins.resolve("CN=Park\\2C Lee,OU=Sales,DC=emea,DC=firm,DC=local"), { id: 22 });
  });

  test("a DN that is nobody's own names nobody, even when its CN matches someone whose own DN is known", () => {
    assert.equal(twins.resolve("CN=Bell\\, Jo,OU=Disabled,DC=firm,DC=local"), undefined, "a departed namesake in another OU");
    assert.deepEqual(twins.resolve("Jo Bell"), { id: 23 }, "the plain name still names her");
  });

  test("a SAM account name two domains share names nobody and says so; a unique one names its holder", () => {
    assert.deepEqual(twins.resolve("lpark"), { ambiguous: 2 });
    assert.deepEqual(twins.resolve("JBELL"), { id: 23 });
    assert.deepEqual(twins.resolve("Jo.Bell"), { id: 23 }, "mail nickname");
  });

  test("several DNs in one value: comma-joined as a multi-valued attribute arrives, each resolved on its own", () => {
    const hits = (v: string) => twins.resolveList(v).map((r) => (r.hit && "id" in r.hit ? r.hit.id : r.token));
    const a = "CN=Park\\, Lee,OU=Sales,DC=firm,DC=local";
    const b = "CN=Bell\\, Jo,OU=Staff,DC=firm,DC=local";
    const gone = "CN=Gone\\, Person,OU=Staff,DC=firm,DC=local";
    assert.deepEqual(hits(`${a}, ${b}`), [21, 23]);
    assert.deepEqual(hits(`${gone}, ${b}`), [gone, 23], "an unknown first DN does not hide the second");
    assert.deepEqual(hits(`${a}; ${b}`), [21, 23]);
    assert.deepEqual(hits(`${gone}, jo.bell@firm.test`), [gone, 23], "a DN then an address");
    assert.deepEqual(hits("CN=Bell\\, Jo,CN=Users,DC=firm,DC=local"), ["CN=Bell\\, Jo,CN=Users,DC=firm,DC=local"], "a CN container is part of the DN, not a second person");
  });

  test("separators: an escaped backslash before a semicolon still separates; an angled DN stays whole", () => {
    const one = buildPeopleIndex([{ id: 31, external_id: "o31", email: "sam.chen@firm.test", name: "Sam Chen", record: { onPremisesSamAccountName: "schen" } }]);
    assert.deepEqual(one.resolveList("FIRM\\\\;schen").map((r) => r.hit), [undefined, { id: 31 }]);
    const angled = "Nobody, Known <CN=Nobody\\, Known,OU=Staff,DC=firm,DC=local>";
    assert.deepEqual(one.resolveList(angled), [{ token: angled, hit: undefined }]);
  });

  test("a CN ending in an escaped space keeps it", () => {
    const sp = buildPeopleIndex([{ id: 41, external_id: "s41", email: "", name: "Trail Space", record: { onPremisesDistinguishedName: "CN=Trail Space\\ ,OU=Staff,DC=firm,DC=local" } }]);
    assert.deepEqual(sp.resolve("CN=Trail Space\\ ,OU=Staff,DC=firm,DC=local"), { id: 41 });
  });
});
