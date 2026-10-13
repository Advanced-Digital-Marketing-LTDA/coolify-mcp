import { describe, expect, it } from "vitest";
import { OwnerIdentityGate, UnconfiguredIdentityProvider, type VerifiedIdentityProvider } from "../src/identity.js";
import { AccessDeniedError, NotConfiguredError, ResourceScopeError } from "../src/errors.js";
import { isActivated, isSafeCoolifyOrigin, readRuntimeConfig } from "../src/config.js";
import { requirePinnedServer, requireResourceOnTarget, safeDetails, serverUuidOf, uuidOf } from "../src/scope.js";
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
    await expect(new OwnerIdentityGate(undefined, provider).requireOwner(undefined)).rejects.toBeInstanceOf(NotConfiguredError);
    await expect(new OwnerIdentityGate("owner@example.test", provider).requireOwner(undefined)).rejects.toBeInstanceOf(NotConfiguredError);
    await expect(new OwnerIdentityGate("owner-immutable-id", new UnconfiguredIdentityProvider()).requireOwner(undefined)).rejects.toBeInstanceOf(NotConfiguredError);
    await expect(new OwnerIdentityGate("owner@example.test", { resolve: async () => ({ subject: "owner@example.test" }) }).requireOwner(undefined)).rejects.toBeInstanceOf(NotConfiguredError);
  });
});

describe("activation and server pin", () => {
  it("is disabled until owner, target UUID, and token are all present", () => {
    const active = { origin: "https://coolify.example.test", targetServerName: "Target Server", ownerSubject: "owner", targetServerUuid: "server-target", apiToken: "synthetic" };
    expect(isActivated({ ownerSubject: "owner", targetServerUuid: "server-target" })).toBe(false);
    expect(isActivated(active)).toBe(true);
    expect(isActivated({ ...active, ownerSubject: "owner@example.test" })).toBe(false);
    expect(isActivated({ ...active, targetServerUuid: " " })).toBe(false);
    expect(isActivated({ ...active, apiToken: " " })).toBe(false);
    expect(isActivated({ ...active, origin: "https://coolify.example.invalid" })).toBe(false);
    expect(isSafeCoolifyOrigin("http://coolify.example.test")).toBe(false);
    expect(isSafeCoolifyOrigin("https://user:pass@coolify.example.test")).toBe(false);
    expect(isSafeCoolifyOrigin("https://coolify.example.test/arbitrary/path")).toBe(false);
    expect(isSafeCoolifyOrigin("https://coolify.example.test/?x=1")).toBe(false);
    expect(isSafeCoolifyOrigin("https://coolify.example.test:8443")).toBe(false);
    expect(readRuntimeConfig({})).toEqual({});
    expect(readRuntimeConfig({ COOLIFY_ORIGIN: "https://coolify.example.test", COOLIFY_TARGET_SERVER_NAME: "Target Server" })).toEqual({ origin: "https://coolify.example.test", targetServerName: "Target Server" });
  });
  it("requires the pinned UUID to resolve uniquely to the configured server name", async () => {
    const provider = new FakeCoolify();
    await expect(requirePinnedServer(provider, undefined, "Target Server")).rejects.toBeInstanceOf(ResourceScopeError);
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
    expect(() => safeDetails({ ...appTarget, server: undefined, server_uuid: undefined }, "application", "server-target")).toThrow();
    expect(serverUuidOf({ server: null })).toBeUndefined();
    expect(serverUuidOf({ server: { uuid: 123 }, server_uuid: "server-target" })).toBe("server-target");
    expect(uuidOf({ uuid: "" })).toBeUndefined();
  });

  it("bounds safe resource names and domains and drops non-string domain values", () => {
    const domains = [...Array.from({ length: 11 }, (_, index) => `https://host-${index}.example.test`), 42, null];
    const details = safeDetails({ ...appTarget, name: "n".repeat(350), fqdn: domains }, "application", "server-target");
    expect(details.name).toHaveLength(300);
    expect(details.fqdn).toHaveLength(10);
    expect(details.fqdn.every((value) => typeof value === "string")).toBe(true);
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
