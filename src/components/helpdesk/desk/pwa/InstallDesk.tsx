"use client";

// Install Desk (1.19.0): the desk as an app of its own (dock, taskbar,
// Home Screen), opening in its own window. Chromium browsers offer their
// install dialog (beforeinstallprompt, caught by PwaHead); everywhere else
// a dialog says how, for the browser in hand. Two placements:
//   InstallDeskMenuItem  a row for the desk top bar's user menu (DeskShell
//                        installSlot), hidden once the desk is installed;
//   InstallDeskCard      the card on Settings → Notifications.

import { useEffect, useId, useState } from "react";
import { MonitorDown, Share, SquarePlus, X } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { MenuItem } from "@/components/Popover";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/Toasts";
import { closeInstallDialog, openInstallDialog, runInstallPrompt, useInstallState } from "./install-store";
import { detectBrave, readPlatform, type DeskPlatform } from "./platform";

function usePlatform(): DeskPlatform | null {
  const [p, setP] = useState<DeskPlatform | null>(null);
  useEffect(() => {
    let live = true;
    void detectBrave().then((brave) => live && setP(readPlatform(brave)));
    return () => {
      live = false;
    };
  }, []);
  return p;
}

/** The steps to install the desk on this browser, as an ordered list of sentences. */
export function installSteps(p: DeskPlatform): { lead: string; steps: string[]; note?: string } {
  if (p.os === "ios" || p.os === "ipados") {
    return {
      lead: `On ${p.os === "ios" ? "iPhone" : "iPad"}, add the desk to your Home Screen. It then opens full screen and can show notifications (iOS and iPadOS 16.4 or later).`,
      steps: [
        "Tap the Share button in the browser's toolbar.",
        "Scroll down and tap Add to Home Screen.",
        "Keep the name Desk and tap Add.",
        "Open Desk from your Home Screen and turn on notifications in Settings → Notifications.",
      ],
    };
  }
  if (p.browser === "safari") {
    return {
      lead: "Safari on macOS Sonoma or later can keep the desk in the Dock as an app.",
      steps: ["In the menu bar, choose File → Add to Dock.", "Click Add.", "Open Desk from the Dock."],
      note: "On older macOS, notifications still work in Safari itself (macOS 13 or later): turn them on below.",
    };
  }
  if (p.browser === "firefox") {
    if (p.os === "android") {
      return {
        lead: "Firefox on Android can add the desk to your Home Screen.",
        steps: ["Tap the menu (three dots).", "Tap Add to Home screen, then Add."],
      };
    }
    return {
      lead: "Firefox doesn't install web apps on most computers. Keep the desk open in a pinned tab instead: notifications work without installing.",
      steps: ["Right-click the desk's tab.", "Choose Pin Tab."],
    };
  }
  if (p.os === "android") {
    return {
      lead: "Add the desk to your Home Screen so it opens like an app.",
      steps: ["Tap the browser menu (three dots).", "Tap Install app or Add to Home screen.", "Confirm with Install."],
    };
  }
  if (p.browser === "edge") {
    return {
      lead: "Edge can install the desk as an app with its own window.",
      steps: ["Click the install icon at the right of the address bar, or open the menu (three dots).", "Choose Apps → Install this site as an app.", "Click Install."],
    };
  }
  return {
    lead: "Your browser can install the desk as an app with its own window.",
    steps: [
      "Click the install icon at the right of the address bar, or open the browser menu (three dots).",
      "Choose Cast, save and share → Install page as app (or Install CompassDocs Desk).",
      "Click Install.",
    ],
  };
}

function InstallDialog({ open, onClose, platform }: { open: boolean; onClose: () => void; platform: DeskPlatform }) {
  const titleId = useId();
  const how = installSteps(platform);
  const ios = platform.os === "ios" || platform.os === "ipados";
  return (
    <Modal open={open} onClose={onClose} labelledBy={titleId} className="w-full max-w-md rounded-xl border border-slate-200 bg-surface p-5 shadow-modal">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-compass-50 text-compass-600" aria-hidden>
          {ios ? <Share className="h-5 w-5" /> : <MonitorDown className="h-5 w-5" />}
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-base font-semibold text-slate-900">
            Install Desk
          </h2>
          <p className="mt-1 text-sm text-slate-600">{how.lead}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" data-tt="Close" className={iconButtonClass("quiet", "sm")}>
          <X aria-hidden />
        </button>
      </div>
      <ol className="mt-4 list-decimal space-y-1.5 pl-5 text-sm text-slate-700">
        {how.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      {how.note && <p className="mt-3 text-xs text-slate-500">{how.note}</p>}
      <div className="mt-5 flex justify-end">
        <Button variant="secondary" onClick={onClose} data-autofocus="">
          Done
        </Button>
      </div>
    </Modal>
  );
}

/** The how-to dialog, mounted once (PwaHead) and opened from the menu row or the card. */
export function InstallDialogHost() {
  const { dialog } = useInstallState();
  const platform = usePlatform();
  if (!platform) return null;
  return <InstallDialog open={dialog} onClose={closeInstallDialog} platform={platform} />;
}

/** Ask the browser, or explain. Shared by the menu row and the card. */
function useInstallAction() {
  const install = useInstallState();
  const platform = usePlatform();
  const installed = install.installed || Boolean(platform?.standalone);

  async function start() {
    if (install.prompt) {
      try {
        if (await runInstallPrompt()) toast("ok", "Desk installed. Open it from your apps.");
      } catch {
        openInstallDialog();
      }
      return;
    }
    openInstallDialog();
  }

  return { installed, canPrompt: Boolean(install.prompt), platform, start };
}

/** The row for the desk top bar's user menu; renders nothing once installed. */
export function InstallDeskMenuItem() {
  const a = useInstallAction();
  if (!a.platform || a.installed) return null;
  return (
    <MenuItem icon={<MonitorDown />} onClick={() => void a.start()}>
      Install Desk app
    </MenuItem>
  );
}

/** The card on Settings → Notifications. */
export function InstallDeskCard() {
  const a = useInstallAction();
  const ios = a.platform?.os === "ios" || a.platform?.os === "ipados";
  return (
    <Card
      id="install"
      className="scroll-mt-6"
      title="Install Desk"
      icon={<MonitorDown />}
      description="Keep the desk in its own window, beside CompassDocs, from your dock, taskbar or Home Screen."
      actions={a.installed ? <Chip tone="ok">Installed</Chip> : undefined}
    >
      {a.installed ? (
        <p className="text-sm text-slate-600">You're using the installed desk on this device.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" icon={ios ? <SquarePlus /> : <MonitorDown />} onClick={() => void a.start()} disabled={!a.platform}>
            {ios ? "Add to Home Screen" : "Install Desk"}
          </Button>
          <p className="text-xs text-slate-500">
            {a.canPrompt ? "Your browser will ask to install it." : "We'll show you how for this browser."}
          </p>
        </div>
      )}
    </Card>
  );
}
