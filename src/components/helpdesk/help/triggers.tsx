"use client";

// The four CompassDocs triggers (1.19.0). Each is a control where the
// trouble is noticed, opening HelpRequestDialog with what the trigger
// knows: the page, the policy, the space address, the link. They render
// only when the server said the person may raise a request (trigger-server),
// so a click never ends in a refusal.

import { useState } from "react";
import { Flag, KeyRound, MessageCircleQuestion, Unlink } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import type { HdFormAnswers, HdRequestType } from "@/lib/helpdesk/types";
import { HelpRequestDialog } from "./HelpRequestDialog";

/**
 * What the trigger knows, as answers: the first text question takes the
 * context line ("Expenses policy · /doc/12"), and a choice whose option
 * matches the hint ("A policy" for a question about a policy) is chosen.
 */
function prefillAnswers(type: HdRequestType | null, text: string, choice?: RegExp): HdFormAnswers {
  const out: HdFormAnswers = {};
  if (!type) return out;
  const firstText = type.form.find((f) => f.type === "text");
  if (firstText && text) out[firstText.key] = text.slice(0, 500);
  if (choice) {
    for (const f of type.form) {
      if ((f.type !== "select" && f.type !== "choice") || !f.options) continue;
      const opt = f.options.find((o) => choice.test(o.label) || choice.test(o.value));
      if (opt) {
        out[f.key] = opt.value;
        break;
      }
    }
  }
  return out;
}

function origin(): string {
  return typeof window === "undefined" ? "" : window.location.origin;
}

/** Document page: "Report a problem with this page", in the rail under Suggest an edit. */
export function ReportPageProblem({ docId, title, type }: { docId: number; title: string; type: HdRequestType | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" icon={<Flag />} onClick={() => setOpen(true)} className="mt-2 -ml-2.5 print:hidden">
        Report a problem with this page
      </Button>
      <HelpRequestDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Report a problem with this page"
        lede={<>About &ldquo;{title}&rdquo;. The team sees the page you were on.</>}
        source="doc"
        sourceRef={{ doc_id: docId }}
        type={type}
        prefill={{ subject: `Problem with “${title}”`, answers: prefillAnswers(type, `${title} · ${origin()}/doc/${docId}`) }}
        bodyLabel="What's wrong with it?"
      />
    </>
  );
}

/** Handbook policy page: "Ask about this policy", after the confirm bar. */
export function AskAboutPolicy({
  handbookId,
  handbookTitle,
  docId,
  title,
  type,
}: {
  handbookId: number;
  handbookTitle: string;
  docId: number;
  title: string;
  type: HdRequestType | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" size="sm" icon={<MessageCircleQuestion />} onClick={() => setOpen(true)} className="print:hidden">
        Ask about this policy
      </Button>
      <HelpRequestDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Ask about this policy"
        lede={
          <>
            About &ldquo;{title}&rdquo; in {handbookTitle}. Whoever answers sees which policy you were reading.
          </>
        }
        source="handbook"
        sourceRef={{ handbook_id: handbookId, doc_id: docId }}
        type={type}
        prefill={{ subject: `Question about “${title}”`, answers: prefillAnswers(type, title, /polic/i) }}
        bodyLabel="What would you like to ask?"
        confirmLabel="Send question"
      />
    </>
  );
}

/**
 * A space address the person cannot open: "Request access". Worded the
 * same whether or not a space lives at the address, and it carries only
 * the address they already have (the slug), never an id: the not-found
 * page must not tell anyone a private space exists.
 */
export function RequestSpaceAccess({ slug, type }: { slug: string; type: HdRequestType | null }) {
  const [open, setOpen] = useState(false);
  const address = `/spaces/${slug}`;
  return (
    <>
      <Button variant="secondary" icon={<KeyRound />} onClick={() => setOpen(true)}>
        Request access
      </Button>
      <HelpRequestDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Request access"
        lede={<>For the space at {address}. Your request goes to the helpdesk, and if a space is there, the people who look after it decide.</>}
        source="space_access"
        sourceRef={{ space_slug: slug }}
        type={type}
        prefill={{ subject: `Access to ${address}`, answers: prefillAnswers(type, address) }}
        bodyLabel="Why do you need access?"
        confirmLabel="Request access"
      />
    </>
  );
}

/**
 * Quick links (the dashboard tile and the Links page): "This link is
 * broken", an icon button beside a curated link, shown on hover and focus
 * (always on a touch screen).
 */
export function BrokenLinkButton({
  linkId,
  title,
  url,
  type,
  className = "",
}: {
  linkId: number;
  title: string;
  url: string;
  type: HdRequestType | null;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-tt="Broken?"
        aria-label={`Report “${title}” as a broken link`}
        className={iconButtonClass("quiet", "sm", `print:hidden ${className}`)}
      >
        <Unlink />
      </button>
      <HelpRequestDialog
        open={open}
        onClose={() => setOpen(false)}
        title="This link is broken"
        lede={<>&ldquo;{title}&rdquo; goes to {url}. The team sees which link it is.</>}
        source="link"
        sourceRef={{ link_id: linkId }}
        type={type}
        prefill={{ subject: `Broken link: ${title}`, answers: prefillAnswers(type, `${title} · ${url}`) }}
        bodyLabel="What happens when you open it?"
        confirmLabel="Report it"
      />
    </>
  );
}
