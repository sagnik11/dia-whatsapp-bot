/**
 * One-time Google authorization for Captain Patch's Gmail and Calendar tools.
 *
 *   npm run google-auth
 *
 * Reads GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (an OAuth "Desktop app"
 * client) from the environment or .env, runs a loopback OAuth flow with PKCE
 * on 127.0.0.1, and prints the refresh token to put in GOOGLE_REFRESH_TOKEN.
 * Access tokens are never printed.
 */
import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { GOOGLE_SCOPES, GOOGLE_TOKEN_URL } from "../src/google-client.js";

const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
if (!clientId || !clientSecret) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first (see docs/integrations.md).");
  process.exit(1);
}

const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(16).toString("hex");

const server = createServer();
await new Promise<void>((resolve) => server.listen(Number(process.env.GOOGLE_AUTH_PORT ?? 0), "127.0.0.1", resolve));
const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  scope: GOOGLE_SCOPES.join(" "),
  access_type: "offline",
  prompt: "consent",
  state,
  code_challenge: challenge,
  code_challenge_method: "S256",
}).toString();

console.log(
  `Open this URL in a browser and sign in with the account in GOOGLE_ACCOUNT_EMAIL:\n\n${authUrl.toString()}\n\nWaiting for Google to redirect back (5 minutes)...`,
);

const code = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Timed out after 5 minutes without a redirect")), 300_000);
  server.on("request", (request, response) => {
    const url = new URL(request.url ?? "/", redirectUri);
    if (url.pathname !== "/callback") {
      response.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get("error");
    const received = url.searchParams.get("code");
    clearTimeout(timer);
    if (error || !received || url.searchParams.get("state") !== state) {
      response.writeHead(400, { "Content-Type": "text/plain" }).end("Authorization failed. Check the terminal.");
      reject(new Error(error ? `Google returned "${error}"` : "The redirect had no code or a mismatched state"));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/plain" }).end("Captain Patch is authorized. You can close this tab.");
    resolve(received);
  });
}).finally(() => {
  server.closeAllConnections();
  server.close();
});

const response = await fetch(GOOGLE_TOKEN_URL, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    code_verifier: verifier,
  }),
  signal: AbortSignal.timeout(15_000),
});
const payload = z
  .object({
    refresh_token: z.string().optional(),
    scope: z.string().default(""),
    error: z.string().optional(),
    error_description: z.string().optional(),
  })
  .parse(await response.json().catch(() => ({})));

if (!response.ok || !payload.refresh_token) {
  console.error(
    `Token exchange failed: ${payload.error_description ?? payload.error ?? `HTTP ${response.status}`}. ` +
      "If no refresh token came back, remove Patch's access at https://myaccount.google.com/permissions and run this again.",
  );
  process.exit(1);
}

const granted = new Set(payload.scope.split(" "));
const missing = GOOGLE_SCOPES.filter((scope) => !granted.has(scope));
if (missing.length > 0) {
  console.warn(`Warning: these scopes were not granted, so some tools will fail: ${missing.join(", ")}`);
}
console.log(`\nAdd this line to .env and keep it secret:\n\nGOOGLE_REFRESH_TOKEN=${payload.refresh_token}\n`);
