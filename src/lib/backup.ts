import { spawn } from "child_process";
import { createReadStream } from "fs";
import { mkdir, readdir, stat, unlink } from "fs/promises";
import { join, basename } from "path";
import { activeDestinations } from "./backup-destinations";
import { getAllSettings, pool } from "./db";

// Full-database backups via pg_dump (custom format). Dumps are written to a
// local directory (a mounted volume in Docker) and mirrored to any configured
// off-site destinations (S3 / Azure). Restore uses pg_restore --clean.

const PREFIX = "compassdocs-";
const EXT = ".dump";
const ADVISORY_LOCK = 728342; // distinct from the schema-init lock

export function backupDir(): string {
  return process.env.COMPASSDOCS_BACKUP_DIR || "/backups";
}

// pg_dump/pg_restore live on PATH in the Docker image; COMPASSDOCS_PG_BIN lets
// a dev point at a specific install (e.g. Homebrew / a versioned path).
function pgBin(name: "pg_dump" | "pg_restore"): string {
  const dir = process.env.COMPASSDOCS_PG_BIN;
  return dir ? join(dir, name) : name;
}

// Derive libpq PG* env from DATABASE_URL so credentials never hit the argv/ps.
function pgEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is not set.");
  const url = new URL(raw);
  env.PGHOST = url.hostname;
  env.PGPORT = url.port || "5432";
  if (url.username) env.PGUSER = decodeURIComponent(url.username);
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  env.PGDATABASE = url.pathname.replace(/^\//, "") || "compassdocs";
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode) env.PGSSLMODE = sslmode;
  else if (process.env.DATABASE_SSL === "require") env.PGSSLMODE = "require";
  else if (process.env.DATABASE_SSL === "disable") env.PGSSLMODE = "disable";
  return env;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: pgEnv() });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${basename(cmd)} exited ${code}: ${stderr.trim().slice(-500)}`))
    );
  });
}

// Only allow our own dump filenames — blocks path traversal on name params.
export function isValidBackupName(name: string): boolean {
  return /^compassdocs-\d{8}-\d{6}\.dump$/.test(name);
}

function stamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

export interface BackupInfo {
  name: string;
  size: number;
  created_at: string; // ISO
}

export interface CreateBackupResult extends BackupInfo {
  uploaded: string[]; // destination labels the copy reached
  uploadErrors: string[];
}

export async function createBackup(now: Date = new Date()): Promise<CreateBackupResult> {
  const dir = backupDir();
  await mkdir(dir, { recursive: true });
  const name = `${PREFIX}${stamp(now)}${EXT}`;
  const path = join(dir, name);

  await run(pgBin("pg_dump"), ["-Fc", "--no-owner", "--no-privileges", "-f", path]);
  const info = await backupInfo(name);

  // Mirror to any configured off-site destinations (never fail the local backup
  // because a remote is down — just report it).
  const uploaded: string[] = [];
  const uploadErrors: string[] = [];
  for (const dest of activeDestinations()) {
    try {
      await dest.upload(path, name);
      uploaded.push(dest.label);
    } catch (e: any) {
      uploadErrors.push(`${dest.label}: ${e?.message || "upload failed"}`);
    }
  }
  return { ...info, uploaded, uploadErrors };
}

async function backupInfo(name: string): Promise<BackupInfo> {
  const s = await stat(join(backupDir(), name));
  return { name, size: s.size, created_at: new Date(s.mtimeMs).toISOString() };
}

export async function listBackups(): Promise<BackupInfo[]> {
  let files: string[];
  try {
    files = await readdir(backupDir());
  } catch {
    return []; // dir not created yet
  }
  const infos = await Promise.all(
    files.filter(isValidBackupName).map((n) => backupInfo(n))
  );
  return infos.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function backupPath(name: string): string | null {
  if (!isValidBackupName(name)) return null;
  return join(backupDir(), name);
}

export function backupReadStream(name: string) {
  const p = backupPath(name);
  if (!p) return null;
  return createReadStream(p);
}

export async function deleteBackup(name: string): Promise<boolean> {
  const p = backupPath(name);
  if (!p) return false;
  try {
    await unlink(p);
  } catch {
    return false;
  }
  // Best-effort remote cleanup.
  for (const dest of activeDestinations()) {
    try {
      await dest.remove(name);
    } catch {
      /* ignore */
    }
  }
  return true;
}

/** Keep the newest `keep` local backups, delete the rest. Returns removed count. */
export async function pruneBackups(keep: number): Promise<number> {
  if (!Number.isFinite(keep) || keep <= 0) return 0;
  const all = await listBackups();
  const toRemove = all.slice(keep);
  let n = 0;
  for (const b of toRemove) if (await deleteBackup(b.name)) n++;
  return n;
}

/** Restore the database from a local backup (DESTRUCTIVE — pg_restore --clean). */
export async function restoreBackup(name: string): Promise<void> {
  const p = backupPath(name);
  if (!p) throw new Error("Invalid backup name.");
  await stat(p); // throws if missing
  const env = pgEnv();
  await run(pgBin("pg_restore"), [
    "--clean",
    "--if-exists",
    "--no-owner",
    "--no-privileges",
    "-d",
    env.PGDATABASE as string,
    p,
  ]);
}

// --- Scheduling --------------------------------------------------------------

function frequencyMs(freq: string): number {
  if (freq === "daily") return 24 * 60 * 60 * 1000;
  if (freq === "weekly") return 7 * 24 * 60 * 60 * 1000;
  return 0; // "off"
}

/**
 * Run a scheduled backup if one is due (newest backup older than the configured
 * frequency). Guarded by a Postgres advisory lock so only one app instance runs
 * it. Safe to call frequently (e.g. hourly).
 */
export async function runScheduledBackupIfDue(now: Date = new Date()): Promise<boolean> {
  const settings = await getAllSettings();
  const interval = frequencyMs(settings.backup_frequency || "off");
  if (interval === 0) return false;

  const client = await pool().connect();
  try {
    const got = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [ADVISORY_LOCK]);
    if (!got.rows[0].ok) return false; // another instance holds it
    try {
      const backups = await listBackups();
      const newest = backups[0];
      const due = !newest || now.getTime() - new Date(newest.created_at).getTime() >= interval;
      if (!due) return false;
      await createBackup(now);
      await pruneBackups(Number(settings.backup_keep) || 7);
      return true;
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK]).catch(() => {});
    }
  } finally {
    client.release();
  }
}
