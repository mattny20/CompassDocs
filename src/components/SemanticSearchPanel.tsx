"use client";

import { useEffect, useRef, useState } from "react";
import { Check, CircleAlert, LoaderCircle, RefreshCw, Sparkles } from "lucide-react";

// Semantic-search configuration (Settings → AI): provider, key, model, base
// URL, index status, and a background rebuild with live progress.

interface Status {
  pgvector: boolean;
  provider: "off" | "voyage" | "openai";
  model: string;
  base_url: string;
  has_key: boolean;
  indexed_docs: number;
  chunks: number;
  total_docs: number;
  index_model: string;
  reindex: { running: boolean; done: number; total: number; error: string };
}

const DEFAULTS = {
  voyage: { model: "voyage-3.5-lite", baseUrl: "https://api.voyageai.com/v1/embeddings" },
  openai: { model: "text-embedding-3-small", baseUrl: "https://api.openai.com/v1/embeddings" },
};

const field =
  "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-compass-400 focus:ring-2 focus:ring-compass-100";

export function SemanticSearchPanel({ initial }: { initial: Status }) {
  const [status, setStatus] = useState<Status>(initial);
  const [provider, setProvider] = useState<string>(initial.provider);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(initial.provider === "off" ? "" : initial.model);
  const [baseUrl, setBaseUrl] = useState(initial.provider === "off" ? "" : initial.base_url);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const defaults = provider === "voyage" || provider === "openai" ? DEFAULTS[provider] : null;

  // Poll status while a rebuild runs.
  useEffect(() => {
    if (!status.reindex.running) return;
    pollRef.current = setInterval(async () => {
      const res = await fetch("/api/admin/embeddings");
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
        if (!data.reindex.running && pollRef.current) clearInterval(pollRef.current);
      }
    }, 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [status.reindex.running]);

  async function send(payload: Record<string, unknown>, okText: string) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/embeddings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ tone: "error", text: data?.error || "Could not save." });
      } else {
        if (data.state) setStatus(data.state);
        if (data.started) setStatus((s) => ({ ...s, reindex: { ...s.reindex, running: true } }));
        if (data.test) {
          setMessage(
            data.test.ok
              ? { tone: "ok", text: `Connection works — ${data.test.dims}-dimension embeddings.` }
              : { tone: "error", text: data.test.error || "Connection test failed." }
          );
        } else {
          setMessage({ tone: "ok", text: okText });
        }
      }
    } catch {
      setMessage({ tone: "error", text: "Request failed." });
    }
    setBusy(false);
  }

  function payload(extra: Record<string, unknown> = {}) {
    return {
      provider,
      model,
      base_url: baseUrl,
      ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
      ...extra,
    };
  }

  const configured = status.provider !== "off" && status.has_key;
  const pct = status.total_docs ? Math.round((status.indexed_docs / status.total_docs) * 100) : 0;

  return (
    <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
      <h3 className="mb-1 flex items-center gap-2 font-semibold text-slate-900">
        <Sparkles className="h-4 w-4 text-compass-600" /> Semantic search
      </h3>
      <p className="mb-3 text-sm text-slate-500">
        Understands meaning, not just keywords — &ldquo;how do we handle refunds?&rdquo; finds the
        billing policy even when no words match. Works alongside keyword search in the app and in
        Ask answers; the public site stays keyword-only. Requires the{" "}
        <code className="rounded bg-slate-100 px-1 text-xs">pgvector</code> Postgres extension and
        an embeddings provider.
      </p>

      {!status.pgvector ? (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            The <strong>pgvector</strong> extension isn&rsquo;t available in your PostgreSQL.
            Deployments using the bundled docker-compose get it automatically from 0.49 — for an
            external database, install <code className="font-mono">postgresql-16-pgvector</code>{" "}
            (or your distro&rsquo;s equivalent) and try again.
          </span>
        </div>
      ) : configured ? (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
          <Check className="h-4 w-4 shrink-0" />
          <span>
            Semantic search is <strong>on</strong> — {status.indexed_docs} of {status.total_docs}{" "}
            documents indexed ({status.chunks} chunks
            {status.index_model ? `, model ${status.index_model}` : ""}).
          </span>
        </div>
      ) : (
        <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
          Semantic search is <strong>off</strong> — searches use keywords only.
        </div>
      )}

      {status.reindex.running && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-compass-100 bg-compass-50 px-3 py-2 text-sm text-compass-700">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          Rebuilding index… {status.reindex.done} / {status.reindex.total} documents
        </div>
      )}
      {status.reindex.error && !status.reindex.running && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          Last rebuild failed: {status.reindex.error}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">Provider</span>
          <select
            value={provider}
            onChange={(e) => {
              const p = e.target.value;
              setProvider(p);
              if (p === "voyage" || p === "openai") {
                setModel(DEFAULTS[p].model);
                setBaseUrl(DEFAULTS[p].baseUrl);
              }
            }}
            className={field}
          >
            <option value="off">Off</option>
            <option value="voyage">Voyage AI</option>
            <option value="openai">OpenAI-compatible (OpenAI, Ollama, LM Studio…)</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">
            API key {status.has_key && <span className="text-slate-400">(saved — enter to replace)</span>}
          </span>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className={`${field} font-mono`}
            placeholder={provider === "voyage" ? "pa-…" : "sk-… (any value for local engines)"}
            autoComplete="off"
            spellCheck={false}
            disabled={provider === "off"}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">Embedding model</span>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className={field}
            placeholder={defaults?.model ?? ""}
            disabled={provider === "off"}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">
            Endpoint URL <span className="text-slate-400">(change for Ollama or a gateway)</span>
          </span>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            className={field}
            placeholder={defaults?.baseUrl ?? ""}
            disabled={provider === "off"}
          />
        </label>
      </div>
      <p className="mt-2 text-xs text-slate-400">
        Changing the model re-embeds everything on the next rebuild. Documents embed automatically
        as they&rsquo;re created and edited; use Rebuild to index existing content the first time.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={() => send(payload(), "Saved.").then(() => setApiKey(""))}
          disabled={busy}
          className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-compass-700 disabled:opacity-60"
        >
          {busy ? "Working…" : "Save"}
        </button>
        <button
          onClick={() => send(payload({ action: "test" }), "Connection works.")}
          disabled={busy || provider === "off"}
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          Test connection
        </button>
        <button
          onClick={() => send({ action: "reindex" }, "Rebuild started.")}
          disabled={busy || !configured || !status.pgvector || status.reindex.running}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          <RefreshCw className="h-4 w-4" /> Rebuild index
        </button>
        {message && (
          <span className={`text-sm ${message.tone === "ok" ? "text-green-600" : "text-red-600"}`}>
            {message.text}
          </span>
        )}
      </div>
    </div>
  );
}
