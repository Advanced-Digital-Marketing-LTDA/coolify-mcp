import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isSafeCoolifyOrigin, MAX_PAGES, PAGE_SIZE } from "./config.js";
import { NotConfiguredError } from "./errors.js";

export function coolifyMcpEndpoint(origin: string | undefined): URL {
  if (!isSafeCoolifyOrigin(origin)) throw new NotConfiguredError("A safe HTTPS Coolify origin is not configured");
  return new URL("/mcp", origin);
}
export type ResourceKind = "application" | "database" | "service" | "project";
export type ApiRecord = Record<string, unknown>;

const LIST_TOOLS: Readonly<Record<ResourceKind | "server", string>> = Object.freeze({
  server: "list_servers",
  application: "list_applications",
  database: "list_databases",
  service: "list_services",
  project: "list_projects",
});

const DETAIL_TOOLS: Readonly<Record<ResourceKind, string>> = Object.freeze({
  application: "get_application",
  database: "get_database",
  service: "get_service",
  project: "get_project",
});

export type PublishedTool = Readonly<{ name: string; inputSchema: Record<string, unknown> }>;
export type ToolResult = Readonly<{ structuredContent?: unknown | undefined; isError?: boolean | undefined; content?: readonly unknown[] | undefined }>;

export function coolifyMcpConnectionOptions(token: string | undefined, origin: string | undefined): {
  url: URL;
  options: {
    requestInit: RequestInit;
    redirectPolicy: "same-origin";
  };
} {
  if (!token?.trim()) throw new NotConfiguredError("Coolify MCP token is not configured");
  return {
    url: coolifyMcpEndpoint(origin),
    options: {
      requestInit: {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream" },
        redirect: "error",
      },
      redirectPolicy: "same-origin",
    },
  };
}

export interface CoolifyToolClient {
  listTools(): Promise<readonly PublishedTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

export interface CoolifyProvider {
  listServers(): Promise<ApiRecord[]>;
  listResources(kind: ResourceKind, serverUuid?: string, environmentUuid?: string): Promise<ApiRecord[]>;
  getResource(kind: ResourceKind, uuid: string): Promise<ApiRecord>;
  getEnvironments(projectUuid: string, serverUuid: string): Promise<ApiRecord[]>;
  listServerResources(serverUuid: string): Promise<ApiRecord[]>;
  listDeployments(applicationUuid: string): Promise<ApiRecord[]>;
  listEnvironmentKeys(kind: Exclude<ResourceKind, "project">, uuid: string): Promise<ApiRecord[]>;
  deploy(applicationUuid: string): Promise<ApiRecord>;
  restart(kind: Exclude<ResourceKind, "project">, uuid: string): Promise<ApiRecord>;
}

export async function listPublishedTools(
  listPage: (cursor?: string) => Promise<{ tools: readonly PublishedTool[]; nextCursor?: string }>,
): Promise<readonly PublishedTool[]> {
  const tools: PublishedTool[] = [];
  const cursors = new Set<string>();
  const names = new Set<string>();
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const page = await listPage(cursor);
    for (const tool of page.tools) {
      if (!tool.name || names.has(tool.name)) throw new Error("Invalid Coolify MCP tool catalog");
      names.add(tool.name);
      tools.push(tool);
    }
    if (!page.nextCursor) return tools;
    if (cursors.has(page.nextCursor)) throw new Error("Invalid Coolify MCP tool pagination");
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error("Coolify MCP tool pagination limit exceeded");
}

export class UnconfiguredCoolifyProvider implements CoolifyProvider {
  private unavailable(): never { throw new NotConfiguredError("Coolify MCP provider is not configured"); }
  async listServers(): Promise<ApiRecord[]> { return this.unavailable(); }
  async listResources(_kind: ResourceKind, _serverUuid?: string, _environmentUuid?: string): Promise<ApiRecord[]> { return this.unavailable(); }
  async getResource(_kind: ResourceKind, _uuid: string): Promise<ApiRecord> { return this.unavailable(); }
  async getEnvironments(_projectUuid: string, _serverUuid: string): Promise<ApiRecord[]> { return this.unavailable(); }
  async listServerResources(_serverUuid: string): Promise<ApiRecord[]> { return this.unavailable(); }
  async listDeployments(_applicationUuid: string): Promise<ApiRecord[]> { return this.unavailable(); }
  async listEnvironmentKeys(_kind: Exclude<ResourceKind, "project">, _uuid: string): Promise<ApiRecord[]> { return this.unavailable(); }
  async deploy(_applicationUuid: string): Promise<ApiRecord> { return this.unavailable(); }
  async restart(_kind: Exclude<ResourceKind, "project">, _uuid: string): Promise<ApiRecord> { return this.unavailable(); }
}

/**
 * The upstream contract is Coolify's documented Streamable HTTP MCP server,
 * not a guessed REST route adapter. Runtime tool schemas are checked before
 * each call so an upstream contract change fails closed.
 */
export class CoolifyMcpProvider implements CoolifyProvider {
  private toolsPromise?: Promise<readonly PublishedTool[]>;

  constructor(private readonly client: CoolifyToolClient) {}

  static async connect(token: string | undefined, origin: string | undefined): Promise<{ provider: CoolifyMcpProvider; close: () => Promise<void> }> {
    const connection = coolifyMcpConnectionOptions(token, origin);
    const client = new Client({ name: "coolify-mcp-foundation", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(connection.url, connection.options);
    await client.connect(transport as unknown as Transport);
    const bridge: CoolifyToolClient = {
      listTools: async () => listPublishedTools(async (cursor) => {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        return { tools: page.tools, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
      }),
      callTool: async (name, args) => await client.callTool({ name, arguments: args }) as ToolResult,
    };
    return { provider: new CoolifyMcpProvider(bridge), close: () => client.close() };
  }

  listServers(): Promise<ApiRecord[]> {
    return this.listAll(LIST_TOOLS.server);
  }

  async listResources(kind: ResourceKind, serverUuid?: string, environmentUuid?: string): Promise<ApiRecord[]> {
    const tool = LIST_TOOLS[kind];
    if (kind === "project") return this.listAll(tool);
    if (!serverUuid?.trim()) throw new Error("A pinned server filter is required for resource lists");
    const values: Record<string, readonly unknown[]> = { server_uuid: [serverUuid] };
    if (environmentUuid !== undefined) values.environment_uuid = [environmentUuid];
    const args = await this.semanticArgs(tool, values, true);
    if (args.server_uuid !== serverUuid || (environmentUuid !== undefined && args.environment_uuid !== environmentUuid)) {
      throw new Error("Coolify resource list does not support the required scope filters");
    }
    const rows = await this.listAll(tool, args);
    for (const row of rows) {
      const observedServer = resourceServerUuid(row);
      if (observedServer !== undefined && observedServer !== serverUuid) throw new Error("Coolify returned a resource outside the requested server filter");
    }
    return rows;
  }

  async getResource(kind: ResourceKind, uuid: string): Promise<ApiRecord> {
    const result = await this.call(DETAIL_TOOLS[kind], { uuid });
    return asRecord(result);
  }

  async getEnvironments(projectUuid: string, serverUuid: string): Promise<ApiRecord[]> {
    const project = await this.getResource("project", projectUuid);
    if (!Array.isArray(project.environments)) throw new Error("Unexpected Coolify MCP project response shape");
    const environments = project.environments.map(asRecord);
    const scoped: ApiRecord[] = [];
    for (const environment of environments) {
      const uuid = uuidOfRecord(environment.uuid);
      if (!uuid) continue;
      const lists = await Promise.all(([
        "application", "database", "service",
      ] as const).map((kind) => this.listResources(kind, serverUuid, uuid)));
      if (lists.some((rows) => rows.length > 0)) scoped.push({ ...environment, server_uuid: serverUuid });
    }
    return scoped;
  }

  async listServerResources(serverUuid: string): Promise<ApiRecord[]> {
    const result = await this.call("get_server_resources", { uuid: serverUuid });
    const envelope = asRecord(result);
    if (envelope.server_uuid !== serverUuid || !Array.isArray(envelope.resources)) {
      throw new Error("Unexpected Coolify server-resource response shape");
    }
    return envelope.resources.map(asRecord);
  }

  async listDeployments(applicationUuid: string): Promise<ApiRecord[]> {
    const filters = await this.semanticArgs("list_deployments", {
      uuid: [applicationUuid],
      application_uuid: [applicationUuid],
      resource_uuid: [applicationUuid],
    }, true);
    return this.listAll("list_deployments", filters);
  }

  async listEnvironmentKeys(kind: Exclude<ResourceKind, "project">, uuid: string): Promise<ApiRecord[]> {
    const tool = "list_env_keys";
    const args = await this.semanticArgs(tool, {
      uuid: [uuid],
      resource: [kind],
    });
    const result = await this.call(tool, args);
    const envelope = asRecord(result);
    if (envelope.uuid !== uuid || envelope.resource !== kind || !Array.isArray(envelope.keys)) {
      throw new Error("Unexpected Coolify MCP environment-key response shape");
    }
    return envelope.keys.map(asRecord);
  }

  async deploy(applicationUuid: string): Promise<ApiRecord> {
    const result = await this.call("deploy", { uuid: applicationUuid });
    return asRecord(result);
  }

  async restart(kind: Exclude<ResourceKind, "project">, uuid: string): Promise<ApiRecord> {
    const args = await this.semanticArgs("control", {
      uuid: [uuid],
      action: ["restart"],
      resource: [kind],
    });
    const result = await this.call("control", args);
    return asRecord(result);
  }

  private async listAll(tool: string, filters: Record<string, unknown> = {}): Promise<ApiRecord[]> {
    const records: ApiRecord[] = [];
    const seen = new Set<string>();
    let args: Record<string, unknown> = { ...filters, page: 1, per_page: PAGE_SIZE };
    for (let count = 0; count < MAX_PAGES; count += 1) {
      const result = await this.call(tool, args, true);
      const page = unpackPage(result);
      for (const item of page.items) {
        const key = typeof item.uuid === "string" ? item.uuid : JSON.stringify(item);
        if (!seen.has(key)) {
          seen.add(key);
          records.push(item);
        }
      }
      if (page.nextArgs) {
        const currentPage = typeof args.page === "number" ? args.page : 1;
        args = { ...filters, ...safePaginationArgs(page.nextArgs, currentPage, filters) };
        continue;
      }
      if (page.totalPages !== undefined) {
        const currentPage = typeof args.page === "number" ? args.page : 1;
        if (currentPage >= page.totalPages) return records;
        args = { ...args, page: currentPage + 1 };
        continue;
      }
      if (page.items.length < PAGE_SIZE) return records;
      args = { ...args, page: (typeof args.page === "number" ? args.page : 1) + 1 };
    }
    throw new Error("Coolify pagination limit exceeded");
  }

  private async semanticArgs(toolName: string, values: Record<string, readonly unknown[]>, paginated = false): Promise<Record<string, unknown>> {
    const tool = await this.findTool(toolName);
    const properties = asRecord(tool.inputSchema.properties);
    const required = Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required.filter((value): value is string => typeof value === "string") : [];
    const args: Record<string, unknown> = {};
    for (const key of required) {
      if (paginated && (key === "page" || key === "per_page")) continue;
      const candidates = values[key];
      if (candidates?.length) {
        args[key] = candidates[0];
        continue;
      }
      const alias = aliasFor(key, values);
      if (!alias || !properties[key]) throw new Error("Coolify tool contract is not supported by this foundation");
      args[key] = values[alias]?.[0];
    }
    const semanticGroups = [
      ["uuid", "application_uuid", "resource_uuid"],
      ["resource", "resource_type", "type", "kind"],
      ["server_uuid"],
      ["environment_uuid"],
      ["action"],
    ];
    for (const group of semanticGroups) {
      const key = group.find((candidate) => properties[candidate] && values[candidate]?.length && !(candidate in args));
      if (key) args[key] = values[key]?.[0];
    }
    return args;
  }

  private async call(name: string, args: Record<string, unknown>, preserveEnvelope = false): Promise<unknown> {
    const tool = await this.findTool(name);
    const properties = asRecord(tool.inputSchema.properties);
    const required = Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required : [];
    for (const key of Object.keys(args)) {
      if (!properties[key]) throw new Error("Coolify tool contract is not supported by this foundation");
    }
    for (const key of required) {
      if (typeof key === "string" && !(key in args)) throw new Error("Coolify tool contract is not supported by this foundation");
    }
    const response = await this.client.callTool(name, args);
    if (response.isError) throw new Error("Coolify MCP tool returned an error");
    const payload = response.structuredContent !== undefined
      ? response.structuredContent
      : parseTextJsonContent(response.content);
    return preserveEnvelope ? payload : unwrapStructured(payload);
  }

  private async findTool(name: string): Promise<PublishedTool> {
    this.toolsPromise ??= this.client.listTools();
    const tools = await this.toolsPromise;
    const found = tools.filter((tool) => tool.name === name);
    if (found.length !== 1 || !found[0]) throw new Error("Required Coolify MCP tool is unavailable");
    return found[0];
  }
}

function aliasFor(key: string, values: Record<string, readonly unknown[]>): string | undefined {
  const aliases: Record<string, string[]> = {
    uuid: ["uuid", "application_uuid", "resource_uuid"],
    application_uuid: ["application_uuid", "uuid"],
    resource_uuid: ["resource_uuid", "uuid"],
    action: ["action"],
    resource: ["resource", "resource_type", "type", "kind"],
    type: ["type", "resource", "resource_type", "kind"],
    resource_type: ["resource_type", "resource", "type", "kind"],
    kind: ["kind", "resource", "resource_type", "type"],
  };
  return (aliases[key] ?? []).find((candidate) => values[candidate]?.length);
}

function unpackPage(value: unknown): { items: ApiRecord[]; totalPages?: number; nextArgs?: Record<string, unknown> } {
  const root = asRecord(value);
  const data = Array.isArray(root.data) ? root.data : Array.isArray(root.items) ? root.items : undefined;
  if (!data) throw new Error("Unexpected Coolify MCP list response shape");
  const pagination = root._pagination && typeof root._pagination === "object" ? asRecord(root._pagination) : undefined;
  const pages = pagination?.total_pages;
  const next = pagination?.next && typeof pagination.next === "object" ? asRecord(pagination.next) : undefined;
  const nextArgs = next?.args && typeof next.args === "object" ? asRecord(next.args) : undefined;
  return {
    items: data.map(asRecord),
    ...(typeof pages === "number" ? { totalPages: pages } : {}),
    ...(nextArgs ? { nextArgs } : {}),
  };
}

function safePaginationArgs(args: Record<string, unknown>, currentPage: number, filters: Record<string, unknown>): { page: number; per_page: number } {
  if (Object.entries(args).some(([key, value]) =>
    key !== "page" && key !== "per_page" && (!(key in filters) || filters[key] !== value))) {
    throw new Error("Invalid Coolify pagination response");
  }
  const page = args.page;
  const perPage = args.per_page;
  if (typeof page !== "number" || !Number.isSafeInteger(page) || page <= currentPage) {
    throw new Error("Invalid Coolify pagination response");
  }
  if (typeof perPage !== "number" || !Number.isSafeInteger(perPage) || perPage < 1 || perPage > PAGE_SIZE) {
    throw new Error("Invalid Coolify pagination response");
  }
  return { page, per_page: perPage };
}


function parseTextJsonContent(content: readonly unknown[] | undefined): unknown {
  if (!content || content.length !== 1) throw new Error("Unexpected Coolify MCP response shape");
  const item = asRecord(content[0]);
  if (item.type !== "text" || typeof item.text !== "string") throw new Error("Unexpected Coolify MCP response shape");
  try {
    return JSON.parse(item.text) as unknown;
  } catch {
    throw new Error("Unexpected Coolify MCP response shape");
  }
}

function unwrapStructured(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const root = asRecord(value);
  if ("data" in root && !("_pagination" in root)) return root.data;
  return root;
}

function asRecord(value: unknown): ApiRecord {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as ApiRecord;
  throw new Error("Unexpected Coolify MCP response shape");
}

function uuidOfRecord(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resourceServerUuid(value: ApiRecord): string | undefined {
  const server = value.server;
  if (server && typeof server === "object" && typeof (server as ApiRecord).uuid === "string") return (server as ApiRecord).uuid as string;
  for (const key of ["server_uuid", "serverUuid"]) if (typeof value[key] === "string") return value[key] as string;
  return undefined;
}
