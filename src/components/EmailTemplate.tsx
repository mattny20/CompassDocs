"use client";

// Renderer for ```email fenced blocks: a letter-style card that clearly
// separates a copy-paste email template from the rest of the document — the
// email sibling of the code block. Leading "Subject:" / "To:" / "Cc:" /
// "Bcc:" lines become header fields; everything after is the body, shown in
// a normal (proportional) font the way it'll read in a mail client.

import { useState } from "react";
import { Mail } from "lucide-react";

const HEADER_KEYS = ["subject", "to", "cc", "bcc"] as const;
type HeaderKey = (typeof HEADER_KEYS)[number];
const HEADER_LABEL: Record<HeaderKey, string> = {
  subject: "Subject",
  to: "To",
  cc: "Cc",
  bcc: "Bcc",
};

/** Split leading header lines from the body. Exported for tests. */
export function parseEmailTemplate(raw: string): {
  headers: { key: HeaderKey; value: string }[];
  body: string;
} {
  const lines = raw.replace(/\n$/, "").split("\n");
  const headers: { key: HeaderKey; value: string }[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = /^(subject|to|cc|bcc)\s*:\s*(.*)$/i.exec(lines[i]);
    if (!m) break;
    headers.push({ key: m[1].toLowerCase() as HeaderKey, value: m[2].trim() });
    i++;
  }
  // Swallow the blank separator line(s) after the header block.
  while (i < lines.length && lines[i].trim() === "") i++;
  return { headers, body: lines.slice(i).join("\n") };
}

function CopyButton({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {}
      }}
      className={`rounded px-2 py-0.5 text-xs font-medium transition ${
        copied
          ? "text-green-600 dark:text-green-400"
          : "text-compass-700 hover:bg-compass-100 dark:text-compass-300 dark:hover:bg-white/10"
      }`}
    >
      {copied ? "Copied ✓" : label}
    </button>
  );
}

export function EmailTemplate({ raw }: { raw: string }) {
  const { headers, body } = parseEmailTemplate(raw);
  const subject = headers.find((h) => h.key === "subject")?.value ?? "";
  const full = raw.replace(/\n$/, "");

  return (
    <div className="email-template group my-4 overflow-hidden rounded-lg border border-compass-200 shadow-sm dark:border-compass-100">
      {/* Header bar */}
      <div className="flex items-center justify-between gap-2 border-b border-compass-200 bg-compass-50 px-3 py-1.5 dark:border-compass-100 dark:bg-compass-50/60">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-compass-700 dark:text-compass-300">
          <Mail className="h-3.5 w-3.5" />
          Email template
        </span>
        <span className="flex items-center gap-0.5">
          {subject && <CopyButton label="Copy subject" text={subject} />}
          {headers.length > 0 && <CopyButton label="Copy body" text={body} />}
          <CopyButton label={headers.length > 0 ? "Copy all" : "Copy"} text={headers.length > 0 ? full : body || full} />
        </span>
      </div>

      {/* Envelope fields */}
      {headers.length > 0 && (
        <div className="space-y-0.5 border-b border-slate-100 bg-surface px-4 py-2.5">
          {headers.map((h, i) => (
            <p key={`${h.key}-${i}`} className="!my-0 text-sm">
              <span className="mr-2 inline-block w-14 text-xs font-semibold uppercase tracking-wide text-slate-400">
                {HEADER_LABEL[h.key]}
              </span>
              <span className={h.key === "subject" ? "font-semibold text-slate-900" : "text-slate-700"}>
                {h.value}
              </span>
            </p>
          ))}
        </div>
      )}

      {/* Body — proportional font, exactly as it will read in a mail client. */}
      <div className="whitespace-pre-wrap bg-surface px-4 py-3 text-[15px] leading-relaxed text-slate-800">
        {body || full}
      </div>
    </div>
  );
}
