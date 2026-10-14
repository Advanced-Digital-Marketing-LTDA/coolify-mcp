import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CoolifyApplicationConfigWriter } from "../src/coolify-rest.js";
import { httpFixture, publicOrigin, resource } from "./http-fixture.js";

let fixture: Awaited<ReturnType<typeof httpFixture>> | undefined;
const clients: Client[] = [];
const writeCases = [
  { tool: "coolify_deploy_application", args: { applicationUuid: "app-alpha" }, finalRead: 2 },
  { tool: "coolify_restart_resource", args: { kind: "application", uuid: "app-alpha" }, finalRead: 2 },
  { tool: "coolify_update_application_configuration", args: { applicationUuid: "app-alpha", field: "description", value: "Invalidated at last check" }, finalRead: 3 },
];
afterEach(async () => { for (const client of clients.splice(0)) await client.close(); await fixture?.close(); fixture = undefined; vi.restoreAllMocks(); });
async function connect(token: string, answer?: (message: string, id: string | number) => Promise<{ action: "accept" | "decline" | "cancel"; content?: { confirmation: string } }>) {
  const client = new Client({ name: "real-http-fixture", version: "1" }, { capabilities: { elicitation: { form: {} } } });
  clients.push(client);
  client.setRequestHandler(ElicitRequestSchema, (request, extra) => answer ? answer(request.params.message, extra.requestId) : Promise.resolve({ action: "accept", content: { confirmation: request.params.message.split("Type exactly: ")[1]! } }));
  const headers = { Authorization: `Bearer ${token}` };
  const transport = new StreamableHTTPClientTransport(new URL(resource), { requestInit: { headers } });
  await client.connect(transport);
  return { client, transport, headers };
}

describe("hosted MCP over real HTTP", () => {
  it("routes initialization and elicitation replies across HTTP requests before sending a single-field authenticated upstream write", async () => {
    fixture = await httpFixture();
    const { tokens } = await fixture.login();
    const { client, transport } = await connect(tokens.access_token);
    expect(transport.sessionId).toEqual(expect.any(String));
    const result = await client.callTool({ name: "coolify_update_application_configuration", arguments: { applicationUuid: "app-alpha", field: "description", value: "Approved change" } });
    expect(result.structuredContent).toMatchObject({ accepted: true, applicationUuid: "app-alpha", field: "description" });
    expect(fixture.writes).toEqual([{ uuid: "app-alpha", body: { description: "Approved change" }, authorization: "Bearer synthetic-team-token" }]);
    expect(JSON.stringify(fixture.writes)).not.toContain(tokens.access_token);
  });

  it("rejects an unexpected Host or Origin before OAuth or MCP routing", async () => {
    fixture = await httpFixture();
    for (const path of ["/.well-known/oauth-authorization-server", "/mcp", "/register"]) {
      for (const headers of [{ Host: "attacker.example.test" }, { Origin: "https://attacker.example.test" }, { Origin: "null" }]) {
        const response = await fixture.request(path, { headers });
        expect(response.status).toBe(403);
        expect(await response.text()).not.toContain("attacker.example.test");
      }
    }
  });

  it("bounds incoming JSON and returns fixed errors without echoing malformed sensitive payloads", async () => {
    fixture = await httpFixture();
    for (const [body, status] of [['{"fixture-private-payload":"fixture-secret-value", invalid', 400], [JSON.stringify({ value: "x".repeat(65_536) }), 413]] as const) {
      const response = await fixture.request("/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: "Request could not be processed" });
    }
  });

  it("requires initialization, scopes each session to its authenticated client, and terminates deleted sessions", async () => {
    fixture = await httpFixture();
    const first = await fixture.login("first"), second = await fixture.login("second");
    const { client, transport } = await connect(first.tokens.access_token);
    const headers = { Authorization: `Bearer ${second.tokens.access_token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json", "Mcp-Protocol-Version": "2025-11-25", "Mcp-Session-Id": transport.sessionId! };
    for (const method of ["POST", "GET", "DELETE"]) {
      const response = await fixture.request("/mcp", { method, headers, ...(method === "POST" ? { body: JSON.stringify({ jsonrpc: "2.0", id: 88, method: "tools/list", params: {} }) } : {}) });
      expect(response.status).toBe(404);
    }
    const noSession = await fixture.request("/mcp", { method: "POST", headers: { ...headers, "Mcp-Session-Id": "" }, body: JSON.stringify({ jsonrpc: "2.0", id: 89, method: "tools/list" }) });
    expect(noSession.status).toBe(400);
    expect((await client.listTools()).tools).toHaveLength(8);
    const session = transport.sessionId!;
    await transport.terminateSession();
    const deleted = await fixture.request("/mcp", { headers: { ...headers, Authorization: `Bearer ${first.tokens.access_token}`, "Mcp-Session-Id": session } });
    expect(deleted.status).toBe(404);
  });

  it("keeps pending confirmations isolated between sessions even when another session submits the response ID", async () => {
    fixture = await httpFixture();
    const { tokens } = await fixture.login();
    let answer!: (value: { action: "accept"; content: { confirmation: string } }) => void;
    let prompt!: (value: { message: string; id: string | number }) => void;
    const prompted = new Promise<{ message: string; id: string | number }>((resolve) => { prompt = resolve; });
    const a = await connect(tokens.access_token, (message, id) => { prompt({ message, id }); return new Promise((resolve) => { answer = resolve; }); });
    const b = await connect(tokens.access_token);
    const pending = a.client.callTool({ name: "coolify_update_application_configuration", arguments: { applicationUuid: "app-alpha", field: "description", value: "Isolated change" } });
    const { message, id } = await prompted;
    const response = await fixture.request("/mcp", { method: "POST", headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json", "Mcp-Protocol-Version": "2025-11-25", "Mcp-Session-Id": b.transport.sessionId! }, body: JSON.stringify({ jsonrpc: "2.0", id, result: { action: "accept", content: { confirmation: message.split("Type exactly: ")[1]! } } }) });
    expect(response.status).toBe(202);
    await a.client.listTools();
    expect(fixture.writes).toEqual([]);
    answer({ action: "accept", content: { confirmation: message.split("Type exactly: ")[1]! } });
    expect((await pending).structuredContent).toMatchObject({ accepted: true });
    expect(fixture.writes).toHaveLength(1);
  });

  it("round trips deploy and restart confirmations and denies an inexact configuration approval", async () => {
    fixture = await httpFixture();
    const { tokens } = await fixture.login();
    const accepted = await connect(tokens.access_token);
    expect((await accepted.client.callTool({ name: "coolify_deploy_application", arguments: { applicationUuid: "app-alpha" } })).structuredContent).toMatchObject({ accepted: true });
    expect((await accepted.client.callTool({ name: "coolify_restart_resource", arguments: { kind: "application", uuid: "app-alpha" } })).structuredContent).toMatchObject({ accepted: true });
    expect(fixture.provider.writes).toEqual(["deploy:app-alpha", "restart:application:app-alpha"]);
    const rejected = await connect(tokens.access_token, async () => ({ action: "accept", content: { confirmation: "approved" } }));
    expect((await rejected.client.callTool({ name: "coolify_update_application_configuration", arguments: { applicationUuid: "app-alpha", field: "description", value: "Wrong approval" } })).structuredContent).toMatchObject({ accepted: false });
    expect(fixture.writes).toEqual([]);
  });

  it.each(["uuid", "server"])("rejects inconsistent %s evidence on the final configuration read", async (changed) => {
    fixture = await httpFixture();
    const { tokens } = await fixture.login();
    const { client } = await connect(tokens.access_token);
    const original = fixture.provider.getResource.bind(fixture.provider);
    vi.spyOn(fixture.provider, "getResource").mockImplementation(async (kind, uuid) => {
      const row = await original(kind, uuid);
      return fixture!.provider.resourceReads === 3 ? { ...row, ...(changed === "uuid" ? { uuid: "app-other" } : { server_uuid: "server-elsewhere" }) } : row;
    });
    const result = await client.callTool({ name: "coolify_update_application_configuration", arguments: { applicationUuid: "app-alpha", field: "description", value: "Unsafe mismatch" } });
    expect(result.isError).toBe(true);
    expect(fixture.writes).toEqual([]);
  });

  it("writes the documented top-level health-check boolean and excludes settings absent from the MCP detail contract", async () => {
    fixture = await httpFixture();
    const { tokens } = await fixture.login();
    const { client } = await connect(tokens.access_token);
    const result = await client.callTool({ name: "coolify_update_application_configuration", arguments: { applicationUuid: "app-alpha", field: "health_check_enabled", value: false } });
    expect(result.structuredContent).toMatchObject({ accepted: true });
    expect(fixture.writes.at(-1)?.body).toEqual({ health_check_enabled: false });
    const tools = await client.listTools();
    const field = tools.tools.find((tool) => tool.name === "coolify_update_application_configuration")!.inputSchema.properties!.field as { enum: string[] };
    expect(field.enum).not.toContain("is_auto_deploy_enabled");
    expect(field.enum).not.toContain("is_force_https_enabled");
  });

  it("expires idle sessions while their access token is still valid", async () => {
    fixture = await httpFixture();
    const { tokens } = await fixture.login();
    const { transport } = await connect(tokens.access_token);
    const later = Date.now() + 15 * 60_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    const response = await fixture.request("/mcp", { headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "text/event-stream", "Mcp-Protocol-Version": "2025-11-25", "Mcp-Session-Id": transport.sessionId! } });
    expect(response.status).toBe(404);
  });

  it("revalidates the owner token after confirmation and denies a revoked pending write", async () => {
    fixture = await httpFixture();
    const { tokens, client: oauthClient } = await fixture.login();
    const grant = await fixture.code(oauthClient);
    const alternate = await (await fixture.tokenRequest({ grant_type: "authorization_code", client_id: oauthClient.client_id, code: grant.code, code_verifier: fixture.verifier, redirect_uri: oauthClient.redirect_uris[0]!, resource })).json();
    const connection = await connect(tokens.access_token, async (message) => {
      const response = await fixture!.request("/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: oauthClient.client_id, token: tokens.access_token }) });
      expect(response.status).toBe(200);
      // The elicitation reply is allowed on the same client's fresh grant; the
      // original write must still revalidate its now-revoked initiating token.
      connection.headers.Authorization = `Bearer ${alternate.access_token}`;
      return { action: "accept", content: { confirmation: message.split("Type exactly: ")[1]! } };
    });
    const result = await connection.client.callTool({ name: "coolify_update_application_configuration", arguments: { applicationUuid: "app-alpha", field: "description", value: "Revoked change" } });
    expect(result.isError).toBe(true);
    expect(fixture.writes).toEqual([]);
  });

  it.each(["stale value", "renamed server", "moved application", "secondary server"])("denies a configuration write after approval observes %s", async (change) => {
    fixture = await httpFixture();
    const { tokens } = await fixture.login();
    const { client } = await connect(tokens.access_token, async (message) => {
      if (change === "stale value") fixture!.provider.collections.application[0] = { ...fixture!.provider.collections.application[0], description: "Changed during approval" };
      if (change === "renamed server") fixture!.provider.servers = [{ uuid: "server-target", name: "Changed name" }];
      if (change === "moved application") fixture!.provider.collections.application[0] = { ...fixture!.provider.collections.application[0], server: { uuid: "server-elsewhere" } };
      if (change === "secondary server") {
        fixture!.provider.servers = [...fixture!.provider.servers, { uuid: "server-elsewhere", name: "Other" }];
        fixture!.provider.definedResourcesByServer["server-elsewhere"] = [{ uuid: "app-alpha", type: "application" }];
      }
      return { action: "accept", content: { confirmation: message.split("Type exactly: ")[1]! } };
    });
    const result = await client.callTool({ name: "coolify_update_application_configuration", arguments: { applicationUuid: "app-alpha", field: "description", value: "Unsafe drift" } });
    expect(result.isError).toBe(true);
    expect(fixture.writes).toEqual([]);
  });

  it("requires a safely typed current value and denies off-target resources before elicitation", async () => {
    fixture = await httpFixture();
    const { tokens } = await fixture.login();
    const prompts: string[] = [];
    const { client } = await connect(tokens.access_token, async (message) => { prompts.push(message); return { action: "decline" }; });
    for (const value of [undefined, null, 1, "true"]) {
      fixture.provider.collections.application[0] = { ...fixture.provider.collections.application[0], health_check_enabled: value };
      expect((await client.callTool({ name: "coolify_update_application_configuration", arguments: { applicationUuid: "app-alpha", field: "health_check_enabled", value: false } })).isError).toBe(true);
    }
    expect((await client.callTool({ name: "coolify_update_application_configuration", arguments: { applicationUuid: "app-outside", field: "description", value: "Forbidden" } })).isError).toBe(true);
    expect(prompts).toEqual([]);
    expect(fixture.writes).toEqual([]);
  });

  it("bounds active sessions and rejects reinitialization of an existing session", async () => {
    fixture = await httpFixture();
    const { tokens } = await fixture.login();
    const headers = { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" };
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: { elicitation: { form: {} } }, clientInfo: { name: "bounded-fixture", version: "1" } } });
    let session = "";
    for (let index = 0; index < 100; index++) {
      const response = await fixture.request("/mcp", { method: "POST", headers, body });
      expect(response.status).toBe(200);
      session = response.headers.get("mcp-session-id")!;
      await response.text();
    }
    expect((await fixture.request("/mcp", { method: "POST", headers, body })).status).toBe(503);
    const repeated = await fixture.request("/mcp", { method: "POST", headers: { ...headers, "Mcp-Session-Id": session }, body });
    expect(repeated.status).toBe(400);
  });

  it.each(writeCases.flatMap((item) => ["revocation", "expiry"].map((change) => ({ ...item, change }))))("denies $tool when token $change occurs during the last membership read", async ({ tool, args, finalRead, change }) => {
    fixture = await httpFixture();
    const active = await fixture.login();
    const { client } = await connect(active.tokens.access_token);
    const original = fixture.provider.getResource.bind(fixture.provider);
    vi.spyOn(fixture.provider, "getResource").mockImplementation(async (kind, uuid) => {
      const row = await original(kind, uuid);
      if (fixture!.provider.resourceReads === finalRead) {
        if (change === "revocation") {
          const response = await fixture!.request("/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: active.client.client_id, token: active.tokens.access_token }) });
          expect(response.status).toBe(200);
        } else vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60 * 60_000);
      }
      return row;
    });
    const result = await client.callTool({ name: tool, arguments: args });
    expect(result.isError).toBe(true);
    expect(fixture.writes).toEqual([]);
    expect(fixture.provider.writes).toEqual([]);
  });

  it.each(writeCases)("denies confirmed $tool when its session is deleted during the last scope check", async ({ tool, args, finalRead }) => {
    fixture = await httpFixture();
    const active = await fixture.login();
    const { client, transport } = await connect(active.tokens.access_token);
    const update = tool === "coolify_deploy_application" ? vi.spyOn(fixture.provider, "deploy") : tool === "coolify_restart_resource" ? vi.spyOn(fixture.provider, "restart") : vi.spyOn(CoolifyApplicationConfigWriter.prototype, "update");
    const original = fixture.provider.getResource.bind(fixture.provider);
    let deleted!: () => void;
    const deletion = new Promise<void>((resolve) => { deleted = resolve; });
    vi.spyOn(fixture.provider, "getResource").mockImplementation(async (kind, uuid) => {
      const row = await original(kind, uuid);
      if (fixture!.provider.resourceReads === finalRead) {
        await transport.terminateSession();
        deleted();
      }
      return row;
    });
    const result = client.callTool({ name: tool, arguments: args }).catch(() => undefined);
    await deletion;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(update).not.toHaveBeenCalled();
    await client.close(); await result;
  });

  it("expires sessions after one hour even when used regularly with renewed access tokens", async () => {
    fixture = await httpFixture();
    const active = await fixture.login();
    const connection = await connect(active.tokens.access_token);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now");
    for (const minute of [14, 28, 42, 56]) {
      clock.mockReturnValue(now + minute * 60_000);
      expect((await connection.client.listTools()).tools).toHaveLength(8);
    }
    const refreshed = await fixture.tokenRequest({ grant_type: "refresh_token", client_id: active.client.client_id, refresh_token: active.tokens.refresh_token, resource });
    expect(refreshed.status).toBe(200);
    const tokens = await refreshed.json();
    clock.mockReturnValue(now + 60 * 60_000);
    expect((await fixture.request("/mcp", { headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "text/event-stream", "Mcp-Protocol-Version": "2025-11-25", "Mcp-Session-Id": connection.transport.sessionId! } })).status).toBe(404);
  });
});
