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
      "CN=Ruiz\\2C Dana,OU=Elsewhere,DC=firm,DC=local",
      'CN="Ruiz, Dana",OU=Elsewhere,DC=firm,DC=local',
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
