import os from "os";
import { statfs } from "fs/promises";
import { getDatabaseStats, attachmentsUsage } from "./db";
import { listBackups, backupDir } from "./backup";
import { destinationStatus } from "./backup-destinations";
import pkg from "../../package.json";

export interface SystemInfo {
  app: {
    version: string;
    imageTag: string | null;
    node: string;
    env: string;
    uptimeSeconds: number;
  };
  database: Awaited<ReturnType<typeof getDatabaseStats>>;
  storage: {
    backupCount: number;
    backupBytes: number;
    backupDir: string;
    attachmentCount: number;
    attachmentBytes: number;
    diskTotalBytes: number | null;
    diskFreeBytes: number | null;
    destinations: { key: string; label: string; configured: boolean }[];
  };
  resources: {
    cpuCount: number;
    loadAvg1: number;
    memTotalBytes: number;
    memFreeBytes: number;
    processRssBytes: number;
  };
  host: { platform: string; arch: string; hostname: string };
  generatedAt: string;
}

async function diskUsage(dir: string): Promise<{ total: number; free: number } | null> {
  try {
    const s = await statfs(dir);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {
    return null; // path missing or unsupported
  }
}

export async function getSystemInfo(): Promise<SystemInfo> {
  const [database, backups, attachments, disk] = await Promise.all([
    getDatabaseStats(),
    listBackups(),
    attachmentsUsage(),
    diskUsage(backupDir()),
  ]);

  return {
    app: {
      version: (pkg as any).version || "0.0.0",
      imageTag: process.env.COMPASSDOCS_VERSION || null,
      node: process.version,
      env: process.env.NODE_ENV || "development",
      uptimeSeconds: Math.round(process.uptime()),
    },
    database,
    storage: {
      backupCount: backups.length,
      backupBytes: backups.reduce((n, b) => n + b.size, 0),
      backupDir: backupDir(),
      attachmentCount: attachments.count,
      attachmentBytes: attachments.bytes,
      diskTotalBytes: disk?.total ?? null,
      diskFreeBytes: disk?.free ?? null,
      destinations: destinationStatus(),
    },
    resources: {
      cpuCount: os.cpus().length,
      loadAvg1: os.loadavg()[0],
      memTotalBytes: os.totalmem(),
      memFreeBytes: os.freemem(),
      processRssBytes: process.memoryUsage().rss,
    },
    host: { platform: os.platform(), arch: os.arch(), hostname: os.hostname() },
    generatedAt: new Date().toISOString(),
  };
}
