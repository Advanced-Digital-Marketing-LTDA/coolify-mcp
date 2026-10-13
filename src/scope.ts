import { ResourceScopeError } from "./errors.js";
import type { ApiRecord, CoolifyProvider, ResourceKind } from "./coolify.js";

export type SafeResource = Readonly<{
  uuid: string;
  name: string;
  kind: ResourceKind;
  status: string | null;
  serverUuid: string;
  project: string | null;
  environment: string | null;
  fqdn: string[];
}>;

export function uuidOf(value: ApiRecord): string | undefined {
  return typeof value.uuid === "string" && value.uuid.length > 0 ? value.uuid : undefined;
}

export function serverUuidOf(value: ApiRecord): string | undefined {
  const server = value.server;
  if (server && typeof server === "object" && typeof (server as ApiRecord).uuid === "string") {
    return (server as ApiRecord).uuid as string;
  }
  for (const key of ["server_uuid", "serverUuid"]) {
    if (typeof value[key] === "string") return value[key] as string;
  }
  return undefined;
}

export function safeResource(value: ApiRecord, kind: ResourceKind, targetUuid: string): SafeResource | undefined {
  const uuid = uuidOf(value);
  if (!uuid || serverUuidOf(value) !== targetUuid) return undefined;
  const domains = value.fqdn;
  const fqdn = Array.isArray(domains)
    ? domains.filter((entry): entry is string => typeof entry === "string").slice(0, 10)
    : typeof domains === "string" ? domains.split(",").map((entry) => entry.trim()).filter(Boolean).slice(0, 10) : [];
  return {
    uuid,
    name: safeString(value.name) ?? safeString(value.project_name) ?? "Unnamed resource",
    kind,
    status: safeString(value.status) ?? null,
    serverUuid: targetUuid,
    project: safeString(value.project_name) ?? null,
    environment: safeString(value.environment_name) ?? null,
    fqdn,
  };
}

/** Normalize a row returned by a required, explicit server_uuid-filtered list. */
export function safeFilteredResource(value: ApiRecord, kind: Exclude<ResourceKind, "project">, targetUuid: string): SafeResource | undefined {
  const observedServer = serverUuidOf(value);
  if (observedServer !== undefined && observedServer !== targetUuid) return undefined;
  if (!uuidOf(value)) return undefined;
  return safeResource({ ...value, server_uuid: targetUuid }, kind, targetUuid);
}

export function safeDetails(value: ApiRecord, kind: ResourceKind, targetUuid: string): SafeResource {
  const normalized = safeResource(value, kind, targetUuid);
  if (!normalized) throw new ResourceScopeError("Resource is stale or outside the approved server scope");
  return normalized;
}

export function safeVerifiedDetails(value: ApiRecord, kind: Exclude<ResourceKind, "project">, targetUuid: string): SafeResource {
  const observedServer = serverUuidOf(value);
  if (observedServer !== undefined && observedServer !== targetUuid) {
    throw new ResourceScopeError("Resource is stale or outside the approved server scope");
  }
  if (!uuidOf(value)) throw new ResourceScopeError("Resource is stale or outside the approved server scope");
  return safeDetails({ ...value, server_uuid: targetUuid }, kind, targetUuid);
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 300) : undefined;
}

export async function requirePinnedServer(provider: CoolifyProvider, targetUuid: string | undefined, targetName: string | undefined): Promise<ApiRecord> {
  if (!targetUuid?.trim() || targetUuid !== targetUuid.trim()) throw new ResourceScopeError("Target server UUID is not configured");
  if (!targetName?.trim()) throw new ResourceScopeError("Target server name is not configured");
  const matches = (await provider.listServers()).filter((server) => uuidOf(server) === targetUuid);
  if (matches.length !== 1 || matches[0]?.name !== targetName) {
    throw new ResourceScopeError("Pinned server is missing or no longer matches the configured name");
  }
  return matches[0]!;
}

export async function requireResourceOnTarget(
  provider: CoolifyProvider,
  kind: Exclude<ResourceKind, "project">,
  uuid: string,
  targetUuid: string,
): Promise<ApiRecord> {
  const members = await provider.listResources(kind, targetUuid);
  const inScope = members.some((item) => uuidOf(item) === uuid && (serverUuidOf(item) === undefined || serverUuidOf(item) === targetUuid));
  if (!inScope) throw new ResourceScopeError("Resource is stale or outside the approved server scope");
  const current = await provider.getResource(kind, uuid);
  if (uuidOf(current) !== uuid || (serverUuidOf(current) !== undefined && serverUuidOf(current) !== targetUuid)) {
    throw new ResourceScopeError("Resource is stale or outside the approved server scope");
  }
  return { ...current, server_uuid: targetUuid };
}

export async function requireSingleServerApplication(provider: CoolifyProvider, applicationUuid: string, targetUuid: string): Promise<void> {
  const servers = await provider.listServers();
  const serverUuids = servers.map(uuidOf);
  if (serverUuids.some((uuid) => !uuid) || new Set(serverUuids).size !== serverUuids.length) {
    throw new ResourceScopeError("Server membership is unknown for this application");
  }
  if (!serverUuids.includes(targetUuid)) throw new ResourceScopeError("Server membership is unknown for this application");

  const memberships: string[] = [];
  for (const serverUuid of serverUuids as string[]) {
    const resources = await provider.listServerResources(serverUuid);
    if (resources.some((resource) => uuidOf(resource) === applicationUuid)) memberships.push(serverUuid);
  }
  if (memberships.length !== 1 || memberships[0] !== targetUuid) {
    throw new ResourceScopeError("Application is assigned to multiple or unknown servers");
  }
}
