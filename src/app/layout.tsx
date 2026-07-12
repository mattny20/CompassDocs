import type { Metadata } from "next";
import { getAppSettings } from "@/lib/settings-store";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const { company_name } = await getAppSettings();
  const isDefault = company_name === "CompassDocs";
  return {
    title: isDefault ? "CompassDocs — Team Knowledge Platform" : `${company_name} — Knowledge Base`,
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
