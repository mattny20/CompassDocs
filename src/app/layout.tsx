import type { Metadata } from "next";
import { getAppSettings } from "@/lib/settings-store";
import { accentCss } from "@/lib/theme";
// Self-host the brand font (Aileron) so it renders offline / on-prem without
// reaching out to a font CDN. Weights: regular, semibold, bold.
import "@fontsource/aileron/400.css";
import "@fontsource/aileron/600.css";
import "@fontsource/aileron/700.css";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  // The title reflects the configured company name, but metadata is also
  // evaluated at build time (e.g. prerendering /_not-found) when no database is
  // available — fall back to the default name rather than failing the build.
  let companyName = "CompassDocs";
  try {
    companyName = (await getAppSettings()).company_name;
  } catch {
    // No DB reachable (build time / cold start) — keep the default.
  }
  const isDefault = companyName === "CompassDocs";
  return {
    title: isDefault ? "CompassDocs — Team Knowledge Platform" : `${companyName} — Knowledge Base`,
    description:
      "Create, organize, and search SOPs, technical docs, policies, and internal knowledge with AI-powered search.",
  };
}

// Resolve the saved theme preference and stamp data-theme on <html> *before*
// first paint, so there's no light/dark flash on load. `system` follows the OS.
const THEME_INIT = `
(function(){try{
  var p = localStorage.getItem('compass-theme') || 'system';
  var dark = p === 'dark' || (p !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}catch(e){}})();
`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Custom workspace accent: derive the palette override server-side. Like
  // generateMetadata above, tolerate a missing database (build time).
  let accent = "";
  try {
    accent = accentCss((await getAppSettings()).accent_color);
  } catch {
    /* no DB (build/prerender) — default palette from globals.css applies */
  }
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
        {accent && <style id="workspace-accent">{accent}</style>}
      </head>
      <body>{children}</body>
    </html>
  );
}
