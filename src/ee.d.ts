// Type of the `@ee` module. `@ee` has no tsconfig path mapping on purpose — the
// only thing that resolves it is the webpack alias in next.config.js (stub in
// the community build, the private overlay in the enterprise build). Declaring
// it here keeps TypeScript happy without letting tsconfig `paths` override that
// alias.
declare module "@ee" {
  import type { EnterpriseEdition } from "@/ee-contract";
  const edition: EnterpriseEdition;
  export default edition;
}
