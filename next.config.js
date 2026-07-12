/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emit a self-contained server (.next/standalone) for small Docker images and
  // easy deploys on Railway / Render / Fly. Vercel ignores this and works too.
  output: "standalone",
  // Keep the Postgres driver out of the server bundle (it has optional native
  // deps and dynamic requires); load it from node_modules at runtime.
  serverExternalPackages: ["pg"],
};

module.exports = nextConfig;
