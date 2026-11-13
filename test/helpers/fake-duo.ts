// A fake Duo for the suites (1.20.5): the three endpoints of Duo's Universal
// Prompt for one Web SDK application, on a loopback port. The app is pointed
// at it with COMPASSDOCS_DUO_TEST_API_BASE (lib/duo-config, test only), so
// neither test/duo-mfa.test.ts nor e2e/duo-mfa.spec.ts ever contacts Duo.
//
// It signs and checks with node:crypto directly, NOT with the app's
// lib/duo-jwt, so a mistake in the app's signing or verifying is not
// mirrored here. The "prompt" approves at once: /oauth/v1/authorize
// redirects straight back to the app's callback with a code. `mode` makes
// it misbehave on command:
//
//   allow         approve (the default)
//   deny          the ID token says auth_result.result = "deny"
//   error         the prompt comes back with ?error=access_denied, no code
//   down          health check answers 503
//   refuse        health check answers 400 { stat: "FAIL" } (bad client)
//   token_down    health check is fine, the token endpoint answers 503
//   wrong_user    the ID token names someone else
//   wrong_nonce   the ID token carries another nonce
//   bad_sig       the ID token is signed with another secret
//   redirect      health check answers a 302 to another host
//   all_down      health check AND the token endpoint answer 503
//   html          health check answers 200 with a page that is not JSON
//   odd           health check answers 200 with JSON that is not Duo's (an array)
//   no_nonce      the ID token carries no nonce claim at all
//
// GET /__fake/mode?set=<mode> switches it from outside the process (the
// e2e spec and the manual runs); GET /__fake/log lists what was asked.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export type FakeDuoMode =
  | "allow" | "deny" | "error" | "down" | "refuse" | "token_down" | "wrong_user" | "wrong_nonce" | "bad_sig" | "redirect"
  | "all_down" | "html" | "odd" | "no_nonce";

export interface FakeDuo {
  base: string;
  port: number;
  mode: FakeDuoMode;
  /** One line per request: "POST /oauth/v1/health_check ok". */
  log: string[];
  /** The duo_uname of the last authorize request. */
  lastUsername: string;
  close(): Promise<void>;
}

const b64 = (v: Buffer | string) => Buffer.from(v).toString("base64url");

function sign(payload: object, secret: string): string {
  const head = b64(JSON.stringify({ alg: "HS512", typ: "JWT" }));
  const body = b64(JSON.stringify(payload));
  return `${head}.${body}.${b64(createHmac("sha512", secret).update(`${head}.${body}`).digest())}`;
}

/** The payload of an HS512 JWT signed with `secret`, or null. */
function open(token: string, secret: string): Record<string, unknown> | null {
  const [head, body, sig] = (token || "").split(".");
  if (!head || !body || !sig) return null;
  try {
    if (JSON.parse(Buffer.from(head, "base64url").toString()).alg !== "HS512") return null;
    const want = createHmac("sha512", secret).update(`${head}.${body}`).digest();
    const got = Buffer.from(sig, "base64url");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    return JSON.parse(Buffer.from(body, "base64url").toString());
  } catch {
    return null;
  }
}

export async function startFakeDuo(opts: { clientId: string; clientSecret: string; port?: number }): Promise<FakeDuo> {
  const codes = new Map<string, { username: string; nonce: string; redirectUri: string }>();
  const duo: FakeDuo = { base: "", port: 0, mode: "allow", log: [], lastUsername: "", close: async () => {} };

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const form = (req: http.IncomingMessage) =>
    new Promise<URLSearchParams>((resolve) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => resolve(new URLSearchParams(raw)));
    });
  /** The client assertion Duo expects on its POST endpoints. */
  const assertionOk = (assertion: string | null, endpoint: string) => {
    const a = open(assertion || "", opts.clientSecret);
    const now = Math.floor(Date.now() / 1000);
    return !!a && a.iss === opts.clientId && a.sub === opts.clientId && a.aud === `${duo.base}${endpoint}` && typeof a.exp === "number" && a.exp > now && typeof a.jti === "string";
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", duo.base);
    const note = (what: string) => duo.log.push(`${req.method} ${url.pathname} ${what}`);

    if (url.pathname === "/__fake/mode") {
      const set = url.searchParams.get("set");
      if (set) duo.mode = set as FakeDuoMode;
      return json(res, 200, { mode: duo.mode });
    }
    if (url.pathname === "/__fake/log") return json(res, 200, { log: duo.log, lastUsername: duo.lastUsername });

    if (req.method === "POST" && url.pathname === "/oauth/v1/health_check") {
      const body = await form(req);
      if (duo.mode === "down" || duo.mode === "all_down") return note("503"), json(res, 503, { stat: "FAIL" });
      if (duo.mode === "html") {
        note("200 html");
        res.writeHead(200, { "content-type": "text/html" });
        return res.end("<html><body>Captive portal: sign in to the network</body></html>");
      }
      if (duo.mode === "odd") return note("200 odd"), json(res, 200, ["OK"]);
      if (duo.mode === "redirect") {
        note("302");
        res.writeHead(302, { location: "http://example.invalid/oauth/v1/health_check" });
        return res.end();
      }
      if (duo.mode === "refuse" || body.get("client_id") !== opts.clientId || !assertionOk(body.get("client_assertion"), "/oauth/v1/health_check")) {
        return note("refused"), json(res, 400, { stat: "FAIL", code: 40002, message: "invalid_client", message_detail: "Failed to verify signature." });
      }
      return note("ok"), json(res, 200, { stat: "OK", response: { timestamp: Math.floor(Date.now() / 1000) } });
    }

    if (req.method === "GET" && url.pathname === "/oauth/v1/authorize") {
      const r = open(url.searchParams.get("request") || "", opts.clientSecret);
      const ok =
        !!r &&
        url.searchParams.get("response_type") === "code" &&
        url.searchParams.get("client_id") === opts.clientId &&
        url.searchParams.get("scope") === "openid" &&
        r.response_type === "code" &&
        r.client_id === opts.clientId &&
        r.iss === opts.clientId &&
        r.aud === duo.base &&
        typeof r.duo_uname === "string" &&
        typeof r.state === "string" &&
        r.state.length >= 22 &&
        r.state.length <= 1024 &&
        typeof r.redirect_uri === "string" &&
        r.redirect_uri === url.searchParams.get("redirect_uri") &&
        r.use_duo_code_attribute === true;
      if (!ok || !r) {
        note("bad request");
        res.writeHead(400, { "content-type": "text/plain" });
        return res.end("Fake Duo: the authorize request is not what Duo expects.");
      }
      duo.lastUsername = String(r.duo_uname);
      const back = new URL(String(r.redirect_uri));
      back.searchParams.set("state", String(r.state));
      if (duo.mode === "error") {
        back.searchParams.set("error", "access_denied");
        note("error");
      } else {
        const code = randomBytes(16).toString("hex");
        codes.set(code, { username: String(r.duo_uname), nonce: typeof r.nonce === "string" ? r.nonce : "", redirectUri: String(r.redirect_uri) });
        back.searchParams.set("duo_code", code);
        note(`prompt for ${r.duo_uname}`);
      }
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }

    if (req.method === "POST" && url.pathname === "/oauth/v1/token") {
      const body = await form(req);
      if (duo.mode === "token_down" || duo.mode === "all_down") return note("503"), json(res, 503, { error: "server_error" });
      const code = body.get("code") || "";
      const held = codes.get(code);
      codes.delete(code); // a code works once
      if (
        !held ||
        body.get("grant_type") !== "authorization_code" ||
        body.get("client_id") !== opts.clientId ||
        body.get("redirect_uri") !== held.redirectUri ||
        body.get("client_assertion_type") !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" ||
        !assertionOk(body.get("client_assertion"), "/oauth/v1/token")
      ) {
        return note("refused"), json(res, 400, { error: "invalid_grant", error_description: "The provided authorization grant or refresh token is invalid." });
      }
      const now = Math.floor(Date.now() / 1000);
      const allow = duo.mode !== "deny";
      const idToken = sign(
        {
          iss: `${duo.base}/oauth/v1/token`,
          sub: held.username,
          aud: opts.clientId,
          exp: now + 300,
          iat: now,
          auth_time: now,
          preferred_username: duo.mode === "wrong_user" ? "someone.else@example.com" : held.username,
          ...(duo.mode === "no_nonce" ? {} : { nonce: duo.mode === "wrong_nonce" ? "not-the-nonce" : held.nonce }),
          auth_result: { result: allow ? "allow" : "deny", status: allow ? "allow" : "deny", status_msg: allow ? "Login Successful" : "Login denied" },
          auth_context: { factor: "duo_push", result: allow ? "success" : "denied", event_type: "authentication" },
        },
        duo.mode === "bad_sig" ? "x".repeat(40) : opts.clientSecret
      );
      note(allow ? "allow" : "deny");
      return json(res, 200, { id_token: idToken, access_token: randomBytes(12).toString("hex"), expires_in: 300, token_type: "Bearer" });
    }

    note("404");
    json(res, 404, { stat: "FAIL" });
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  duo.port = (server.address() as AddressInfo).port;
  duo.base = `http://127.0.0.1:${duo.port}`;
  duo.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return duo;
}
