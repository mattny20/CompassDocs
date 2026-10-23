"use client";

// The download landing page's working part (1.15.0). On arrival it asks the
// export route for the file with the visitor's own session, then hands the
// bytes to the browser as a download (an object URL on an <a download>), so
// the page knows when the file has arrived and can say so, and the visitor
// stays here with a way back home. A refusal (rate limit, no access, a
// preset removed since the link went out) is said in words with a way to
// try again; a session that ran out goes back through sign-in. A plain
// link to the same file sits under the status for a browser that blocks
// the automatic download, or with JavaScript off.

import { useCallback, useEffect, useRef, useState } from "react";
import { CircleCheck, Download, Home, RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/Button";
import { Spinner } from "@/components/Spinner";
import { exportLinkApiPath, filenameFromDisposition, type ExportLinkFormat } from "@/lib/directory-export-link";
import { loginHref } from "@/lib/return-to";

type State =
  | { kind: "working" }
  | { kind: "done"; filename: string }
  | { kind: "error"; message: string };

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
  const started = useRef(false);
  const api = exportLinkApiPath(presetId, format);

  const run = useCallback(async () => {
    setState({ kind: "working" });
    let res: Response;
    try {
      res = await fetch(api, { credentials: "same-origin", cache: "no-store" });
    } catch {
      setState({ kind: "error", message: "The download could not reach CompassDocs. Check your connection and try again." });
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
      setState({ kind: "error", message });
      return;
    }
    const filename = filenameFromDisposition(res.headers.get("content-disposition"), fallbackName);
    const blob = await res.blob();
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
    setState({ kind: "done", filename });
  }, [api, fallbackName]);

  useEffect(() => {
    // Once per visit (React runs effects twice in development).
    if (started.current) return;
    started.current = true;
    void run();
  }, [run]);

  return (
    <div className="rounded-xl border border-slate-200 bg-surface px-4 py-10 text-center shadow-xs">
      <div role="status" aria-live="polite" className="mx-auto flex max-w-md flex-col items-center gap-3">
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
              <span className="font-medium text-slate-700 [overflow-wrap:anywhere]">{state.filename}</span> is in your downloads folder.
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
          <Button variant="secondary" icon={state.kind === "error" ? <RotateCcw /> : <Download />} onClick={() => void run()}>
            {state.kind === "error" ? "Try again" : "Download again"}
          </Button>
        )}
      </div>
      {state.kind === "working" && (
        <p className="mt-4 text-xs text-slate-500">
          Nothing happening?{" "}
          <a href={api} download className="font-medium text-compass-700 hover:underline">
            Download it directly
          </a>
          .
        </p>
      )}
    </div>
  );
}
