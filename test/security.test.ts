import { describe, expect, it } from "vitest";
import { OwnerIdentityGate, UnconfiguredIdentityProvider, type VerifiedIdentityProvider } from "../src/identity.js";
import { AccessDeniedError, NotConfiguredError, ResourceScopeError } from "../src/errors.js";
import { isActivated, isHostedConfigured, isSafeCoolifyOrigin, readRuntimeConfig } from "../src/config.js";
import { requirePinnedServer, requireResourceOnTarget, requireSingleServerApplication, safeDetails, safeFilteredResource, safeVerifiedDetails, serverUuidOf, uuidOf } from "../src/scope.js";
import { ConfigurationWritePolicy } from "../src/policy.js";
import { FakeCoolify, otherServer, targetServer, appTarget } from "./fixtures.js";

describe("owner identity gate", () => {
  const provider: VerifiedIdentityProvider = { resolve: async () => ({ subject: "owner-immutable-id" }) };
  it("allows only the configured stable owner subject", async () => {
    const gate = new OwnerIdentityGate("owner-immutable-id", provider);
    await expect(gate.requireOwner(undefined)).resolves.toEqual({ subject: "owner-immutable-id" });
    await expect(new OwnerIdentityGate("other", provider).requireOwner(undefined)).rejects.toBeInstanceOf(AccessDeniedError);
  });
  it("does not auto-enroll when the owner is not pinned or identity provider is absent", async () => {
    await expect(new OwnerIdentityGate(undefined, provider).requireOwner(undefined)).rejects.toThrow("Pinned non-email owner subject is not configured");
    await expect(new OwnerIdentityGate("owner@example.test", provider).requireOwner(undefined)).rejects.toThrow("Pinned non-email owner subject is not configured");
    await expect(new OwnerIdentityGate("owner-immutable-id", new UnconfiguredIdentityProvider()).requireOwner(undefined)).rejects.toThrow("Verified OAuth owner identity is not configured");
    await expect(new OwnerIdentityGate("owner@example.test", { resolve: async () => ({ subject: "owner@example.test" }) }).requireOwner(undefined)).rejects.toBeInstanceOf(NotConfiguredError);
  });
});

describe("public error contract", () => {
  it("uses stable names and generic default messages for known failures", () => {
    expect(new AccessDeniedError()).toMatchObject({ name: "AccessDeniedError", message: "Access denied" });
    expect(new NotConfiguredError()).toMatchObject({ name: "NotConfiguredError", message: "Coolify MCP is not configured" });
    expect(new ResourceScopeError()).toMatchObject({ name: "ResourceScopeError", message: "Resource is outside the approved server scope" });
  });
});

describe("activation and server pin", () => {
  it("is disabled until owner, target UUID, and token are all present", () => {
    const active = { origin: "https://coolify.example.test", targetServerName: "Target Server", ownerSubject: "owner", targetServerUuid: "server-target", apiToken: "synthetic" };
    expect(isActivated({ ownerSubject: "owner", targetServerUuid: "server-target" })).toBe(false);
    expect(isActivated(active)).toBe(true);
    expect(isActivated({ ...active, ownerSubject: "owner@example.test" })).toBe(false);
    expect(isActivated({ ...active, ownerSubject: "   " })).toBe(false);
    expect(isActivated({ ...active, targetServerUuid: " " })).toBe(false);
    expect(isActivated({ ...active, targetServerName: "   " })).toBe(false);
    expect(isActivated({ ...active, apiToken: " " })).toBe(false);
    expect(isActivated({ ...active, origin: "https://coolify.example.invalid" })).toBe(false);
    expect(isSafeCoolifyOrigin("http://coolify.example.test")).toBe(false);
    expect(isSafeCoolifyOrigin("https://user:pass@coolify.example.test")).toBe(false);
    expect(isSafeCoolifyOrigin("https://coolify.example.test/arbitrary/path")).toBe(false);
    expect(isSafeCoolifyOrigin("https://coolify.example.test/?x=1")).toBe(false);
    expect(isSafeCoolifyOrigin("https://coolify.example.test:8443")).toBe(false);
    expect(isSafeCoolifyOrigin("https://coolify.example.test/")).toBe(true);
    expect(isSafeCoolifyOrigin("not-a-url")).toBe(false);
    expect(readRuntimeConfig({})).toEqual({});
    expect(readRuntimeConfig({
      COOLIFY_TARGET_SERVER_NAME: " \n ",
      COOLIFY_OWNER_SUBJECT: " \n ",
      COOLIFY_TARGET_SERVER_UUID: " \n ",
      COOLIFY_API_TOKEN: " \n ",
    })).toEqual({});
    expect(readRuntimeConfig({
      COOLIFY_ORIGIN: "https://coolify.example.test",
      COOLIFY_TARGET_SERVER_NAME: " Target Server ",
      COOLIFY_OWNER_SUBJECT: " owner-subject\n",
      COOLIFY_TARGET_SERVER_UUID: "server-target\n",
      COOLIFY_API_TOKEN: " synthetic-token ",
    })).toEqual({
      origin: "https://coolify.example.test",
      targetServerName: "Target Server",
      ownerSubject: "owner-subject",
      targetServerUuid: "server-target",
      apiToken: "synthetic-token",
    });
    expect(readRuntimeConfig({
      MCP_PUBLIC_ORIGIN: "https://mcp.example.test",
      OIDC_ISSUER: "https://identity.example.test/tenant",
      OIDC_CLIENT_ID: " client-id ",
      OIDC_CLIENT_SECRET: " synthetic-secret ",
    })).toEqual({ publicOrigin: "https://mcp.example.test", oidcIssuer: "https://identity.example.test/tenant", oidcClientId: "client-id", oidcClientSecret: "synthetic-secret" });
    expect(readRuntimeConfig({ OIDC_ISSUER: "http://identity.example.test" })).toEqual({});
    expect(readRuntimeConfig({ OIDC_ISSUER: "https://[invalid" })).toEqual({});
    expect(readRuntimeConfig({ OIDC_CLIENT_ID: " ", OIDC_CLIENT_SECRET: " " })).toEqual({});
    for (const issuer of ["https://user:pass@identity.example.test", "https://identity.example.test?tenant=x", "https://identity.example.test#tenant"]) {
      expect(readRuntimeConfig({ OIDC_ISSUER: issuer }).oidcIssuer).toBeUndefined();
    }
  });

  it("requires the final trusted HTTPS origin and configured OIDC client for hosted activation", () => {
    const ready = { origin: "https://coolify.example.test", publicOrigin: "https://mcp.example.test", oidcIssuer: "https://id.example.test/tenant", oidcClientId: "client", oidcClientSecret: "synthetic-secret", targetServerName: "AI Agents", targetServerUuid: "pcrionkfci16zmkssngc6vaa", ownerSubject: "owner-subject", apiToken: "synthetic-token" };
    expect(isHostedConfigured(ready)).toBe(true);
    expect(isHostedConfigured({ ...ready, publicOrigin: "http://169.58.185.96:8000" })).toBe(false);
    expect(isHostedConfigured({ ...ready, oidcClientSecret: "" })).toBe(false);
    expect(isHostedConfigured({ ...ready, oidcIssuer: "" })).toBe(false);
    expect(isHostedConfigured({ ...ready, oidcClientId: " " })).toBe(false);
    expect(isHostedConfigured({ ...ready, oidcClientSecret: " " })).toBe(false);
    expect(isHostedConfigured({ ...ready, ownerSubject: "owner@example.test" })).toBe(false);
  });
  it("requires the pinned UUID to resolve uniquely to the configured server name", async () => {
    const provider = new FakeCoolify();
    await expect(requirePinnedServer(provider, undefined, "Target Server")).rejects.toBeInstanceOf(ResourceScopeError);
    await expect(requirePinnedServer(provider, " \n", "Target Server")).rejects.toBeInstanceOf(ResourceScopeError);
    await expect(requirePinnedServer(provider, "server-target\n", "Target Server")).rejects.toBeInstanceOf(ResourceScopeError);
    await expect(requirePinnedServer(provider, "server-target", " \n ")).rejects.toBeInstanceOf(ResourceScopeError);
    await expect(requirePinnedServer(provider, "server-elsewhere", "Target Server")).rejects.toThrow("configured name");
    provider.servers = [targetServer, targetServer];
    await expect(requirePinnedServer(provider, "server-target", "Target Server")).rejects.toBeInstanceOf(ResourceScopeError);
    provider.servers = [targetServer];
    await expect(requirePinnedServer(provider, "server-target", "Target Server")).resolves.toEqual(targetServer);
    await expect(requirePinnedServer(provider, "server-target", "Different Name")).rejects.toBeInstanceOf(ResourceScopeError);
  });
  it("rejects stale resources and unknown server membership", async () => {
    const provider = new FakeCoolify();
    await expect(requireResourceOnTarget(provider, "application", "app-alpha", "server-elsewhere")).rejects.toBeInstanceOf(ResourceScopeError);
    provider.onResourceRead = () => ({ ...appTarget, uuid: "different-resource", server: targetServer });
    await expect(requireResourceOnTarget(provider, "application", "app-alpha", "server-target")).rejects.toBeInstanceOf(ResourceScopeError);
    provider.getResource = async () => ({ ...appTarget, server: { uuid: "server-elsewhere" } });
    await expect(requireResourceOnTarget(provider, "application", "app-alpha", "server-target")).rejects.toBeInstanceOf(ResourceScopeError);
    provider.getResource = async () => ({ uuid: "app-alpha", name: "Alpha", server_uuid: "server-target" });
    provider.listResources = async () => [{ uuid: "app-alpha" }];
    await expect(requireResourceOnTarget(provider, "application", "app-alpha", "server-target")).resolves.toMatchObject({ uuid: "app-alpha" });
    provider.listResources = async () => [{ uuid: "app-alpha", server_uuid: "server-elsewhere" }];
    await expect(requireResourceOnTarget(provider, "application", "app-alpha", "server-target")).rejects.toBeInstanceOf(ResourceScopeError);
    provider.listResources = async () => [{ uuid: "different-resource", server_uuid: "server-target" }];
    await expect(requireResourceOnTarget(provider, "application", "app-alpha", "server-target")).rejects.toBeInstanceOf(ResourceScopeError);
    expect(() => safeDetails({ ...appTarget, server: undefined, server_uuid: undefined }, "application", "server-target")).toThrow();
    expect(serverUuidOf({ server: null })).toBeUndefined();
    expect(serverUuidOf({ server: { uuid: 123 }, server_uuid: "server-target" })).toBe("server-target");
    expect(uuidOf({ uuid: "" })).toBeUndefined();
  });

  it("normalizes only rows proven by a server filter and rejects contradictory or incomplete detail membership", () => {
    expect(safeFilteredResource({ uuid: "app-alpha", name: "Alpha" }, "application", "server-target")?.serverUuid).toBe("server-target");
    expect(safeFilteredResource({ uuid: "app-alpha", server_uuid: "server-elsewhere" }, "application", "server-target")).toBeUndefined();
    expect(safeFilteredResource({ name: "missing UUID" }, "application", "server-target")).toBeUndefined();
    expect(safeVerifiedDetails({ uuid: "app-alpha", name: "Alpha" }, "application", "server-target").serverUuid).toBe("server-target");
    expect(() => safeVerifiedDetails({ uuid: "app-alpha", server_uuid: "server-elsewhere" }, "application", "server-target")).toThrow(ResourceScopeError);
    expect(() => safeVerifiedDetails({ name: "missing UUID" }, "application", "server-target")).toThrow(ResourceScopeError);
  });

  it("requires complete unique server membership for app-wide actions", async () => {
    const provider = new FakeCoolify();
    provider.servers = [targetServer, otherServer];
    provider.definedResourcesByServer["server-target"] = [{ uuid: "app-alpha", type: "application" }];
    provider.definedResourcesByServer["server-elsewhere"] = [];
    await expect(requireSingleServerApplication(provider, "app-alpha", "server-target")).resolves.toBeUndefined();

    provider.definedResourcesByServer["server-elsewhere"] = [{ uuid: "some-other-app", type: "application" }];
    await expect(requireSingleServerApplication(provider, "app-alpha", "server-target")).resolves.toBeUndefined();
    provider.definedResourcesByServer["server-elsewhere"] = [{ uuid: "app-alpha", type: "application" }];
    await expect(requireSingleServerApplication(provider, "app-alpha", "server-target")).rejects.toThrow("multiple or unknown servers");
    provider.definedResourcesByServer["server-target"] = [];
    provider.definedResourcesByServer["server-elsewhere"] = [{ uuid: "app-alpha", type: "application" }];
    await expect(requireSingleServerApplication(provider, "app-alpha", "server-target")).rejects.toThrow("multiple or unknown servers");
    provider.definedResourcesByServer["server-target"] = [{ uuid: "app-alpha", type: "application" }];
    provider.servers = [targetServer, { name: "unknown server" }];
    await expect(requireSingleServerApplication(provider, "app-alpha", "server-target")).rejects.toThrow("membership is unknown");
    provider.servers = [targetServer, targetServer];
    await expect(requireSingleServerApplication(provider, "app-alpha", "server-target")).rejects.toThrow("membership is unknown");
    provider.servers = [otherServer];
    await expect(requireSingleServerApplication(provider, "app-alpha", "server-target")).rejects.toThrow("membership is unknown");
  });

  it("bounds safe resource names and domains and drops non-string domain values", () => {
    const domains = [42, null, ...Array.from({ length: 11 }, (_, index) => `https://host-${index}.example.test`)];
    const details = safeDetails({ ...appTarget, name: "n".repeat(350), fqdn: domains }, "application", "server-target");
    expect(details.name).toHaveLength(300);
    expect(details.fqdn).toHaveLength(10);
    expect(details.fqdn.every((value) => typeof value === "string")).toBe(true);
    const commaSeparated = safeDetails({ ...appTarget, fqdn: " https://one.example.test , ,https://two.example.test " }, "application", "server-target");
    expect(commaSeparated.fqdn).toEqual(["https://one.example.test", "https://two.example.test"]);
    const tooManyCommaSeparated = safeDetails({ ...appTarget, fqdn: Array.from({ length: 12 }, (_, index) => `https://host-${index}.example.test`).join(",") }, "application", "server-target");
    expect(tooManyCommaSeparated.fqdn).toHaveLength(10);
    expect(safeDetails({ ...appTarget, name: "", project_name: "" }, "application", "server-target").name).toBe("Unnamed resource");
  });
});

describe("configuration write allow-list", () => {
  it("denies every config write until an exact owner grant exists", () => {
    const policy = new ConfigurationWritePolicy();
    const request = { kind: "application" as const, resourceUuid: "app-alpha", key: "PUBLIC_MODE", value: "safe" };
    expect(policy.allows(request)).toBe(false);
    const granted = new ConfigurationWritePolicy([request]);
    expect(granted.allows(request)).toBe(true);
    expect(granted.allows({ ...request, value: "changed" })).toBe(false);
    expect(granted.allows({ ...request, resourceUuid: "app-other" })).toBe(false);
    expect(granted.allows({ ...request, kind: "service" })).toBe(false);
    expect(granted.allows({ ...request, key: "UNRELATED_KEY" })).toBe(false);
  });
});
