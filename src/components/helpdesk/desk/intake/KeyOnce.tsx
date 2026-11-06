"use client";

// The endpoint and a fresh API key, shown once (agent P): after creating a
// webhook integration and after "Make a new key". Copy buttons for both, a
// curl example with the key filled in, and the tool's setup notes. Once
// dismissed the key is gone: only its hash is kept.

import { KeyRound } from "lucide-react";
import { Button } from "@/components/Button";
import { CopyButton } from "@/components/CopyButton";
import type { HdIntegrationKind } from "@/lib/helpdesk/intake/shared";
import { SetupNotes } from "./SetupNotes";
import { curlExample } from "./setup-notes";

export function absoluteUrl(path: string): string {
  return path ? `${typeof window === "undefined" ? "" : window.location.origin}${path}` : "";
}

export function KeyOnce({
  kind,
  endpointPath,
  apiKey,
  onDone,
  doneLabel = "Done",
}: {
  kind: HdIntegrationKind;
  endpointPath: string;
  apiKey: string;
  onDone: () => void;
  doneLabel?: string;
}) {
  const url = absoluteUrl(endpointPath);
  const curl = curlExample(url, apiKey);
  return (
    <div className="space-y-5">
      <div className="notice-ok rounded-lg border p-4 text-sm">
        <p className="flex items-center gap-2 font-semibold">
          <KeyRound className="h-4 w-4" aria-hidden />
          Copy the key now. It won&apos;t be shown again.
        </p>
        <p className="mt-1">Only a fingerprint of it is kept. If it is lost, make a new key on the integration&apos;s page.</p>
      </div>
      <div className="space-y-3">
        <div>
          <p className="mb-1 text-xs font-medium text-slate-500">Endpoint</p>
          <div className="flex flex-wrap items-center gap-2">
            <code data-testid="intake-url" className="min-w-0 max-w-full truncate rounded-md border border-slate-200 bg-canvas px-2 py-1.5 font-mono text-xs text-slate-700">
              {url}
            </code>
            <CopyButton text={url} label="Copy URL" />
          </div>
        </div>
        <div>
          <p className="mb-1 text-xs font-medium text-slate-500">API key</p>
          <div className="flex flex-wrap items-center gap-2">
            <code data-testid="intake-key" className="min-w-0 max-w-full truncate rounded-md border border-slate-200 bg-canvas px-2 py-1.5 font-mono text-xs text-slate-700">
              {apiKey}
            </code>
            <CopyButton text={apiKey} label="Copy key" variant="primary" />
          </div>
          <p className="mt-1 text-xs text-slate-500">Send it as Authorization: Bearer &lt;key&gt;. Treat it like a password.</p>
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-slate-500">Try it</p>
            <CopyButton text={curl} label="Copy command" />
          </div>
          <pre className="overflow-x-auto rounded-lg border border-slate-200 bg-canvas p-3 font-mono text-xs leading-5 text-slate-700">{curl}</pre>
        </div>
      </div>
      <SetupNotes kind={kind} url={url} />
      <Button onClick={onDone}>{doneLabel}</Button>
    </div>
  );
}
