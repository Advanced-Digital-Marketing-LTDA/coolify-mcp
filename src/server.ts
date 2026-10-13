import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { type RuntimeConfig, isActivated } from "./config.js";
import { requestExactConfirmation, sanitizeConfirmationName } from "./confirmation.js";
import { UnconfiguredCoolifyProvider, type ApiRecord, type CoolifyProvider, type ResourceKind } from "./coolify.js";
import { AccessDeniedError, NotConfiguredError, publicError } from "./errors.js";
import { OwnerIdentityGate, UnconfiguredIdentityProvider, type VerifiedIdentityProvider } from "./identity.js";
import { safeFilteredResource, safeVerifiedDetails, serverUuidOf, uuidOf, requirePinnedServer, requireResourceOnTarget, requireSingleServerApplication } from "./scope.js";

const uuidSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9-]+$/);
const kindSchema = z.enum(["application", "database", "service", "project"]);
const mutableKindSchema = z.enum(["application", "database", "service"]);

export type ServerDependencies = Readonly<{
  config: RuntimeConfig;
  identity?: VerifiedIdentityProvider;
  provider?: CoolifyProvider;
}>;

export function createCoolifyMcpServer(dependencies: ServerDependencies): McpServer {
  const { config } = dependencies;
  const provider = dependencies.provider ?? new UnconfiguredCoolifyProvider();
  const gate = new OwnerIdentityGate(config.ownerSubject, dependencies.identity ?? new UnconfiguredIdentityProvider());
  const server = new McpServer(
    { name: "coolify-mcp-foundation", version: "0.1.0" },
    {
      instructions: [
        "Coolify integration for the pinned owner only.",
        "Coolify origin and target server name are fixed deployment settings and are never caller-controlled.",
        "All resource lists use a server filter; resource details are returned only after current membership is verified.",
        "Deploy and restart ask for exact interactive confirmation and recheck current server and application destinations before writing.",
        "Secret values, logs, arbitrary URLs, and shell execution are not exposed.",
      ].join(" "),
      capabilities: { tools: {} },
    },
  );

  const owner = async (authInfo: AuthInfo | undefined): Promise<void> => {
    await gate.requireOwner(authInfo);
    if (!isActivated(config)) throw new NotConfiguredError("Owner identity, Coolify origin, target server name and UUID, and token must be configured");
    await requirePinnedServer(provider, config.targetServerUuid, config.targetServerName);
  };

  const tool = (callback: (args: any, extra: any) => Promise<unknown>): any => async (...callArgs: any[]) => {
    const extra = callArgs.length === 1 ? callArgs[0] : callArgs[1];
    const args = callArgs.length === 1 ? {} : callArgs[0];
    try {
      await owner(extra.authInfo);
      const result = await callback(args, extra);
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> };
    } catch (error) {
      return { content: [{ type: "text", text: publicError(error) }], isError: true };
    }
  };

  server.registerTool("coolify_inventory", {
    title: "List scoped resources",
    description: "List applications, databases, services, projects, and environments currently assigned to the configured pinned server.",
    inputSchema: z.strictObject({}),
    outputSchema: z.object({ server: z.object({ uuid: z.string(), name: z.string(), status: z.string().nullable(), reachable: z.boolean().nullable(), usable: z.boolean().nullable() }), resources: z.array(z.object({ uuid: z.string(), name: z.string(), kind: kindSchema, status: z.string().nullable(), serverUuid: z.string(), project: z.string().nullable(), environment: z.string().nullable(), fqdn: z.array(z.string()) })), projects: z.array(z.object({ uuid: z.string(), name: z.string(), environments: z.array(z.object({ uuid: z.string(), name: z.string() })) })) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, tool(async () => {
    const target = await requirePinnedServer(provider, config.targetServerUuid, config.targetServerName);
    const [applications, databases, services, projects] = await Promise.all([
      provider.listResources("application", config.targetServerUuid!),
      provider.listResources("database", config.targetServerUuid!),
      provider.listResources("service", config.targetServerUuid!),
      provider.listResources("project"),
    ]);
    const resources = [
      ...applications.flatMap((item) => safeFilteredResource(item, "application", config.targetServerUuid!) ?? []),
      ...databases.flatMap((item) => safeFilteredResource(item, "database", config.targetServerUuid!) ?? []),
      ...services.flatMap((item) => safeFilteredResource(item, "service", config.targetServerUuid!) ?? []),
    ];
    const scopedProjects = [];
    for (const project of projects) {
      const uuid = uuidOf(project);
      if (!uuid) continue;
      const envs = await provider.getEnvironments(uuid, config.targetServerUuid!, { application: applications, service: services });
      const environments = envs
        .filter((environment) => serverUuidOf(environment) === config.targetServerUuid)
        .flatMap((environment) => {
          const envUuid = uuidOf(environment);
          return envUuid ? [{ uuid: envUuid, name: typeof environment.name === "string" ? environment.name : "Unnamed environment" }] : [];
        });
      if (environments.length > 0) {
        scopedProjects.push({ uuid, name: typeof project.name === "string" ? project.name : "Unnamed project", environments });
      }
    }
    return {
      server: {
        uuid: config.targetServerUuid,
        name: config.targetServerName!,
        status: typeof target.is_reachable === "boolean" ? (target.is_reachable ? "reachable" : "unreachable") : null,
        reachable: typeof target.is_reachable === "boolean" ? target.is_reachable : null,
        usable: typeof target.is_usable === "boolean" ? target.is_usable : null,
      },
      resources,
      projects: scopedProjects,
    };
  }));

  server.registerTool("coolify_resource_status", {
    title: "Get resource status",
    description: "Read current status and a small safe detail set for one resource on the pinned server.",
    inputSchema: z.strictObject({ kind: kindSchema, uuid: uuidSchema }),
    outputSchema: z.object({
      uuid: z.string(),
      name: z.string(),
      kind: kindSchema,
      status: z.string().nullable().optional(),
      serverUuid: z.string().optional(),
      project: z.string().nullable().optional(),
      environment: z.string().nullable().optional(),
      fqdn: z.array(z.string()).optional(),
      environments: z.array(z.object({ uuid: z.string(), name: z.string() })).optional(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, tool(async ({ kind, uuid }) => {
    const target = config.targetServerUuid!;
    if (kind === "project") {
      const project = await provider.getResource("project", uuid);
      if (uuidOf(project) !== uuid) throw new AccessDeniedError("Project not found");
      const environments = await provider.getEnvironments(uuid, target);
      const inScope = environments.filter((environment) => serverUuidOf(environment) === target);
      if (!inScope.length) throw new AccessDeniedError("Project has no environment on the approved server");
      return { uuid, name: typeof project.name === "string" ? project.name : "Unnamed project", kind, environments: inScope.flatMap((env) => uuidOf(env) ? [{ uuid: uuidOf(env), name: typeof env.name === "string" ? env.name : "Unnamed environment" }] : []) };
    }
    const current = await requireResourceOnTarget(provider, kind, uuid, target);
    return safeVerifiedDetails(current, kind, target);
  }));

  server.registerTool("coolify_deployment_history", {
    title: "Read deployment history",
    description: "Read recent deployment metadata for one current application on the pinned server. Build logs and output are never returned.",
    inputSchema: z.strictObject({ applicationUuid: uuidSchema }),
    outputSchema: z.object({ applicationUuid: z.string(), deployments: z.array(z.object({ uuid: z.string().nullable(), status: z.string().nullable(), createdAt: z.string().nullable(), updatedAt: z.string().nullable() })) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, tool(async ({ applicationUuid }) => {
    await requireResourceOnTarget(provider, "application", applicationUuid, config.targetServerUuid!);
    const deployments = await provider.listDeployments(applicationUuid);
    return {
      applicationUuid,
      deployments: deployments
        .filter((item) => deploymentBelongsTo(item, applicationUuid))
        .map((item) => ({
          uuid: stringValue(item.deployment_uuid) ?? stringValue(item.uuid),
          status: stringValue(item.status),
          createdAt: stringValue(item.created_at) ?? stringValue(item.createdAt),
          updatedAt: stringValue(item.updated_at) ?? stringValue(item.updatedAt),
        })),
    };
  }));

  server.registerTool("coolify_environment_key_names", {
    title: "List environment key names",
    description: "Return environment variable key names only for one current resource on the pinned server. Values are omitted.",
    inputSchema: z.strictObject({ kind: mutableKindSchema, uuid: uuidSchema }),
    outputSchema: z.object({ uuid: z.string(), keys: z.array(z.string()) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, tool(async ({ kind, uuid }) => {
    await requireResourceOnTarget(provider, kind, uuid, config.targetServerUuid!);
    const records = await provider.listEnvironmentKeys(kind, uuid);
    const keys = [...new Set(records.flatMap((item) => {
      const key = stringValue(item.key) ?? stringValue(item.name);
      return key && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) ? [key] : [];
    }))].sort();
    return { uuid, keys };
  }));

  server.registerTool("coolify_deploy_application", {
    title: "Deploy application",
    description: "Queue a normal deployment for one application after exact interactive user confirmation. Force builds and previews are not supported.",
    inputSchema: z.strictObject({ applicationUuid: uuidSchema }),
    outputSchema: z.object({ accepted: z.boolean(), message: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, tool(async ({ applicationUuid }, extra) => {
    const current = await requireResourceOnTarget(provider, "application", applicationUuid, config.targetServerUuid!);
    await requireSingleServerApplication(provider, applicationUuid, config.targetServerUuid!);
    if (!(await requestExactConfirmation(extra, "deploy", label(current), applicationUuid))) return { accepted: false, message: "Deployment was not confirmed" };
    await recheckBeforeWrite(provider, config.targetServerUuid, config.targetServerName, "application", applicationUuid);
    await provider.deploy(applicationUuid);
    return { accepted: true, message: "Deployment request accepted" };
  }));

  server.registerTool("coolify_restart_resource", {
    title: "Restart resource",
    description: "Restart one application, database, or service after exact interactive user confirmation. Stop and cancel actions are not supported.",
    inputSchema: z.strictObject({ kind: mutableKindSchema, uuid: uuidSchema }),
    outputSchema: z.object({ accepted: z.boolean(), message: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, tool(async ({ kind, uuid }, extra) => {
    const current = await requireResourceOnTarget(provider, kind, uuid, config.targetServerUuid!);
    if (kind === "application") await requireSingleServerApplication(provider, uuid, config.targetServerUuid!);
    if (!(await requestExactConfirmation(extra, "restart", label(current), uuid))) return { accepted: false, message: "Restart was not confirmed" };
    await recheckBeforeWrite(provider, config.targetServerUuid, config.targetServerName, kind, uuid);
    await provider.restart(kind, uuid);
    return { accepted: true, message: "Restart request accepted" };
  }));

  return server;
}

async function recheckBeforeWrite(
  provider: CoolifyProvider,
  targetUuid: string | undefined,
  targetName: string | undefined,
  kind: Exclude<ResourceKind, "project">,
  uuid: string,
): Promise<void> {
  await requirePinnedServer(provider, targetUuid, targetName);
  await requireResourceOnTarget(provider, kind, uuid, targetUuid!);
  if (kind === "application") await requireSingleServerApplication(provider, uuid, targetUuid!);
}

function deploymentBelongsTo(item: ApiRecord, applicationUuid: string): boolean {
  return [item.application_uuid, item.applicationUuid, item.resource_uuid, item.uuid_application].includes(applicationUuid);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value.slice(0, 300) : null;
}

function label(item: ApiRecord): string {
  return sanitizeConfirmationName(typeof item.name === "string" ? item.name : "Unnamed resource");
}
