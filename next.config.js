/** @type {import('next').NextConfig} */
const nextConfig = {
  // better-sqlite3 is a native module; keep it out of the bundle so it loads
  // from node_modules at runtime on the Node.js server.
  serverExternalPackages: ["better-sqlite3"],
};

module.exports = nextConfig;
