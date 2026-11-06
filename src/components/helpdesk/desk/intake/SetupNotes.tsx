"use client";

// A tool's setup steps (setup-notes.ts), with the endpoint filled into its
// snippet. The key is never in it: the snippet says <your key>.

import { CopyButton } from "@/components/CopyButton";
import { HD_INTEGRATION_KIND_LABEL, type HdIntegrationKind } from "@/lib/helpdesk/intake/shared";
import { SETUP_NOTES } from "./setup-notes";

export function SetupNotes({ kind, url }: { kind: HdIntegrationKind; url: string }) {
  const note = SETUP_NOTES[kind];
  const snippet = note.snippet ? note.snippet.text.replaceAll("{url}", url || "<endpoint>") : "";
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-slate-800">Set up {HD_INTEGRATION_KIND_LABEL[kind]}</h3>
      <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-600">
        {note.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      {note.snippet && (
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-slate-500">{note.snippet.label}</p>
            <CopyButton text={snippet} label="Copy" />
          </div>
          <pre className="overflow-x-auto rounded-lg border border-slate-200 bg-canvas p-3 font-mono text-xs leading-5 text-slate-700">{snippet}</pre>
        </div>
      )}
    </div>
  );
}
