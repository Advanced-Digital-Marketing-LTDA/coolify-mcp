import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import { spawnSync } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const origin = "https://mcp.example.test", resource = `${origin}/mcp`;
const verifier = "synthetic-smoke-verifier-at-least-43-characters-long";
// Real loopback sockets with exact Host; no DNS or external network is used.
async function request(path, init = {}) {
  return new Promise((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(init.headers));
    headers.host ??= new URL(origin).host;
    const req = httpRequest(new URL(path, "http://127.0.0.1:3000"), {
      method: init.method ?? "GET", headers, signal: init.signal ?? AbortSignal.timeout(5000),
    }, (res) => {
      resolve(new Response([204, 205, 304].includes(res.statusCode) ? null : Readable.toWeb(res), {
        status: res.statusCode, headers: Object.fromEntries(Object.entries(res.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value])),
      }));
    });
    req.on("error", reject);
    req.end(init.body === undefined ? undefined : String(init.body));
  });
}
async function login(subject) {
  const registration = await request("/register", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://chatgpt.com/connector/oauth/smoke"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
  assert.equal(registration.status, 201);
  const client = await registration.json();
  const params = new URLSearchParams({ client_id: client.client_id, response_type: "code", redirect_uri: client.redirect_uris[0],
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", scope: "mcp", resource, state: "smoke-state" });
  const authorization = await request(`/authorize?${params}`);
  assert.equal(authorization.status, 302);
  const login = new URL(authorization.headers.get("location"));
  assert.equal(login.origin, "https://identity.example.test");
  const code = Buffer.from(JSON.stringify({ nonce: login.searchParams.get("nonce"), challenge: login.searchParams.get("code_challenge"), subject })).toString("base64url");
  const callback = await request(`/oauth/callback?${new URLSearchParams({ state: login.searchParams.get("state"), code })}`);
  if (subject !== "synthetic-owner") { assert.equal(callback.status, 400); return; }
  assert.equal(callback.status, 302);
  const redirect = new URL(callback.headers.get("location"));
  assert.equal(redirect.searchParams.get("state"), "smoke-state");
  const response = await request("/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id, code: redirect.searchParams.get("code"), code_verifier: verifier, redirect_uri: client.redirect_uris[0], resource }) });
  assert.equal(response.status, 200);
  return response.json();
}

export async function check() {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = (await request("/healthz", { headers: { Host: "127.0.0.1:3000" } })).status === 200; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, "Built host did not become ready");
  assert.deepEqual(await (await request("/healthz")).json(), { status: "ok" });
  assert.equal(spawnSync(process.execPath, ["docker/healthcheck.mjs"]).status, 0);
  assert.equal((await request("/healthz", { headers: { Host: "attacker.example.test", "X-Forwarded-Host": "mcp.example.test" } })).status, 403);
  assert.equal((await request("/healthz", { headers: { Host: "127.0.0.1:3000", Origin: origin } })).status, 403);
  assert.equal((await request("/mcp", { headers: { Host: "127.0.0.1:3000" } })).status, 403);
  assert.equal((await request("/mcp", { headers: { Origin: "https://attacker.example.test" } })).status, 403);
  for (const headers of [{}, { Authorization: "Bearer invalid-synthetic-token" }]) assert.equal((await request("/mcp", { headers })).status, 401);
  const discovery = await request("/.well-known/oauth-protected-resource/mcp");
  assert.equal(discovery.status, 200);
  assert.equal((await discovery.json()).resource, resource);
  await login("synthetic-non-owner");
  const tokens = await login("synthetic-owner");
  const client = new Client({ name: "built-runtime-smoke", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(resource), {
    requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    fetch: async (url, init) => {
      const destination = new URL(String(url));
      assert.equal(destination.origin, origin);
      return request(destination.pathname + destination.search, init);
    },
  });
  try {
    await client.connect(transport);
    assert.ok(transport.sessionId);
    assert.equal((await client.listTools()).tools.length, 8);
    const inventory = await client.callTool({ name: "coolify_inventory", arguments: {} });
    assert.equal(inventory.isError, undefined);
    assert.equal(inventory.structuredContent.server.uuid, "server-synthetic");
    assert.deepEqual(inventory.structuredContent.resources, []);
    await transport.terminateSession();
  } finally { await client.close(); }
  if (process.argv.includes("--container")) {
    assert.notEqual(process.getuid(), 0);
    for (const path of ["src", ".env", ".git", "node_modules/typescript", "node_modules/vitest"]) await assert.rejects(access(path));
    await assert.rejects(writeFile("/app/smoke-write-probe", "must not write"));
  }
  console.log("Smoke passed: built startup, health probe, Host/Origin, bearer denial, signed OIDC owner gate, MCP initialize/tools/inventory/session close.");
}
if (process.argv[1]?.endsWith("check.mjs")) await check();
