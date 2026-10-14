import { beforeEach, describe, expect, it, vi } from "vitest";

const oidcFake = vi.hoisted(() => ({ subject: "owner-stable-subject", authorizationParams: undefined as Record<string, string> | undefined }));
vi.mock("openid-client", () => ({
  enableNonRepudiationChecks: () => undefined,
  discovery: async () => ({ serverMetadata: () => ({ code_challenge_methods_supported: ["S256"] }) }),
  randomNonce: () => "oidc-nonce",
  randomPKCECodeVerifier: () => "oidc-verifier",
  calculatePKCECodeChallenge: async () => "oidc-s256-challenge",
  buildAuthorizationUrl: (_config: unknown, params: Record<string, string>) => {
    oidcFake.authorizationParams = params;
    const url = new URL("https://identity.example.test/authorize");
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url;
  },
  authorizationCodeGrant: async (_config: unknown, _callback: URL, options: Record<string, string>) => {
    if (options.expectedState !== oidcFake.authorizationParams?.state || options.expectedNonce !== "oidc-nonce" || options.pkceCodeVerifier !== "oidc-verifier") throw new Error("OIDC transaction failed");
    return { claims: () => ({ sub: oidcFake.subject }) };
  },
}));

import { HostedOAuthProvider } from "../src/hosted-auth.js";
import { createHostedApp } from "../src/host.js";

const owner = "owner-stable-subject";
const resource = "https://mcp.example.test/mcp";
const callback = "https://chatgpt.com/connector/oauth/callback-id";
const registration = {
  redirect_uris: [new URL(callback)], token_endpoint_auth_method: "none",
  grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
};

describe("hosted OAuth bridge", () => {
  beforeEach(() => { oidcFake.subject = owner; oidcFake.authorizationParams = undefined; });

  it("fails closed before network setup when owner activation settings are incomplete", async () => {
    await expect(createHostedApp({})).rejects.toThrow("Hosted MCP is inactive");
  });

  it("binds ChatGPT DCR, OIDC login, code exchange, and access tokens to the pinned owner and MCP resource", async () => {
    const provider = await HostedOAuthProvider.create({ issuer: "https://identity.example.test/tenant", clientId: "synthetic-client", clientSecret: "synthetic-secret", resourceUri: resource, ownerSubject: owner });
    const client = await provider.clientsStore.registerClient!(registration as never);
    const redirects: string[] = [];
    await provider.authorize(client, { codeChallenge: "chatgpt-pkce-challenge", redirectUri: callback, resource: new URL(resource), scopes: ["mcp"], state: "chatgpt-state" }, { redirect: (...args: unknown[]) => { redirects.push(String(args.at(-1))); } } as never);
    const idp = new URL(redirects[0]!);
    expect(idp.origin).toBe("https://identity.example.test");
    expect(idp.searchParams.get("code_challenge_method")).toBe("S256");
    const returned = new URL(await provider.completeLogin(new URL(`/oauth/callback?code=synthetic-code&state=${idp.searchParams.get("state")}`, "https://mcp.example.test")));
    expect(returned.origin + returned.pathname).toBe(callback);
    expect(returned.searchParams.get("state")).toBe("chatgpt-state");
    const code = returned.searchParams.get("code")!;
    await expect(provider.challengeForAuthorizationCode(client, code)).resolves.toBe("chatgpt-pkce-challenge");
    const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, callback, new URL(resource));
    const auth = await provider.verifyAccessToken(tokens.access_token);
    expect(auth).toMatchObject({ clientId: client.client_id, scopes: ["mcp"], resource: new URL(resource), extra: { ownerSubject: owner } });
    await expect(provider.verifyAccessToken("not-a-token")).rejects.toThrow("Invalid access token");
  });

  it("rejects non-owner login, non-ChatGPT redirects, and mismatched resource/scope requests", async () => {
    const provider = await HostedOAuthProvider.create({ issuer: "https://identity.example.test", clientId: "synthetic-client", clientSecret: "synthetic-secret", resourceUri: resource, ownerSubject: owner });
    await expect(provider.clientsStore.registerClient!({ ...registration, redirect_uris: [new URL("https://evil.example.test/callback")] } as never)).rejects.toThrow();
    await expect(provider.clientsStore.registerClient!({ ...registration, grant_types: ["authorization_code", "client_credentials"] } as never)).rejects.toThrow();
    const client = await provider.clientsStore.registerClient!(registration as never);
    await expect(provider.authorize(client, { codeChallenge: "challenge", redirectUri: callback, resource: new URL("https://elsewhere.example.test/mcp"), scopes: ["mcp"] }, { redirect: () => undefined } as never)).rejects.toThrow();
    await expect(provider.authorize(client, { codeChallenge: "challenge", redirectUri: callback, resource: new URL(resource), scopes: ["mcp", "admin"] }, { redirect: () => undefined } as never)).rejects.toThrow();
    await provider.authorize(client, { codeChallenge: "challenge", redirectUri: callback, resource: new URL(resource), scopes: ["mcp"] }, { redirect: () => undefined } as never);
    const state = oidcFake.authorizationParams!.state;
    oidcFake.subject = "different-owner";
    await expect(provider.completeLogin(new URL(`/oauth/callback?code=synthetic&state=${state}`, "https://mcp.example.test"))).rejects.toThrow("different owner");
  });

  it("does not allocate a client store that unauthenticated registrations can exhaust", async () => {
    const provider = await HostedOAuthProvider.create({ issuer: "https://identity.example.test", clientId: "synthetic-client", clientSecret: "synthetic-secret", resourceUri: resource, ownerSubject: owner });
    const first = await provider.clientsStore.registerClient!(registration as never);
    for (let index = 0; index < 2_100; index++) {
      await provider.clientsStore.registerClient!({ ...registration, redirect_uris: [new URL(`https://chatgpt.com/connector/oauth/fixture-${index}`)] } as never);
    }
    expect(await provider.clientsStore.getClient(first.client_id)).toMatchObject({ client_id: first.client_id });
    expect(await provider.clientsStore.getClient(first.client_id.slice(0, -1) + "!")).toBeUndefined();
    await expect(provider.clientsStore.registerClient!({ ...registration, redirect_uris: [new URL("https://chatgpt.com:444/connector/oauth/x")] } as never)).rejects.toThrow();
    await expect(provider.clientsStore.registerClient!({ ...registration, redirect_uris: [new URL("https://user@chatgpt.com/connector/oauth/x")] } as never)).rejects.toThrow();
  });

  it("expires registered clients and refresh grants without extending their validity on reads", async () => {
    const provider = await HostedOAuthProvider.create({ issuer: "https://identity.example.test", clientId: "synthetic-client", clientSecret: "synthetic-secret", resourceUri: resource, ownerSubject: owner });
    const client = await provider.clientsStore.registerClient!(registration as never);
    await provider.authorize(client, { codeChallenge: "challenge", redirectUri: callback, resource: new URL(resource), scopes: ["mcp"] }, { redirect: () => undefined } as never);
    const returned = new URL(await provider.completeLogin(new URL(`/oauth/callback?code=synthetic&state=${oidcFake.authorizationParams!.state}`, "https://mcp.example.test")));
    const tokens = await provider.exchangeAuthorizationCode(client, returned.searchParams.get("code")!, undefined, callback, new URL(resource));
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 30 * 86_400_000);
    try {
      expect(await provider.clientsStore.getClient(client.client_id)).toBeUndefined();
      await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!, ["mcp"], new URL(resource))).rejects.toThrow("Invalid refresh token");
    } finally { clock.mockRestore(); }
  });
});
