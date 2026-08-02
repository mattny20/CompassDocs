"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toasts";
import { Field, TextInput, Select } from "@/components/form";

type AiKeySource = "settings" | "env" | "none";
type AiProvider = "anthropic" | "openai";

interface AiState {
  source: AiKeySource;
  has_key: boolean;
  model: string;
  default_model: string;
  provider: AiProvider;
  openai_base_url: string;
  openai_key_set: boolean;
  openai_model: string;
  openai_default_url: string;
}

// Mirrors AI_MODELS in lib/ai-config.ts. Kept here so this client component
// doesn't import the server-only config module.
const MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: "claude-opus-4-8", label: "Claude Opus 4.8 — most capable" },
  { value: "claude-sonnet-5", label: "Claude Sonnet 5 — balanced" },
  { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 — fastest" },
];

export function AiSettings({ initial }: { initial: AiState }) {
  const router = useRouter();
  const [source, setSource] = useState<AiKeySource>(initial.source);
  const [hasKey, setHasKey] = useState(initial.has_key);
  const [model, setModel] = useState(initial.model);
  const [apiKey, setApiKey] = useState("");

  const [provider, setProvider] = useState<AiProvider>(initial.provider);
  const [oaUrl, setOaUrl] = useState(initial.openai_base_url);
  const [oaModel, setOaModel] = useState(initial.openai_model);
  const [oaKey, setOaKey] = useState("");
  const [oaKeySet, setOaKeySet] = useState(initial.openai_key_set);

  const [saving, setSaving] = useState(false);

  // If the current model isn't one of the presets (e.g. set via env), show it.
  const modelOptions = MODEL_OPTIONS.some((m) => m.value === model)
    ? MODEL_OPTIONS
    : [{ value: model, label: `${model} (custom)` }, ...MODEL_OPTIONS];

  const aiOn = provider === "anthropic" ? source !== "none" : Boolean(oaUrl && oaModel);

  async function send(payload: Record<string, unknown>, okText: string) {
    setSaving(true);
    const res = await fetch("/api/admin/ai", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setSaving(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast("error", data?.error || "Could not save.");
      return false;
    }
    if (data?.state) {
      setSource(data.state.source);
      setHasKey(data.state.has_key);
      setModel(data.state.model);
      setProvider(data.state.provider);
      setOaUrl(data.state.openai_base_url);
      setOaModel(data.state.openai_model);
      setOaKeySet(data.state.openai_key_set);
    }
    toast("ok", okText);
    router.refresh();
    return true;
  }

  async function save() {
    const payload: Record<string, unknown> = { provider };
    if (provider === "anthropic") {
      payload.model = model;
      if (apiKey.trim()) payload.api_key = apiKey.trim();
    } else {
      payload.openai_base_url = oaUrl.trim();
      payload.openai_model = oaModel.trim();
      if (oaKey.trim()) payload.openai_api_key = oaKey.trim();
    }
    const ok = await send(payload, "AI settings saved.");
    if (ok) {
      setApiKey("");
      setOaKey("");
    }
  }

  async function removeKey() {
    if (!confirm("Remove the saved API key? AI features will turn off unless a key is set in the environment.")) return;
    await send({ clear: true }, "API key removed.");
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="mt-1 text-sm text-slate-500">
          Connect an AI provider to enable <strong>Ask CompassDocs</strong> answers,
          <strong> ✨ Write</strong>, and <strong>✨ Proofread</strong>. Search and everything else
          work without it.
        </p>
      </div>

      {/* Status banner */}
      {!aiOn ? (
        <div className="notice-warn rounded-lg border px-3 py-2 text-sm">
          AI features are <strong>off</strong> — no provider configured.
        </div>
      ) : (
        <div className="notice-ok rounded-lg border px-3 py-2 text-sm">
          ✓ AI features are <strong>on</strong>
          {provider === "anthropic"
            ? source === "env"
              ? " — Anthropic, using the ANTHROPIC_API_KEY environment variable."
              : " — Anthropic, using the key saved here."
            : ` — OpenAI-compatible endpoint (${oaModel}).`}
        </div>
      )}

      {/* Provider */}
      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
        <h3 className="mb-1 font-semibold text-slate-900">Provider</h3>
        <p className="mb-3 text-sm text-slate-500">
          Who answers: Anthropic&rsquo;s Claude, or any OpenAI-compatible chat endpoint — OpenAI
          itself, an Azure gateway, or a local engine like Ollama, LM Studio, or vLLM.
        </p>
        <div className="space-y-2">
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input
              type="radio"
              name="ai-provider"
              className="mt-0.5"
              checked={provider === "anthropic"}
              onChange={() => setProvider("anthropic")}
            />
            <span>
              <strong>Anthropic (Claude)</strong>
              <span className="block text-xs text-slate-500">
                The default — best quality for grounded answers and careful edits.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input
              type="radio"
              name="ai-provider"
              className="mt-0.5"
              checked={provider === "openai"}
              onChange={() => setProvider("openai")}
            />
            <span>
              <strong>OpenAI-compatible endpoint</strong>
              <span className="block text-xs text-slate-500">
                Bring your own <code className="font-mono">/v1/chat/completions</code> — including
                fully local models, so nothing leaves your network.
              </span>
            </span>
          </label>
        </div>
      </div>

      {provider === "anthropic" ? (
        <>
          {/* Anthropic API key */}
          <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
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

            <div className="max-w-md">
              <Field label={hasKey ? "Replace key" : "API key"}>
                <TextInput
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="font-mono"
                  placeholder="sk-ant-…"
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
            </div>
          </div>

          {/* Model */}
          <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
            <h3 className="mb-1 font-semibold text-slate-900">Model</h3>
            <p className="mb-3 text-sm text-slate-500">
              Which Claude model answers questions and proofreads. Opus is the most capable; Haiku is
              the fastest and cheapest.
            </p>
            <div className="max-w-md">
              <Field label="Model">
                <Select value={model} onChange={(e) => setModel(e.target.value)}>
                  {modelOptions.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </div>
        </>
      ) : (
        /* OpenAI-compatible endpoint */
        <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
          <h3 className="mb-1 font-semibold text-slate-900">OpenAI-compatible endpoint</h3>
          <p className="mb-3 text-sm text-slate-500">
            The full URL of a chat-completions endpoint. Examples:{" "}
            <code className="font-mono text-xs">{initial.openai_default_url}</code> (OpenAI) or{" "}
            <code className="font-mono text-xs">http://localhost:11434/v1/chat/completions</code>{" "}
            (Ollama). The endpoint is tested with a tiny request when you save.
          </p>
          <div className="max-w-md space-y-3">
            <Field label="Endpoint URL">
              <TextInput
                type="url"
                value={oaUrl}
                onChange={(e) => setOaUrl(e.target.value)}
                className="font-mono"
                placeholder="https://api.openai.com/v1/chat/completions"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <Field label="Model name">
              <TextInput
                type="text"
                value={oaModel}
                onChange={(e) => setOaModel(e.target.value)}
                className="font-mono"
                placeholder="gpt-4o-mini, llama3.1, …"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <Field
              label={
                <>
                  API key {oaKeySet ? "(saved — leave blank to keep)" : "(optional for local engines)"}
                </>
              }
            >
              <TextInput
                type="password"
                value={oaKey}
                onChange={(e) => setOaKey(e.target.value)}
                className="font-mono"
                placeholder={oaKeySet ? "••••••••" : "sk-…"}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white shadow-xs hover:bg-compass-700 disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
