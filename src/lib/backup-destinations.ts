import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { basename } from "path";

// Optional off-site backup destinations. Each is "configured" purely from
// environment variables (secrets never live in the database), and the heavy
// SDKs are imported lazily so they cost nothing unless actually used. A backup
// is always written locally first; configured destinations receive a copy.

export interface BackupDestination {
  key: string;
  label: string;
  /** Upload a local dump file under the given object name. */
  upload(localPath: string, name: string): Promise<void>;
  /** Best-effort removal of a previously-uploaded object. */
  remove(name: string): Promise<void>;
}

// --- S3 (AWS S3, Cloudflare R2, MinIO, any S3-compatible) --------------------

function s3Config() {
  const bucket = process.env.BACKUP_S3_BUCKET;
  const accessKeyId = process.env.BACKUP_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.BACKUP_S3_SECRET_ACCESS_KEY;
  if (!bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    bucket,
    accessKeyId,
    secretAccessKey,
    region: process.env.BACKUP_S3_REGION || "us-east-1",
    endpoint: process.env.BACKUP_S3_ENDPOINT || undefined, // set for R2/MinIO
    prefix: (process.env.BACKUP_S3_PREFIX || "").replace(/^\/+|\/+$/g, ""),
  };
}

function s3Key(prefix: string, name: string) {
  return prefix ? `${prefix}/${name}` : name;
}

function makeS3Destination(): BackupDestination {
  const cfg = s3Config()!;
  async function client() {
    const { S3Client } = await import("@aws-sdk/client-s3");
    return new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: !!cfg.endpoint, // needed by R2/MinIO
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }
  return {
    key: "s3",
    label: `S3 (${cfg.bucket})`,
    async upload(localPath, name) {
      const { PutObjectCommand } = await import("@aws-sdk/client-s3");
      const c = await client();
      const size = (await stat(localPath)).size;
      await c.send(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: s3Key(cfg.prefix, name),
          Body: createReadStream(localPath),
          ContentLength: size,
          ContentType: "application/octet-stream",
        })
      );
    },
    async remove(name) {
      const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
      const c = await client();
      await c.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: s3Key(cfg.prefix, name) }));
    },
  };
}

// --- Azure Blob Storage ------------------------------------------------------

function azureConfig() {
  const connectionString = process.env.BACKUP_AZURE_CONNECTION_STRING;
  const container = process.env.BACKUP_AZURE_CONTAINER;
  if (!connectionString || !container) return null;
  return { connectionString, container };
}

function makeAzureDestination(): BackupDestination {
  const cfg = azureConfig()!;
  async function container() {
    const { BlobServiceClient } = await import("@azure/storage-blob");
    const svc = BlobServiceClient.fromConnectionString(cfg.connectionString);
    const c = svc.getContainerClient(cfg.container);
    await c.createIfNotExists();
    return c;
  }
  return {
    key: "azure",
    label: `Azure Blob (${cfg.container})`,
    async upload(localPath, name) {
      const c = await container();
      await c.getBlockBlobClient(name).uploadFile(localPath);
    },
    async remove(name) {
      const c = await container();
      await c.getBlockBlobClient(name).deleteIfExists();
    },
  };
}

/** All remote destinations that are configured via the environment. */
export function activeDestinations(): BackupDestination[] {
  const out: BackupDestination[] = [];
  if (s3Config()) out.push(makeS3Destination());
  if (azureConfig()) out.push(makeAzureDestination());
  return out;
}

/** Lightweight status for the admin UI (labels only, no secrets). */
export function destinationStatus(): { key: string; label: string; configured: boolean }[] {
  return [
    { key: "local", label: "Local volume", configured: true },
    { key: "s3", label: "S3-compatible", configured: !!s3Config() },
    { key: "azure", label: "Azure Blob", configured: !!azureConfig() },
  ];
}

export { basename };
