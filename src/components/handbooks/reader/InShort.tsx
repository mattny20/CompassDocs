// "In short" (1.18.0): a policy's summary points, up to five short bullets
// set in the document's settings, in an accent panel above the body. A
// point is one plain sentence; **bold** is the only markup it keeps (the
// mock-up's "You get **25 days** a year"), rendered as React text, so a
// point can never carry a link, an image or HTML. The id is the contents
// rail's "In short" anchor. Server-safe.

import type { ReactNode } from "react";

/** The anchor the contents rail links to. */
export const IN_SHORT_ID = "in-short";

/** "You get **25 days** a year" → text and <strong> runs; an unpaired ** stays as typed. */
export function boldRuns(point: string): ReactNode[] {
  return point.split(/\*\*(.+?)\*\*/g).map((run, i) =>
    i % 2 === 1 ? (
      <strong key={i} className="font-semibold text-slate-900">
        {run}
      </strong>
    ) : (
      run
    )
  );
}

export function InShort({ points }: { points: string[] }) {
  const shown = points.map((p) => p.trim()).filter(Boolean).slice(0, 5);
  if (shown.length === 0) return null;
  return (
    <section
      id={IN_SHORT_ID}
      aria-labelledby={`${IN_SHORT_ID}-title`}
      className="scroll-mt-20 rounded-lg border border-compass-200 bg-compass-50 px-4 py-3.5 break-inside-avoid print:bg-transparent"
    >
      <h3 id={`${IN_SHORT_ID}-title`} className="mb-1.5 text-sm font-bold text-compass-700">
        In short
      </h3>
      <ul className="list-disc space-y-0.5 pl-5 text-sm leading-relaxed text-slate-700 marker:text-compass-500">
        {shown.map((p, i) => (
          <li key={i}>{boldRuns(p)}</li>
        ))}
      </ul>
    </section>
  );
}
