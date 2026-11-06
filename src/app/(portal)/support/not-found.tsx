// The customer portal's 404 (Helpdesk 1.19.1): a request that is not yours,
// an address that leads nowhere, or the portal switched off. Says nothing
// about the workspace and links nowhere into the app.

import { FileQuestion } from "lucide-react";

export default function PortalNotFound() {
  return (
    <div className="mx-auto mt-16 w-full max-w-md rounded-2xl border border-slate-200 bg-surface p-6 text-center shadow-xs">
      <FileQuestion className="mx-auto h-6 w-6 text-compass-600" aria-hidden />
      <h1 className="mt-2 text-2xl font-bold text-slate-900">Page not found</h1>
      <p className="mt-1 text-sm text-slate-500">This address doesn&rsquo;t lead anywhere we can show you.</p>
    </div>
  );
}
