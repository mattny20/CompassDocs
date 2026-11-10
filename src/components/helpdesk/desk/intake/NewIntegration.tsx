"use client";

// Settings → Integrations → New (agent P): three steps. Pick the kind of
// tool; name it and say where its tickets go and how alerts dedupe; then
// the endpoint and the key, shown once, with a curl example and the tool's
// setup notes. Automated email has no key: its last step is the notes.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Plug } from "lucide-react";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { FormError } from "@/components/form";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { toast } from "@/components/Toasts";
import {
  HD_INTEGRATION_KINDS,
  HD_INTEGRATION_KIND_LABEL,
  HD_INTEGRATION_KIND_SHORT,
  type HdIntegrationKind,
  type HdIntegrationView,
} from "@/lib/helpdesk/intake/shared";
import { getJson, sendJson } from "../api";
import { DRAFT_DEFAULTS, IntegrationForm, draftBody, type IntegrationDraft } from "./IntegrationForm";
import { KIND_HINT, KIND_ICON } from "./kind-icons";
import { KeyOnce } from "./KeyOnce";
import { SetupNotes } from "./SetupNotes";

type Step = 1 | 2 | 3;

export function NewIntegration({ initialKind = null }: { initialKind?: HdIntegrationKind | null }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(initialKind ? 2 : 1);
  const [kind, setKind] = useState<HdIntegrationKind | null>(initialKind);
  const [draft, setDraft] = useState<IntegrationDraft>({ ...DRAFT_DEFAULTS, name: initialKind ? `Monitoring` : "" });
  const [teams, setTeams] = useState<{ id: number; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{ integration: HdIntegrationView; key: string | null } | null>(null);

  useEffect(() => {
    getJson<{ teams: { id: number; name: string }[] }>("/api/helpdesk/intake/integrations", "Couldn't load the teams.")
      .then((d) => setTeams(d.teams))
      .catch(() => setTeams([]));
  }, []);

  function pick(k: HdIntegrationKind) {
    setKind(k);
    setDraft((d) => ({ ...d, name: d.name || (k === "email" ? "Automated mail" : k === "api" ? "Bot" : "Monitoring") }));
  }

  async function create() {
    if (!kind) return;
    setBusy(true);
    setError("");
    try {
      const r = await sendJson<{ integration: HdIntegrationView; key: string | null }>(
        "/api/helpdesk/intake/integrations",
        "POST",
        { kind, ...draftBody(draft, kind) },
        "Couldn't create the integration."
      );
      setCreated(r);
      setStep(3);
      toast("ok", `${r.integration.name} created.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const done = () => router.push(created ? `/desk/settings/integrations/${created.integration.id}` : "/desk/settings/integrations/alerts");

  return (
    <PageContainer>
      <PageHeader
        icon={<Plug />}
        title="New integration"
        subtitle="Connect a monitoring tool, a bot or automated mail."
        back={{ href: "/desk/settings/integrations/alerts", label: "Alert sources" }}
      />
      <p className="mb-3 text-xs font-medium text-slate-500" aria-live="polite">
        Step {step} of 3 · {step === 1 ? "Choose the tool" : step === 2 ? "Where its tickets go" : kind === "email" ? "Set it up" : "Your key"}
      </p>

      {step === 1 && (
        <Card title="What sends the alerts?">
          <div role="radiogroup" aria-label="Kind of integration" className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
            {HD_INTEGRATION_KINDS.map((k) => {
              const Icon = KIND_ICON[k];
              const on = kind === k;
              return (
                <label
                  key={k}
                  className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3.5 py-3 transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-compass-500 ${
                    on ? "border-compass-300 bg-compass-50/60" : "border-slate-200 bg-surface hover:bg-slate-50"
                  }`}
                >
                  <input type="radio" name="kind" value={k} checked={on} onChange={() => pick(k)} className="sr-only" />
                  <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${on ? "bg-compass-100 text-compass-700" : "bg-slate-100 text-slate-600"}`}>
                    <Icon className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-slate-800">{HD_INTEGRATION_KIND_LABEL[k]}</span>
                    <span className="block text-xs text-slate-500">{KIND_HINT[k]}</span>
                  </span>
                </label>
              );
            })}
          </div>
          <div className="mt-4 flex items-center gap-3">
            <Button disabled={!kind} onClick={() => setStep(2)} icon={<ArrowRight />}>
              Continue
            </Button>
          </div>
        </Card>
      )}

      {step === 2 && kind && (
        <Card
          title={HD_INTEGRATION_KIND_LABEL[kind]}
          description={`Tickets from it show as ${draft.name.trim() || "its name"} (${HD_INTEGRATION_KIND_SHORT[kind]}), marked Automated, with nobody to reply to.`}
        >
          <IntegrationForm kind={kind} draft={draft} teams={teams} onChange={(p) => setDraft((d) => ({ ...d, ...p }))} />
          <FormError className="mt-4">{error}</FormError>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button onClick={create} busy={busy} disabled={!draft.name.trim() || (kind === "email" && !draft.sender_addresses.trim())}>
              {kind === "email" ? "Create integration" : "Create and show the key"}
            </Button>
            <Button variant="ghost" onClick={() => setStep(1)} disabled={busy}>
              Back
            </Button>
          </div>
        </Card>
      )}

      {step === 3 && created && kind && (
        <Card title={created.integration.name} description={HD_INTEGRATION_KIND_LABEL[kind]}>
          {created.key ? (
            <KeyOnce kind={kind} endpointPath={created.integration.endpoint_path} apiKey={created.key} onDone={done} doneLabel="I've copied the key" />
          ) : (
            <div className="space-y-5">
              <SetupNotes kind={kind} url="" />
              <Button onClick={done}>Done</Button>
            </div>
          )}
        </Card>
      )}
    </PageContainer>
  );
}
