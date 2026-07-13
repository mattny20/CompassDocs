// Community-edition stub for the enterprise overlay. This is what `@ee` resolves
// to in the open-source build (see next.config.js). It advertises no features,
// so every enterprise surface is simply absent. The real implementation lives in
// the private `compassdocs-ee` package and replaces this at build time.

import type { EnterpriseEdition } from "@/ee-contract";

const community: EnterpriseEdition = {
  present: false,
  features: [],
};

export default community;
