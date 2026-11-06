"use client";

// The reply box on a portal request (Get help's recipe: a borderless
// textarea in a card, the paperclip and Send under a hairline). Sends the
// text and files together to /support/api/requests/[n]/messages, then
// reloads the page's data.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Send } from "lucide-react";
import { Button } from "@/components/Button";
import { FormError, Textarea } from "@/components/form";
import { portalFetch } from "./client";
import { PortalAttachButton, PortalFileChips } from "./PortalFiles";

export function PortalReply({ number }: { number: number }) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!body.trim() && !files.length) {
      setError("Write a reply.");
      return;
    }
    setBusy(true);
    const form = new FormData();
    form.append("body", body);
    for (const f of files) form.append("files", f);
    const r = await portalFetch(`/support/api/requests/${number}/messages`, { method: "POST", body: form }, "Couldn't send your reply. Try again.");
    setBusy(false);
    if (!r.ok) {
      if (r.status === 401) window.location.assign(`/support?next=/support/requests/${number}`);
      setError(r.error);
      return;
    }
    setBody("");
    setFiles([]);
    router.refresh();
  }

  return (
    <form onSubmit={send} className="rounded-xl border border-slate-200 bg-surface shadow-xs">
      <label htmlFor="portal-reply" className="sr-only">
        Your reply
      </label>
      <Textarea
        id="portal-reply"
        rows={4}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Write a reply…"
        className="rounded-b-none border-0 bg-transparent px-4 py-3 text-base shadow-none focus:ring-0 sm:text-sm"
      />
      <div className="space-y-2 border-t border-slate-100 px-3 py-2.5">
        <PortalFileChips files={files} onChange={setFiles} />
        {error && <FormError>{error}</FormError>}
        <div className="flex items-center gap-2">
          <PortalAttachButton files={files} onChange={setFiles} onError={setError} />
          <Button type="submit" busy={busy} icon={<Send />} className="ml-auto">
            Send
          </Button>
        </div>
      </div>
    </form>
  );
}
