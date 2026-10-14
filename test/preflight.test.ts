import { describe, expect, it, vi } from "vitest";
import { parseTrustedProxies } from "../src/config.js";
import { APPROVED_SERVER_UUID, checkDiscovery, formatReport, runPreflight } from "../src/preflight.js";

const secrets = { OIDC_CLIENT_SECRET: "synthetic-oidc-secret-value", COOLIFY_API_TOKEN: "synthetic-team-token-value", COOLIFY_OWNER_SUBJECT: "synthetic-owner-subject-value" };
const complete = {
  ...secrets,
  MCP_PUBLIC_ORIGIN: "https://mcp.bridge-owner.dev", COOLIFY_ORIGIN: "https://coolify.bridge-owner.dev",
  OIDC_ISSUER: "https://login.bridge-owner.dev/realms/owner", OIDC_CLIENT_ID: "coolify-mcp",
  COOLIFY_TARGET_SERVER_NAME: "AI Agents", COOLIFY_TARGET_SERVER_UUID: APPROVED_SERVER_UUID,
  MCP_TRUSTED_PROXY_CIDRS: "172.18.0.1/32",
};
const statusOf = (env: NodeJS.ProcessEnv, setting: string) => runPreflight(env).checks.find((check) => check.setting === setting)?.status;

describe("activation preflight", () => {
  it("passes a complete configuration and derives the public callback and MCP URLs", () => {
    const report = runPreflight(complete);
    expect(report.checks.filter((check) => check.status !== "ok")).toEqual([]);
    expect(report.ready).toBe(true);
    expect(report.oidcCallbackUri).toBe("https://mcp.bridge-owner.dev/oauth/callback");
    expect(report.mcpUrl).toBe("https://mcp.bridge-owner.dev/mcp");
    expect(formatReport(report)).toContain("Preflight passed");
  });

  it("never prints secret values or the owner subject", () => {
    for (const env of [complete, { ...complete, COOLIFY_OWNER_SUBJECT: "owner@bridge-owner.dev" }, { ...secrets }]) {
      const output = formatReport(runPreflight(env));
      for (const value of Object.values(secrets)) expect(output).not.toContain(value);
      expect(output).not.toContain("owner@bridge-owner.dev");
    }
  });

  it("reports every missing setting on an empty environment", () => {
    const report = runPreflight({});
    expect(report.ready).toBe(false);
    expect(report.checks.every((check) => check.status === "missing")).toBe(true);
    expect(report.oidcCallbackUri).toBeUndefined();
    expect(formatReport(report)).toContain("Preflight failed");
  });

  it.each([
    ["MCP_PUBLIC_ORIGIN", "http://mcp.bridge-owner.dev"],
    ["MCP_PUBLIC_ORIGIN", "https://mcp.bridge-owner.dev:8443"],
    ["MCP_PUBLIC_ORIGIN", "https://mcp.bridge-owner.dev/mcp"],
    ["MCP_PUBLIC_ORIGIN", "https://mcp.example.com"],
    ["MCP_PUBLIC_ORIGIN", "https://localhost"],
    ["MCP_PUBLIC_ORIGIN", "https://mcp.example.com."],
    ["COOLIFY_ORIGIN", "https://coolify.test."],
    ["COOLIFY_TARGET_SERVER_NAME", "AI Agent"],
    ["COOLIFY_ORIGIN", "https://coolify.example.invalid"],
    ["COOLIFY_ORIGIN", "http://169.58.185.96:8000"],
    ["OIDC_ISSUER", "http://login.bridge-owner.dev"],
    ["OIDC_ISSUER", "https://identity.example.com/realms/owner"],
    ["OIDC_ISSUER", "https://issuer.test"],
    ["OIDC_ISSUER", "https://localhost/"],
    ["OIDC_ISSUER", "https://login.bridge-owner.dev/?tenant=x"],
    ["COOLIFY_OWNER_SUBJECT", "owner@bridge-owner.dev"],
    ["COOLIFY_TARGET_SERVER_UUID", "another-server-uuid"],
    ["MCP_TRUSTED_PROXY_CIDRS", "0.0.0.0/0x"],
    ["MCP_TRUSTED_PROXY_CIDRS", "2"],
    ["MCP_TRUSTED_PROXY_CIDRS", "*"],
  ])("rejects unsafe %s=%s", (setting, value) => {
    const env = { ...complete, [setting]: value };
    expect(statusOf(env, setting)).toBe("invalid");
    expect(runPreflight(env).ready).toBe(false);
  });

  it("does not derive a callback from an invalid public origin", () => {
    expect(runPreflight({ ...complete, MCP_PUBLIC_ORIGIN: "http://mcp.bridge-owner.dev" }).oidcCallbackUri).toBeUndefined();
  });
});

describe("trusted proxy parsing", () => {
  it("accepts explicit IPv4 and IPv6 addresses and CIDRs", () => {
    expect(parseTrustedProxies(" 10.0.0.2 , 172.18.0.1/32,::1/128,fd00::/8")).toEqual(["10.0.0.2", "172.18.0.1/32", "::1/128", "fd00::/8"]);
    expect(parseTrustedProxies("10.0.0.0/1,fd00::/64,10.0.0.0/10")).toEqual(["10.0.0.0/1", "fd00::/64", "10.0.0.0/10"]);
  });

  it.each([undefined, "", "10.0.0.0/33", "::/129", "10.0.0.0/0", "10.0.0.0/08", "10.0.0.0/8/8", "loopback", "10.0.0.1,", "10.0.0.0/64", "/8", "10.0.0.0/", "10.0.0.0/8x", "x10.0.0.0/8"])("rejects %s", (value) => {
    expect(parseTrustedProxies(value)).toBeUndefined();
  });

  it("caps the list at 32 entries", () => {
    const entries = Array.from({ length: 33 }, (_, i) => `10.0.0.${i + 1}`);
    expect(parseTrustedProxies(entries.slice(0, 32).join(","))).toHaveLength(32);
    expect(parseTrustedProxies(entries.join(","))).toBeUndefined();
  });
});

describe("issuer discovery check", () => {
  const issuer = "https://login.bridge-owner.dev/realms/owner";
  const respond = (body: unknown, status = 200) => vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
  const good = { issuer, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] };

  it("fetches the well-known document without credentials or redirects", async () => {
    const request = respond(good);
    await expect(checkDiscovery(issuer, request as typeof fetch)).resolves.toMatchObject({ ok: true });
    const [url, init] = request.mock.calls[0]!;
    expect((url as URL).href).toBe(`${issuer}/.well-known/openid-configuration`);
    expect(init).toMatchObject({ redirect: "error" });
    expect(JSON.stringify(init?.headers)).not.toMatch(/authorization/i);
  });

  it.each([
    [{ ...good, issuer: "https://other.bridge-owner.dev" }, /issuer does not match/],
    [{ ...good, issuer: `${issuer}/` }, /issuer does not match/],
    [{ ...good, issuer: 42 }, /issuer does not match/],
    [{ ...good, code_challenge_methods_supported: ["plain"] }, /PKCE S256/],
    [{ ...good, response_types_supported: ["id_token"] }, /authorization code/],
  ])("rejects unsuitable providers", async (body, message) => {
    const result = await checkDiscovery(issuer, respond(body) as typeof fetch);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(message);
  });

  it("accepts a bare-origin issuer with or without its trailing slash, as openid-client does", async () => {
    const origin = "https://login.bridge-owner.dev";
    await expect(checkDiscovery(`${origin}/`, respond({ ...good, issuer: origin }) as typeof fetch)).resolves.toMatchObject({ ok: true });
  });

  it("reports HTTP and network failures without echoing details", async () => {
    await expect(checkDiscovery(issuer, respond({}, 404) as typeof fetch)).resolves.toEqual({ ok: false, detail: "discovery returned HTTP 404" });
    const failing = vi.fn(async () => { throw new Error("synthetic-network-detail"); });
    const result = await checkDiscovery(issuer, failing as typeof fetch);
    expect(result.ok).toBe(false);
    expect(result.detail).not.toContain("synthetic-network-detail");
  });
});
