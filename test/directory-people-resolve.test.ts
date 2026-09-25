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
