"use client";

// Settings → Notifications (1.19.0): push on this device, and every device
// the agent turned it on for. "Turn on notifications on this device" asks
// the browser's permission, subscribes through the desk service worker with
// the workspace's VAPID key and registers the subscription. Denied, iOS
// before Add to Home Screen, Brave without Google push messaging and plain
// HTTP each get their own sentence and a way forward.

import { useCallback, useEffect, useState } from "react";
import { BellOff, BellRing, Monitor, Pencil, Send, Share, Smartphone, Trash2 } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip, chipClass } from "@/components/Chip";
import { confirmDialog, promptDialog } from "@/components/Dialog";
import { SectionEmpty } from "@/components/form";
import { RelativeTime } from "@/components/RelativeTime";
import { SubHeading } from "@/components/Heading";
import { toast } from "@/components/Toasts";
import { useFormatDate } from "@/components/SettingsProvider";
import { deviceLabel, type HdPushDevice } from "@/lib/helpdesk/push-shared";
import { getJson, sendJson, listOf } from "../api";
import { deskRegistration, detectBrave, fingerprintOf, readPlatform, urlBase64ToUint8Array, type DeskPlatform } from "../pwa/platform";
import { openInstallDialog } from "../pwa/install-store";
import { BRAVE_HINT, IOS_INSTALL_HINT, deniedSteps, systemHint } from "./PushHelp";

type Perm = NotificationPermission | "unsupported";

function mobile(d: Pick<HdPushDevice, "os">) {
  return d.os === "ios" || d.os === "ipados" || d.os === "android";
}

export function DevicesCard({ initial, onCount }: { initial: HdPushDevice[]; onCount: (n: number) => void }) {
  const fmt = useFormatDate();
  const [devices, setDevices] = useState<HdPushDevice[]>(initial);
  const [platform, setPlatform] = useState<DeskPlatform | null>(null);
  const [perm, setPerm] = useState<Perm>("default");
  const [mine, setMine] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState("");
  const [brave, setBrave] = useState(false);

  useEffect(() => onCount(devices.length), [devices.length, onCount]);

  const reload = useCallback(async () => {
    try {
      setDevices(listOf<HdPushDevice>(await getJson("/api/helpdesk/push/devices", "Couldn't load your devices."), "devices"));
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }, []);

  // What this browser is and whether it already has a subscription.
  useEffect(() => {
    let live = true;
    (async () => {
      const isBrave = await detectBrave();
      const p = readPlatform(isBrave);
      if (!live) return;
      setBrave(isBrave);
      setPlatform(p);
      if (!p.pushSupported || !p.secure) {
        setPerm("unsupported");
        return;
      }
      setPerm(Notification.permission);
      try {
        const reg = await navigator.serviceWorker.getRegistration("/desk");
        const sub = await reg?.pushManager.getSubscription();
        if (sub && live) setMine(await fingerprintOf(sub.endpoint));
      } catch {
        /* no registration yet */
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const thisDevice = mine ? devices.find((d) => d.fingerprint === mine) ?? null : null;

  async function turnOn() {
    if (!platform) return;
    setBusy("on");
    setFailure("");
    try {
      const answer = await Notification.requestPermission();
      setPerm(answer);
      if (answer !== "granted") {
        if (answer === "denied") toast("error", "Notifications are blocked for this site. See how to allow them below.");
        return;
      }
      const reg = await deskRegistration();
      const { public_key } = await getJson<{ public_key: string }>("/api/helpdesk/push/vapid", "Couldn't prepare notifications.");
      const key = urlBase64ToUint8Array(public_key);
      let sub = await reg.pushManager.getSubscription();
      // A subscription made with another key (keys reset) can't be used: replace it.
      const oldKey = sub?.options.applicationServerKey;
      if (sub && oldKey && !sameBytes(new Uint8Array(oldKey), key)) {
        await sub.unsubscribe().catch(() => {});
        sub = null;
      }
      if (!sub) {
        try {
          sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        } catch (e) {
          setFailure(
            brave
              ? BRAVE_HINT
              : `Your browser couldn't set up push (${(e as Error).message || "no reason given"}). Try again, or try another browser.`
          );
          return;
        }
      }
      const { device } = await sendJson<{ device: HdPushDevice }>(
        "/api/helpdesk/push/subscriptions",
        "POST",
        { subscription: sub.toJSON(), brave, touch_mac: platform.touchMac },
        "Couldn't turn on notifications."
      );
      setMine(device.fingerprint);
      await reload();
      toast("ok", "Notifications are on for this device.");
    } catch (e) {
      toast("error", (e as Error).message || "Couldn't turn on notifications.");
    } finally {
      setBusy(null);
    }
  }

  async function turnOffHere() {
    setBusy("off");
    try {
      const reg = await navigator.serviceWorker.getRegistration("/desk");
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await sendJson("/api/helpdesk/push/subscriptions", "DELETE", { endpoint: sub.endpoint }, "Couldn't turn off notifications.");
        await sub.unsubscribe().catch(() => {});
      } else if (thisDevice) {
        await sendJson(`/api/helpdesk/push/devices/${thisDevice.id}`, "DELETE", undefined, "Couldn't turn off notifications.");
      }
      setMine(null);
      await reload();
      toast("ok", "Notifications are off for this device.");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function test(d: HdPushDevice) {
    setBusy(`test-${d.id}`);
    try {
      await sendJson("/api/helpdesk/push/test", "POST", { device_id: d.id }, "Couldn't send a test notification.");
      toast("ok", `Test sent to ${d.label}.`);
    } catch (e) {
      toast("error", (e as Error).message);
      await reload();
    } finally {
      setBusy(null);
    }
  }

  async function rename(d: HdPushDevice) {
    const label = await promptDialog({
      title: "Rename device",
      label: "Name",
      initial: d.label,
      confirmLabel: "Rename",
      validate: (v) => (!v.trim() ? "Give the device a name." : v.length > 60 ? "Use 60 characters or fewer." : undefined),
    });
    if (label === null || label.trim() === d.label) return;
    setBusy(`rename-${d.id}`);
    try {
      await sendJson(`/api/helpdesk/push/devices/${d.id}`, "PATCH", { label: label.trim() }, "Couldn't rename the device.");
      await reload();
      toast("ok", "Device renamed.");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function remove(d: HdPushDevice) {
    const here = d.fingerprint === mine;
    const ok = await confirmDialog({
      title: `Remove ${d.label}?`,
      body: here
        ? "This device stops getting desk notifications. You can turn them on again here."
        : "That device stops getting desk notifications until someone turns them on again on it.",
      confirmLabel: "Remove device",
      danger: true,
    });
    if (!ok) return;
    if (here) return turnOffHere();
    setBusy(`remove-${d.id}`);
    try {
      await sendJson(`/api/helpdesk/push/devices/${d.id}`, "DELETE", undefined, "Couldn't remove the device.");
      await reload();
      toast("ok", "Device removed.");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card
      id="devices"
      className="scroll-mt-6"
      title="Push notifications"
      icon={<BellRing />}
      description="Notifications on your computer and phone, even when the desk isn't the tab you're looking at."
    >
      <div className="rounded-lg border border-slate-200 bg-canvas p-4" aria-live="polite">
        <SubHeading icon={platform && mobile(platform) ? <Smartphone /> : <Monitor />}>
          This device{thisDevice ? `: ${thisDevice.label}` : platform ? `: ${deviceLabel(platform)}` : ""}
        </SubHeading>
        <ThisDeviceState
          platform={platform}
          perm={perm}
          on={Boolean(thisDevice)}
          busy={busy}
          brave={brave}
          failure={failure}
          onTurnOn={turnOn}
          onTurnOff={turnOffHere}
        />
      </div>

      <div className="mt-5">
        <SubHeading>Your devices ({devices.length})</SubHeading>
        {devices.length === 0 ? (
          <SectionEmpty className="mt-1">Devices you turn notifications on for will be listed here.</SectionEmpty>
        ) : (
          <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">
            {devices.map((d) => {
              const here = d.fingerprint === mine;
              return (
                <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-compass-50 text-compass-600" aria-hidden>
                    {mobile(d) ? <Smartphone className="h-4 w-4" /> : <Monitor className="h-4 w-4" />}
                  </span>
                  <div className="min-w-[12rem] flex-1">
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-medium text-slate-800">
                      <span className="min-w-0 break-words">{d.label}</span>
                      {here && <Chip tone="accent" size="sm">This device</Chip>}
                      {d.last_error && <Chip tone="warn" size="sm">Not delivering</Chip>}
                    </p>
                    <p className="text-xs text-slate-500">
                      {deviceLabel(d)} · added {fmt.date(d.created_at)} · last used{" "}
                      {d.last_used_at ? <RelativeTime value={d.last_used_at} /> : "never"}
                    </p>
                    {d.last_error && <p className="mt-0.5 break-words text-xs ink-warn">The push service said: {d.last_error}</p>}
                  </div>
                  <div className="ml-11 flex shrink-0 items-center gap-1 sm:ml-0">
                    <Button variant="secondary" size="sm" icon={<Send />} busy={busy === `test-${d.id}`} disabled={busy !== null} onClick={() => test(d)}>
                      Send test
                    </Button>
                    <button
                      type="button"
                      className={iconButtonClass("quiet", "sm")}
                      data-tt="Rename"
                      aria-label={`Rename ${d.label}`}
                      disabled={busy !== null}
                      onClick={() => rename(d)}
                    >
                      <Pencil aria-hidden />
                    </button>
                    <button
                      type="button"
                      className={iconButtonClass("quiet", "sm", "hover-danger")}
                      data-tt="Remove"
                      aria-label={`Remove ${d.label}`}
                      disabled={busy !== null}
                      onClick={() => remove(d)}
                    >
                      <Trash2 aria-hidden />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function ThisDeviceState({
  platform,
  perm,
  on,
  busy,
  brave,
  failure,
  onTurnOn,
  onTurnOff,
}: {
  platform: DeskPlatform | null;
  perm: Perm;
  on: boolean;
  busy: string | null;
  brave: boolean;
  failure: string;
  onTurnOn: () => void;
  onTurnOff: () => void;
}) {
  if (!platform) return <p className="mt-1 text-sm text-slate-500">Checking this browser…</p>;

  if (platform.iosNeedsInstall) {
    return (
      <div className="mt-2 space-y-2">
        <p className="notice-warn rounded-lg border px-3 py-2 text-sm">{IOS_INSTALL_HINT}</p>
        <Button variant="secondary" size="sm" icon={<Share />} onClick={openInstallDialog}>
          Show me how
        </Button>
      </div>
    );
  }
  if (!platform.secure) {
    return (
      <div className="mt-2 notice-warn rounded-lg border px-3 py-2 text-sm">
        Notifications need a secure connection. Open the desk over https:// (ask your administrator if the site has no certificate).
      </div>
    );
  }
  if (perm === "unsupported") {
    return (
      <p className="mt-1 text-sm text-slate-600">
        This browser can't show web notifications. Use a current Chrome, Edge, Firefox or Safari, or the desk on your phone.
      </p>
    );
  }
  if (perm === "denied") {
    const hint = systemHint(platform);
    return (
      <div className="mt-2 space-y-2">
        <p className="flex items-center gap-2 text-sm font-medium text-slate-800">
          <span className={chipClass("error", "sm")}>Blocked</span>
          Notifications are blocked for this site in your browser.
        </p>
        <p className="text-sm text-slate-600">To allow them:</p>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-600">
          {deniedSteps(platform).map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        {hint && <p className="text-xs text-slate-500">{hint}</p>}
      </div>
    );
  }
  if (perm === "granted" && on) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <p className="flex items-center gap-2 text-sm text-slate-700">
          <Chip tone="ok" size="sm">On</Chip>
          This device gets desk notifications.
        </p>
        <Button variant="secondary" size="sm" icon={<BellOff />} busy={busy === "off"} disabled={busy !== null} onClick={onTurnOff}>
          Turn off on this device
        </Button>
      </div>
    );
  }
  return (
    <div className="mt-2 space-y-3">
      <p className="text-sm text-slate-600">
        {perm === "granted"
          ? "Your browser allows notifications from the desk, but this device isn't registered yet."
          : "Your browser will ask whether the desk may show notifications."}
      </p>
      <Button icon={<BellRing />} busy={busy === "on"} disabled={busy !== null} onClick={onTurnOn}>
        Turn on notifications on this device
      </Button>
      {failure ? (
        <p role="alert" className="notice-error rounded-lg border px-3 py-2 text-sm">
          {failure}
        </p>
      ) : (
        brave && <p className="text-xs text-slate-500">{BRAVE_HINT}</p>
      )}
    </div>
  );
}
