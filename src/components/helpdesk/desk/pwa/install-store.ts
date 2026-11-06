"use client";

// The browser's install offer (Chromium's beforeinstallprompt), caught as
// soon as the desk loads (PwaHead) and kept here, so the Install Desk menu
// row and card can use it whenever the agent asks. Module state shared by
// the desk's client components; useSyncExternalStore reads it.

import { useSyncExternalStore } from "react";

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

interface InstallState {
  /** The deferred Chromium prompt, when the browser offered one. */
  prompt: BeforeInstallPromptEvent | null;
  /** Installed during this visit (appinstalled) or running installed. */
  installed: boolean;
  /** The how-to dialog (hosted once by PwaHead, so a closing menu cannot take it down). */
  dialog: boolean;
}

let state: InstallState = { prompt: null, installed: false, dialog: false };
const listeners = new Set<() => void>();
const SERVER: InstallState = { prompt: null, installed: false, dialog: false };

function set(next: Partial<InstallState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

export function offerInstall(e: BeforeInstallPromptEvent) {
  set({ prompt: e });
}

export function openInstallDialog() {
  set({ dialog: true });
}

export function closeInstallDialog() {
  set({ dialog: false });
}

export function markInstalled() {
  set({ prompt: null, installed: true });
}

/** Show the browser's own install dialog; resolves to whether the agent accepted. */
export async function runInstallPrompt(): Promise<boolean> {
  const p = state.prompt;
  if (!p) return false;
  set({ prompt: null });
  await p.prompt();
  const choice = await p.userChoice.catch(() => ({ outcome: "dismissed" as const }));
  if (choice.outcome === "accepted") markInstalled();
  return choice.outcome === "accepted";
}

export function useInstallState(): InstallState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => SERVER
  );
}
