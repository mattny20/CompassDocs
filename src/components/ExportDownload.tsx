"use client";

// The download landing page's working part (1.15.0). On arrival it asks the
// export route for the file with the visitor's own session, then hands the
// bytes to the browser as a download (an object URL on an <a download>), so
// the page knows when the file has arrived and can say so, and the visitor
// stays here with a way back home. A refusal (rate limit, no access, a
// preset removed since the link went out) or a transfer cut off half way
// is said in words with Try again; a session that ran out goes back through
// sign-in. A plain link to the same file sits under the status, while the
// file is made and after, for a browser that blocks the automatic download
// (or with JavaScript off); using it stops the page's own request, so the
// file comes once.
//
// Once a visit has downloaded, the history entry remembers it: Back to this
// page from home shows "Downloaded" again instead of fetching another copy.
// Opening the link afresh (a new history entry) downloads as usual.

import { useCallback, useEffect, useRef, useState } from "react";
import { CircleCheck, Download, Home, RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/Button";
import { Spinner } from "@/components/Spinner";
import { exportLinkApiPath, filenameFromDisposition, type ExportLinkFormat } from "@/lib/directory-export-link";
import { loginHref } from "@/lib/return-to";

type State =
  | { kind: "working" }
  /** `filename` is unknown when the visitor took the direct link. */
  | { kind: "done"; filename?: string }
  | { kind: "error"; message: string };

/** The key this page keeps in its history entry once it has downloaded. */
const HISTORY_KEY = "compassDirectoryDownload";

function rememberedDownload(api: string): string | null {
  try {
    const mark = (window.history.state as Record<string, unknown> | null)?.[HISTORY_KEY] as
      | { api?: string; filename?: string }
      | undefined;
    return mark?.api === api ? (mark.filename ?? "") : null;
  } catch {
    return null;
  }
}

function rememberDownload(api: string, filename: string) {
  try {
    // Next keeps its own keys in history.state; they are carried over.
    window.history.replaceState({ ...(window.history.state ?? {}), [HISTORY_KEY]: { api, filename } }, "");
  } catch {
    // Remembering is a convenience: without it, Back downloads again.
  }
}

export function ExportDownload({
  presetId,
  format,
  fileLabel,
  fallbackName,
}: {
  presetId: string;
  format: ExportLinkFormat;
  /** What the file is, in words ("PDF", "CSV spreadsheet"). */
  fileLabel: string;
  /** The file name to use when the response does not name one. */
  fallbackName: string;
}) {
  const [state, setState] = useState<State>({ kind: "working" });
  const inflight = useRef<AbortController | null>(null);
  // Set when the visitor pressed Try again / Download again: that button
  // goes while the file is made, so focus moves to the status once it lands.
  const retried = useRef(false);
  const statusRef = useRef<HTMLDivElement>(null);
  const api = exportLinkApiPath(presetId, format);

  const run = useCallback(async () => {
    inflight.current?.abort();
    const ctl = new AbortController();
    inflight.current = ctl;
    setState({ kind: "working" });
    const fail = (message: string) => {
      if (!ctl.signal.aborted) setState({ kind: "error", message });
    };
    let res: Response;
    try {
      res = await fetch(api, { credentials: "same-origin", cache: "no-store", signal: ctl.signal });
    } catch {
      fail("The download could not reach CompassDocs. Check your connection and try again.");
      return;
    }
    // The session ran out between the page and the file: through sign-in and
    // back here, which starts the download again.
    if (res.status === 401) {
      window.location.assign(loginHref(window.location.pathname + window.location.search));
      return;
    }
    if (!res.ok) {
      let message = "The file could not be made. Try again in a moment.";
      if (res.status === 403) message = "Your account can't export the directory. Ask an administrator for access.";
      else {
        try {
          const body = (await res.json()) as { error?: unknown };
          if (typeof body.error === "string" && body.error) message = body.error;
        } catch {
          // keep the general sentence
        }
      }
      fail(message);
      return;
    }
    const filename = filenameFromDisposition(res.headers.get("content-disposition"), fallbackName);
    let blob: Blob;
    try {
      blob = await res.blob();
    } catch {
      fail("The download was cut off before it finished. Check your connection and try again.");
      return;
    }
    // Left the page, or took the direct link, while the file was on its way.
    if (ctl.signal.aborted) return;
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Long enough for the browser to have taken the bytes.
    setTimeout(() => URL.revokeObjectURL(href), 60_000);
    inflight.current = null;
    rememberDownload(api, filename);
    setState({ kind: "done", filename });
  }, [api, fallbackName]);

  useEffect(() => {
    const earlier = rememberedDownload(api);
    if (earlier !== null) setState({ kind: "done", filename: earlier || undefined });
    else void run();
    // Leaving the page stops a file still being made. (Development's double
    // effect aborts the first request here and the second one downloads.)
    return () => inflight.current?.abort();
  }, [api, run]);

  useEffect(() => {
    if (state.kind === "working" || !retried.current) return;
    retried.current = false;
    statusRef.current?.focus({ preventScroll: true });
  }, [state.kind]);

  function retry() {
    retried.current = true;
    void run();
  }

  /** The direct link was used: the browser fetches the file itself, so the page's own request stops. */
  function tookDirect() {
    if (state.kind !== "working") return;
    inflight.current?.abort();
    inflight.current = null;
    rememberDownload(api, "");
    setState({ kind: "done" });
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-surface px-4 py-10 text-center shadow-xs">
      <div
        ref={statusRef}
        role="status"
        aria-live="polite"
        tabIndex={-1}
        className="mx-auto flex max-w-md flex-col items-center gap-3"
      >
        {state.kind === "working" && (
          <>
            <Spinner size="lg" className="text-compass-600" />
            <p className="text-base font-semibold text-slate-800">Preparing your {fileLabel}…</p>
            <p className="text-sm text-slate-500">It downloads as soon as it is ready; a large directory takes a few seconds.</p>
          </>
        )}
        {state.kind === "done" && (
          <>
            <CircleCheck className="h-8 w-8 text-emerald-600" aria-hidden />
            <p className="text-base font-semibold text-slate-800">Downloaded</p>
            <p className="text-sm text-slate-500">
              {state.filename ? (
                <>
                  <span className="font-medium text-slate-700 [overflow-wrap:anywhere]">{state.filename}</span> is in your
                  downloads folder.
                </>
              ) : (
                "The file is in your downloads folder."
              )}
            </p>
          </>
        )}
        {state.kind === "error" && (
          <>
            <TriangleAlert className="h-8 w-8 text-amber-600" aria-hidden />
            <p className="text-base font-semibold text-slate-800">The download didn&rsquo;t start</p>
            <p className="text-sm text-slate-500">{state.message}</p>
          </>
        )}
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <Button href="/" variant={state.kind === "working" ? "secondary" : "primary"} icon={<Home />}>
          Back to home
        </Button>
        {state.kind !== "working" && (
          <Button variant="secondary" icon={state.kind === "error" ? <RotateCcw /> : <Download />} onClick={retry}>
            {state.kind === "error" ? "Try again" : "Download again"}
          </Button>
        )}
      </div>
      {state.kind !== "error" && (
        <p className="mt-4 text-xs text-slate-500">
          {state.kind === "working" ? "Nothing happening?" : "Not in your downloads?"}{" "}
          <a href={api} download onClick={tookDirect} className="link font-medium">
            Download it directly
          </a>
          .
        </p>
      )}
    </div>
  );
}
