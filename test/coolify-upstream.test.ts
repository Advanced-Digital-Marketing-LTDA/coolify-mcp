import { describe, expect, it } from "vitest";
import { coolifyMcpEndpoint, CoolifyMcpProvider, coolifyMcpConnectionOptions, listPublishedTools, type CoolifyToolClient, type PublishedTool, type ToolResult } from "../src/coolify.js";
import { PAGE_SIZE } from "../src/config.js";

class MockCoolifyTools implements CoolifyToolClient {
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  tools: PublishedTool[] = [
    listTool("list_servers"),
    listTool("list_applications"),
    listTool("list_databases"),
    listTool("list_services"),
    listTool("list_projects"),
    listTool("list_deployments", ["uuid"]),
    detailTool("get_application"), detailTool("get_database"), detailTool("get_service"), detailTool("get_project"),
    detailTool("get_server_resources"),
    { name: "list_env_keys", inputSchema: { type: "object", properties: { uuid: {}, resource: {} }, required: ["uuid", "resource"] } },
    { name: "deploy", inputSchema: { type: "object", properties: { uuid: {}, force: {} }, required: ["uuid"] } },
    { name: "control", inputSchema: { type: "object", properties: { uuid: {}, action: { enum: ["start", "stop", "restart"] }, resource: {} }, required: ["uuid", "action", "resource"] } },
  ];

  async listTools() { return this.tools; }
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    this.calls.push({ name, args });
    if (name === "list_applications" && args.page === 1) {
      return { structuredContent: { data: Array.from({ length: PAGE_SIZE }, (_, index) => ({ uuid: `app-${index}`, server: { uuid: "server-target" } })), _pagination: { page: 1, per_page: PAGE_SIZE, total: PAGE_SIZE + 1, total_pages: 2, next: { args: { server_uuid: "server-target", page: 2, per_page: 50 } } } } };
    }
    if (name === "list_applications" && args.page === 2) {
      return { structuredContent: { data: [{ uuid: "app-last", server: { uuid: "server-target" } }, { uuid: "app-0", server: { uuid: "server-target" } }], _pagination: { page: 2, per_page: 50, total: PAGE_SIZE + 1, total_pages: 2 } } };
    }
    if (name === "list_env_keys") return { structuredContent: { data: { resource: args.resource, uuid: args.uuid, keys: [{ key: "API_TOKEN" }, { key: "PUBLIC_URL" }] } } };
    if (name === "get_server_resources") return { structuredContent: { data: { server_uuid: args.uuid, resources: [] } } };
    if (name === "get_application") return { structuredContent: { data: { uuid: args.uuid, name: "Synthetic app", server: { uuid: "fixture-server" } } } };
    return { structuredContent: { data: { message: "synthetic-success" } } };
  }
}

const listTool = (name: string, required: string[] = ["page", "per_page"]): PublishedTool => ({
  name,
  inputSchema: { type: "object", properties: { page: {}, per_page: {}, uuid: {}, server_uuid: {}, environment_uuid: {}, project_uuid: {} }, required },
});
const detailTool = (name: string): PublishedTool => ({ name, inputSchema: { type: "object", properties: { uuid: {} }, required: ["uuid"] } });

describe("Coolify MCP upstream adapter", () => {
  it("uses the documented fixed Streamable HTTP endpoint", () => {
    expect(coolifyMcpEndpoint("https://coolify.example.test").href).toBe("https://coolify.example.test/mcp");
  });

  it("discovers every published upstream tool page and rejects repeated cursors or tool names", async () => {
    const pages = [
      { tools: [listTool("page-one-tool")], nextCursor: "cursor-2" },
      { tools: [listTool("page-two-tool")] },
    ];
    const cursors: Array<string | undefined> = [];
    const all = await listPublishedTools(async (cursor) => {
      cursors.push(cursor);
      return pages[cursors.length - 1]!;
    });
    expect(all.map((tool) => tool.name)).toEqual(["page-one-tool", "page-two-tool"]);
    expect(cursors).toEqual([undefined, "cursor-2"]);
    await expect(listPublishedTools(async () => ({ tools: [listTool("duplicate"), listTool("duplicate")] }))).rejects.toThrow("tool catalog");
    let repeatedCursorCalls = 0;
    await expect(listPublishedTools(async () => {
      repeatedCursorCalls += 1;
      return { tools: [listTool(`tool-${repeatedCursorCalls}`)], nextCursor: "same" };
    })).rejects.toThrow("tool pagination");
    expect(repeatedCursorCalls).toBe(2);
  });

  it("constructs a fixed-origin, token-only, redirect-blocked upstream connection without connecting", () => {
    expect(() => coolifyMcpConnectionOptions(undefined, "https://coolify.example.test")).toThrow("token is not configured");
    expect(() => coolifyMcpConnectionOptions("  ", "https://coolify.example.test")).toThrow("token is not configured");
    expect(() => coolifyMcpConnectionOptions("synthetic-token", "https://coolify.example.test/path")).toThrow("safe HTTPS Coolify origin");
    const connection = coolifyMcpConnectionOptions("synthetic-token", "https://coolify.example.test");
    expect(connection.url.href).toBe("https://coolify.example.test/mcp");
    expect(connection.options.requestInit.headers).toEqual({ Authorization: "Bearer synthetic-token", Accept: "application/json, text/event-stream" });
    expect(connection.options.requestInit.redirect).toBe("error");
    expect(connection.options.redirectPolicy).toBe("same-origin");
  });

  it("uses the pinned server filter and follows returned pagination args to exhaustion", async () => {
    const upstream = new MockCoolifyTools();
    const provider = new CoolifyMcpProvider(upstream);
    const rows = await (provider.listResources as (kind: "application", serverUuid: string) => Promise<Array<Record<string, unknown>>>) ("application", "server-target");
    expect(rows).toHaveLength(PAGE_SIZE + 1);
    expect(upstream.calls.map(({ name, args }) => ({ name, args }))).toEqual([
      { name: "list_applications", args: { server_uuid: "server-target", page: 1, per_page: PAGE_SIZE } },
      { name: "list_applications", args: { server_uuid: "server-target", page: 2, per_page: 50 } },
    ]);
  });

  it("maps a published application_uuid argument alias without forwarding arbitrary filters", async () => {
    const upstream = new MockCoolifyTools();
    upstream.tools = upstream.tools.map((tool) => tool.name === "list_deployments"
      ? { ...tool, inputSchema: { type: "object", properties: { application_uuid: {}, page: {}, per_page: {} }, required: ["application_uuid", "page", "per_page"] } }
      : tool);
    upstream.callTool = async (name, args) => {
      upstream.calls.push({ name, args });
      return { structuredContent: { data: [], _pagination: { page: 1, per_page: PAGE_SIZE, total_pages: 1 } } };
    };
    const provider = new CoolifyMcpProvider(upstream);
    await provider.listDeployments("app-synthetic");
    expect(upstream.calls[0]).toEqual({ name: "list_deployments", args: { application_uuid: "app-synthetic", page: 1, per_page: PAGE_SIZE } });
  });

  it("returns environment key names from the upstream key-only tool", async () => {
    const upstream = new MockCoolifyTools();
    const provider = new CoolifyMcpProvider(upstream);
    const keys = await provider.listEnvironmentKeys("application", "app-synthetic");
    expect(keys).toEqual([{ key: "API_TOKEN" }, { key: "PUBLIC_URL" }]);
    expect(upstream.calls).toEqual([{ name: "list_env_keys", args: { uuid: "app-synthetic", resource: "application" } }]);
  });

  it("derives project environment membership through fully paginated server-filtered resource lists", async () => {
    const upstream = new MockCoolifyTools();
    upstream.callTool = async (name, args) => {
      upstream.calls.push({ name, args });
      if (name === "get_project") return { structuredContent: { data: { uuid: args.uuid, environments: [
        { uuid: "env-app", name: "application env" },
        { uuid: "env-database", name: "database env" },
        { uuid: "env-off-target", name: "off target" },
      ] } } };
      const envUuid = args.environment_uuid;
      const items = (name === "list_applications" && envUuid === "env-app") || (name === "list_databases" && envUuid === "env-database")
        ? [{ uuid: `resource-${envUuid}` }]
        : [];
      return { structuredContent: { data: items, _pagination: { page: 1, per_page: PAGE_SIZE, total: items.length, total_pages: 1 } } };
    };
    const provider = new CoolifyMcpProvider(upstream);
    const environments = await (provider.getEnvironments as (projectUuid: string, serverUuid: string) => Promise<Array<Record<string, unknown>>>) ("project-a", "server-target");
    expect(environments).toEqual([
      { uuid: "env-app", name: "application env", server_uuid: "server-target" },
      { uuid: "env-database", name: "database env", server_uuid: "server-target" },
    ]);
    const listCalls = upstream.calls.filter(({ name }) => name.startsWith("list_"));
    expect(listCalls).toHaveLength(9);
    expect(listCalls.every(({ args }) => args.server_uuid === "server-target" && typeof args.environment_uuid === "string" && args.page === 1 && args.per_page === PAGE_SIZE)).toBe(true);
  });

  it("lists all resources for a server to detect additional application destinations", async () => {
    const upstream = new MockCoolifyTools();
    upstream.callTool = async (name, args) => {
      upstream.calls.push({ name, args });
      return { structuredContent: { data: { server_uuid: args.uuid, resources: [{ uuid: "app-synthetic", type: "application" }] } } };
    };
    const provider = new CoolifyMcpProvider(upstream);
    const rows = await (provider.listServerResources as (uuid: string) => Promise<Array<Record<string, unknown>>>) ("server-target");
    expect(rows).toEqual([{ uuid: "app-synthetic", type: "application" }]);
    expect(upstream.calls).toEqual([{ name: "get_server_resources", args: { uuid: "server-target" } }]);
  });

  it("fails closed when Coolify does not publish the required server filter or confirms another server", async () => {
    const upstream = new MockCoolifyTools();
    upstream.tools = upstream.tools.map((tool) => tool.name === "list_applications"
      ? { ...tool, inputSchema: { type: "object", properties: { page: {}, per_page: {} }, required: ["page", "per_page"] } }
      : tool);
    const provider = new CoolifyMcpProvider(upstream);
    await expect((provider.listResources as (kind: "application", serverUuid: string) => Promise<unknown>) ("application", "server-target"))
      .rejects.toThrow("does not support the required scope filters");
    expect(upstream.calls).toEqual([]);

    const mismatched = new MockCoolifyTools();
    mismatched.callTool = async (name, args) => {
      mismatched.calls.push({ name, args });
      return { structuredContent: { data: { server_uuid: "server-elsewhere", resources: [] } } };
    };
    await expect(new CoolifyMcpProvider(mismatched).listServerResources("server-target"))
      .rejects.toThrow("server-resource response shape");
  });

  it("does not request force, preview, stop, cancel, secret, or arbitrary operations", async () => {
    const upstream = new MockCoolifyTools();
    const provider = new CoolifyMcpProvider(upstream);
    await provider.deploy("app-synthetic");
    await provider.restart("service", "service-synthetic");
    expect(upstream.calls).toEqual([
      { name: "deploy", args: { uuid: "app-synthetic" } },
      { name: "control", args: { uuid: "service-synthetic", action: "restart", resource: "service" } },
    ]);
  });

  it("fails closed if an upstream tool disappears or its published schema changes", async () => {
    const upstream = new MockCoolifyTools();
    upstream.tools = upstream.tools.filter((tool) => tool.name !== "deploy");
    const provider = new CoolifyMcpProvider(upstream);
    await expect(provider.deploy("app-synthetic")).rejects.toThrow("unavailable");
    expect(upstream.calls).toEqual([]);
  });

  it("rejects a published operation schema that requires an unapproved argument", async () => {
    const upstream = new MockCoolifyTools();
    upstream.tools = upstream.tools.map((tool) => tool.name === "list_deployments"
      ? { ...tool, inputSchema: { type: "object", properties: { uuid: {}, shell: {} }, required: ["uuid", "shell"] } }
      : tool);
    const provider = new CoolifyMcpProvider(upstream);
    await expect(provider.listDeployments("app-synthetic")).rejects.toThrow("contract is not supported");
    expect(upstream.calls).toEqual([]);
  });

  it("rejects upstream pagination arguments that attempt to change filters or exceed the page limit", async () => {
    for (const nextArgs of [
      { page: 2, per_page: 50, origin: "https://attacker.invalid" },
      { page: 2, per_page: 50, server_uuid: "server-elsewhere" },
      { page: 2, per_page: PAGE_SIZE + 1 },
      { page: 1, per_page: 50 },
    ]) {
      const upstream = new MockCoolifyTools();
      upstream.callTool = async (name, args) => {
        upstream.calls.push({ name, args });
        return { structuredContent: { data: Array.from({ length: PAGE_SIZE }, (_, index) => ({ uuid: `row-${index}` })), _pagination: { next: { args: nextArgs } } } };
      };
      const provider = new CoolifyMcpProvider(upstream);
      await expect(provider.listServers()).rejects.toThrow("Invalid Coolify pagination response");
      expect(upstream.calls).toHaveLength(1);
    }
  });

  it("unwraps documented structured data without accepting text-only or malformed pages", async () => {
    const upstream = new MockCoolifyTools();
    upstream.callTool = async (name, args) => {
      upstream.calls.push({ name, args });
      return { content: [{ type: "text", text: "fake list" }] };
    };
    const provider = new CoolifyMcpProvider(upstream);
    await expect(provider.listServers()).rejects.toThrow("response shape");
  });

  it("does not echo upstream tool error text that may contain secrets", async () => {
    const upstream = new MockCoolifyTools();
    upstream.callTool = async () => ({ isError: true, content: [{ type: "text", text: "synthetic-secret-token" }] });
    const provider = new CoolifyMcpProvider(upstream);
    await expect(provider.listServers()).rejects.toThrow("Coolify MCP tool returned an error");
    await expect(provider.listServers()).rejects.not.toThrow("synthetic-secret-token");
  });
});
