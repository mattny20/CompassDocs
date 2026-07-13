import type { SystemInfo } from "@/lib/system-info";
import type { AppSettings } from "@/lib/settings";
import { formatDateTime } from "@/lib/format";
import { RefreshButton } from "./RefreshButton";

function bytes(n: number | null): string {
  if (n == null) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function duration(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
      <h3 className="mb-3 font-semibold text-slate-900">{title}</h3>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-slate-100 py-1.5 text-sm last:border-0">
      <span className="text-slate-500">{label}</span>
      <span className="text-right font-medium text-slate-800">{value}</span>
    </div>
  );
}

function Meter({ used, total }: { used: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const tone = pct >= 90 ? "bg-red-500" : pct >= 75 ? "bg-amber-500" : "bg-compass-500";
  return (
    <div className="mt-1">
      <div className="h-2 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 text-xs text-slate-400">
        {bytes(used)} of {bytes(total)} used ({pct}%)
      </div>
    </div>
  );
}

export function SystemPanel({ info, settings }: { info: SystemInfo; settings: AppSettings }) {
  const s = info.storage;
  const r = info.resources;
  const diskUsed =
    s.diskTotalBytes != null && s.diskFreeBytes != null ? s.diskTotalBytes - s.diskFreeBytes : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-400">
          As of {formatDateTime(info.generatedAt, settings)}
        </p>
        <RefreshButton />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card title="Application">
          <Row label="Version" value={`v${info.app.version}`} />
          {info.app.imageTag && <Row label="Image" value={info.app.imageTag} />}
          <Row label="Environment" value={info.app.env} />
          <Row label="Node.js" value={info.app.node} />
          <Row label="Uptime" value={duration(info.app.uptimeSeconds)} />
          <Row label="Host" value={`${info.host.platform}/${info.host.arch}`} />
        </Card>

        <Card title="Database">
          <Row label="Engine" value={info.database.version} />
          <Row label="Size" value={bytes(info.database.sizeBytes)} />
          <Row label="Documents" value={info.database.documents} />
          <Row label="In trash" value={info.database.documents_trashed} />
          <Row label="Spaces" value={info.database.spaces} />
          <Row label="Versions" value={info.database.versions} />
          <Row label="Users" value={info.database.users} />
          <Row label="Active sessions" value={info.database.active_sessions} />
          <Row
            label="Pending review"
            value={info.database.pending_changes + info.database.open_suggestions}
          />
        </Card>

        <Card title="Storage">
          <Row label="Backups" value={`${s.backupCount} · ${bytes(s.backupBytes)}`} />
          <Row label="Backup path" value={<code className="text-xs">{s.backupDir}</code>} />
          {diskUsed != null && s.diskTotalBytes != null ? (
            <div className="pt-1">
              <div className="text-sm text-slate-500">Backup volume</div>
              <Meter used={diskUsed} total={s.diskTotalBytes} />
            </div>
          ) : (
            <Row label="Disk" value="unavailable" />
          )}
          <div className="mt-3 flex flex-wrap gap-1.5">
            {s.destinations.map((d) => (
              <span
                key={d.key}
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                  d.configured ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-400"
                }`}
              >
                {d.configured ? "✓" : "○"} {d.label}
              </span>
            ))}
          </div>
        </Card>

        <Card title="Resources">
          <div>
            <div className="text-sm text-slate-500">Memory</div>
            <Meter used={r.memTotalBytes - r.memFreeBytes} total={r.memTotalBytes} />
          </div>
          <div className="mt-3">
            <Row label="CPU cores" value={r.cpuCount} />
            <Row label="Load (1m)" value={r.loadAvg1.toFixed(2)} />
            <Row label="App memory (RSS)" value={bytes(r.processRssBytes)} />
          </div>
        </Card>
      </div>
    </div>
  );
}
