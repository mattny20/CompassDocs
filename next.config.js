const path = require("path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emit a self-contained server (.next/standalone) for small Docker images and
  // easy deploys on Railway / Render / Fly. Vercel ignores this and works too.
  output: "standalone",
  // Keep the Postgres driver out of the server bundle (it has optional native
  // deps and dynamic requires); load it from node_modules at runtime.
  serverExternalPackages: ["pg"],
  async headers() {
    // Baseline hardening on every response. HSTS is a no-op over plain HTTP
    // (browsers ignore it), so it's safe to send unconditionally.
    const base = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Strict-Transport-Security", value: "max-age=15552000" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    ];
    // Anti-clickjacking CSP. The Outlook task pane (/addin/*) must stay
    // frameable by Outlook's webviews, so those routes allow Office origins;
    // everything else can only be framed by the app itself. The two rules are
    // disjoint because a browser enforces the INTERSECTION of duplicate CSPs.
    const officeFrames =
      "frame-ancestors 'self' https://outlook.office.com https://outlook.office365.com " +
      "https://outlook.live.com https://*.office.com; object-src 'none'; base-uri 'self'";
    const selfFrames = "frame-ancestors 'self'; object-src 'none'; base-uri 'self'";
    return [
      {
        source: "/addin/:path*",
        headers: [...base, { key: "Content-Security-Policy", value: officeFrames }],
      },
      {
        source: "/((?!addin).*)",
        headers: [...base, { key: "Content-Security-Policy", value: selfFrames }],
      },
    ];
  },
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
