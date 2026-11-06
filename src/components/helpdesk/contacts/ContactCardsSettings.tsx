"use client";

// Desk settings → Contact cards (Helpdesk 1.19.0). Which directory field
// fills each slot of a contact card, the chat apps (Teams, Webex, Slack),
// up to six extra fields, who counts as a VIP, office time zones, and what
// each side sees: agents on a requester's card, requesters on the agent's.
// The directory's own visibility always wins: a field set to admins only
// in Directory → Fields shows only to directory admins, whatever is ticked
// here. One PUT to /api/helpdesk/admin/contact-cards.

import { useEffect, useMemo, useState } from "react";
import { Contact, Crown, Plus, X } from "lucide-react";
import { Card } from "@/components/Card";
import { iconButtonClass } from "@/components/Button";
import { EntityPicker } from "@/components/EntityPicker";
import { Field, SectionEmpty, Select, TextInput } from "@/components/form";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { SaveRow } from "@/components/SaveRow";
import { LoadingRow } from "@/components/Spinner";
import { toast } from "@/components/Toasts";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import {
  HD_CARD_EXTRA_MAX,
  HD_CARD_PARTS,
  HD_CARD_PART_LABEL,
  HD_CARD_SLOT_LABEL,
  normalizeSlackDomain,
  normalizeSlackTeamId,
  slackLinks,
  validTimeZone,
  type HdCardPart,
  type HdCardSlot,
  type HdContactCardSettings,
  type HdVipEntry,
} from "@/lib/helpdesk/contact-cards-shared";
import { getJson, sendJson } from "../desk/api";

interface FieldOpt {
  key: string;
  label: string;
  kind: string;
  display: string;
  visibility: string;
  builtin: boolean;
}
interface Options {
  fields: FieldOpt[];
  markers: { id: string; label: string; symbol: string }[];
  groups: { id: number; name: string }[];
  departments: string[];
  offices: { key: string; name: string }[];
  users: { id: number; name: string; email: string }[];
  labels: { users: Record<number, string>; groups: Record<number, string> };
}

const SLOTS: { slot: HdCardSlot; help: string; people?: boolean }[] = [
  { slot: "desk_phone", help: "Click to call from the card." },
  { slot: "cell_phone", help: "Click to call. Requesters don't see it unless you tick it below." },
  { slot: "email", help: "Opens the viewer's own mail app. Without a value, the account's email." },
  { slot: "title", help: "" },
  { slot: "department", help: "" },
  { slot: "office", help: "With its local time when the office has a time zone (below)." },
  { slot: "manager", help: "A people field: links to their profile.", people: true },
  { slot: "pronouns", help: "Shown under the name." },
  { slot: "timezone", help: "A field holding a time zone such as Europe/London; empty uses the office's." },
];

/** Parts that are only about the requester (agents see them on requester cards). */
const AGENT_ONLY: HdCardPart[] = [];
/** Parts only an agent's card has (requesters see them on the agent's). */
const AGENT_CARD_ONLY: HdCardPart[] = ["team", "availability"];

export function ContactCardsSettings() {
  const [s, setS] = useState<HdContactCardSettings | null>(null);
  const [opts, setOpts] = useState<Options | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const snap = JSON.stringify(s);
  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(snap);
  useLeaveGuard(dirty, hasUnsavedChanges);

  useEffect(() => {
    getJson<{ settings: HdContactCardSettings; options: Options }>("/api/helpdesk/admin/contact-cards", "Couldn't load the contact card settings.")
      .then((d) => {
        setS(d.settings);
        setOpts(d.options);
        markClean(JSON.stringify(d.settings));
      })
      .catch((e: Error) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const zones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
    } catch {
      return [];
    }
  }, []);

  if (error && !s) return <PageContainer><p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p></PageContainer>;
  if (!s || !opts) return <PageContainer><LoadingRow className="py-10" /></PageContainer>;

  const set = (patch: Partial<HdContactCardSettings>) => {
    markDirty();
    setS({ ...s, ...patch });
  };
  const fieldLabel = (f: FieldOpt) => `${f.label}${f.visibility === "admins" ? " (admins only)" : ""}`;
  const valueFields = opts.fields.filter((f) => f.kind !== "people");
  const peopleFields = opts.fields.filter((f) => f.kind === "people");
  const textFields = opts.fields.filter((f) => f.kind === "text");

  const fieldSelect = (value: string, onChange: (v: string) => void, list: FieldOpt[], none = "Not shown") => (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{none}</option>
      {list.map((f) => (
        <option key={f.key} value={f.key}>
          {fieldLabel(f)}
        </option>
      ))}
      {value && !list.some((f) => f.key === value) && <option value={value}>{value} (no longer in the directory)</option>}
    </Select>
  );

  async function save() {
    if (!s) return;
    if (s.slack.mode === "field" && s.slack.domain && !normalizeSlackDomain(s.slack.domain)) {
      toast("error", "The Slack workspace should look like acme or acme.slack.com.");
      return;
    }
    if (s.slack.mode === "field" && s.slack.team_id && !normalizeSlackTeamId(s.slack.team_id)) {
      toast("error", "The Slack team ID starts with T and has letters and digits, like T01ABCDEF.");
      return;
    }
    const badZone = Object.entries(s.office_timezones).find(([, z]) => z && !validTimeZone(z));
    if (badZone) {
      toast("error", `"${badZone[1]}" isn't a time zone. Pick one from the list, such as Europe/London.`);
      return;
    }
    setBusy(true);
    try {
      const out = await sendJson<{ settings: HdContactCardSettings }>("/api/helpdesk/admin/contact-cards", "PUT", s, "Couldn't save the contact card settings.");
      setS(out.settings);
      markClean(JSON.stringify(out.settings));
      toast("ok", "Contact card settings saved.");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const togglePart = (side: "agent_sees" | "requester_sees", p: HdCardPart, on: boolean) => {
    const cur = new Set(s[side]);
    if (on) cur.add(p);
    else cur.delete(p);
    set({ [side]: HD_CARD_PARTS.filter((x) => cur.has(x)) } as Partial<HdContactCardSettings>);
  };

  const vipList = s.vip.list;
  const setVip = (patch: Partial<HdContactCardSettings["vip"]>) => set({ vip: { ...s.vip, ...patch } });
  const addVip = (e: HdVipEntry) => setVip({ list: [...vipList, e] });
  const vipName = (e: HdVipEntry) =>
    e.kind === "user"
      ? opts.users.find((u) => u.id === e.user_id)?.name ?? opts.labels.users[e.user_id!] ?? `Person ${e.user_id}`
      : e.kind === "group"
        ? opts.groups.find((g) => g.id === e.group_id)?.name ?? opts.labels.groups[e.group_id!] ?? `Group ${e.group_id}`
        : e.department!;
  const slackPreview = slackLinks("U012AB3CD", s.slack.domain, s.slack.team_id);

  return (
    <PageContainer>
      <PageHeader
        icon={<Contact />}
        title="Contact cards"
        subtitle="Who's who on a ticket, from the directory: what each card shows and who sees what."
      />
      <div className="flex flex-col gap-4">
        <Card
          title="Fields from the directory"
          description="Pick the directory field behind each line of the card. Fields set to admins only in the directory show only to directory admins, whatever you pick here."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            {SLOTS.map(({ slot, help, people }) => (
              <Field key={slot} label={HD_CARD_SLOT_LABEL[slot]} help={help || undefined}>
                {fieldSelect(
                  s.fields[slot],
                  (v) => set({ fields: { ...s.fields, [slot]: v } }),
                  people ? peopleFields : slot === "timezone" ? textFields : valueFields,
                  slot === "timezone" ? "From the office" : "Not shown"
                )}
              </Field>
            ))}
          </div>
        </Card>

        <Card title="Chat" description="Buttons on the card that open a chat with the person: in a new tab, or straight in the app where it has its own link.">
          <div className="flex flex-col gap-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Teams" help="Chats by email or sign-in name (UPN).">
                <Select value={s.teams.mode} onChange={(e) => set({ teams: { ...s.teams, mode: e.target.value as HdContactCardSettings["teams"]["mode"] } })}>
                  <option value="microsoft">People synced from Microsoft 365</option>
                  <option value="everyone">Everyone with an email</option>
                  <option value="field">A directory field</option>
                  <option value="off">Off</option>
                </Select>
              </Field>
              {s.teams.mode === "field" && (
                <Field label="Teams field" help="Holds their Teams sign-in name, such as ana@example.com.">
                  {fieldSelect(s.teams.field, (v) => set({ teams: { ...s.teams, field: v } }), textFields, "Pick a field")}
                </Field>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Webex" help="An address opens a Webex chat; a webex.com room link opens the room.">
                <Select value={s.webex.mode} onChange={(e) => set({ webex: { ...s.webex, mode: e.target.value as HdContactCardSettings["webex"]["mode"] } })}>
                  <option value="off">Off</option>
                  <option value="email">Use their email</option>
                  <option value="field">A directory field</option>
                </Select>
              </Field>
              {s.webex.mode === "field" && (
                <Field label="Webex field" help="Holds a Webex address or a personal room link.">
                  {fieldSelect(s.webex.field, (v) => set({ webex: { ...s.webex, field: v } }), textFields, "Pick a field")}
                </Field>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Slack" help="Slack links need each person's member ID (U…), from their Slack profile.">
                <Select value={s.slack.mode} onChange={(e) => set({ slack: { ...s.slack, mode: e.target.value as HdContactCardSettings["slack"]["mode"] } })}>
                  <option value="off">Off</option>
                  <option value="field">A directory field holds the member ID</option>
                </Select>
              </Field>
              {s.slack.mode === "field" && (
                <>
                  <Field label="Member ID field">
                    {fieldSelect(s.slack.field, (v) => set({ slack: { ...s.slack, field: v } }), textFields, "Pick a field")}
                  </Field>
                  <Field label="Workspace" help="Your Slack address: acme for acme.slack.com.">
                    <TextInput value={s.slack.domain} maxLength={80} spellCheck={false} placeholder="acme" onChange={(e) => set({ slack: { ...s.slack, domain: e.target.value } })} />
                  </Field>
                  <Field label="Team ID (optional)" help="T…, from Slack's About this workspace. Adds an open-in-app link.">
                    <TextInput value={s.slack.team_id} maxLength={24} spellCheck={false} placeholder="T01ABCDEF" onChange={(e) => set({ slack: { ...s.slack, team_id: e.target.value } })} />
                  </Field>
                  <p className="text-xs text-slate-500 sm:col-span-2">
                    {slackPreview ? (
                      <>
                        A card links to <code className="break-all">{slackPreview.href.replace("U012AB3CD", "<member ID>")}</code>
                        {slackPreview.app_href && <> and <code className="break-all">{slackPreview.app_href.replace("U012AB3CD", "<member ID>")}</code></>}.
                      </>
                    ) : (
                      "Add the workspace (or the team ID) to make Slack links."
                    )}
                  </p>
                </>
              )}
            </div>
          </div>
        </Card>

        <Card title="Extra fields" description={`Up to ${HD_CARD_EXTRA_MAX} more directory fields under the contact lines: pronouns, extension, location, assistant.`}>
          <ul className="flex flex-col gap-2">
            {s.extra.map((key, i) => (
              <li key={`${key}-${i}`} className="flex items-center gap-2">
                <span className="w-full max-w-md">
                  {fieldSelect(
                    key,
                    (v) => set({ extra: s.extra.map((k, j) => (j === i ? v : k)).filter(Boolean) }),
                    opts.fields.filter((f) => f.key === key || !s.extra.includes(f.key)),
                    "Remove"
                  )}
                </span>
                <button
                  type="button"
                  className={iconButtonClass("quiet", "md")}
                  data-tt="Remove"
                  aria-label={`Remove ${opts.fields.find((f) => f.key === key)?.label ?? key}`}
                  onClick={() => set({ extra: s.extra.filter((_, j) => j !== i) })}
                >
                  <X />
                </button>
              </li>
            ))}
          </ul>
          {s.extra.length < HD_CARD_EXTRA_MAX && (
            <div className="mt-3 max-w-md">
              <Select
                aria-label="Add a field"
                value=""
                onChange={(e) => e.target.value && set({ extra: [...s.extra, e.target.value] })}
              >
                <option value="">Add a field…</option>
                {opts.fields
                  .filter((f) => !s.extra.includes(f.key))
                  .map((f) => (
                    <option key={f.key} value={f.key}>
                      {fieldLabel(f)}
                    </option>
                  ))}
              </Select>
            </div>
          )}
        </Card>

        <Card
          title="VIPs"
          icon={<Crown />}
          description="A VIP chip on the requester's card, the ticket and the queue, for agents only. Assignment rules and reports can use it too."
        >
          <div className="flex flex-col gap-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="From the directory">
                <Select value={s.vip.rule} onChange={(e) => setVip({ rule: e.target.value as HdContactCardSettings["vip"]["rule"] })}>
                  <option value="off">Off</option>
                  <option value="field">A field has a value</option>
                  <option value="marker" disabled={opts.markers.length === 0}>
                    An export marker{opts.markers.length === 0 ? " (none yet)" : ""}
                  </option>
                </Select>
              </Field>
              {s.vip.rule === "field" && (
                <>
                  <Field label="Field">{fieldSelect(s.vip.field, (v) => setVip({ field: v }), opts.fields, "Pick a field")}</Field>
                  <Field label="Value" help="Leave empty for anyone with a value.">
                    <TextInput value={s.vip.value} maxLength={120} placeholder="Partner" onChange={(e) => setVip({ value: e.target.value })} />
                  </Field>
                </>
              )}
              {s.vip.rule === "marker" && (
                <Field label="Marker" help="The markers from Directory, Export.">
                  <Select value={s.vip.marker_id} onChange={(e) => setVip({ marker_id: e.target.value })}>
                    <option value="">Pick a marker</option>
                    {opts.markers.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.symbol} {m.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </div>

            <div>
              <h3 className="mb-1 text-sm font-semibold text-slate-800">Helpdesk VIP list</h3>
              <p className="mb-3 text-xs text-slate-500">People, groups and departments, with a note agents see on the chip.</p>
              {vipList.length > 0 && (
                <ul className="mb-3 divide-y divide-slate-100 rounded-lg border border-slate-200">
                  {vipList.map((e, i) => (
                    <li key={`${e.kind}-${e.user_id ?? e.group_id ?? e.department}`} className="flex flex-wrap items-center gap-2 px-3 py-2">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-slate-800">{vipName(e)}</span>
                        <span className="block text-xs text-slate-500">{e.kind === "user" ? "Person" : e.kind === "group" ? "Group" : "Department"}</span>
                      </span>
                      <TextInput
                        dense
                        aria-label={`Note for ${vipName(e)}`}
                        className="w-full sm:w-64"
                        maxLength={120}
                        placeholder="Note (optional)"
                        value={e.note}
                        onChange={(ev) => setVip({ list: vipList.map((x, j) => (j === i ? { ...x, note: ev.target.value } : x)) })}
                      />
                      <button
                        type="button"
                        className={iconButtonClass("quiet", "md")}
                        data-tt="Remove"
                        aria-label={`Remove ${vipName(e)} from the VIP list`}
                        onClick={() => setVip({ list: vipList.filter((_, j) => j !== i) })}
                      >
                        <X />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <span className="mb-1 block text-xs font-medium text-slate-500">Add a person</span>
                  <EntityPicker
                    label="Add a person"
                    placeholder="Search people…"
                    options={opts.users
                      .filter((u) => !vipList.some((e) => e.kind === "user" && e.user_id === u.id))
                      .map((u) => ({ id: u.id, label: u.name, sublabel: u.email }))}
                    onPick={(id) => addVip({ kind: "user", user_id: id, note: "" })}
                  />
                </div>
                <Field label="Add a group">
                  <Select value="" onChange={(e) => e.target.value && addVip({ kind: "group", group_id: Number(e.target.value), note: "" })}>
                    <option value="">Pick a group…</option>
                    {opts.groups
                      .filter((g) => !vipList.some((e) => e.kind === "group" && e.group_id === g.id))
                      .map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                  </Select>
                </Field>
                <Field label="Add a department">
                  <Select value="" onChange={(e) => e.target.value && addVip({ kind: "department", department: e.target.value, note: "" })}>
                    <option value="">Pick a department…</option>
                    {opts.departments
                      .filter((d) => !vipList.some((e) => e.kind === "department" && e.department?.toLowerCase() === d.toLowerCase()))
                      .map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                  </Select>
                </Field>
              </div>
            </div>
          </div>
        </Card>

        <Card title="Office time zones" description="A card shows the person's local time from their office's time zone.">
          {opts.offices.length === 0 ? (
            <SectionEmpty>No offices in the directory yet.</SectionEmpty>
          ) : (
            <>
              <datalist id="hd-cc-zones">
                {zones.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
              <ul className="grid gap-3 sm:grid-cols-2">
                {opts.offices.map((o) => (
                  <li key={o.key}>
                    <Field label={o.name}>
                      <TextInput
                        list="hd-cc-zones"
                        spellCheck={false}
                        placeholder="Europe/London"
                        value={s.office_timezones[o.key] ?? ""}
                        onChange={(e) => {
                          const next = { ...s.office_timezones };
                          if (e.target.value.trim()) next[o.key] = e.target.value.trim();
                          else delete next[o.key];
                          set({ office_timezones: next });
                        }}
                      />
                    </Field>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>

        <Card
          title="Who sees what"
          description="Agents see the cards of the people on a ticket; requesters see the card of the agent working on theirs. Phone numbers are off for requesters until you tick them."
          padding="none"
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                  <th scope="col" className="px-5 py-2">On the card</th>
                  <th scope="col" className="px-3 py-2 text-center">Agents see</th>
                  <th scope="col" className="px-5 py-2 text-center">Requesters see</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {HD_CARD_PARTS.map((p) => (
                  <tr key={p}>
                    <th scope="row" className="px-5 py-2 text-left font-medium text-slate-800">
                      {HD_CARD_PART_LABEL[p]}
                    </th>
                    <td className="px-3 py-2 text-center">
                      {AGENT_ONLY.includes(p) ? null : (
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-compass-600"
                          aria-label={`Agents see ${HD_CARD_PART_LABEL[p].toLowerCase()}`}
                          checked={s.agent_sees.includes(p)}
                          onChange={(e) => togglePart("agent_sees", p, e.target.checked)}
                        />
                      )}
                    </td>
                    <td className="px-5 py-2 text-center">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-compass-600"
                        aria-label={`Requesters see ${HD_CARD_PART_LABEL[p].toLowerCase()}`}
                        checked={s.requester_sees.includes(p)}
                        onChange={(e) => togglePart("requester_sees", p, e.target.checked)}
                      />
                      {AGENT_CARD_ONLY.includes(p) && <span className="sr-only"> (on the agent&rsquo;s card)</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
            VIP and earlier tickets are for agents only and never show to requesters.
          </p>
        </Card>
      </div>
      <SaveRow dirty={dirty} busy={busy} onSave={save} label="Save contact cards" />
    </PageContainer>
  );
}
