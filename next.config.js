const path = require("path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emit a self-contained server (.next/standalone) for small Docker images and
  // easy deploys on Railway / Render / Fly. Vercel ignores this and works too.
  output: "standalone",
  // Keep the Postgres driver out of the server bundle (it has optional native
  // deps and dynamic requires); load it from node_modules at runtime.
  serverExternalPackages: ["pg"],
  webpack(config) {
    // Open-core edition switch. `@ee` resolves to the community stub by default,
    // or to an overlaid `./ee` package when COMPASSDOCS_EE=1 (the enterprise
    // build). Core imports `@ee` only through src/lib/ee.ts.
    config.resolve.alias["@ee"] =
      process.env.COMPASSDOCS_EE === "1"
        ? path.resolve(__dirname, "ee")
        : path.resolve(__dirname, "src/ee-stub");
    return config;
  },
};

module.exports = nextConfig;
