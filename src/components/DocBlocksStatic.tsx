// Presentation-only rich-document blocks (no client interactivity needed):
// callouts, accordions, video embeds, and website embeds. Kept separate from
// DocBlocks.tsx so these stay server-rendered — including on the public site.

import { videoEmbedUrl } from "@/lib/doc-blocks";

// --- Callouts -----------------------------------------------------------------

const CALLOUT_STYLE: Record<
  string,
  { icon: string; box: string; title: string; defaultTitle: string }
> = {
  note: {
    icon: "📝",
    box: "border-slate-300 bg-slate-50 dark:border-slate-600 dark:bg-slate-800/40",
    title: "text-slate-700 dark:text-slate-200",
    defaultTitle: "Note",
  },
  info: {
    icon: "ℹ️",
    box: "border-sky-300 bg-sky-50 dark:border-sky-800 dark:bg-sky-950/40",
    title: "text-sky-800 dark:text-sky-200",
    defaultTitle: "Info",
  },
  tip: {
    icon: "💡",
    box: "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/40",
    title: "text-emerald-800 dark:text-emerald-200",
    defaultTitle: "Tip",
  },
  warning: {
    icon: "⚠️",
    box: "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40",
    title: "text-amber-800 dark:text-amber-200",
    defaultTitle: "Warning",
  },
  danger: {
    icon: "🚨",
    box: "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/40",
    title: "text-red-800 dark:text-red-200",
    defaultTitle: "Danger",
  },
};

export function Callout({
  kind,
  title,
  children,
}: {
  kind: string;
  title?: string;
  children: React.ReactNode;
}) {
  const s = CALLOUT_STYLE[kind] ?? CALLOUT_STYLE.note;
  return (
    <div className={`md-callout-box my-4 rounded-lg border-l-4 border px-4 py-3 ${s.box}`}>
      <div className={`mb-1 flex items-center gap-1.5 text-sm font-semibold ${s.title}`}>
        <span aria-hidden>{s.icon}</span> {title || s.defaultTitle}
      </div>
      <div className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 text-[0.95em]">{children}</div>
    </div>
  );
}

// --- Accordion ----------------------------------------------------------------

export function DocDetails({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="my-3 rounded-lg border border-slate-200 bg-surface [&[open]>summary]:border-b [&[open]>summary]:border-slate-100">
      <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-semibold text-slate-700 hover:text-compass-700 marker:text-compass-500">
        {title}
      </summary>
      <div className="px-4 py-1 [&>*:first-child]:mt-2 [&>*:last-child]:mb-3">{children}</div>
    </details>
  );
}

// --- Video embeds -------------------------------------------------------------

export function VideoBlock({ src, title }: { src: string; title?: string }) {
  const embed = videoEmbedUrl(src);
  if (!embed) {
    return (
      <p className="my-3 text-sm text-slate-500">
        🎬{" "}
        <a href={src} className="text-compass-600 underline" rel="noreferrer noopener">
          {title || src}
        </a>{" "}
        <span className="text-slate-400">(unsupported video URL — use YouTube, Vimeo, Loom, or an uploaded file)</span>
      </p>
    );
  }
  return (
    <figure className="my-4">
      {embed.kind === "iframe" ? (
        <div className="relative w-full overflow-hidden rounded-lg border border-slate-200" style={{ paddingTop: "56.25%" }}>
          <iframe
            src={embed.url}
            title={title || "Embedded video"}
            loading="lazy"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            className="absolute inset-0 h-full w-full border-0"
          />
        </div>
      ) : (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video src={embed.url} controls preload="metadata" className="w-full rounded-lg border border-slate-200" />
      )}
      {title && <figcaption className="mt-1.5 text-center text-sm text-slate-400">{title}</figcaption>}
    </figure>
  );
}

// --- Website embeds -----------------------------------------------------------

export function SiteEmbed({ src, height, title }: { src: string; height?: string; title?: string }) {
  let ok = false;
  try {
    const u = new URL(src);
    ok = u.protocol === "https:";
  } catch {
    ok = false;
  }
  if (!ok) {
    return (
      <p className="my-3 text-sm text-amber-700">
        ⚠️ Embeds need a full <code>https://</code> URL.
      </p>
    );
  }
  const h = Math.min(Math.max(Number(height) || 420, 160), 1200);
  return (
    <figure className="my-4">
      <iframe
        src={src}
        title={title || "Embedded page"}
        loading="lazy"
        height={h}
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
        referrerPolicy="strict-origin-when-cross-origin"
        className="w-full rounded-lg border border-slate-200 bg-white"
        style={{ height: h }}
      />
      <figcaption className="mt-1 flex items-center justify-between text-xs text-slate-400">
        <span>{title || ""}</span>
        <a href={src} target="_blank" rel="noreferrer noopener" className="hover:text-compass-600">
          Open in new tab ↗
        </a>
      </figcaption>
    </figure>
  );
}
