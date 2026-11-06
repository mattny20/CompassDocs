// What the handbook reader shows (1.18.0), worked out on the server for the
// two reader routes (/handbooks/{id} and /handbooks/{id}/{docId}). The
// handbook and the policy come from lib/handbooks (which decides who may
// read them); this module adds the reader's own standing and the policy
// page's facts, reading the same rows and helpers the document page reads,
// so the reader and /doc/{id} can never disagree about a confirmation.
//
// "Handbook access opens its policies": the policy's content is rendered
// here, from the document getHandbookPolicy returned, so /doc/{id} keeps
// its own space check unchanged. Links that lead out of the handbook (the
// compare view, a related document outside it) are offered only to a
// reader who may open them. Server-only.

import "server-only";
import { cache } from "react";
import { canManage, getHandbook, getHandbookPolicy, handbookSignatureRequired, mayConfirmPolicy } from "@/lib/handbooks";
import type { Handbook, HandbookItem, HandbookPolicy } from "@/lib/handbooks";
import { requireUser } from "@/lib/auth";
import type { SessionUser } from "@/lib/types";
import type { AppSettings } from "@/lib/settings";
import type { AckSeed } from "@/components/AckState";
import type { ContentsSection } from "./HandbookContents";
import type { PolicyFact } from "./PolicyFacts";
import type { ReaderLink } from "./PolicyConfirmBar";
import {
  getAckVersionInfo,
  getCurrentAck,
  getLatestAck,
  getMyAssignment,
  getUserByUsername,
  listMyPolicies,
  listVersions,
} from "@/lib/db";
import type { MyPolicyState } from "@/lib/db";
import type { HandbookStanding } from "@/lib/handbook-confirm-shared";
import { EVERY_SPACE_UNFILTERED, scopeAllows, spaceScopeFor } from "@/lib/access";
import { featureEnabled } from "@/lib/ee";
import { getComplianceSettings } from "@/lib/compliance-settings";
import { relationsFor } from "@/lib/relations";
import { findScopeFor } from "@/lib/handbook-visibility";
import { formatDate } from "@/lib/format";
import { handbookItemsLabel, handbookKind, handbookPositionLabel, handbookTypeCounts, itemKind } from "@/lib/handbook-shared";
import type { HandbookNounKind, HandbookTypeCounts } from "@/lib/handbook-shared";

/** The reader's standing on one policy, as the status chip says it (HandbookStanding without 'info'). */
export type PolicyStanding = Exclude<HandbookStanding, "info">;

export const handbookHref = (id: number) => `/handbooks/${id}`;
export const policyHref = (id: number, docId: number) => `/handbooks/${id}/${docId}`;

/**
 * The handbook as the signed-in person may read it, once per request
 * (generateMetadata and the page share the answer, as lib/page-data does
 * for documents); undefined when it is missing or not theirs to read.
 * Readers get published items only; editors of a draft see it too.
 */
export const readerHandbook = cache(async (id: number): Promise<Handbook | undefined> => {
  if (!Number.isInteger(id) || id <= 0) return undefined;
  const user = await requireUser();
  return getHandbook(user, id);
});

/** A policy through its handbook, once per request; undefined when the handbook doesn't grant it. */
export const readerPolicy = cache(async (id: number, docId: number): Promise<HandbookPolicy | undefined> => {
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(docId) || docId <= 0) return undefined;
  const user = await requireUser();
  return getHandbookPolicy(user, id, docId);
});

/** May the signed-in person edit this handbook (the Edit button). */
export const readerCanEdit = cache(async (id: number): Promise<boolean> => canManage(await requireUser(), id));

export interface ReaderBase {
  handbook: Handbook;
  items: HandbookItem[];
  /** Read confirmation is licensed (policy_ack). */
  ackLicensed: boolean;
  /** The reader's open assignments among this handbook's policies, by document. */
  states: Map<number, MyPolicyState>;
  contents: ContentsSection[];
  progress: { confirmed: number; total: number } | null;
  /** "8 policies in 3 sections · updated Nov 2, 2026 · owned by People Ops" ("3 policies and 2 SOPs in …" for a mix). */
  subtitle: string;
  /** What the reader's view holds, by kind (1.18.2): the counts and "Policy k of N" name it. */
  mix: HandbookTypeCounts;
  /** "Confirm handbook" is offered: licensed and the handbook asks for it. */
  confirmWhole: boolean;
}

/** "1 policy" / "8 policies". */
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export async function loadReaderBase(user: SessionUser, handbook: Handbook, fmt: AppSettings): Promise<ReaderBase> {
  const items = handbook.sections.flatMap((s) => s.items);
  const ackLicensed = await featureEnabled("policy_ack");
  // The reader's own assignments, every space: a handbook can open a policy
  // whose space the reader cannot browse, and these rows are the reader's
  // own (nothing about anyone else). Narrowed to this handbook's documents.
  const ids = new Set(items.map((i) => i.doc_id));
  const states = new Map<number, MyPolicyState>();
  if (ackLicensed && ids.size > 0) {
    for (const row of await listMyPolicies(user.id, EVERY_SPACE_UNFILTERED)) {
      if (ids.has(row.id)) states.set(row.id, row.state);
    }
  }
  const contents: ContentsSection[] = handbook.sections
    .filter((s) => s.items.length > 0)
    .map((s) => ({
      id: s.id,
      number: s.number,
      title: s.title,
      items: s.items.map((i) => ({
        docId: i.doc_id,
        number: i.number,
        title: i.title,
        href: policyHref(handbook.id, i.doc_id),
        type: i.type,
        confirmed: states.get(i.doc_id) === "confirmed",
      })),
    }));
  const asked = [...states.values()];
  const progress =
    ackLicensed && asked.length > 0
      ? { confirmed: asked.filter((s) => s === "confirmed").length, total: asked.length }
      : null;
  const sectionCount = contents.length;
  const mix = handbookTypeCounts(items);
  const owner = handbook.space_id === null ? "for the whole workspace" : `owned by ${handbook.owner_label}`;
  const subtitle = [
    `${handbookItemsLabel(mix)} in ${count(sectionCount, "section", "sections")}`,
    `updated ${formatDate(handbook.updated_at, fmt)}`,
    owner,
  ].join(" · ");
  return {
    handbook,
    items,
    ackLicensed,
    states,
    contents,
    progress,
    subtitle,
    mix,
    confirmWhole: ackLicensed && handbook.confirm_whole,
  };
}

export interface PolicyView {
  docId: number;
  title: string;
  type: HandbookItem["type"];
  content: string;
  number: number;
  total: number;
  /** "Policy 2 of 5"; "SOP 2 of 5" in a handbook of SOPs, "Document 2 of 5" in a mixed one. */
  position: string;
  /** This document's own noun (policy, SOP, else document): "This SOP doesn't ask you to confirm it." */
  noun: HandbookNounKind;
  /** What the handbook holds (handbookKind of the reader's mix): the bar's "Next policy / SOP / document". */
  handbookNoun: HandbookNounKind;
  handbookOnly: boolean;
  /** The handbook it is read in: the Handbook only chip's tooltip names it. */
  handbookTitle: string;
  /** The reader's standing; null when the policy does not ask them (or read confirmation is off). */
  standing: PolicyStanding | null;
  facts: PolicyFact[];
  summaryPoints: string[];
  whatChanged: {
    rev: number | null;
    confirmedRev: number | null;
    notes: string[];
    updatedLabel: string | null;
    compareHref: string | null;
  } | null;
  /** Seeds AckProvider; null when the bar has nothing to confirm. */
  ackSeed: AckSeed | null;
  confirm: {
    /** The handbook the confirmation is made in (POST /ack's handbook_id). */
    handbookId: number;
    statement: string | undefined;
    /** A typed signature is asked (POST /ack's rule): the policy requires one, or this handbook does, or — read only through handbooks — any of the reader's handbooks holding it does. */
    signature: boolean;
    localAccount: boolean;
    signedName: string | null;
    readerName: string;
    forInformation: boolean;
  };
  prev: ReaderLink | null;
  next: ReaderLink | null;
  finish: ReaderLink | null;
  related: { href: string; title: string }[];
}

export async function loadPolicyView(
  user: SessionUser,
  base: ReaderBase,
  policy: HandbookPolicy,
  fmt: AppSettings
): Promise<PolicyView> {
  const { document: doc, item, handbook } = policy;
  const readerName = user.name || user.username;
  const [scope, versions, ackVersion] = await Promise.all([
    spaceScopeFor(user),
    listVersions(doc.id),
    getAckVersionInfo(doc.id),
  ]);
  const canOpenDoc = scopeAllows(scope, doc.space_id);

  // Read confirmation, decided exactly as the document page decides it: a
  // published, required, live policy under the licence, for a reader the
  // policy asks (an open assignment) who may submit — document.ack_submit
  // on the space, or, for a reader who reaches the policy through this
  // handbook, held anywhere with the handbook standing in for the space
  // (lib/handbooks mayConfirmPolicy, the rule POST /ack applies).
  const ackActive =
    base.ackLicensed &&
    doc.ack_required === 1 &&
    doc.status === "published" &&
    doc.branch_of === null &&
    doc.ack_retired_at === null;
  const [myAck, myRow, canSubmitAck] = ackActive
    ? await Promise.all([
        getCurrentAck(doc.id, user.id),
        getMyAssignment(doc.id, user.id),
        mayConfirmPolicy(user, doc, handbook.id),
      ])
    : [undefined, null, false];
  const asked = ackActive && canSubmitAck && myRow !== null;
  const priorAck = asked && !myAck ? await getLatestAck(doc.id, user.id) : undefined;
  const latestVersionId = ackVersion.latest_version_id ?? ackVersion.version_id ?? doc.ack_version_id;
  const latestRev = ackVersion.latest_rev ?? ackVersion.rev ?? null;

  // The version the reader confirmed, when it is older than the text on
  // screen: a lapsed confirmation (the text changed and everyone was
  // asked again) or one that still counts after a kept edit.
  const baseVersion = asked
    ? myAck
      ? myAck.version_id !== null && latestVersionId !== null && myAck.version_id !== latestVersionId
        ? { id: myAck.version_id, rev: myAck.rev }
        : null
      : priorAck && priorAck.version_id !== null
        ? { id: priorAck.version_id, rev: priorAck.rev }
        : null
    : null;
  const since = baseVersion ? versions.filter((v) => v.id > baseVersion.id) : [];
  const whatChanged =
    baseVersion && since.length > 0
      ? {
          rev: latestRev,
          confirmedRev: baseVersion.rev,
          notes: [...since].reverse().map((v) => v.note),
          updatedLabel: formatDate(since[0].created_at, fmt),
          compareHref: canOpenDoc ? `/doc/${doc.id}/history?from=${baseVersion.id}&to=current` : null,
        }
      : null;
  // The confirm page's standings (lib/handbook-confirm-shared): a counting
  // confirmation is "confirmed" even after a kept edit (the box above and
  // the bar's Re-confirm say what changed); "updated" is one that lapsed.
  const standing: PolicyStanding | null = !asked ? null : myAck ? "confirmed" : priorAck ? "updated" : "to_confirm";

  // The facts row: Owner, Approved by, Version and Effective are the
  // item's (lib/handbooks, one rule with the printed copy, so the two can
  // never disagree); the next review is the review schedule's.
  const facts: PolicyFact[] = [
    { label: "Owner", value: item.owner_name },
    { label: "Approved by", value: item.approver_name },
    { label: "Version", value: item.version !== null ? String(item.version) : "" },
    { label: "Effective", value: item.effective_at ? formatDate(item.effective_at, fmt) : "" },
    { label: "Next review", value: doc.review_due_at ? formatDate(doc.review_due_at, fmt) : "" },
    { label: "Applies to", value: item.applies_to || "" },
  ];

  const complianceSettings = asked ? await getComplianceSettings() : null;
  // The typed signature, exactly when POST /ack will demand it: the
  // policy's own, or this handbook's "Require a typed signature" (the bar
  // sends handbook_id), or — for a reader who has the policy ONLY through
  // handbooks (no space access: documentReadVia 'handbook') — any published
  // handbook of theirs that holds it with the switch on
  // (handbookSignatureRequired), whichever handbook it is read in.
  const signature =
    asked &&
    (doc.ack_signature === 1 ||
      handbook.require_signature ||
      (!canOpenDoc && (await handbookSignatureRequired(user, doc.id))));
  const localAccount = signature ? Boolean((await getUserByUsername(user.username))?.password_hash) : false;

  // Related documents (the document's own typed relations), published
  // only: one inside this handbook opens here, whatever its space; one
  // outside it is listed only when the reader may open its own page.
  const inHandbook = new Set(base.items.map((i) => i.doc_id));
  const [allRelated, visibleRelated] = await Promise.all([
    relationsFor(doc.id, EVERY_SPACE_UNFILTERED, false),
    // Outside the handbook, the reader's own listing rule (H6): a
    // handbook-only document they do not look after is not offered.
    relationsFor(doc.id, scope, false, await findScopeFor(user)),
  ]);
  const visible = new Set(visibleRelated.map((r) => r.id));
  const related: { href: string; title: string }[] = [];
  for (const r of allRelated) {
    if (r.id === doc.id || related.some((x) => x.title === r.title && x.href.endsWith(`/${r.id}`))) continue;
    if (inHandbook.has(r.id)) related.push({ href: policyHref(handbook.id, r.id), title: r.title });
    else if (visible.has(r.id)) related.push({ href: `/doc/${r.id}`, title: r.title });
  }

  const toLink = (i: HandbookItem | null): ReaderLink | null =>
    i ? { href: policyHref(handbook.id, i.doc_id), label: i.title } : null;

  return {
    docId: doc.id,
    title: doc.title,
    type: doc.type,
    content: doc.content,
    number: item.number,
    total: base.items.length,
    position: handbookPositionLabel(base.mix, item.number, base.items.length),
    noun: itemKind(doc.type),
    handbookNoun: handbookKind(base.mix),
    handbookOnly: item.effective_find_mode === "handbook_only",
    handbookTitle: handbook.title,
    standing,
    facts,
    summaryPoints: item.summary_points ?? [],
    whatChanged,
    ackSeed: asked
      ? {
          ackedAt: myAck?.acknowledged_at ?? null,
          ackedVersionId: myAck?.version_id ?? null,
          ackedRev: myAck?.rev ?? null,
          versionId: latestVersionId,
          rev: latestRev,
          canSubmit: canSubmitAck,
          prior: null,
        }
      : null,
    confirm: {
      handbookId: handbook.id,
      statement: asked ? (doc.ack_statement ?? complianceSettings?.compliance_statement_default) : undefined,
      signature,
      localAccount,
      signedName: myAck?.signed_name ?? null,
      readerName,
      forInformation: base.ackLicensed && !asked,
    },
    prev: toLink(policy.prev),
    next: toLink(policy.next),
    finish: !policy.next && base.confirmWhole ? { href: `${handbookHref(handbook.id)}/confirm`, label: "Confirm handbook" } : null,
    related,
  };
}
