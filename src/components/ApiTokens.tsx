"use client";

// Personal API token manager (Account → API tokens). Creating a token shows
// its value exactly once, with copy-ready setup instructions for the Claude
// connector; afterwards only the prefix is visible.

import { useState } from "react";
import type { ApiToken } from "@/lib/db";

const field =
  "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-compass-400 focus:ring-2 focus:ring-compass-100";

export function ApiTokens({ initial }: { initial: ApiToken[] }) {
  const [tokens, setTokens] = useState(initial);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<{ token: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/account/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    setBusy(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data?.error || "Could not create the token.");
      return;
    }
    setFresh({ token: data.token, name: data.record.name });
    setTokens([data.record, ...tokens]);
    setName("");
  }

  async function revoke(id: number) {
    if (!confirm("Revoke this token? Anything using it stops working immediately.")) return;
    const res = await fetch(`/api/account/tokens/${id}`, { method: "DELETE" });
    if (res.ok) setTokens(tokens.filter((t) => t.id !== id));
  }

  async function copy(text: string, tag: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      setTimeout(() => setCopied(""), 1600);
    } catch {}
  }

  const origin = typeof window !== "undefined" ? window.location.origin : "https://your-compassdocs";
  const claudeConfig = fresh
    ? JSON.stringify(
        {
          compassdocs: {
            command: "npx",
            args: [
              "-y",
              "mcp-remote",
              `${origin}/api/mcp`,
              "--header",
              `Authorization: Bearer ${fresh.token}`,
            ],
          },
        },
        null,
        2
      )
    : "";

  return (
    <div>
      {fresh && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 p-3 text-sm">
          <p className="font-semibold text-green-800">
            Token &ldquo;{fresh.name}&rdquo; created — copy it now, it won&rsquo;t be shown again.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1 font-mono text-xs ring-1 ring-green-200">
              {fresh.token}
            </code>
            <button
              onClick={() => copy(fresh.token, "tok")}
              className="shrink-0 rounded-lg bg-green-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-green-700"
            >
              {copied === "tok" ? "Copied ✓" : "Copy"}
            </button>
          </div>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs font-medium text-green-700">
              Claude Desktop setup (mcpServers entry)
            </summary>
            <div className="mt-2">
              <pre className="overflow-x-auto rounded bg-slate-900 p-2 text-[11px] leading-4 text-slate-200">
                {claudeConfig}
              </pre>
              <button
                onClick={() => copy(claudeConfig, "cfg")}
                className="mt-1 rounded-lg border border-green-300 px-2.5 py-1 text-xs font-medium text-green-700 hover:bg-green-100"
              >
                {copied === "cfg" ? "Copied ✓" : "Copy config"}
              </button>
            </div>
          </details>
          <button
            onClick={() => setFresh(null)}
            className="mt-2 text-xs font-medium text-green-700 underline"
          >
            Done — hide this
          </button>
        </div>
      )}

      <form onSubmit={create} className="flex gap-2">
        <input
          className={field}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Token name (e.g. Claude Desktop on my Mac)"
          maxLength={60}
        />
        <button
          type="submit"
          disabled={busy}
          className="shrink-0 rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60"
        >
          {busy ? "Creating…" : "Create token"}
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <ul className="mt-4 divide-y divide-slate-100">
        {tokens.length === 0 && (
          <li className="py-3 text-sm text-slate-400">No tokens yet.</li>
        )}
        {tokens.map((t) => (
          <li key={t.id} className="flex items-center gap-3 py-2.5 text-sm">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-slate-800">{t.name}</div>
              <div className="text-xs text-slate-400">
                <code className="font-mono">{t.prefix}</code> · created{" "}
                {new Date(t.created_at).toLocaleDateString()}
                {t.last_used_at
                  ? ` · last used ${new Date(t.last_used_at).toLocaleString()}`
                  : " · never used"}
              </div>
            </div>
            <button
              onClick={() => revoke(t.id)}
              className="shrink-0 rounded-lg border border-red-200 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
            >
              Revoke
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
