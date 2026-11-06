"use client";

// Hands the account's single-key preference to the desk's shortcuts
// (hotkeys.ts) from the server layout.

import type { ReactNode } from "react";
import { SingleKeyContext } from "./hotkeys";

export function DeskKeysProvider({ singleKey, children }: { singleKey: boolean; children: ReactNode }) {
  return <SingleKeyContext.Provider value={singleKey}>{children}</SingleKeyContext.Provider>;
}
