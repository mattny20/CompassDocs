"use client";

// Fenced-code renderer for document views. Every block gets a header bar with
// the language label and a one-click Copy button. Shell-flavored languages
// render as "run blocks" — terminal styling with a ● ● ● cap — built for
// runbooks and step-by-step procedures. Purely presentational: nothing is ever
// executed.

import { useState } from "react";

const RUN_LANGS = new Set([
  "run",
  "sh",
  "shell",
  "bash",
  "zsh",
  "terminal",
  "console",
  "cmd",
  "powershell",
  "ps1",
]);

const LANG_LABEL: Record<string, string> = {
  run: "shell",
  sh: "shell",
  zsh: "zsh",
  bash: "bash",
  shell: "shell",
  terminal: "shell",
  console: "shell",
  cmd: "cmd",
  powershell: "PowerShell",
  ps1: "PowerShell",
  js: "JavaScript",
  jsx: "JSX",
  ts: "TypeScript",
  tsx: "TSX",
  py: "Python",
  python: "Python",
  yml: "YAML",
  yaml: "YAML",
  json: "JSON",
  sql: "SQL",
  html: "HTML",
  css: "CSS",
  md: "Markdown",
};

export function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const lang = language.toLowerCase();
  const isRun = RUN_LANGS.has(lang);
  const label = LANG_LABEL[lang] || language || "code";

  async function copy() {
    try {
      await navigator.clipboard.writeText(code.replace(/\n$/, ""));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {}
  }

  return (
    <div className="code-block group my-4 overflow-hidden rounded-lg ring-1 ring-slate-800/60">
      <div className="flex items-center justify-between bg-slate-800 px-3 py-1.5">
        <span className="flex items-center gap-2 text-xs font-medium text-slate-400">
          {isRun ? (
            <>
              <span className="flex gap-1" aria-hidden>
                <span className="h-2 w-2 rounded-full bg-red-400/80" />
                <span className="h-2 w-2 rounded-full bg-amber-400/80" />
                <span className="h-2 w-2 rounded-full bg-green-400/80" />
              </span>
              <span className="rounded bg-compass-500/20 px-1.5 py-0.5 font-semibold uppercase tracking-wider text-compass-300">
                Run
              </span>
            </>
          ) : null}
          {label}
        </span>
        <button
          onClick={copy}
          className={`rounded px-2 py-0.5 text-xs font-medium transition ${
            copied ? "text-green-400" : "text-slate-400 hover:bg-slate-700 hover:text-slate-200"
          }`}
        >
          {copied ? "Copied ✓" : isRun ? "Copy commands" : "Copy"}
        </button>
      </div>
      <pre className="!my-0 !rounded-none">
        <code>{code}</code>
      </pre>
    </div>
  );
}
