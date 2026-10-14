import express from "express";
import { generateKeyPairSync, createHash, sign, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import { vi } from "vitest";
import { CoolifyMcpProvider } from "../src/coolify.js";
import { createHostedApp } from "../src/host.js";
import { FakeCoolify, appTarget } from "./fixtures.js";

export const publicOrigin = "https://mcp.example.test";
export const resource = `${publicOrigin}/mcp`;
export const issuer = "https://identity.example.test";
export const owner = "owner-stable-subject";
export const env = {
  COOLIFY_ORIGIN: "https://coolify.example.test", MCP_PUBLIC_ORIGIN: publicOrigin,
  COOLIFY_TARGET_SERVER_NAME: "Target Server", COOLIFY_TARGET_SERVER_UUID: "server-target",
  COOLIFY_OWNER_SUBJECT: owner, COOLIFY_API_TOKEN: "synthetic-team-token",
  OIDC_ISSUER: issuer, OIDC_CLIENT_ID: "synthetic-oidc-client", OIDC_CLIENT_SECRET: "synthetic-oidc-secret",
};
const verifier = "synthetic-chatgpt-verifier-at-least-43-characters-long";
const hash = (value: string) => createHash("sha256").update(value).digest("base64url");
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
async function listen(app: ReturnType<typeof express>) {
  const server = await new Promise<Server>((resolve) => { const server = app.listen(0, "127.0.0.1", () => resolve(server)); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback address");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}
const closeServer = (server: Server) => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve()); });

/** Real HTTP endpoints and signed OIDC tokens; only network destinations are synthetic. */
export async function httpFixture() {
  const provider = new FakeCoolify();
  provider.collections.application = [{ ...appTarget, health_check_enabled: true }];
  const writes: Array<{ uuid: string; body: Record<string, unknown>; authorization: string | undefined }> = [];
  const idp = express();
  idp.use(express.urlencoded({ extended: false }));
  idp.use(express.json());
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "fixture-key", alg: "RS256", use: "sig" };
  const idpCodes = new Map<string, URLSearchParams>();
  const claimsOverride: Record<string, unknown> = {};
  const idpBehavior = { corruptSignature: false };
  idp.get("/.well-known/openid-configuration", (_req, res) => res.json({
    issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
    response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
    code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["client_secret_post"],
  }));
  idp.get("/jwks", (_req, res) => res.json({ keys: [jwk] }));
  idp.get("/authorize", (req, res) => {
    const params = new URL(req.originalUrl, issuer).searchParams;
    const code = randomUUID(); idpCodes.set(code, params);
    const callback = new URL(params.get("redirect_uri")!);
    callback.searchParams.set("state", params.get("state")!); callback.searchParams.set("code", code);
    res.redirect(302, callback.href);
  });
  idp.post("/token", (req, res) => {
    const params = idpCodes.get(req.body.code); idpCodes.delete(req.body.code);
    if (!params || hash(req.body.code_verifier ?? "") !== params.get("code_challenge") || req.body.client_id !== env.OIDC_CLIENT_ID || req.body.client_secret !== env.OIDC_CLIENT_SECRET) {
      res.status(400).json({ error: "invalid_grant" }); return;
    }
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: issuer, aud: env.OIDC_CLIENT_ID, sub: owner, nonce: params.get("nonce"), iat: now, exp: now + 300, ...claimsOverride };
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: jwk.kid })).toString("base64url");
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const data = `${header}.${payload}`;
    const signature = sign("RSA-SHA256", Buffer.from(data), privateKey);
    if (idpBehavior.corruptSignature) signature[0] = signature[0]! ^ 1;
    res.json({ token_type: "Bearer", access_token: "synthetic-idp-token", expires_in: 300, id_token: `${data}.${signature.toString("base64url")}` });
  });
  idp.patch("/api/v1/applications/:uuid", (req, res) => {
    writes.push({ uuid: req.params.uuid, body: req.body, authorization: req.headers.authorization });
    res.json({ uuid: req.params.uuid });
  });
  const identityHost = await listen(idp);
  let mcpLocalOrigin: string | undefined;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const originalHost = url.host;
    const destination = url.origin === issuer || url.origin === env.COOLIFY_ORIGIN ? identityHost.origin : url.origin === publicOrigin ? mcpLocalOrigin : undefined;
    if (!destination) throw new Error("Fixture blocked an unexpected network destination");
    const headers = new Headers(init?.headers); if (!headers.has("Host")) headers.set("Host", originalHost);
    // Node's native fetch rewrites Host. Use real node:http sockets so the
    // fixture exercises the public Host preserved by a reverse proxy.
    return new Promise<Response>((resolve, reject) => {
      const request = httpRequest(new URL(url.pathname + url.search, destination), { method: init?.method ?? "GET", headers: Object.fromEntries(headers), signal: init?.signal ?? undefined }, (response) => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
        const status = response.statusCode!;
        if (status >= 300 && status < 400 && init?.redirect === "error") { response.destroy(); reject(new Error("Fixture redirect blocked")); return; }
        resolve(new Response([204, 205, 304].includes(status) ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, headers: responseHeaders }));
      });
      request.on("error", reject);
      request.end(init?.body === undefined || init.body === null ? undefined : String(init.body));
    });
  });
  vi.spyOn(CoolifyMcpProvider, "connect").mockResolvedValue({ provider: provider as never, close: async () => undefined });
  let hosted!: Awaited<ReturnType<typeof createHostedApp>>;
  let host!: Awaited<ReturnType<typeof listen>>;
  try {
    hosted = await createHostedApp(env);
    host = await listen(hosted.app); mcpLocalOrigin = host.origin;
  } catch (error) {
    await hosted?.close(); await closeServer(identityHost.server); vi.restoreAllMocks();
    throw error;
  }
  const request = (path: string, init?: RequestInit) => fetch(new URL(path, publicOrigin), init);
  async function register(callbackId = "fixture-callback") {
    const response = await request("/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [`https://chatgpt.com/connector/oauth/${callbackId}`], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
    return { response, client: await response.json() as { client_id: string; redirect_uris: string[] } };
  }
  async function authorize(client: { client_id: string; redirect_uris: string[] }) {
    const params = new URLSearchParams({ client_id: client.client_id, response_type: "code", redirect_uri: client.redirect_uris[0]!, code_challenge: hash(verifier), code_challenge_method: "S256", scope: "mcp", resource, state: "fixture-chatgpt-state" });
    const response = await request(`/authorize?${params}`, { redirect: "manual" });
    if (response.status !== 302) throw new Error(`Authorization failed: ${response.status}`);
    const login = await fetch(response.headers.get("location")!, { redirect: "manual" });
    return login.headers.get("location")!;
  }
  const tokenRequest = (body: Record<string, string>) => request("/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
  async function code(client: { client_id: string; redirect_uris: string[] }) {
    const callback = await authorize(client);
    const response = await fetch(callback, { redirect: "manual" });
    if (response.status !== 302) throw new Error(`OIDC callback failed: ${response.status}`);
    const redirect = new URL(response.headers.get("location")!);
    if (redirect.searchParams.get("state") !== "fixture-chatgpt-state") throw new Error("ChatGPT state was not preserved");
    return { code: redirect.searchParams.get("code")!, callback };
  }
  async function login(callbackId = "fixture-callback") {
    const { response: registrationResponse, client } = await register(callbackId);
    if (registrationResponse.status !== 201) throw new Error(`Registration failed: ${registrationResponse.status} ${JSON.stringify(client)}`);
    const grant = await code(client);
    const response = await tokenRequest({ grant_type: "authorization_code", client_id: client.client_id, code: grant.code, code_verifier: verifier, redirect_uri: client.redirect_uris[0]!, resource });
    if (response.status !== 200) throw new Error(`Token exchange failed: ${response.status}`);
    return { client, tokens: await response.json() as { access_token: string; refresh_token: string; expires_in: number }, grant };
  }
  return { provider, writes, request, register, authorize, code, login, tokenRequest, claimsOverride, idpBehavior, verifier,
    close: async () => { await hosted.close(); await closeServer(host.server); await closeServer(identityHost.server); vi.restoreAllMocks(); } };
}
