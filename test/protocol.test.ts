import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createCoolifyMcpServer } from "../src/server.js";
import type { VerifiedIdentityProvider } from "../src/identity.js";
import { FakeCoolify, appTarget, otherServer, targetServer } from "./fixtures.js";

const ownerIdentity: VerifiedIdentityProvider = { resolve: async () => ({ subject: "owner-subject" }) };
const config = { origin: "https://coolify.example.test", targetServerName: "Target Server", ownerSubject: "owner-subject", targetServerUuid: "server-target", apiToken: "synthetic-token" };

type ElicitationAnswer = { action: "accept" | "decline" | "cancel"; confirmation?: string };

async function connect(provider = new FakeCoolify(), answer?: (phrase: string) => ElicitationAnswer) {
  const server = createCoolifyMcpServer({ config, identity: ownerIdentity, provider });
  const client = new Client({ name: "protocol-test-client", version: "1.0.0" }, { capabilities: { elicitation: { form: {} } } });
  const elicitationRequests: Array<{ params: { mode?: string; message: string; requestedSchema: unknown } }> = [];
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    elicitationRequests.push(request);
    const message = request.params.message;
    const phrase = message.match(/Type exactly: (.+)$/)?.[1] ?? "";
    const response = answer?.(phrase) ?? { action: "accept", confirmation: phrase };
    return { action: response.action, ...(response.confirmation === undefined ? {} : { content: { confirmation: response.confirmation } }) };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { server, client, provider, elicitationRequests };
}

afterEach(async () => {});

describe("published MCP protocol and schemas", () => {
  it("publishes the approved tools with valid input schemas and consequential annotations", async () => {
    const { client, server } = await connect();
    try {
      const listed = await client.listTools();
      const tools = new Map(listed.tools.map((tool) => [tool.name, tool]));
      expect([...tools.keys()].sort()).toEqual([
        "coolify_deploy_application",
        "coolify_deployment_history",
        "coolify_environment_key_names",
        "coolify_inventory",
        "coolify_resource_status",
        "coolify_restart_resource",
      ]);
      for (const name of ["coolify_deploy_application", "coolify_restart_resource"]) {
        expect(tools.get(name)?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
      }
      for (const name of ["coolify_inventory", "coolify_resource_status", "coolify_deployment_history", "coolify_environment_key_names"]) {
        expect(tools.get(name)?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
      }
      expect(tools.get("coolify_deploy_application")?.inputSchema.properties).toEqual({ applicationUuid: expect.any(Object) });
      expect(tools.get("coolify_restart_resource")?.inputSchema.properties).toEqual({ kind: expect.any(Object), uuid: expect.any(Object) });
      expect([...tools.keys()].some((name) => /delete|stop|cancel|force|tag|clone|preview|configuration_write/i.test(name))).toBe(false);
      expect(tools.get("coolify_inventory")?.outputSchema).toMatchObject({ properties: { server: expect.any(Object), resources: expect.any(Object), projects: expect.any(Object) } });
      expect(tools.get("coolify_resource_status")?.outputSchema).toMatchObject({
        properties: {
          uuid: { type: "string" },
          kind: expect.any(Object),
          environments: expect.any(Object),
        },
      });
      expect(tools.get("coolify_environment_key_names")?.outputSchema).toMatchObject({ properties: { uuid: expect.any(Object), keys: expect.any(Object) } });
      expect(tools.get("coolify_deploy_application")?.outputSchema).toMatchObject({ properties: { accepted: { type: "boolean" }, message: { type: "string" } } });
      expect(tools.get("coolify_restart_resource")?.outputSchema).toMatchObject({ properties: { accepted: { type: "boolean" }, message: { type: "string" } } });
      expect(tools.get("coolify_deployment_history")?.outputSchema).toMatchObject({ properties: { applicationUuid: { type: "string" }, deployments: expect.any(Object) } });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("filters inventory, projects, and environments to the pinned server after full provider reads", async () => {
    const provider = new FakeCoolify();
    provider.collections.application.push({ uuid: "app-outside", name: "Outside", server: { uuid: "server-elsewhere" }, status: "running" });
    const { client, server } = await connect(provider);
    try {
      const result = await client.callTool({ name: "coolify_inventory", arguments: {} });
      const data = result.structuredContent as { resources: Array<{ uuid: string }>; projects: Array<{ environments: Array<{ uuid: string }> }> };
      expect(data.resources.map((item) => item.uuid)).toEqual(["app-alpha", "db-alpha", "service-alpha"]);
      expect(data.projects).toEqual([{ uuid: "project-web", name: "Website", environments: [{ uuid: "env-prod", name: "production" }] }]);
      expect(JSON.stringify(result)).not.toContain("db-outside");
      expect(JSON.stringify(result)).not.toContain("service-outside");
      expect(JSON.stringify(result)).not.toContain("env-staging");
      expect(JSON.stringify(result)).not.toContain("env-unknown");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("does not leak raw resource secrets, environment values, deployment logs, or other-app deployments", async () => {
    const provider = new FakeCoolify();
    provider.envs.push({ key: "BAD KEY", value: "synthetic-invalid-key-value" }, { key: "PUBLIC_URL", value: "synthetic-duplicate" });
    const { client, server } = await connect(provider);
    try {
      const details = await client.callTool({ name: "coolify_resource_status", arguments: { kind: "application", uuid: "app-alpha" } });
      expect(JSON.stringify(details)).not.toContain("never-return");
      const keys = await client.callTool({ name: "coolify_environment_key_names", arguments: { kind: "application", uuid: "app-alpha" } });
      expect(keys.structuredContent).toEqual({ uuid: "app-alpha", keys: ["DATABASE_PASSWORD", "PUBLIC_URL"] });
      expect(JSON.stringify(keys)).not.toContain("fixture-secret-value");
      expect(JSON.stringify(keys)).not.toContain("synthetic-invalid-key-value");
      const history = await client.callTool({ name: "coolify_deployment_history", arguments: { applicationUuid: "app-alpha" } });
      expect(JSON.stringify(history)).toContain("deploy-1");
      expect(JSON.stringify(history)).not.toContain("fixture-private-log");
      expect(JSON.stringify(history)).not.toContain("deploy-other");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("filters project status environments to the current target membership", async () => {
    const { client, server } = await connect();
    try {
      const status = await client.callTool({ name: "coolify_resource_status", arguments: { kind: "project", uuid: "project-web" } });
      expect(status.isError).toBeUndefined();
      expect(status.structuredContent).toEqual({ uuid: "project-web", name: "Website", kind: "project", environments: [{ uuid: "env-prod", name: "production" }] });
      expect(JSON.stringify(status)).not.toContain("env-staging");
      expect(JSON.stringify(status)).not.toContain("env-unknown");
      const missing = await client.callTool({ name: "coolify_resource_status", arguments: { kind: "project", uuid: "project-missing" } });
      expect(missing.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("does not return project status when no environment belongs to the pinned server", async () => {
    const provider = new FakeCoolify();
    provider.environments["project-web"] = [{ uuid: "env-staging", name: "staging", server: otherServer }];
    const { client, server } = await connect(provider);
    try {
      const status = await client.callTool({ name: "coolify_resource_status", arguments: { kind: "project", uuid: "project-web" } });
      expect(status.isError).toBe(true);
      expect(JSON.stringify(status)).not.toContain("env-staging");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects arbitrary path-like resource identifiers before provider reads", async () => {
    const provider = new FakeCoolify();
    const { client, server } = await connect(provider);
    try {
      const result = await client.callTool({ name: "coolify_resource_status", arguments: { kind: "application", uuid: "app-alpha/../../secret" } as never });
      expect(result.isError).toBe(true);
      expect(provider.resourceReads).toBe(0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("requires a user elicitation, accepts exact deploy and restart phrases, and rejects boolean approval args", async () => {
    const provider = new FakeCoolify();
    const { client, server, elicitationRequests } = await connect(provider);
    try {
      const result = await client.callTool({ name: "coolify_deploy_application", arguments: { applicationUuid: "app-alpha" } });
      expect(result.structuredContent).toMatchObject({ accepted: true });
      expect(JSON.stringify(result)).not.toContain("must-not-return");
      expect(JSON.stringify(result)).not.toContain("queued");
      expect(provider.writes).toEqual(["deploy:app-alpha"]);
      expect(elicitationRequests[0]?.params).toMatchObject({
        mode: "form",
        message: "Confirm deploy for Alpha (app-alpha). Type exactly: DEPLOY Alpha (app-alpha)",
        requestedSchema: { type: "object", required: ["confirmation"], properties: { confirmation: { type: "string" } } },
      });
      const denied = await client.callTool({ name: "coolify_restart_resource", arguments: { kind: "application", uuid: "app-alpha", confirmed: true } as never });
      expect(denied.isError).toBe(true);
      expect(provider.writes).toHaveLength(1);
      const restarted = await client.callTool({ name: "coolify_restart_resource", arguments: { kind: "application", uuid: "app-alpha" } });
      expect(restarted.structuredContent).toMatchObject({ accepted: true });
      expect(provider.writes).toEqual(["deploy:app-alpha", "restart:application:app-alpha"]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("does not write when the owner declines or supplies a mismatched confirmation phrase", async () => {
    for (const action of ["deploy", "restart"] as const) {
      for (const answer of [
        (_phrase: string) => ({ action: "decline" as const, confirmation: `${action.toUpperCase()} Alpha (app-alpha)` }),
        (_phrase: string) => ({ action: "accept" as const, confirmation: `${action.toUpperCase()} other (app-alpha)` }),
      ]) {
        const provider = new FakeCoolify();
        const { client, server } = await connect(provider, answer);
        try {
          const toolName = action === "deploy" ? "coolify_deploy_application" : "coolify_restart_resource";
          const arguments_ = action === "deploy" ? { applicationUuid: "app-alpha" } : { kind: "application", uuid: "app-alpha" };
          const result = await client.callTool({ name: toolName, arguments: arguments_ });
          expect(result.structuredContent).toMatchObject({ accepted: false });
          expect(provider.writes).toEqual([]);
        } finally {
          await client.close();
          await server.close();
        }
      }
    }
  });

  it("blocks writes to a resource whose current server membership is off target", async () => {
    const provider = new FakeCoolify();
    provider.collections.application[0] = { ...appTarget, server: otherServer };
    const { client, server, elicitationRequests } = await connect(provider);
    try {
      const result = await client.callTool({ name: "coolify_deploy_application", arguments: { applicationUuid: "app-alpha" } });
      expect(result.isError).toBe(true);
      expect(provider.writes).toEqual([]);
      expect(elicitationRequests).toHaveLength(0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("denies a non-owner before reading any Coolify resources", async () => {
    const provider = new FakeCoolify();
    const server = createCoolifyMcpServer({ config, identity: { resolve: async () => ({ subject: "other-owner" }) }, provider });
    const client = new Client({ name: "identity-denial-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const result = await client.callTool({ name: "coolify_inventory", arguments: {} });
      expect(result.isError).toBe(true);
      expect(provider.resourceReads).toBe(0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rechecks current membership immediately before each confirmed write", async () => {
    for (const action of ["deploy", "restart"] as const) {
      const provider = new FakeCoolify();
      provider.onResourceRead = (_kind, uuid) => provider.resourceReads > 1 ? { ...appTarget, uuid, server: otherServer } : undefined;
      const { client, server } = await connect(provider);
      try {
        const toolName = action === "deploy" ? "coolify_deploy_application" : "coolify_restart_resource";
        const arguments_ = action === "deploy" ? { applicationUuid: "app-alpha" } : { kind: "application", uuid: "app-alpha" };
        const result = await client.callTool({ name: toolName, arguments: arguments_ });
        expect(result.isError).toBe(true);
        expect(provider.writes).toEqual([]);
        expect(JSON.stringify(result)).not.toContain("server-elsewhere");
      } finally {
        await client.close();
        await server.close();
      }
    }
  });

  it("blocks unconfigured UUID and target-name mismatches before listing resources", async () => {
    const noUuid = { ownerSubject: config.ownerSubject, apiToken: config.apiToken };
    const provider = new FakeCoolify();
    const server = createCoolifyMcpServer({ config: noUuid, identity: ownerIdentity, provider });
    const client = new Client({ name: "gate-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const result = await client.callTool({ name: "coolify_inventory", arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("must be configured");
      expect(provider.resourceReads).toBe(0);
    } finally { await client.close(); await server.close(); }

    provider.servers = [{ ...targetServer, name: "Renamed server" }];
    const mismatch = await connect(provider);
    try {
      const result = await mismatch.client.callTool({ name: "coolify_inventory", arguments: {} });
      expect(result.isError).toBe(true);
      expect(provider.resourceReads).toBe(0);
    } finally { await mismatch.client.close(); await mismatch.server.close(); }
  });

  it("redacts provider errors and does not return error details", async () => {
    const provider = new FakeCoolify();
    provider.failWith = new Error("synthetic-secret-token from upstream");
    const { client, server } = await connect(provider);
    try {
      const result = await client.callTool({ name: "coolify_inventory", arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("synthetic-secret-token");
      expect(JSON.stringify(result)).toContain("details were withheld");
    } finally { await client.close(); await server.close(); }
  });
});
