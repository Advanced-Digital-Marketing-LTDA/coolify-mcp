// Explicit test preload, mounted only by smoke runners. Never copied into the image.
// OIDC signatures/claims are real; the issuer fetch and Coolify provider are synthetic.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { CoolifyMcpProvider } from "../../dist/src/coolify.js";

const issuer = "https://identity.example.test";
Object.assign(process.env, {
  PORT: "3000", MCP_PUBLIC_ORIGIN: "https://mcp.example.test",
  MCP_TRUSTED_PROXY_CIDRS: "127.0.0.1/32", COOLIFY_ORIGIN: "https://coolify.example.test",
  COOLIFY_TARGET_SERVER_NAME: "Synthetic Server", COOLIFY_TARGET_SERVER_UUID: "server-synthetic",
  COOLIFY_OWNER_SUBJECT: "synthetic-owner", COOLIFY_API_TOKEN: "synthetic-team-token",
  OIDC_ISSUER: issuer, OIDC_CLIENT_ID: "synthetic-client", OIDC_CLIENT_SECRET: "synthetic-secret",
});
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "smoke-key", alg: "RS256", use: "sig" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assert.equal(url.origin, issuer, "Smoke fixture blocked unexpected outbound destination");
  if (url.pathname === "/.well-known/openid-configuration") return json({
    issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
    response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
    code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["client_secret_post"],
  });
  if (url.pathname === "/jwks") return json({ keys: [jwk] });
  if (url.pathname === "/token") {
    const body = new URLSearchParams(String(init?.body));
    const grant = JSON.parse(Buffer.from(body.get("code"), "base64url").toString());
    assert.equal(body.get("client_id"), "synthetic-client");
    assert.equal(body.get("client_secret"), "synthetic-secret");
    assert.equal(body.get("redirect_uri"), "https://mcp.example.test/oauth/callback");
    assert.equal(createHash("sha256").update(body.get("code_verifier")).digest("base64url"), grant.challenge);
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: jwk.kid })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iss: issuer, aud: "synthetic-client", sub: grant.subject, nonce: grant.nonce, iat: now, exp: now + 300 })).toString("base64url");
    const data = `${header}.${payload}`;
    return json({ token_type: "Bearer", access_token: "synthetic-idp-token", expires_in: 300,
      id_token: `${data}.${sign("RSA-SHA256", Buffer.from(data), privateKey).toString("base64url")}` });
  }
  throw new Error("Smoke fixture blocked unexpected issuer path");
};
CoolifyMcpProvider.connect = async (token, origin) => {
  assert.equal(token, "synthetic-team-token");
  assert.equal(origin, "https://coolify.example.test");
  const provider = {
    listServers: async () => [{ uuid: "server-synthetic", name: "Synthetic Server" }],
    listResources: async () => [], getEnvironments: async () => [],
  };
  return { provider, close: async () => {} };
};
