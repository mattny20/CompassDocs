import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { basename } from "path";
import { getS3Config, getAzureConfig, type S3Config, type AzureConfig } from "./backup-config";

// Optional off-site backup destinations. Configuration is resolved from the
// admin settings (with environment-variable fallback) in `backup-config.ts`;
// this module turns a resolved config into an uploader. The heavy SDKs are
// imported lazily so they cost nothing unless a destination is actually used. A
// backup is always written locally first; configured destinations receive a copy.

export interface BackupDestination {
  key: string;
  label: string;
  /** Upload a local dump file under the given object name. */
  upload(localPath: string, name: string): Promise<void>;
  /** Best-effort removal of a previously-uploaded object. */
  remove(name: string): Promise<void>;
}

// --- S3 (AWS S3, Cloudflare R2, MinIO, any S3-compatible) --------------------

function s3Key(prefix: string, name: string) {
  return prefix ? `${prefix}/${name}` : name;
}

function makeS3Destination(cfg: S3Config): BackupDestination {
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

function makeAzureDestination(cfg: AzureConfig): BackupDestination {
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

/** All remote destinations that are currently configured. */
export async function activeDestinations(): Promise<BackupDestination[]> {
  const out: BackupDestination[] = [];
  const [s3, azure] = await Promise.all([getS3Config(), getAzureConfig()]);
  if (s3) out.push(makeS3Destination(s3));
  if (azure) out.push(makeAzureDestination(azure));
  return out;
}

/** Lightweight status for the admin UI (labels only, no secrets). */
export async function destinationStatus(): Promise<
  { key: string; label: string; configured: boolean }[]
> {
  const [s3, azure] = await Promise.all([getS3Config(), getAzureConfig()]);
  return [
    { key: "local", label: "Local volume", configured: true },
    { key: "s3", label: "S3-compatible", configured: !!s3 },
    { key: "azure", label: "Azure Blob", configured: !!azure },
  ];
}

export { basename };
