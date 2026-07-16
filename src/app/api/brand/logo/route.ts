import { NextResponse } from "next/server";
import { Readable } from "stream";
import { getSetting } from "@/lib/db";
import { uploadReadStream } from "@/lib/uploads";

export const dynamic = "force-dynamic";

// Serve the uploaded / fetched workspace logo. Deliberately public: the logo
// renders on the login page and the anonymous public site, both pre-auth.
// Only ever streams the one file referenced by the logo_file setting (an
// opaque random name in the uploads volume), so nothing else is exposed.
export async function GET() {
  const [file, mime] = await Promise.all([getSetting("logo_file"), getSetting("logo_mime")]);
  if (!file || !mime) return NextResponse.json({ error: "No logo set." }, { status: 404 });

  const stream = uploadReadStream(file);
  if (!stream) return NextResponse.json({ error: "No logo set." }, { status: 404 });

  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
    headers: {
      "Content-Type": mime,
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
      // The URL carries a ?v= cache-buster that changes on every replacement.
      "Cache-Control": "public, max-age=86400",
    },
  });
}
