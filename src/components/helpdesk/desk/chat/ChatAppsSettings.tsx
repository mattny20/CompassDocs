"use client";

// Desk settings → Chat apps (1.19.4; mock-up f1): let people raise, follow
// and approve requests from Microsoft Teams or Slack, through the admin's own
// Azure Bot or Slack app.
//
//   app cards   one per app, side by side (stacked on a phone): the tile,
//               the name, one status line and a Connected chip, or Connect.
//               Connect (or Edit) opens the card's form: the credentials
//               (stored encrypted, never shown again: a saved one reads as
//               dots with Replace), the address to paste into the bot or
//               app with Copy, and the setup steps (a native <details>).
//               Connect saves at once and calls nobody; Test asks Microsoft
//               or Slack and toasts the answer, which stays under the card.
//               Disconnect is confirmed and stops everything at once.
//   abilities   "What people can do in Teams" (one card per connected app):
//               four toggles, the last off by default.
//   channels    "Channels that open tickets": a house table (channel, team,
//               opened by) with an icon-only Remove, and an Add row.
//
// Abilities and channels share the page's one SaveRow. GET/PUT
// /api/helpdesk/admin/chat and POST …/test (settings.manage).

import { useCallback, useEffect, useRef, useState } from "react";
import { Hash, Lock, MessageCircle, Plus, PlugZap, Trash2 } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { chipClass } from "@/components/Chip";
import { CopyButton } from "@/components/CopyButton";
import { confirmDialog } from "@/components/Dialog";
import { Field, SectionEmpty, Select, TextInput, Toggle, controlClass } from "@/components/form";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { SaveRow } from "@/components/SaveRow";
import { LoadingRow } from "@/components/Spinner";
import { FIT, TABLE_HEAD_ROW, TD, TH, TR, Table } from "@/components/Table";
import { toast } from "@/components/Toasts";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import {
  CHAT_ENDPOINTS,
  HD_CHAT_ABILITIES,
  HD_CHAT_ABILITY_TEXT,
  HD_CHAT_APP_LABEL,
  HD_CHAT_APP_SHORT,
  type HdChatAbilities,
  type HdChatApp,
  type HdChatAppView,
  type HdChatChannel,
  type HdChatSettingsView,
} from "@/lib/helpdesk/chat-shared";
import { getJson, sendJson } from "../api";

const URL_ = "/api/helpdesk/admin/chat";

interface Form {
  abilities: Record<HdChatApp, HdChatAbilities>;
  channels: HdChatChannel[];
}

const formOf = (v: HdChatSettingsView): Form => ({ abilities: { teams: { ...v.teams.abilities }, slack: { ...v.slack.abilities } }, channels: v.channels.map((c) => ({ ...c })) });

const shortDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : "numeric" }) : "");

export function ChatAppsSettings() {
  const [view, setView] = useState<HdChatSettingsView | null>(null);
  const [f, setF] = useState<Form | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(JSON.stringify(f));
  useLeaveGuard(dirty, hasUnsavedChanges);

  const apply = useCallback(
    (v: HdChatSettingsView, resetForm: boolean) => {
      setView(v);
      if (resetForm) {
        const next = formOf(v);
        setF(next);
        markClean(JSON.stringify(next));
      }
    },
    [markClean]
  );

  useEffect(() => {
    // Only the latest load applies: a slower earlier answer must never reset what someone has started changing.
    let current = true;
    getJson<HdChatSettingsView>(URL_, "Couldn't load the chat app settings.")
      .then((v) => current && apply(v, true))
      .catch((e: Error) => current && setError(e.message));
    return () => {
      current = false;
    };
  }, [apply]);

  if (error && !view) return <PageContainer><p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p></PageContainer>;
  if (!view || !f) return <PageContainer><LoadingRow className="py-10" /></PageContainer>;

  const set = (patch: Partial<Form>) => {
    markDirty();
    setF({ ...f, ...patch });
  };

  async function save() {
    if (!f) return;
    setBusy(true);
    try {
      const v = await sendJson<HdChatSettingsView>(URL_, "PUT", { teams: { abilities: f.abilities.teams }, slack: { abilities: f.abilities.slack }, channels: f.channels }, "Couldn't save the chat app settings.");
      apply(v, true);
      toast("ok", "Chat app settings saved.");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // A card's own Connect, Test or Disconnect: the view changes, the page's unsaved toggles and channels stay.
  const onAppChanged = (v: HdChatSettingsView) => apply(v, false);
  const connectedApps = (["teams", "slack"] as const).filter((a) => view[a].connected);

  return (
    <PageContainer>
      <PageHeader icon={<MessageCircle />} title="Chat apps" subtitle="Let people raise and follow requests, and approve them, from Microsoft Teams or Slack." />
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <AppCard app="teams" v={view.teams} origin={view.origin} onChanged={onAppChanged} />
          <AppCard app="slack" v={view.slack} origin={view.origin} onChanged={onAppChanged} />
        </div>

        {connectedApps.map((app) => (
          <Card key={app} title={`What people can do in ${HD_CHAT_APP_SHORT[app]}`} id={`chat-abilities-${app}`} className="scroll-mt-6">
            <div className="divide-y divide-slate-100" data-testid={`chat-abilities-${app}`}>
              {HD_CHAT_ABILITIES.map((k) => (
                <Toggle
                  key={k}
                  size="full"
                  className="py-3 first:pt-0 last:pb-0"
                  label={HD_CHAT_ABILITY_TEXT[k].label}
                  help={HD_CHAT_ABILITY_TEXT[k].help}
                  checked={f.abilities[app][k]}
                  onChange={(on) => set({ abilities: { ...f.abilities, [app]: { ...f.abilities[app], [k]: on } } })}
                />
              ))}
            </div>
          </Card>
        ))}

        <ChannelsCard view={view} channels={f.channels} onChange={(channels) => set({ channels })} />
      </div>
      <SaveRow dirty={dirty} busy={busy} onSave={save} label="Save chat app settings" />
    </PageContainer>
  );
}

// --- One app's card ---------------------------------------------------------------------

function AppCard({ app, v, origin, onChanged }: { app: HdChatApp; v: HdChatAppView; origin: string; onChanged: (v: HdChatSettingsView) => void }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "test" | "disconnect">("");
  const [appId, setAppId] = useState(v.app_id);
  const [tenant, setTenant] = useState(v.tenant_id);
  const [secret, setSecret] = useState("");
  const [signing, setSigning] = useState("");
  const [replacing, setReplacing] = useState<{ secret: boolean; signing: boolean }>({ secret: false, signing: false });
  const firstInput = useRef<HTMLInputElement>(null);
  const endpoint = `${origin || "https://your-compassdocs-address"}${CHAT_ENDPOINTS[app]}`;
  const name = HD_CHAT_APP_LABEL[app];

  const open = () => {
    setAppId(v.app_id);
    setTenant(v.tenant_id);
    setSecret("");
    setSigning("");
    setReplacing({ secret: false, signing: false });
    setEditing(true);
    requestAnimationFrame(() => firstInput.current?.focus());
  };

  async function connect() {
    setBusy("save");
    try {
      const body =
        app === "teams"
          ? { teams: { app_id: appId, tenant_id: tenant, ...(secret.trim() ? { secret } : {}) } }
          : { slack: { ...(secret.trim() ? { bot_token: secret } : {}), ...(signing.trim() ? { signing_secret: signing } : {}) } };
      const view = await sendJson<HdChatSettingsView>(URL_, "PUT", body, `Couldn't save ${name}.`);
      onChanged(view);
      if (view[app].connected) {
        setEditing(false);
        toast("ok", v.connected ? `${name} saved.` : `${name} connected. Use Test to check it with ${app === "teams" ? "Microsoft" : "Slack"}.`);
      } else {
        toast("error", app === "teams" ? "Enter the app ID, the client secret and the tenant." : "Paste the bot token and the signing secret.");
      }
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function test() {
    setBusy("test");
    try {
      const r = await sendJson<{ ok: boolean; message: string; settings: HdChatSettingsView }>(`${URL_}/test`, "POST", { app }, "Couldn't test the connection.");
      onChanged(r.settings);
      toast(r.ok ? "ok" : "error", r.message);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function disconnect() {
    const ok = await confirmDialog({
      title: `Disconnect ${name}?`,
      body: `CompassDocs stops reading and sending ${HD_CHAT_APP_SHORT[app]} messages at once, and forgets who is who there. Tickets raised from ${HD_CHAT_APP_SHORT[app]} stay, and replies to them go by email.`,
      confirmLabel: "Disconnect",
      danger: true,
    });
    if (ok !== true) return;
    setBusy("disconnect");
    try {
      onChanged(await sendJson<HdChatSettingsView>(URL_, "PUT", { [app]: { disconnect: true } }, "Couldn't disconnect."));
      setEditing(false);
      toast("ok", `${name} disconnected.`);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy("");
    }
  }

  const status = v.connected
    ? app === "teams"
      ? `Connected · tenant ${v.tenant_id.length > 13 ? `${v.tenant_id.slice(0, 8)}…` : v.tenant_id}`
      : `Connected · ${v.team_name || (v.team_id ? `workspace ${v.team_id}` : "workspace not checked yet")}`
    : "Not connected";
  const help = v.connected
    ? `${v.connected_by ? `Connected by ${v.connected_by}` : "Connected"}${v.connected_at ? ` on ${shortDate(v.connected_at)}` : ""}.`
    : app === "teams"
      ? "Connect your Azure Bot to install the CompassDocs app in Teams."
      : "Connect a Slack workspace to install the CompassDocs app.";
  const showSecretInput = !v.secret_set || replacing.secret || (app === "teams" && appId.trim() !== v.app_id);
  const showSigningInput = !v.signing_secret_set || replacing.signing;
  const titleId = `chat-app-${app}`;

  return (
    <section aria-labelledby={titleId} className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs sm:p-5" data-testid={`chat-app-${app}`}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-compass-50 text-compass-700" aria-hidden>
          <MessageCircle className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 id={titleId} className="text-sm font-semibold text-slate-900">
            {name}
          </h2>
          <p className="text-sm text-slate-500">{status}</p>
        </div>
        {v.connected ? (
          <span className={chipClass("ok")}>Connected</span>
        ) : (
          !editing && (
            <Button className="ml-auto" onClick={open}>
              Connect
            </Button>
          )
        )}
      </div>
      <p className="mt-3 text-sm text-slate-500">{help}</p>
      {v.connected && v.last_test && (
        <p className={`mt-1 text-xs ${v.last_test.ok ? "text-slate-500" : "ink-warn"}`} data-testid={`chat-test-${app}`}>
          Last test {shortDate(v.last_test.at)}: {v.last_test.message}
        </p>
      )}

      {v.connected && !editing && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" icon={<PlugZap />} busy={busy === "test"} onClick={test}>
            Test
          </Button>
          <Button variant="ghost" size="sm" onClick={open}>
            Edit
          </Button>
          <Button variant="ghost" size="sm" busy={busy === "disconnect"} onClick={disconnect}>
            Disconnect
          </Button>
        </div>
      )}

      {editing && (
        <div className="mt-4 border-t border-slate-100 pt-4" data-testid={`chat-form-${app}`}>
          <div className="grid grid-cols-1 gap-3">
            {app === "teams" && (
              <>
                <Field label="App ID" help="The Microsoft App ID of your Azure Bot.">
                  <TextInput ref={firstInput} value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" autoComplete="off" spellCheck={false} />
                </Field>
                <Field label="Tenant ID" help="Your Microsoft Entra tenant ID. Messages from any other tenant are refused.">
                  <TextInput value={tenant} onChange={(e) => setTenant(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" autoComplete="off" spellCheck={false} />
                </Field>
              </>
            )}
            <SecretField
              label={app === "teams" ? "Client secret" : "Bot token"}
              placeholder={app === "teams" ? "The secret's Value, from Certificates & secrets" : "xoxb-…"}
              show={showSecretInput}
              value={secret}
              onChange={setSecret}
              onReplace={() => setReplacing((r) => ({ ...r, secret: true }))}
              inputRef={app === "slack" ? firstInput : undefined}
            />
            {app === "slack" && (
              <SecretField
                label="Signing secret"
                placeholder="From the app's Basic Information page"
                show={showSigningInput}
                value={signing}
                onChange={setSigning}
                onReplace={() => setReplacing((r) => ({ ...r, signing: true }))}
              />
            )}
            <div role="group" aria-labelledby={`${titleId}-endpoint`}>
              <span id={`${titleId}-endpoint`} className="mb-1 block text-xs font-medium text-slate-500">
                {app === "teams" ? "Messaging endpoint" : "Request URL (Events and Interactivity)"}
              </span>
              <div className="flex items-center gap-2">
                <code className={controlClass(false, "min-w-0 flex-1 truncate font-mono text-xs leading-6")} data-testid={`chat-endpoint-${app}`}>
                  {endpoint}
                </code>
                <CopyButton text={endpoint} />
              </div>
            </div>
          </div>
          <p className="mt-2 text-xs text-slate-500">Secrets are stored encrypted and never shown again. Saving calls nobody; Test checks them with {app === "teams" ? "Microsoft" : "Slack"}.</p>
          <SetupSteps app={app} endpoint={endpoint} />
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button busy={busy === "save"} onClick={connect}>
              {v.connected ? "Save" : "Connect"}
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function SecretField({
  label,
  placeholder,
  show,
  value,
  onChange,
  onReplace,
  inputRef,
}: {
  label: string;
  placeholder: string;
  show: boolean;
  value: string;
  onChange: (v: string) => void;
  onReplace: () => void;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  const own = useRef<HTMLInputElement>(null);
  const [focusNext, setFocusNext] = useState(false);
  useEffect(() => {
    if (show && focusNext) {
      own.current?.focus();
      setFocusNext(false);
    }
  }, [show, focusNext]);
  if (show) {
    return (
      <Field label={label}>
        <TextInput
          ref={(el) => {
            own.current = el;
            if (typeof inputRef === "function") inputRef(el);
            else if (inputRef) (inputRef as React.MutableRefObject<HTMLInputElement | null>).current = el;
          }}
          type="password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
    );
  }
  const id = `secret-${label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    // A saved secret: not a control, so not inside Field's <label> (a button there takes the label's name).
    <div role="group" aria-labelledby={id}>
      <span id={id} className="mb-1 block text-xs font-medium text-slate-500">
        {label}
      </span>
      <div className={controlClass(false, "flex items-center gap-2")}>
        <span aria-hidden>••••••••••••••••</span>
        <span className="sr-only">Saved</span>
        <Lock className="h-3.5 w-3.5 text-slate-500" aria-hidden />
        <button
          type="button"
          className="link ml-auto text-sm"
          aria-label={`Replace the ${label.toLowerCase()}`}
          onClick={() => {
            setFocusNext(true);
            onReplace();
          }}
        >
          Replace
        </button>
      </div>
    </div>
  );
}

function slackManifest(endpoint: string): string {
  return `display_information:
  name: CompassDocs
  description: Raise and follow helpdesk requests, and approve them.
features:
  app_home:
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: CompassDocs
    always_online: true
  shortcuts:
    - name: Get help
      type: message
      callback_id: cd_get_help
      description: Raise a request about this message
    - name: Turn into a ticket
      type: message
      callback_id: cd_make_ticket
      description: Agents only. Open a ticket from this message
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - chat:write
      - commands
      - im:history
      - im:write
      - reactions:read
      - users:read
      - users:read.email
settings:
  event_subscriptions:
    request_url: ${endpoint}
    bot_events:
      - app_mention
      - message.im
      - reaction_added
  interactivity:
    is_enabled: true
    request_url: ${endpoint}
  org_deploy_enabled: false
  socket_mode_enabled: false
`;
}

function SetupSteps({ app, endpoint }: { app: HdChatApp; endpoint: string }) {
  return (
    <details className="mt-3 text-sm text-slate-600">
      <summary className="cursor-pointer text-sm font-semibold text-slate-900">How to set up {HD_CHAT_APP_SHORT[app]}</summary>
      {app === "teams" ? (
        <ol className="mt-2 list-decimal space-y-1.5 pl-5">
          <li>In the Azure portal, create an Azure Bot of type Single Tenant in your tenant. Copy its Microsoft App ID, and under Certificates &amp; secrets add a client secret (copy its Value).</li>
          <li>In the bot&apos;s Configuration, paste the messaging endpoint above. Under Channels, add Microsoft Teams.</li>
          <li>
            In the Teams Developer Portal, make an app with this bot in the Personal and Team scopes, and two message actions with &ldquo;Fetch a dynamic set of parameters&rdquo;: <b>Get help</b> (command ID getHelp) and <b>Turn into a ticket</b> (makeTicket).
          </li>
          <li>Publish it to your organisation and install it for the people who should use it (Teams admin centre, setup policies). People are matched through the Microsoft directory sync, so it must be on.</li>
          <li>Channels open tickets only when the app is added to that team and someone mentions it there.</li>
        </ol>
      ) : (
        <>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5">
            <li>At api.slack.com/apps, create an app From an app manifest, and paste the manifest below (the Request URL is already in it).</li>
            <li>Install it to your workspace. Paste the Bot User OAuth Token (xoxb-…) from OAuth &amp; Permissions, and the Signing Secret from Basic Information.</li>
            <li>People are matched by the email address on their Slack profile, which must be the confirmed address of their CompassDocs account.</li>
            <li>To open tickets from a channel, invite the app to it, then add the channel below.</li>
          </ol>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <CopyButton text={() => slackManifest(endpoint)} label="Copy app manifest" />
          </div>
        </>
      )}
    </details>
  );
}

// --- Channels that open tickets -------------------------------------------------------------

function ChannelsCard({ view, channels, onChange }: { view: HdChatSettingsView; channels: HdChatChannel[]; onChange: (c: HdChatChannel[]) => void }) {
  const teamName = (id: number) => view.teams_list.find((t) => t.id === id)?.name ?? "A team that was removed";
  const firstApp: HdChatApp = view.slack.connected && !view.teams.connected ? "slack" : "teams";
  const blank = (): Omit<HdChatChannel, "id"> => ({ app: firstApp, channel_id: "", name: "", team_id: view.teams_list[0]?.id ?? 0, trigger: "mention", reaction: "ticket" });
  const [draft, setDraft] = useState(blank);
  const [adding, setAdding] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const appSelect = useRef<HTMLSelectElement>(null);

  const add = () => {
    if (!draft.channel_id.trim()) {
      toast("error", "Enter the channel ID.");
      return;
    }
    const id = Math.random().toString(36).slice(2, 12);
    onChange([...channels, { ...draft, id, channel_id: draft.channel_id.trim(), name: draft.name.trim().replace(/^#/, "") || draft.channel_id.trim(), reaction: draft.trigger === "reaction" ? draft.reaction.replace(/:/g, "").trim() : "" }]);
    setDraft(blank());
    setAdding(false);
    requestAnimationFrame(() => addButton.current?.focus());
  };
  const remove = (i: number) => {
    onChange(channels.filter((_, j) => j !== i));
    requestAnimationFrame(() => addButton.current?.focus());
  };

  return (
    // relative: the header's sr-only "Actions" (absolutely placed) stays inside the card instead of widening a phone's page.
    <Card title="Channels that open tickets" padding="none" id="chat-channels" className="relative scroll-mt-6">
      {channels.length ? (
        <Table scroll minWidth="36rem" data-testid="chat-channels">
          <thead>
            <tr className={TABLE_HEAD_ROW}>
              <th className={TH}>Channel</th>
              <th className={TH}>Team</th>
              <th className={TH}>Opened by</th>
              <th className={`${TH} ${FIT}`}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {channels.map((c, i) => (
              <tr key={c.id} className={TR}>
                <td className={TD}>
                  <span className="inline-flex items-center gap-1.5 font-medium text-slate-900">
                    <Hash className="h-3.5 w-3.5 text-slate-500" aria-hidden />
                    {c.name}
                  </span>
                  <span className="block text-xs text-slate-500">{HD_CHAT_APP_SHORT[c.app]}</span>
                </td>
                <td className={TD}>{teamName(c.team_id)}</td>
                <td className={`${TD} text-slate-600`}>{c.trigger === "mention" ? "Any message that mentions @CompassDocs" : `The :${c.reaction}: reaction`}</td>
                <td className={`${TD} ${FIT}`}>
                  <button type="button" className={iconButtonClass("quiet", "sm")} aria-label={`Remove #${c.name}`} data-tt="Remove" onClick={() => remove(i)}>
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <SectionEmpty className="px-4 py-5">No channels open tickets yet. People can still message the app directly.</SectionEmpty>
      )}
      <div className="border-t border-slate-100 px-4 py-3">
        {adding ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_10rem]" data-testid="chat-channel-add">
            <Field label="App" size="full">
              <Select ref={appSelect} value={draft.app} onChange={(e) => setDraft({ ...draft, app: e.target.value as HdChatApp, trigger: e.target.value === "teams" ? "mention" : draft.trigger })}>
                <option value="teams">Teams</option>
                <option value="slack">Slack</option>
              </Select>
            </Field>
            <Field label="Channel ID" size="full" help={draft.app === "slack" ? "Starts with C" : "Starts with 19:"}>
              <TextInput value={draft.channel_id} onChange={(e) => setDraft({ ...draft, channel_id: e.target.value })} autoComplete="off" spellCheck={false} />
            </Field>
            <Field label="Name" size="full">
              <TextInput value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="it-help" />
            </Field>
            <Field label="Team" size="full">
              <Select value={String(draft.team_id)} onChange={(e) => setDraft({ ...draft, team_id: Number(e.target.value) })}>
                {view.teams_list.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Opened by" size="full">
              <Select value={draft.trigger} onChange={(e) => setDraft({ ...draft, trigger: e.target.value as HdChatChannel["trigger"] })}>
                <option value="mention">A mention</option>
                {draft.app === "slack" && <option value="reaction">A reaction</option>}
              </Select>
            </Field>
            {draft.trigger === "reaction" && (
              <Field label="Reaction" size="sm" help="Its name, like ticket">
                <TextInput value={draft.reaction} onChange={(e) => setDraft({ ...draft, reaction: e.target.value })} autoComplete="off" spellCheck={false} />
              </Field>
            )}
            <div className="flex flex-wrap items-center gap-2 sm:col-span-2 lg:col-span-5">
              <Button variant="secondary" size="sm" onClick={add}>
                Add channel
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <span className="text-xs text-slate-500">Saved with the page. Tickets go to the team, with the person who posted as the requester.</span>
            </div>
          </div>
        ) : (
          <Button
            ref={addButton}
            variant="secondary"
            size="sm"
            icon={<Plus />}
            disabled={!view.teams_list.length || channels.length >= 50}
            onClick={() => {
              setAdding(true);
              requestAnimationFrame(() => appSelect.current?.focus());
            }}
          >
            Add a channel
          </Button>
        )}
      </div>
    </Card>
  );
}
