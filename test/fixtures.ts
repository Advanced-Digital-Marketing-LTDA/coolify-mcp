import type { ApiRecord, CoolifyProvider, ResourceKind } from "../src/coolify.js";
import { serverUuidOf } from "../src/scope.js";

export const targetServer: ApiRecord = { uuid: "server-target", name: "Target Server", is_reachable: true, is_usable: true };
export const otherServer: ApiRecord = { uuid: "server-elsewhere", name: "Other", is_reachable: true, is_usable: true };
export const appTarget: ApiRecord = { uuid: "app-alpha", name: "Alpha", server: { uuid: "server-target" }, status: "running", fqdn: "alpha.example.test", project_uuid: "project-web", project_name: "Website", environment_uuid: "env-prod", environment_name: "production", secrets: "never-return" };
export const databaseTarget: ApiRecord = { uuid: "db-alpha", name: "Main database", server: { uuid: "server-target" }, status: "running", project_uuid: "project-web", environment_uuid: "env-prod" };
export const serviceTarget: ApiRecord = { uuid: "service-alpha", name: "Worker", server: { uuid: "server-target" }, status: "running", project_uuid: "project-web", environment_uuid: "env-prod" };

export class FakeCoolify implements CoolifyProvider {
  servers: ApiRecord[] = [targetServer];
  collections: Record<ResourceKind, ApiRecord[]> = {
    application: [appTarget],
    database: [databaseTarget, { uuid: "db-outside", name: "Outside database", server: { uuid: "server-elsewhere" }, project_uuid: "project-web", environment_uuid: "env-staging" }],
    service: [serviceTarget, { uuid: "service-outside", name: "Outside service", server: { uuid: "server-elsewhere" }, project_uuid: "project-web", environment_uuid: "env-staging" }],
    project: [{ uuid: "project-web", name: "Website", secrets: "hidden" }],
  };
  environments: Record<string, ApiRecord[]> = {
    "project-web": [
      { uuid: "env-prod", name: "production" },
      { uuid: "env-staging", name: "staging" },
      { uuid: "env-unknown", name: "unknown" },
    ],
  };
  envs: ApiRecord[] = [{ key: "DATABASE_PASSWORD", value: "fixture-secret-value" }, { name: "PUBLIC_URL", value: "https://example.test" }];
  deployments: ApiRecord[] = [{ deployment_uuid: "deploy-1", application_uuid: "app-alpha", status: "finished", created_at: "2026-10-13T00:00:00Z", logs: "fixture-private-log" }, { deployment_uuid: "deploy-other", application_uuid: "app-outside", status: "finished", logs: "outside-log" }];
  writes: string[] = [];
  resourceReads = 0;
  membershipReads = 0;
  serverResourceReads = 0;
  definedResourcesByServer: Record<string, ApiRecord[]> = {};
  failServerResources = false;
  onResourceRead?: (kind: ResourceKind, uuid: string) => ApiRecord | undefined;
  onResourceList?: (kind: ResourceKind, serverUuid: string) => ApiRecord[] | undefined;
  onServerResources?: (serverUuid: string, readNumber: number) => ApiRecord[] | undefined;
  failWith?: Error;

  async listServers() { this.check(); return this.servers; }
  async listResources(kind: ResourceKind, serverUuid?: string, environmentUuid?: string) {
    this.check();
    if (kind === "project") return this.collections.project;
    if (!serverUuid) return [];
    this.membershipReads += 1;
    const changed = this.onResourceList?.(kind, serverUuid);
    const rows = changed ?? this.collections[kind];
    return rows.filter((item) => serverUuidOf(item) === serverUuid && (!environmentUuid || item.environment_uuid === environmentUuid));
  }
  async getResource(kind: ResourceKind, uuid: string) {
    this.check();
    this.resourceReads += 1;
    const changed = this.onResourceRead?.(kind, uuid);
    const item = changed ?? this.collections[kind].find((entry) => entry.uuid === uuid) ?? {};
    if (kind === "project") return item;
    const { server: _server, server_uuid: _serverUuid, serverUuid: _serverUuidCamel, ...detail } = item;
    return detail;
  }
  async getEnvironments(projectUuid: string, targetServerUuid?: string) {
    this.check();
    const environments = this.environments[projectUuid] ?? [];
    if (!targetServerUuid) return environments;
    const result: ApiRecord[] = [];
    for (const environment of environments) {
      if (typeof environment.uuid !== "string") continue;
      const rows = await Promise.all((Object.keys(this.collections) as ResourceKind[])
        .filter((kind) => kind !== "project")
        .map((kind) => this.listResources(kind, targetServerUuid, environment.uuid)));
      if (rows.some((items) => items.length > 0)) result.push({ ...environment, server_uuid: targetServerUuid });
    }
    return result;
  }
  async listServerResources(serverUuid: string) {
    this.check();
    if (this.failServerResources) throw new Error("synthetic server-resource listing failure");
    this.serverResourceReads += 1;
    const changed = this.onServerResources?.(serverUuid, this.serverResourceReads);
    if (changed) return changed;
    if (this.definedResourcesByServer[serverUuid]) return this.definedResourcesByServer[serverUuid]!;
    return (Object.keys(this.collections) as ResourceKind[])
      .filter((kind) => kind !== "project")
      .flatMap((kind) => this.collections[kind]
        .filter((item) => serverUuidOf(item) === serverUuid)
        .map((item) => ({ uuid: item.uuid, type: kind })));
  }
  async listDeployments() { this.check(); return this.deployments; }
  async listEnvironmentKeys() { this.check(); return this.envs; }
  async deploy(uuid: string) { this.check(); this.writes.push(`deploy:${uuid}`); return { message: "queued", fixtureSecret: "must-not-return" }; }
  async restart(kind: Exclude<ResourceKind, "project">, uuid: string) { this.check(); this.writes.push(`restart:${kind}:${uuid}`); return { message: "restarted", fixtureSecret: "must-not-return" }; }

  private check() { if (this.failWith) throw this.failWith; }
}
