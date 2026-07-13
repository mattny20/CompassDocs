"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type AiKeySource = "settings" | "env" | "none";

interface AiState {
  source: AiKeySource;
  has_key: boolean;
  model: string;
  default_model: string;
}

// Mirrors AI_MODELS in lib/ai-config.ts. Kept here so this client component
// doesn't import the server-only config module.
const MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: "claude-opus-4-8", label: "Claude Opus 4.8 — most capable" },
  { value: "claude-sonnet-5", label: "Claude Sonnet 5 — balanced" },
  { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 — fastest" },
];

const field =
  "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-compass-400 focus:ring-2 focus:ring-compass-100";

export function AiSettings({ initial }: { initial: AiState }) {
  const router = useRouter();
  const [source, setSource] = useState<AiKeySource>(initial.source);
  const [hasKey, setHasKey] = useState(initial.has_key);
  const [model, setModel] = useState(initial.model);
  const [apiKey, setApiKey] = useState("");

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  // If the current model isn't one of the presets (e.g. set via env), show it.
  const modelOptions = MODEL_OPTIONS.some((m) => m.value === model)
    ? MODEL_OPTIONS
    : [{ value: model, label: `${model} (custom)` }, ...MODEL_OPTIONS];

  async function send(payload: Record<string, unknown>) {
    setSaving(true);
    setError("");
    setSaved(false);
    const res = await fetch("/api/admin/ai", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setSaving(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data?.error || "Could not save.");
      return false;
    }
    if (data?.state) {
      setSource(data.state.source);
      setHasKey(data.state.has_key);
      setModel(data.state.model);
    }
    setSaved(true);
    router.refresh();
    return true;
  }

  async function save() {
    const ok = await send({ model, ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}) });
    if (ok) setApiKey("");
  }

  async function removeKey() {
    if (!confirm("Remove the saved API key? AI features will turn off unless a key is set in the environment.")) return;
    await send({ clear: true });
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">AI</h2>
        <p className="mt-1 text-sm text-slate-500">
          Connect an Anthropic API key to enable <strong>Ask CompassDocs</strong> answers and
          <strong> ✨ Proofread</strong>. Search and everything else work without it.
        </p>
      </div>

      {/* Status banner */}
      {source === "none" ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          AI features are <strong>off</strong> — no API key configured.
        </div>
      ) : (
        <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
          ✓ AI features are <strong>on</strong>
          {source === "env"
            ? " — using the ANTHROPIC_API_KEY environment variable."
            : " — using the key saved here."}
        </div>
      )}

      {/* API key */}
      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
        <h3 className="mb-1 font-semibold text-slate-900">Anthropic API key</h3>
        <p className="mb-3 text-sm text-slate-500">
          Get a key from{" "}
          <a
            href="https://console.anthropic.com/settings/keys"
            target="_blank"
            rel="noreferrer"
            className="text-compass-600 underline underline-offset-2 hover:text-compass-700"
          >
            console.anthropic.com
          </a>
          . It&rsquo;s stored securely and never shown again. The key is validated when you save.
        </p>

        {source === "env" && (
          <p className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
            A key is currently provided by the <code className="font-mono">ANTHROPIC_API_KEY</code>{" "}
            environment variable. Saving a key here overrides it.
          </p>
        )}
        {source === "settings" && hasKey && (
          <div className="mb-3 flex items-center gap-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
            <span>🔑 A key is saved.</span>
            <button
              onClick={removeKey}
              disabled={saving}
              className="font-medium text-red-600 hover:underline disabled:opacity-60"
            >
              Remove key
            </button>
          </div>
        )}

        <label className="block max-w-md">
          <span className="mb-1 block text-xs font-medium text-slate-500">
            {hasKey ? "Replace key" : "API key"}
          </span>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              setSaved(false);
            }}
            className={`${field} font-mono`}
            placeholder="sk-ant-…"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      </div>

      {/* Model */}
      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
        <h3 className="mb-1 font-semibold text-slate-900">Model</h3>
        <p className="mb-3 text-sm text-slate-500">
          Which Claude model answers questions and proofreads. Opus is the most capable; Haiku is
          the fastest and cheapest.
        </p>
        <label className="block max-w-md">
          <span className="mb-1 block text-xs font-medium text-slate-500">Model</span>
          <select
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              setSaved(false);
            }}
            className={field}
          >
            {modelOptions.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-compass-700 disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && <span className="text-sm text-green-600">✓ Saved</span>}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}
