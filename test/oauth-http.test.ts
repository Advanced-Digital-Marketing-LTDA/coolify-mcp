import { afterEach, describe, expect, it, vi } from "vitest";
import { httpFixture, publicOrigin, resource } from "./http-fixture.js";

let fixture: Awaited<ReturnType<typeof httpFixture>> | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; vi.restoreAllMocks(); });
const protectedRead = (token: string) => fixture!.request("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });

describe("OAuth endpoints over real HTTP and a signed synthetic OIDC issuer", () => {
  it("publishes resource-bound discovery, requires bearer authentication, and omits upstream issuer from token responses", async () => {
    fixture = await httpFixture();
    const metadata = await (await fixture.request("/.well-known/oauth-authorization-server")).json();
    expect(metadata).toMatchObject({ code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
    const protectedResource = await (await fixture.request("/.well-known/oauth-protected-resource/mcp")).json();
    expect(protectedResource).toMatchObject({ resource, authorization_servers: [publicOrigin + "/"] });
    expect(metadata.issuer).toBe(protectedResource.authorization_servers[0]);
    const response = await fixture.request("/mcp", { headers: { "X-Sites-Owner": "owner-stable-subject" } });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
    const { tokens } = await fixture.login();
    expect(tokens).not.toHaveProperty("issuer");
    expect((await protectedRead("synthetic-idp-token")).status).toBe(401);
  });

  it("enforces S256 verifier and client, redirect, resource, and one-time code bindings at /token", async () => {
    fixture = await httpFixture();
    const { client } = await fixture.register("pkce-client"), { client: other } = await fixture.register("other-client");
    const { code } = await fixture.code(client);
    const params = { grant_type: "authorization_code", client_id: client.client_id, code, code_verifier: fixture.verifier, redirect_uri: client.redirect_uris[0]!, resource };
    for (const wrong of [{ code_verifier: "wrong-verifier" }, { client_id: other.client_id }, { redirect_uri: other.redirect_uris[0]! }, { resource: "https://elsewhere.example.test/mcp" }]) {
      const response = await fixture.tokenRequest({ ...params, ...wrong });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_grant" });
    }
    const response = await fixture.tokenRequest(params);
    expect(response.status).toBe(200);
    expect((await fixture.tokenRequest(params)).status).toBe(400);
  });

  it("rejects tampered state and replays of the OIDC callback", async () => {
    fixture = await httpFixture();
    const { client } = await fixture.register();
    const callback = new URL(await fixture.authorize(client));
    const wrong = new URL(callback); wrong.searchParams.set("state", "wrong-state");
    expect((await fetch(wrong, { redirect: "manual" })).status).toBe(400);
    expect((await fetch(callback, { redirect: "manual" })).status).toBe(302);
    expect((await fetch(callback, { redirect: "manual" })).status).toBe(400);
  });

  it.each([{ sub: "another-owner" }, { aud: "another-client" }, { iss: "https://untrusted.example.test" }, { nonce: "wrong-nonce" }, { exp: 1 }])("rejects untrusted OIDC claims %j", async (claims) => {
    fixture = await httpFixture();
    Object.assign(fixture.claimsOverride, claims);
    const { client } = await fixture.register();
    const callback = await fixture.authorize(client);
    expect((await fetch(callback, { redirect: "manual" })).status).toBe(400);
  });

  it("validates the ID-token signature using the issuer's JWKS", async () => {
    fixture = await httpFixture();
    fixture.idpBehavior.corruptSignature = true;
    const { client } = await fixture.register();
    const callback = await fixture.authorize(client);
    expect((await fetch(callback, { redirect: "manual" })).status).toBe(400);
  });

  it("expires authorization codes and access tokens at their boundary", async () => {
    fixture = await httpFixture();
    const active = await fixture.login("active"), { client } = await fixture.register("expiring-code");
    const { code } = await fixture.code(client);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 10 * 60_000);
    expect((await fixture.tokenRequest({ grant_type: "authorization_code", client_id: client.client_id, code, code_verifier: fixture.verifier, redirect_uri: client.redirect_uris[0]!, resource })).status).toBe(400);
    clock.mockReturnValue(now + 60 * 60_000);
    expect((await protectedRead(active.tokens.access_token)).status).toBe(401);
  });

  it("rotates refresh tokens, rejects cross-client/resource use, and revokes the grant on replay", async () => {
    fixture = await httpFixture();
    const active = await fixture.login("refresh-owner"), { client: other } = await fixture.register("refresh-other");
    const params = { grant_type: "refresh_token", client_id: active.client.client_id, refresh_token: active.tokens.refresh_token, resource };
    for (const wrong of [{ client_id: other.client_id }, { resource: "https://elsewhere.example.test/mcp" }, { scope: "admin" }]) {
      expect((await fixture.tokenRequest({ ...params, ...wrong })).status).toBe(400);
    }
    const response = await fixture.tokenRequest(params);
    expect(response.status).toBe(200);
    const rotated = await response.json() as { access_token: string; refresh_token: string };
    expect(rotated.refresh_token).not.toBe(active.tokens.refresh_token);
    expect((await fixture.tokenRequest(params)).status).toBe(400);
    expect((await protectedRead(rotated.access_token)).status).toBe(401);
    expect((await protectedRead(active.tokens.access_token)).status).toBe(401);
    expect((await fixture.tokenRequest({ ...params, refresh_token: rotated.refresh_token })).status).toBe(400);
  });

  it("revokes one grant's access and refresh tokens without revoking a separate grant", async () => {
    fixture = await httpFixture();
    const a = await fixture.login("revoke-client"), b = await fixture.login("revoke-client");
    const response = await fixture.request("/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: a.client.client_id, token: a.tokens.refresh_token }) });
    expect(response.status).toBe(200);
    expect((await protectedRead(a.tokens.access_token)).status).toBe(401);
    expect((await protectedRead(b.tokens.access_token)).status).toBe(400); // Valid token, initialization required.
    expect((await fixture.tokenRequest({ grant_type: "refresh_token", client_id: a.client.client_id, refresh_token: a.tokens.refresh_token, resource })).status).toBe(400);
  });

  it("retains registration rate limits and rejects forged client metadata envelopes", async () => {
    fixture = await httpFixture();
    const active = await fixture.login();
    for (let i = 0; i < 19; i++) expect((await fixture.register(`rate-${i}`)).response.status).toBe(201);
    expect((await fixture.register("excess")).response.status).toBe(429);
    const forged = active.client.client_id.slice(0, -1) + "!";
    const rejected = await fixture.tokenRequest({ grant_type: "refresh_token", client_id: forged, refresh_token: active.tokens.refresh_token, resource });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: "invalid_client" });
    expect((await protectedRead(active.tokens.access_token)).status).toBe(400);
  });

  it("isolates anonymous quotas by the actual client address forwarded by a trusted proxy", async () => {
    fixture = await httpFixture();
    const denied = { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "198.51.100.10" }, body: "{}" };
    for (let index = 0; index < 20; index++) expect((await fixture.request("/register", denied)).status).toBe(400);
    expect((await fixture.request("/register", denied)).status).toBe(429);
    expect((await fixture.request("/register", { ...denied, headers: { ...denied.headers, "X-Forwarded-For": "198.51.100.11" } })).status).toBe(400);
    expect((await fixture.request("/.well-known/oauth-authorization-server", { headers: { Host: "evil.example.test", "X-Forwarded-Host": "mcp.example.test" } })).status).toBe(403);
  });

  it("ignores spoofed forwarded addresses from a socket outside the trusted proxy list", async () => {
    fixture = await httpFixture();
    fixture.clientSourceAddress.value = "127.0.0.2";
    for (let index = 0; index < 20; index++) {
      const response = await fixture.request("/register", { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": `198.51.100.${index + 1}` }, body: "{}" });
      expect(response.status).toBe(400);
    }
    expect((await fixture.request("/register", { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "198.51.100.200" }, body: "{}" })).status).toBe(429);
  });
});
