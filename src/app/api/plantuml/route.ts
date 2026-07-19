import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Renders ```plantuml fences by proxying to a PlantUML server and caching the
// SVG in memory. Defaults to the public plantuml.com server; self-hosters who
// don't want diagram text leaving their network can run the official
// plantuml/plantuml-server image and point COMPASSDOCS_PLANTUML_SERVER at it
// (set it to "off" to disable rendering entirely).
//
// Anonymous access is intentional (public-site documents render diagrams too):
// the route only ever talks to the configured server, and input is capped.

const MAX_CODE = 20_000;
const CACHE_MAX = 200;
const cache = new Map<string, Buffer>(); // sha256(code|dark) -> svg

function serverBase(): string {
  return (process.env.COMPASSDOCS_PLANTUML_SERVER || "https://www.plantuml.com/plantuml").replace(
    /\/+$/,
    ""
  );
}

// PlantUML's URL encoding: raw DEFLATE, then base64 with its own alphabet.
const PU_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
function plantumlEncode(text: string): string {
  const data = deflateRawSync(Buffer.from(text, "utf8"), { level: 9 });
  let out = "";
  for (let i = 0; i < data.length; i += 3) {
    const b1 = data[i];
    const b2 = i + 1 < data.length ? data[i + 1] : 0;
    const b3 = i + 2 < data.length ? data[i + 2] : 0;
    out += PU_ALPHABET[b1 >> 2];
    out += PU_ALPHABET[((b1 & 0x3) << 4) | (b2 >> 4)];
    if (i + 1 < data.length) out += PU_ALPHABET[((b2 & 0xf) << 2) | (b3 >> 6)];
    if (i + 2 < data.length) out += PU_ALPHABET[b3 & 0x3f];
  }
  return out;
}

export async function POST(req: Request) {
  const base = serverBase();
  if (base === "off") {
    return NextResponse.json(
      { error: "PlantUML rendering is disabled on this workspace." },
      { status: 503 }
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const code = String(body?.code ?? "").trim();
  const dark = Boolean(body?.dark);
  if (!code) return NextResponse.json({ error: "Empty diagram." }, { status: 400 });
  if (code.length > MAX_CODE) {
    return NextResponse.json({ error: "Diagram is too large (20 KB max)." }, { status: 413 });
  }

  // Wrap bare diagrams so authors can skip @startuml/@enduml; add dark theme
  // when the app is in dark mode and the author didn't pick one.
  let source = code;
  if (!/^@start/m.test(source)) source = `@startuml\n${source}\n@enduml`;
  if (dark && !/!theme\s/.test(source)) {
    source = source.replace(/^(@start\w+.*)$/m, "$1\n!theme cyborg");
  }

  const key = createHash("sha256").update(source).digest("hex");
  const hit = cache.get(key);
  if (hit) {
    return new Response(new Uint8Array(hit), {
      headers: { "Content-Type": "image/svg+xml", "Cache-Control": "private, max-age=3600" },
    });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${base}/svg/${plantumlEncode(source)}`, {
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return NextResponse.json(
      { error: "Couldn't reach the PlantUML server. Check the network or COMPASSDOCS_PLANTUML_SERVER." },
      { status: 502 }
    );
  }
  // PlantUML returns 400 WITH a rendered error image for syntax errors — pass
  // those through so authors see what's wrong, but fail on anything non-SVG.
  const type = upstream.headers.get("content-type") || "";
  if (!type.includes("svg")) {
    return NextResponse.json(
      { error: `PlantUML server returned ${upstream.status}.` },
      { status: 502 }
    );
  }
  const svg = Buffer.from(await upstream.arrayBuffer());
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, svg);
  return new Response(new Uint8Array(svg), {
    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "private, max-age=3600" },
  });
}
