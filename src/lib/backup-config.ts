// Resolution and storage of off-site backup destination settings (S3-compatible
// and Azure Blob). Like the AI key, each field can be set from the admin GUI
// (stored in the settings table) or via an environment variable; the GUI value
// takes precedence. Secrets (the S3 secret access key, the Azure connection
// string) are write-only — never returned to the client.
//
// Server-only: imports the Postgres data layer.

import { getSetting, setSetting } from "./db";

async function resolve(settingKey: string, envKey: string): Promise<string> {
  const v = (await getSetting(settingKey))?.trim();
  return v || process.env[envKey]?.trim() || "";
}

async function stored(settingKey: string): Promise<string> {
  return (await getSetting(settingKey))?.trim() || "";
}

// --- S3 ----------------------------------------------------------------------

export interface S3Config {
  bucket: string;
  region: string;
  endpoint?: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export async function getS3Config(): Promise<S3Config | null> {
  const bucket = await resolve("backup_s3_bucket", "BACKUP_S3_BUCKET");
  const accessKeyId = await resolve("backup_s3_access_key_id", "BACKUP_S3_ACCESS_KEY_ID");
  const secretAccessKey = await resolve("backup_s3_secret_access_key", "BACKUP_S3_SECRET_ACCESS_KEY");
  if (!bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    bucket,
    accessKeyId,
    secretAccessKey,
    region: (await resolve("backup_s3_region", "BACKUP_S3_REGION")) || "us-east-1",
    endpoint: (await resolve("backup_s3_endpoint", "BACKUP_S3_ENDPOINT")) || undefined,
    prefix: (await resolve("backup_s3_prefix", "BACKUP_S3_PREFIX")).replace(/^\/+|\/+$/g, ""),
  };
}

// --- Azure -------------------------------------------------------------------

export interface AzureConfig {
  connectionString: string;
  container: string;
}

export async function getAzureConfig(): Promise<AzureConfig | null> {
  const connectionString = await resolve(
    "backup_azure_connection_string",
    "BACKUP_AZURE_CONNECTION_STRING"
  );
  const container = await resolve("backup_azure_container", "BACKUP_AZURE_CONTAINER");
  if (!connectionString || !container) return null;
  return { connectionString, container };
}

// --- GUI state (no secrets) --------------------------------------------------

export interface BackupDestState {
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
  /** True if any value is currently supplied by an environment variable. */
  env_present: boolean;
}

export async function getBackupDestState(): Promise<BackupDestState> {
  const [s3, azure] = await Promise.all([getS3Config(), getAzureConfig()]);
  const s3Secret = await resolve("backup_s3_secret_access_key", "BACKUP_S3_SECRET_ACCESS_KEY");
  const azureConn = await resolve(
    "backup_azure_connection_string",
    "BACKUP_AZURE_CONNECTION_STRING"
  );

  const envKeys = [
    "BACKUP_S3_BUCKET",
    "BACKUP_S3_REGION",
    "BACKUP_S3_ENDPOINT",
    "BACKUP_S3_PREFIX",
    "BACKUP_S3_ACCESS_KEY_ID",
    "BACKUP_S3_SECRET_ACCESS_KEY",
    "BACKUP_AZURE_CONNECTION_STRING",
    "BACKUP_AZURE_CONTAINER",
  ];
  const env_present = envKeys.some((k) => !!process.env[k]?.trim());

  return {
    s3: {
      bucket: await resolve("backup_s3_bucket", "BACKUP_S3_BUCKET"),
      region: (await resolve("backup_s3_region", "BACKUP_S3_REGION")) || "us-east-1",
      endpoint: await resolve("backup_s3_endpoint", "BACKUP_S3_ENDPOINT"),
      prefix: await resolve("backup_s3_prefix", "BACKUP_S3_PREFIX"),
      access_key_id: await resolve("backup_s3_access_key_id", "BACKUP_S3_ACCESS_KEY_ID"),
      has_secret: !!s3Secret,
      configured: !!s3,
    },
    azure: {
      container: await resolve("backup_azure_container", "BACKUP_AZURE_CONTAINER"),
      has_connection_string: !!azureConn,
      configured: !!azure,
    },
    env_present,
  };
}

// --- Writes ------------------------------------------------------------------

export interface S3Patch {
  bucket?: string;
  region?: string;
  endpoint?: string;
  prefix?: string;
  access_key_id?: string;
  secret_access_key?: string;
}

export async function updateS3(patch: S3Patch): Promise<void> {
  const map: [keyof S3Patch, string][] = [
    ["bucket", "backup_s3_bucket"],
    ["region", "backup_s3_region"],
    ["endpoint", "backup_s3_endpoint"],
    ["prefix", "backup_s3_prefix"],
    ["access_key_id", "backup_s3_access_key_id"],
  ];
  for (const [field, key] of map) {
    if (patch[field] !== undefined) await setSetting(key, String(patch[field]).trim());
  }
  // Secret: only overwrite when a non-empty value is supplied.
  if (patch.secret_access_key) {
    await setSetting("backup_s3_secret_access_key", patch.secret_access_key.trim());
  }
}

export async function updateAzure(patch: {
  container?: string;
  connection_string?: string;
}): Promise<void> {
  if (patch.container !== undefined) {
    await setSetting("backup_azure_container", patch.container.trim());
  }
  if (patch.connection_string) {
    await setSetting("backup_azure_connection_string", patch.connection_string.trim());
  }
}

export async function clearS3(): Promise<void> {
  for (const k of [
    "backup_s3_bucket",
    "backup_s3_region",
    "backup_s3_endpoint",
    "backup_s3_prefix",
    "backup_s3_access_key_id",
    "backup_s3_secret_access_key",
  ]) {
    await setSetting(k, "");
  }
}

export async function clearAzure(): Promise<void> {
  await setSetting("backup_azure_connection_string", "");
  await setSetting("backup_azure_container", "");
}

// --- Connection tests --------------------------------------------------------

const TEST_OBJECT = ".compassdocs-connection-test";

/** Verify S3 credentials by writing then deleting a tiny object. */
export async function testS3(): Promise<{ ok: boolean; error?: string }> {
  const cfg = await getS3Config();
  if (!cfg) return { ok: false, error: "Fill in the bucket, access key, and secret first." };
  try {
    const { S3Client, PutObjectCommand, DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    const c = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: !!cfg.endpoint,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
    const key = cfg.prefix ? `${cfg.prefix}/${TEST_OBJECT}` : TEST_OBJECT;
    await c.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: "ok" }));
    await c.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: `S3 test failed: ${e?.message || e}` };
  }
}

/** Verify Azure credentials by writing then deleting a tiny blob. */
export async function testAzure(): Promise<{ ok: boolean; error?: string }> {
  const cfg = await getAzureConfig();
  if (!cfg) return { ok: false, error: "Fill in the container and connection string first." };
  try {
    const { BlobServiceClient } = await import("@azure/storage-blob");
    const svc = BlobServiceClient.fromConnectionString(cfg.connectionString);
    const c = svc.getContainerClient(cfg.container);
    await c.createIfNotExists();
    const blob = c.getBlockBlobClient(TEST_OBJECT);
    await blob.upload("ok", 2);
    await blob.deleteIfExists();
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: `Azure test failed: ${e?.message || e}` };
  }
}
