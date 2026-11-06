"use client";

// The desk's web-app plumbing (1.19.0), rendered once by the (desk) layout
// beside the shell (it draws only the Install Desk dialog, when open): registers the desk service worker
// (public/desk-sw.js, scope /desk) so push and the offline page work, keeps
// the browser's install offer for Install Desk, and follows a notification
// click that the worker hands to an open desk window it does not control.
// The manifest, icons and theme colour are metadata (./metadata), which
// the layout spreads into its own.

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { InstallDialogHost } from "./InstallDesk";
import { markInstalled, offerInstall, type BeforeInstallPromptEvent } from "./install-store";
import { isStandalone, SW_SCOPE, SW_URL } from "./platform";

export function PwaHead() {
  const router = useRouter();

  useEffect(() => {
    if (isStandalone()) markInstalled();
    const onPrompt = (e: Event) => {
      e.preventDefault();
      offerInstall(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => markInstalled();
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);

    let onMessage: ((e: MessageEvent) => void) | null = null;
    if ("serviceWorker" in navigator && window.isSecureContext) {
      navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE }).catch((err) => {
        console.warn("Desk service worker not registered:", err);
      });
      onMessage = (e: MessageEvent) => {
        const data = e.data as { type?: string; url?: string } | null;
        if (data?.type === "desk:navigate" && typeof data.url === "string" && data.url.startsWith("/") && !data.url.startsWith("//")) {
          router.push(data.url);
        }
      };
      navigator.serviceWorker.addEventListener("message", onMessage);
      // An agent who opens the desk has seen what the badge pointed at.
      const nav = navigator as Navigator & { clearAppBadge?: () => Promise<void> };
      nav.clearAppBadge?.().catch(() => {});
    }
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
      if (onMessage) navigator.serviceWorker.removeEventListener("message", onMessage);
    };
  }, [router]);

  return <InstallDialogHost />;
}
