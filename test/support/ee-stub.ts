// lib/ee as a licensed enterprise build sees it, for a test file that drives
// a licence-gated path (complianceHourly, the compliance routes). The test
// tsconfig's `@ee` alias is the community stub, whose edition grants
// nothing, so the stub is installed through Module._resolveFilename and
// must be in place before lib/compliance or a route loads: `import
// "./support/ee-stub"` goes FIRST among a file's imports (imports run in
// source order, before any other statement). test/ack-reask.test.ts and
// test/ack-statement.test.ts carry the same stub inline, with a lazy
// import of the modules under test instead.
//
// `edition.features` is exported so a test can switch the feature off and
// prove the gate.

import Module from "node:module";
import path from "node:path";

export const edition: { present: boolean; features: string[] } = { present: true, features: ["policy_ack"] };

const EE_STUB = path.join(__dirname, "..", "stubs", "ee.support.virtual.js");
const EE_REAL = path.join(__dirname, "..", "..", "src", "lib", "ee");

if (!require.cache[EE_STUB]) {
  const ee = new Module(EE_STUB);
  ee.filename = EE_STUB;
  ee.loaded = true;
  ee.exports = {
    ee: () => edition,
    eePresent: () => edition.present,
    featureEnabled: async (feature: string) => edition.features.includes(feature),
  };
  require.cache[EE_STUB] = ee;

  const loader = Module as unknown as {
    _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string;
  };
  const resolveFilename = loader._resolveFilename;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "@/lib/ee") return EE_STUB;
    if (request === "./ee" && parent?.filename && path.resolve(path.dirname(parent.filename), "ee") === EE_REAL) {
      return EE_STUB;
    }
    return resolveFilename.call(this, request, parent, ...rest);
  };
}
