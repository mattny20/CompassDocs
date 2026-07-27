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
    // Content-Security-Policy. Two disjoint rules — /addin/* must stay frameable
    // by Outlook and load Office.js, everything else is locked to 'self'. A
    // browser enforces the INTERSECTION of duplicate CSP headers, so these are
    // kept separate rather than merged.
    //
    // script-src keeps 'unsafe-inline' because the app ships a few inline
    // scripts (pre-paint theme init) and has no nonce middleware yet; the real
    // XSS fix is escaping user content at the sink. What this policy *does* add
    // over the previous frame-ancestors-only header: default-src 'self' (no
    // external script/object loads) and connect-src 'self' (blocks XHR/fetch/
    // WebSocket exfiltration to attacker hosts) — meaningful blast-radius
    // reduction. img-src/frame-src allow https: for user-embedded images and
    // video/site embeds.
    const commonCsp =
      "default-src 'self'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob: https:; " +
      "font-src 'self'; " +
      "object-src 'none'; " +
      "base-uri 'self'; " +
      "form-action 'self'";
    const mainCsp =
      "script-src 'self' 'unsafe-inline'; " +
      "connect-src 'self'; " +
      "frame-src 'self' https:; " +
      "frame-ancestors 'self'; " +
      commonCsp;
    // The Outlook task pane loads Office.js from Microsoft and is framed by
    // Outlook's webviews.
    const office = "https://appsforoffice.microsoft.com https://*.office.com";
    const addinCsp =
      `script-src 'self' 'unsafe-inline' ${office}; ` +
      `connect-src 'self' ${office}; ` +
      "frame-src 'self' https:; " +
      "frame-ancestors 'self' https://outlook.office.com https://outlook.office365.com " +
      "https://outlook.live.com https://*.office.com; " +
      commonCsp;
    return [
      {
        source: "/addin/:path*",
        headers: [...base, { key: "Content-Security-Policy", value: addinCsp }],
      },
      {
        source: "/((?!addin).*)",
        headers: [...base, { key: "Content-Security-Policy", value: mainCsp }],
      },
    ];
  },
  // Open-core edition switch. `@ee` resolves to the community stub by default,
  // or to an overlaid `./ee` package when COMPASSDOCS_EE=1 (the enterprise
  // build). Core imports `@ee` only through src/lib/ee.ts. Declared for both
  // bundlers: Turbopack builds (the Next 16 default) read `turbopack`, and a
  // `next build --webpack` fallback still works via the webpack hook.
  turbopack: {
    // Turbopack aliases are project-root-relative strings (absolute paths get
    // "./" prepended and break), unlike the webpack hook's absolute paths.
    resolveAlias: {
      "@ee": process.env.COMPASSDOCS_EE === "1" ? "./ee" : "./src/ee-stub",
    },
  },
  webpack(config) {
    config.resolve.alias["@ee"] =
      process.env.COMPASSDOCS_EE === "1"
        ? path.resolve(__dirname, "ee")
        : path.resolve(__dirname, "src/ee-stub");
    return config;
  },
};

module.exports = nextConfig;
