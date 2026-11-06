// The desk as an installable web app (1.19.0): the metadata the (desk)
// layout spreads into its own, so the desk's pages name the desk manifest,
// icons and colours instead of the CompassDocs app's. Next merges a child
// layout's `manifest`, `icons` and `appleWebApp` over the root layout's,
// which a <link> rendered in the body could not do (the root's manifest
// link would come first and win). Server-safe.
//
//   export const metadata: Metadata = { …, ...deskPwaMetadata };
//   export const viewport: Viewport = deskPwaViewport;

import type { Metadata, Viewport } from "next";

/** The house accent, as in public/desk.webmanifest. */
export const DESK_THEME_COLOR = "#2e75bd";

export const deskPwaMetadata: Pick<Metadata, "manifest" | "icons" | "appleWebApp" | "applicationName"> = {
  manifest: "/desk.webmanifest",
  applicationName: "CompassDocs Desk",
  icons: {
    icon: [
      { url: "/desk-192.png", sizes: "192x192", type: "image/png" },
      { url: "/desk-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/desk-apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: { capable: true, title: "Desk", statusBarStyle: "default" },
};

export const deskPwaViewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: DESK_THEME_COLOR },
    { media: "(prefers-color-scheme: dark)", color: "#0f172a" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};
