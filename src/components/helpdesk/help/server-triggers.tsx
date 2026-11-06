// Server wrappers for the triggers that sit deep in a page with no user in
// hand (1.19.0): each asks trigger-server whether the person may raise a
// request and renders nothing otherwise. Async server components.

import { helpTrigger } from "./trigger-server";
import { AskAboutPolicy, RequestSpaceAccess } from "./triggers";

/** The handbook reader's policy page: "Ask about this policy". */
export async function AskAboutPolicyTrigger(props: { handbookId: number; handbookTitle: string; docId: number; title: string }) {
  const setup = await helpTrigger(null, "handbook");
  if (!setup) return null;
  return (
    <div className="mt-3.5 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-slate-500 print:hidden">
      <span>Not sure what this means for you?</span>
      <AskAboutPolicy {...props} type={setup.type} />
    </div>
  );
}

/**
 * The shell's not-found page, on a space address (/spaces/{slug}) only:
 * "Request access". Shown alike whether a space lives there or not (the
 * same page, the same words, and only the slug the person already typed or
 * was sent), so it tells nobody that a private space exists. The request
 * carries the slug; the helpdesk resolves it.
 */
export async function SpaceAccessOffer({ path }: { path: string }) {
  const m = path.split(/[?#]/)[0].match(/^\/spaces\/([^/]+)\/?$/);
  if (!m) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  if (!/^[\p{L}\p{N}_-]{1,100}$/u.test(slug)) return null;
  const setup = await helpTrigger(null, "space_access");
  if (!setup) return null;
  return (
    <div className="mx-auto mt-6 flex max-w-lg flex-col items-center gap-3 border-t border-slate-100 pt-6">
      <p className="text-sm text-slate-500">If this is a space you need for your work, you can ask for access.</p>
      <RequestSpaceAccess slug={slug} type={setup.type} />
    </div>
  );
}
