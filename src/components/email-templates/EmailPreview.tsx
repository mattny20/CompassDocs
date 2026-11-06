"use client";

// The live preview of a composed email (1.19.0, STYLEGUIDE §Email templates
// in parts): the subject line over the rendered message in a sandboxed
// iframe, at a desktop or a phone width. The HTML is the preview route's
// own render of the real mail (header, body, signature and footer with
// sample values), so what the admin sees is what a recipient's mail client
// gets. The frame runs no script (sandbox without allow-scripts) and is
// `inert`; allow-same-origin only lets this page measure the document's
// height so the frame grows to fit the message instead of scrolling.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Monitor, Smartphone } from "lucide-react";
import { Segmented } from "@/components/Segmented";
import { busyClass, LoadingRow } from "@/components/Spinner";
import { EYEBROW_TEXT } from "@/components/Heading";

export type PreviewWidth = "desktop" | "phone";

/** Mail-client widths in CSS px: a desktop reading pane and a phone. */
const WIDTH_PX: Record<PreviewWidth, number> = { desktop: 640, phone: 375 };

/** A fragment becomes a document with a plain white page, as a mail client shows it. */
function asDocument(html: string): string {
  if (/^\s*(<!doctype|<html)/i.test(html)) return html;
  return (
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<style>body{margin:0;padding:16px;background:#fff;color:#1e293b;font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}img{max-width:100%}</style>" +
    `</head><body>${html}</body></html>`
  );
}

export function EmailPreview({
  subject,
  html,
  loading,
  error,
  label = "Email preview",
  className = "",
}: {
  subject: string | null;
  html: string | null;
  /** A newer render is on its way: dim the current one. */
  loading: boolean;
  /** The preview route refused (a part that does not render). */
  error?: string | null;
  /** The frame's title. */
  label?: string;
  className?: string;
}) {
  const [width, setWidth] = useState<PreviewWidth>("desktop");
  const wrapRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [box, setBox] = useState(0);
  const [height, setHeight] = useState(360);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setBox(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  function fit() {
    try {
      // The body's own box, not the document's scrollHeight: that never
      // drops below the frame's current height, so a shorter mail would
      // keep the taller frame of the one before it.
      const doc = frameRef.current?.contentDocument;
      const body = doc?.body;
      if (body && doc.defaultView) {
        const cs = doc.defaultView.getComputedStyle(body);
        const h = body.getBoundingClientRect().height + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
        setHeight(Math.max(160, Math.ceil(h)));
      }
    } catch {
      /* cross-origin: keep the last height */
    }
  }

  // The frame keeps its width in px (so the mail's own media queries
  // resolve as on the device) and is scaled down when the pane is narrower.
  // Desktop is the reading pane's own width (mail clients are fluid); a
  // phone is 375px, scaled down when the pane is narrower.
  const W = width === "phone" ? WIDTH_PX.phone : box || WIDTH_PX.desktop;
  const scale = box > 0 ? Math.min(1, box / W) : 1;
  useEffect(() => {
    fit();
  }, [html, width, W]);

  return (
    <div className={className}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className={EYEBROW_TEXT}>Preview with sample values</span>
        <Segmented
          size="sm"
          label="Preview width"
          value={width}
          onChange={setWidth}
          className="flex-wrap"
          options={[
            { value: "desktop", label: "Desktop", icon: Monitor },
            { value: "phone", label: "Phone", icon: Smartphone },
          ]}
        />
      </div>
      <div className="rounded-xl border border-slate-200 bg-canvas p-3">
        <p className="mb-3 border-b border-slate-200 pb-2 text-sm" aria-live="polite">
          <span className="text-slate-500">Subject: </span>
          <span className="font-medium text-slate-800" data-testid="email-preview-subject">
            {subject ?? "…"}
          </span>
        </p>
        <div ref={wrapRef} className="w-full">
          {error ? (
            <p role="alert" className="notice-error rounded-lg border px-3 py-2 text-sm">
              {error}
            </p>
          ) : html === null ? (
            <LoadingRow className="py-10">Rendering preview…</LoadingRow>
          ) : (
            <div
              inert
              aria-busy={loading}
              className={`mx-auto overflow-hidden rounded-lg ring-1 ring-slate-200 ${busyClass(loading)}`}
              style={{ width: W * scale, height: height * scale }}
            >
              <iframe
                ref={frameRef}
                title={label}
                tabIndex={-1}
                sandbox="allow-same-origin"
                srcDoc={asDocument(html)}
                onLoad={fit}
                style={{
                  width: W,
                  height,
                  border: 0,
                  transform: `scale(${scale})`,
                  transformOrigin: "0 0",
                  display: "block",
                }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
