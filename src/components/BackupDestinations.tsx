"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toasts";
import { Field, TextInput } from "@/components/form";

interface DestState {
  s3: {
    bucket: string;
    region: string;
    endpoint: string;
    prefix: string;
    access_key_id: string;
    has_secret: boolean;
    configured: boolean;
  };
  azure: {
    container: string;
    has_connection_string: boolean;
    configured: boolean;
  };
  env_present: boolean;
}


export function BackupDestinations({ initial }: { initial: DestState }) {
  const router = useRouter();
  const [state, setState] = useState<DestState>(initial);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">Off-site destinations</h2>
        <p className="mt-1 text-sm text-slate-500">
          Mirror every backup to object storage so it survives losing this server. Credentials are
          stored securely and can be verified with a test upload.
        </p>
      </div>

      {state.env_present && (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
          Some values are currently provided by environment variables. Saving here stores the
          settings in CompassDocs, which take precedence.
        </p>
      )}

      <S3Card
        s3={state.s3}
        onState={(s) => setState(s)}
        refresh={() => router.refresh()}
      />
      <AzureCard
        azure={state.azure}
        onState={(s) => setState(s)}
        refresh={() => router.refresh()}
      />
    </div>
  );
}

function useSaver(refresh: () => void, onState: (s: DestState) => void) {
  const [saving, setSaving] = useState<"" | "save" | "test">("");

  async function submit(payload: Record<string, unknown>, withTest: boolean) {
    setSaving(withTest ? "test" : "save");
    const res = await fetch("/api/admin/backup-destinations", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, test: withTest }),
    });
    setSaving("");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast("error", data?.error || "Could not save.");
      return null;
    }
    if (data?.state) onState(data.state);
    if (withTest) {
      if (data?.test?.ok) toast("ok", "Destination saved — connection verified.");
      else toast("error", data?.test?.error || "Saved, but the connection test failed.");
    } else {
      toast("ok", "Destination saved.");
    }
    refresh();
    return data;
  }

  return { saving, submit };
}

function S3Card({
  s3,
  onState,
  refresh,
}: {
  s3: DestState["s3"];
  onState: (s: DestState) => void;
  refresh: () => void;
}) {
  const [bucket, setBucket] = useState(s3.bucket);
  const [region, setRegion] = useState(s3.region);
  const [endpoint, setEndpoint] = useState(s3.endpoint);
  const [prefix, setPrefix] = useState(s3.prefix);
  const [accessKeyId, setAccessKeyId] = useState(s3.access_key_id);
  const [secret, setSecret] = useState("");
  const { saving, submit } = useSaver(refresh, onState);

  const payload = () => ({
    provider: "s3",
    bucket,
    region,
    endpoint,
    prefix,
    access_key_id: accessKeyId,
    ...(secret ? { secret_access_key: secret } : {}),
  });

  async function remove() {
    if (!confirm("Remove the S3 destination? Backups will no longer be mirrored there.")) return;
    await submitClear();
  }
  async function submitClear() {
    const res = await fetch("/api/admin/backup-destinations", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "s3", clear: true }),
    });
    const data = await res.json().catch(() => ({}));
    if (data?.state) onState(data.state);
    setBucket("");
    setEndpoint("");
    setPrefix("");
    setAccessKeyId("");
    setSecret("");
    toast("ok", "S3 destination removed.");
    refresh();
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-semibold text-slate-900">
          S3-compatible{" "}
          <span className="text-xs font-normal text-slate-400">(AWS S3, Cloudflare R2, MinIO)</span>
        </h3>
        {s3.configured && (
          <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
            ✓ Active
          </span>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Bucket">
          <TextInput value={bucket} onChange={(e) => setBucket(e.target.value)} placeholder="my-compassdocs-backups" />
        </Field>
        <Field label="Region">
          <TextInput value={region} onChange={(e) => setRegion(e.target.value)} placeholder="us-east-1" />
        </Field>
        <Field label="Endpoint (optional — for R2 / MinIO)">
          <TextInput value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://<account>.r2.cloudflarestorage.com" />
        </Field>
        <Field label="Key prefix (optional)">
          <TextInput value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="compassdocs" />
        </Field>
        <Field label="Access key ID">
          <TextInput value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} className="font-mono" autoComplete="off" />
        </Field>
        <Field label={s3.has_secret ? "Secret access key (leave blank to keep)" : "Secret access key"}>
          <TextInput
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            className="font-mono"
            placeholder={s3.has_secret ? "•••••••• saved" : "secret access key"}
            autoComplete="off"
          />
        </Field>
      </div>

      <Actions
        saving={saving}
        onSave={() => submit(payload(), false)}
        onTest={() => submit(payload(), true)}
        onRemove={s3.configured ? remove : undefined}
      />
    </div>
  );
}

function AzureCard({
  azure,
  onState,
  refresh,
}: {
  azure: DestState["azure"];
  onState: (s: DestState) => void;
  refresh: () => void;
}) {
  const [container, setContainer] = useState(azure.container);
  const [conn, setConn] = useState("");
  const { saving, submit } = useSaver(refresh, onState);

  const payload = () => ({
    provider: "azure",
    container,
    ...(conn ? { connection_string: conn } : {}),
  });

  async function remove() {
    if (!confirm("Remove the Azure destination? Backups will no longer be mirrored there.")) return;
    const res = await fetch("/api/admin/backup-destinations", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "azure", clear: true }),
    });
    const data = await res.json().catch(() => ({}));
    if (data?.state) onState(data.state);
    setContainer("");
    setConn("");
    toast("ok", "Azure destination removed.");
    refresh();
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-semibold text-slate-900">Azure Blob Storage</h3>
        {azure.configured && (
          <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
            ✓ Active
          </span>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Container">
          <TextInput value={container} onChange={(e) => setContainer(e.target.value)} placeholder="compassdocs-backups" />
        </Field>
        <Field label={azure.has_connection_string ? "Connection string (leave blank to keep)" : "Connection string"}>
          <TextInput
            type="password"
            value={conn}
            onChange={(e) => setConn(e.target.value)}
            className="font-mono"
            placeholder={azure.has_connection_string ? "•••••••• saved" : "DefaultEndpointsProtocol=https;AccountName=…"}
            autoComplete="off"
          />
        </Field>
      </div>

      <Actions
        saving={saving}
        onSave={() => submit(payload(), false)}
        onTest={() => submit(payload(), true)}
        onRemove={azure.configured ? remove : undefined}
      />
    </div>
  );
}

function Actions({
  saving,
  onSave,
  onTest,
  onRemove,
}: {
  saving: "" | "save" | "test";
  onSave: () => void;
  onTest: () => void;
  onRemove?: () => void;
}) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <button
        onClick={onSave}
        disabled={!!saving}
        className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white shadow-xs hover:bg-compass-700 disabled:opacity-60"
      >
        {saving === "save" ? "Saving…" : "Save"}
      </button>
      <button
        onClick={onTest}
        disabled={!!saving}
        className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60"
      >
        {saving === "test" ? "Testing…" : "Save & test"}
      </button>
      {onRemove && (
        <button
          onClick={onRemove}
          disabled={!!saving}
          className="rounded-lg px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-60"
        >
          Remove
        </button>
      )}
    </div>
  );
}
