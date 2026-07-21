import { NextResponse } from "next/server";
import {
  getBackupDestState,
  updateS3,
  updateAzure,
  clearS3,
  clearAzure,
  testS3,
  testAzure,
} from "@/lib/backup-config";
import { apiGuard, credentialSaveError } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await getBackupDestState());
}

export async function PATCH(req: Request) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const provider = body?.provider;
  if (provider !== "s3" && provider !== "azure") {
    return NextResponse.json({ error: "Unknown provider." }, { status: 400 });
  }

  // Remove a destination's configuration entirely.
  if (body?.clear === true) {
    if (provider === "s3") await clearS3();
    else await clearAzure();
    await audit({
      actor: actorFrom(gate),
      action: "settings.backup_destination_removed",
      details: { provider },
      ip: ipFrom(req),
    });
    return NextResponse.json({ ok: true, state: await getBackupDestState() });
  }

  // Save provided fields (secrets only overwritten when non-empty).
  const keyErr = await credentialSaveError(() =>
    provider === "s3"
      ? updateS3({
          bucket: body.bucket,
          region: body.region,
          endpoint: body.endpoint,
          prefix: body.prefix,
          access_key_id: body.access_key_id,
          secret_access_key: body.secret_access_key,
        })
      : updateAzure({
          container: body.container,
          connection_string: body.connection_string,
        })
  );
  if (keyErr) return keyErr;

  // Optionally verify the credentials with a test upload.
  let test: { ok: boolean; error?: string } | undefined;
  if (body?.test === true) {
    test = provider === "s3" ? await testS3() : await testAzure();
  }

  await audit({
    actor: actorFrom(gate),
    action: "settings.backup_destination",
    details: { provider, tested: body?.test === true, test_ok: test?.ok },
    ip: ipFrom(req),
  });

  return NextResponse.json({ ok: true, test, state: await getBackupDestState() });
}
