"use client";

// Ask-in-chat settings: Slack slash command + Teams outgoing webhook.
// Shows the endpoint URLs to paste into each platform, takes the verification
// secret (write-only), and an enable switch per integration.

import { useState } from "react";

interface Config {
  slack_enabled: boolean;
  slack_secret_set: boolean;
  teams_enabled: boolean;
  teams_secret_set: boolean;
}

export function ChatAskPanel({ initial, baseUrl }: { initial: Config; baseUrl: string }) {
  const [cfg, setCfg] = useState<Config>(initial);
  const [slackSecret, setSlackSecret] = useState("");
  const [teamsSecret, setTeamsSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  async function save(patch: Record<string, unknown>) {
    setSaving(true);
    setMsg("");
    setError("");
    try {
      const res = await fetch("/api/admin/chat-ask", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data?.error || "Could not save.");
      else {
        setCfg(data as Config);
        setSlackSecret("");
        setTeamsSecret("");
        setMsg("Saved.");
      }
    } catch {
      setError("Could not save.");
    }
    setSaving(false);
  }

  const inputCls =
    "w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 outline-none focus:border-compass-400";
  const urlCls =
    "block select-all rounded-md bg-slate-100 px-2 py-1 font-mono text-xs text-slate-700";

  return (
    <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
      <h3 className="mb-1 font-semibold text-slate-900">Ask in chat</h3>
      <p className="mb-4 text-sm text-slate-500">
        Let people ask the knowledge base from Slack or Microsoft Teams and get the same grounded,
        cited answers as in-app Ask. Chat answers draw <strong>only from published documents in
        non-private spaces</strong> — private content never reaches a channel.
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Slack */}
        <div className="rounded-lg border border-slate-200 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-medium text-slate-800">Slack slash command</span>
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={cfg.slack_enabled}
                disabled={saving || !cfg.slack_secret_set}
                onChange={(e) => save({ slack_enabled: e.target.checked })}
              />
              Enabled
            </label>
          </div>
          <ol className="mb-3 list-decimal space-y-1 pl-5 text-xs text-slate-500">
            <li>
              Create a Slack app with a slash command (e.g. <code>/askdocs</code>) pointing at:
              <span className={urlCls}>{baseUrl}/api/integrations/slack/ask</span>
            </li>
            <li>
              Paste the app's <strong>Signing Secret</strong> below and enable.
            </li>
          </ol>
          <div className="flex gap-2">
            <input
              type="password"
              value={slackSecret}
              onChange={(e) => setSlackSecret(e.target.value)}
              placeholder={cfg.slack_secret_set ? "Signing secret is set — replace…" : "Signing secret"}
              className={inputCls}
              autoComplete="off"
            />
            <button
              onClick={() => save({ slack_signing_secret: slackSecret })}
              disabled={saving || !slackSecret.trim()}
              className="shrink-0 rounded-lg bg-compass-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-50"
            >
              Save
            </button>
          </div>
          {cfg.slack_secret_set && (
            <button
              onClick={() => save({ slack_signing_secret: "", slack_enabled: false })}
              disabled={saving}
              className="mt-2 text-xs font-medium text-red-600 hover:underline"
            >
              Remove secret &amp; disable
            </button>
          )}
        </div>

        {/* Teams */}
        <div className="rounded-lg border border-slate-200 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-medium text-slate-800">Teams outgoing webhook</span>
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={cfg.teams_enabled}
                disabled={saving || !cfg.teams_secret_set}
                onChange={(e) => save({ teams_enabled: e.target.checked })}
              />
              Enabled
            </label>
          </div>
          <ol className="mb-3 list-decimal space-y-1 pl-5 text-xs text-slate-500">
            <li>
              In a team: <em>Manage team → Apps → Create an outgoing webhook</em>, callback URL:
              <span className={urlCls}>{baseUrl}/api/integrations/teams/ask</span>
            </li>
            <li>
              Paste the <strong>security token</strong> Teams shows on creation below and enable.
              Then @mention the webhook in a channel to ask.
            </li>
          </ol>
          <div className="flex gap-2">
            <input
              type="password"
              value={teamsSecret}
              onChange={(e) => setTeamsSecret(e.target.value)}
              placeholder={cfg.teams_secret_set ? "Security token is set — replace…" : "Security token"}
              className={inputCls}
              autoComplete="off"
            />
            <button
              onClick={() => save({ teams_hmac_secret: teamsSecret })}
              disabled={saving || !teamsSecret.trim()}
              className="shrink-0 rounded-lg bg-compass-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-50"
            >
              Save
            </button>
          </div>
          {cfg.teams_secret_set && (
            <button
              onClick={() => save({ teams_hmac_secret: "", teams_enabled: false })}
              disabled={saving}
              className="mt-2 text-xs font-medium text-red-600 hover:underline"
            >
              Remove secret &amp; disable
            </button>
          )}
        </div>
      </div>

      {msg && <p className="mt-3 text-sm font-medium text-green-700">{msg}</p>}
      {error && (
        <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}
    </div>
  );
}
