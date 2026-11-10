"use client";

// The desk's help addresses (1.20.2, lib/helpdesk/mailboxes) as the queue
// needs them: the Filter dialog's Address choice and the address beside a
// ticket's requester, both shown only while more than one is listed. One
// read per page load, shared by every caller; the Email settings page
// forgets it after a change.

import { useEffect, useState } from "react";
import type { HdMailboxOption } from "@/lib/helpdesk/mailboxes-shared";
import { getJson, listOf } from "./api";

let cache: Promise<HdMailboxOption[]> | null = null;

function load(): Promise<HdMailboxOption[]> {
  cache ??= getJson("/api/helpdesk/mailboxes")
    .then((d) => listOf<HdMailboxOption>(d, "mailboxes"))
    .catch(() => {
      cache = null;
      return [];
    });
  return cache;
}

/** Forget the list (after the Email settings page changed it). */
export function forgetDeskMailboxes(): void {
  cache = null;
}

/** The listed addresses ([] until loaded, and for anyone who may not read them). */
export function useDeskMailboxes(): HdMailboxOption[] {
  const [list, setList] = useState<HdMailboxOption[]>([]);
  useEffect(() => {
    let live = true;
    void load().then((l) => live && setList(l));
    return () => {
      live = false;
    };
  }, []);
  return list;
}
