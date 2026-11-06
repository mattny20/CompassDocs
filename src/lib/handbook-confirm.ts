// Confirm the whole handbook (1.18.0): one statement, one optional
// signature, and every policy in the handbook that is waiting for this
// person is confirmed against its current version, exactly as its own
// card would have done it.
//
// Exactly as the card: each row is written by recordAcknowledgement, the
// one writer POST /api/documents/[id]/ack uses (the same row, the same
// stale rule, the same content hash), and each recorded row is echoed by
// auditAck("document.acknowledge") with the details that route writes,
// plus `via: "handbook"` and the handbook's id. A per-document
// confirmation queues no notice and fires no channel event, so neither
// does this. The gates are the card's too: a published, required,
// non-branch, unretired policy, document.ack_submit (on its space, or held
// anywhere with this handbook's grant standing in for the space:
// lib/handbooks mayConfirmPolicy, the rule POST /ack applies) and an open
// assignment row (the audience). Anything else in the handbook is "For
// information" and is never written. Reading the policy is the handbook's
// grant (lib/handbooks), not the space's, so a reader outside the space
// confirms here what the handbook let them read.
//
// The statement: the reader ticks one box. A policy that asks in its own
// words (documents.ack_statement, when it differs from the handbook's
// sentence) is listed under the handbook's statement, and the box covers
// those too; its row stores its own statement, as its card would have.
// Every other row stores the handbook's statement.
//
// The typed signature is lib/attestation's verifyAttestation, called ONCE
// for the batch (one password check, one throttle hit per attempt). It is
// asked when any outstanding policy requires a signature or the
// handbook's own "Require a typed signature" is on, and a signed batch
// stores the name on every row it writes. A policy the person reads ONLY
// through handbooks also requires one when any published handbook of
// theirs that holds it has the switch on (lib/handbooks
// handbookSignatureRequired, the rule POST /ack applies), so confirming it
// here, in a handbook with the switch off, does not step around that. A wrong password is on the
// record as the card's route records it (auth.login_failed with via
// "attestation", auth.lockout when it engaged the throttle), against the
// handbook.
//
// Transaction safety without pool starvation: recordAcknowledgement takes
// a pool client of its own for its transaction, so this module never holds
// one while calling it (the requestAcknowledgement lesson: a client held
// across a call that takes another starves a five-connection pool under
// load). Every check that can refuse runs BEFORE the first write: the
// licence, the handbook, the ticked statement, the versions the page
// showed (any outstanding policy whose current version differs answers
// 409 stale and nothing is written), the statement and contents
// fingerprint the page showed (1.18.2: either differing from the server's
// is 409 stale too) and the signature. The writes then run
// one policy at a time, each in its own transaction, and each is
// idempotent (a double submit, or a retry, records nothing for a policy
// already current). The one window left, a policy republished between the
// check and its own write, is reported per policy (stale) without undoing
// the rows already written, which are valid confirmations of current
// versions; the handbook-level record is written only when nothing is left
// waiting.
//
// Server-only.

import "server-only";
import {
  getDocument,
  getCurrentAck,
  getLatestAck,
  getAckVersionInfo,
  getMyAssignment,
  recordAcknowledgement,
  getUserByUsername,
} from "./db";
import type { AckIdentityProof } from "./db";
import { featureEnabled } from "./ee";
import { audit, auditAck, actorFrom } from "./audit";
import { readSecondsSince } from "./analytics";
import { verifyAttestation, signedNameFrom } from "./attestation";
import {
  documentReadVia,
  getHandbook,
  handbookConfirmedAt,
  handbookSignatureRequired,
  mayConfirmPolicy,
  recordHandbookConfirmation,
} from "./handbooks";
import type { Handbook, HandbookItem } from "./handbooks";
import {
  CONFIRM_ALREADY,
  CONFIRM_NOT_ASKED,
  CONFIRM_TICK_FIRST,
  CONFIRM_UNLICENSED,
  confirmStale,
  handbookStatementFor,
} from "./handbook-confirm-shared";
import type { ConfirmItem, ConfirmResult, HandbookConfirmView } from "./handbook-confirm-shared";
import { handbookTypeCounts } from "./handbook-shared";
import type { DocumentWithSpace, SessionUser } from "./types";

export * from "./handbook-confirm-shared";

export type ConfirmInput = {
  agreed?: unknown;
  /** The version each outstanding policy showed on the page: { [doc_id]: version_id }. */
  versions?: unknown;
  /**
   * The statement printed beside the box the person ticked (the view's
   * `statement`, 1.18.2). Compared with the one the server would store; a
   * difference is stale and nothing is written.
   */
  statement?: unknown;
  /** The contents fingerprint the page was drawn with (the view's handbook.fingerprint). */
  fingerprint?: unknown;
  signed_name?: unknown;
  password?: unknown;
};

export type ConfirmOutcome = ConfirmResult | { ok: false; status: 400 | 402 | 404 | 409 | 429; error: string; stale?: true };

// --- The handbook-level record -------------------------------------------------------
// handbook_confirmations belongs to lib/handbooks: recordHandbookConfirmation
// writes it (and refuses contents that no longer match the fingerprint),
// handbookConfirmedAt reads it. The handbook.confirmed audit row is ours.

/** The reader's newest record of these exact contents (fingerprint), or null. */
export async function getHandbookConfirmation(
  handbookId: number,
  userId: number,
  fingerprint: string
): Promise<{ at: string } | null> {
  const at = await handbookConfirmedAt(handbookId, userId, fingerprint);
  return at ? { at } : null;
}

// --- Reads ---------------------------------------------------------------------------

/**
 * At most this many policies are measured at once. Each measurement runs a
 * few queries; the pool has five connections, and a long handbook must
 * never take all of them from the rest of the app.
 */
const STANDING_CONCURRENCY = 2;

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

interface Measured {
  item: ConfirmItem;
  doc: DocumentWithSpace | undefined;
}

/**
 * One policy, measured the way the document page decides whether to show
 * its card (ackActive, document.ack_submit on the space, an open row) and
 * what the card says (getCurrentAck, else getLatestAck for a lapse).
 */
async function measure(
  user: SessionUser,
  handbook: Pick<Handbook, "id">,
  it: HandbookItem,
  sectionTitle: string,
  ackEnabled: boolean,
  statement: string
): Promise<Measured> {
  const base: ConfirmItem = {
    doc_id: it.doc_id,
    number: it.number,
    title: it.title,
    type: it.type,
    section_title: sectionTitle,
    space_name: it.space_name,
    standing: "info",
    version_id: null,
    rev: null,
    signature: false,
    statement: null,
    confirmed_at: null,
  };
  if (!ackEnabled) return { item: base, doc: undefined };
  const doc = await getDocument(it.doc_id);
  const active =
    doc !== undefined &&
    !doc.deleted_at &&
    doc.ack_required === 1 &&
    doc.status === "published" &&
    doc.branch_of === null &&
    doc.ack_retired_at === null;
  if (!doc || !active) return { item: base, doc };
  const [canSubmit, row] = await Promise.all([
    mayConfirmPolicy(user, doc, handbook.id),
    getMyAssignment(doc.id, user.id),
  ]);
  if (!canSubmit || !row) return { item: { ...base, title: doc.title }, doc };
  const [current, version, via] = await Promise.all([
    getCurrentAck(doc.id, user.id),
    getAckVersionInfo(doc.id),
    doc.ack_signature === 1 ? Promise.resolve(null) : documentReadVia(user, doc),
  ]);
  const signature = doc.ack_signature === 1 || (via === "handbook" && (await handbookSignatureRequired(user, doc.id)));
  const prior = current ? undefined : await getLatestAck(doc.id, user.id);
  const own = doc.ack_statement?.trim() ?? "";
  return {
    doc,
    item: {
      ...base,
      title: doc.title,
      standing: current ? "confirmed" : prior ? "updated" : "to_confirm",
      // Its own words, when they are not the handbook's: listed on the page
      // and stored on its row. Only while it is waiting (a confirmed policy
      // is not confirmed again).
      statement: !current && own !== "" && own !== statement ? own : null,
      // The text on screen is the newest version: the card cites it (POST
      // /ack answers stale otherwise), never the marker after a kept edit.
      version_id: version.latest_version_id ?? version.version_id ?? doc.ack_version_id,
      rev: version.latest_rev ?? version.rev,
      signature,
      confirmed_at: current?.acknowledged_at ?? null,
    },
  };
}

async function measureAll(user: SessionUser, handbook: Handbook): Promise<Measured[]> {
  const ackEnabled = await featureEnabled("policy_ack");
  const flat = handbook.sections.flatMap((s) => s.items.map((it) => ({ it, section: s.title })));
  // The type does not decide whether a document asks: a policy, an SOP or
  // any other document that requires confirmation is measured the same.
  const statement = handbookStatementFor(handbook.title, flat.map(({ it }) => it));
  return mapLimited(flat, STANDING_CONCURRENCY, ({ it, section }) =>
    measure(user, handbook, it, section, ackEnabled, statement)
  );
}

const isOutstanding = (i: ConfirmItem) => i.standing === "to_confirm" || i.standing === "updated";

function viewFrom(
  handbook: Handbook,
  measured: Measured[],
  localAccount: boolean,
  confirmed: HandbookConfirmView["confirmed"]
): HandbookConfirmView {
  const items = measured.map((m) => m.item);
  const outstanding = items.filter(isOutstanding);
  const counts = {
    total: items.length,
    confirmed: items.filter((i) => i.standing === "confirmed").length,
    to_confirm: items.filter((i) => i.standing === "to_confirm").length,
    updated: items.filter((i) => i.standing === "updated").length,
    info: items.filter((i) => i.standing === "info").length,
    outstanding: outstanding.length,
  };
  const policies = outstanding.filter((i) => i.signature).map((i) => i.title);
  return {
    handbook: {
      id: handbook.id,
      title: handbook.title,
      confirm_whole: handbook.confirm_whole,
      require_signature: handbook.require_signature,
      fingerprint: handbook.fingerprint,
    },
    items,
    counts,
    statement: handbookStatementFor(handbook.title, items),
    own_statements: outstanding
      .filter((i) => i.statement !== null)
      .map((i) => ({ doc_id: i.doc_id, title: i.title, statement: i.statement! })),
    signature: {
      required: policies.length > 0 || handbook.require_signature,
      policies,
      handbook: handbook.require_signature,
      local_account: localAccount,
    },
    // A record of other contents (a policy added, a version since) is not
    // this one: the reader is asked again.
    confirmed: outstanding.length === 0 ? confirmed : null,
  };
}

async function hasPassword(user: SessionUser): Promise<boolean> {
  return Boolean((await getUserByUsername(user.username))?.password_hash);
}

/**
 * The confirm page's data, or undefined when the person may not read the
 * handbook or it is not published (readers confirm what everyone reads,
 * never an editor's draft).
 */
export async function loadConfirmView(user: SessionUser, handbookId: number): Promise<HandbookConfirmView | undefined> {
  const handbook = await getHandbook(user, handbookId);
  if (!handbook || handbook.status !== "published") return undefined;
  const measured = await measureAll(user, handbook);
  const [local, confirmed] = await Promise.all([
    hasPassword(user),
    getHandbookConfirmation(handbook.id, user.id, handbook.fingerprint),
  ]);
  return viewFrom(handbook, measured, local, confirmed);
}

// --- The write -------------------------------------------------------------------------

/** { "12": 345 } → Map(12 → 345); anything malformed is left out, so it reads as stale. */
function versionsFrom(raw: unknown): Map<number, number> {
  const out = new Map<number, number>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const id = Number(k);
    if (Number.isInteger(id) && typeof v === "number" && Number.isInteger(v)) out.set(id, v);
  }
  return out;
}

/** Whether the statement and fingerprint the page posted are the ones the server computes now (see confirmHandbook). */
function shownMatches(input: ConfirmInput, view: HandbookConfirmView): boolean {
  const hasStatement = typeof input.statement === "string";
  const hasFingerprint = typeof input.fingerprint === "string";
  if (!hasStatement && !hasFingerprint) return false;
  if (hasStatement && input.statement !== view.statement) return false;
  if (hasFingerprint && input.fingerprint !== view.handbook.fingerprint) return false;
  return true;
}

/**
 * Confirm every outstanding policy in the handbook for this person, then
 * record the handbook itself. The caller takes the password out of
 * whatever it logs; this function never logs, audits or returns it.
 */
export async function confirmHandbook(
  user: SessionUser,
  handbookId: number,
  input: ConfirmInput,
  ctx: { ip: string | null; userAgent: string }
): Promise<ConfirmOutcome> {
  if (!(await featureEnabled("policy_ack"))) return { ok: false, status: 402, error: CONFIRM_UNLICENSED };

  const handbook = await getHandbook(user, handbookId);
  if (!handbook || handbook.status !== "published") return { ok: false, status: 404, error: "Not found." };
  if (!handbook.confirm_whole) return { ok: false, status: 400, error: CONFIRM_NOT_ASKED };
  if (input.agreed !== true) return { ok: false, status: 400, error: CONFIRM_TICK_FIRST };

  const measured = await measureAll(user, handbook);
  const view = viewFrom(handbook, measured, false, null);
  const outstanding = measured.filter((m) => isOutstanding(m.item));
  // Nothing waiting and these contents already on record: a second
  // submit. Answered, never written twice.
  if (outstanding.length === 0 && (await getHandbookConfirmation(handbook.id, user.id, handbook.fingerprint))) {
    return { ok: false, status: 409, error: CONFIRM_ALREADY };
  }

  // The versions the page showed. Every outstanding policy must have been
  // on the page at its current version: a policy that changed, or one that
  // started asking this person after the page was drawn, answers stale
  // and nothing is written (the card's rule, for the whole list at once).
  const shown = versionsFrom(input.versions);
  if (outstanding.some((m) => shown.get(m.item.doc_id) !== m.item.version_id)) {
    return { ok: false, status: 409, stale: true, error: confirmStale(handbookTypeCounts(view.items)) };
  }
  // The statement and the contents the page showed. The statement is
  // stored on every row below, so it must be the sentence the person
  // ticked: contents changed since the page was drawn (a document added
  // for information, a type changed) would otherwise store words, and a
  // fingerprint, they never saw. A client that sends only the fingerprint
  // is checked on it alone; one that sends neither (a tab opened before
  // this release) is stale, so it refreshes into a page that sends both.
  if (!shownMatches(input, view)) {
    return { ok: false, status: 409, stale: true, error: confirmStale(handbookTypeCounts(view.items)) };
  }

  // The signature, once for the batch, before anything is written.
  let signedName: string | null = null;
  let identityProof: AckIdentityProof | "" = "";
  if (view.signature.required) {
    const signed = await verifyAttestation(user, { signed_name: input.signed_name, password: input.password }, { ip: ctx.ip });
    if (!signed.ok) {
      if (signed.code === "password") {
        // The rows the sign-in form writes on a miss, against the handbook
        // being signed; `signed` never carries the password.
        const target = { targetType: "handbook", targetId: handbook.id, targetLabel: handbook.title };
        await audit({ actor: actorFrom(user), action: "auth.login_failed", ...target, details: { via: "attestation" }, ip: ctx.ip });
        if (signed.lock_engaged) {
          await audit({ actor: actorFrom(user), action: "auth.lockout", ...target, details: { minutes: 15 }, ip: ctx.ip });
        }
      }
      return { ok: false, status: signed.status, error: signed.error };
    }
    signedName = signedNameFrom(input.signed_name);
    identityProof = signed.identity_proof;
  }

  // The writes: one policy at a time, each through the card's own writer
  // in its own transaction. No client is held here across them.
  const userAgent = ctx.userAgent.slice(0, 300);
  const ip = ctx.ip ?? "";
  let confirmed = 0;
  const stale: number[] = [];
  for (const { item, doc } of outstanding) {
    if (!doc || item.version_id === null) {
      stale.push(item.doc_id);
      continue;
    }
    const readSeconds = await readSecondsSince(doc.id, user.id, doc.ack_revision_at ?? null);
    const result = await recordAcknowledgement(doc.id, user.id, ip, item.version_id, {
      readSeconds,
      // The card's self-reported latch belongs to the card; this page saw
      // no policy's end, so the row says false.
      reachedEnd: false,
      // What the person agreed to, as this server serves it: the policy's
      // own words when the page listed them under the box they ticked,
      // else the handbook's statement, the sentence beside the box.
      statementText: item.statement ?? view.statement,
      signedName,
      identityProof,
      userAgent,
    });
    if (result.stale) {
      stale.push(doc.id);
      continue;
    }
    if (!result.recorded) continue; // already current (a concurrent submit): nothing new to echo
    confirmed++;
    const ack = await getCurrentAck(doc.id, user.id);
    await auditAck("document.acknowledge", doc, {
      actor: actorFrom(user),
      ip: ctx.ip,
      version_id: ack?.version_id ?? item.version_id,
      version: ack?.rev ?? item.rev,
      content_sha256: ack?.content_sha256 ?? null,
      details: {
        user_agent: userAgent,
        signed_name: signedName,
        identity_proof: identityProof,
        via: "handbook",
        handbook_id: handbook.id,
      },
    });
  }

  // The handbook-level record, for reporting: once nothing that asks this
  // person is left waiting, of the contents that were measured and checked
  // above (handbook.fingerprint). recordHandbookConfirmation writes nothing
  // when the handbook changed since (a policy added, a new version: a
  // record of contents nobody showed this person), and nothing twice: one
  // record per contents and person (a concurrent submit wins, its row is
  // the record; the rows above are idempotent on their own).
  let handbookConfirmed = false;
  if (stale.length === 0) {
    const exists = await getHandbookConfirmation(handbook.id, user.id, handbook.fingerprint);
    const written = exists
      ? null
      : await recordHandbookConfirmation({
          handbook_id: handbook.id,
          user_id: user.id,
          fingerprint: handbook.fingerprint,
          user_name: user.name || user.username,
          policies_confirmed: confirmed,
          signed_name: signedName,
          ip: ip.slice(0, 100),
          user_agent: userAgent,
        });
    if (written) {
      handbookConfirmed = true;
      await audit({
        actor: actorFrom(user),
        action: "handbook.confirmed",
        targetType: "handbook",
        targetId: handbook.id,
        targetLabel: handbook.title,
        details: {
          fingerprint: handbook.fingerprint,
          policies: view.counts.total,
          asked: view.counts.total - view.counts.info,
          confirmed,
          signed_name: signedName,
          identity_proof: identityProof,
          user_agent: userAgent,
        },
        ip: ctx.ip,
      });
    }
  }

  return { ok: true, confirmed, outstanding: stale.length, stale, handbook_confirmed: handbookConfirmed };
}
