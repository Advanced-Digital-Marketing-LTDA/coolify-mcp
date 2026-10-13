import type { ApiRecord, CoolifyProvider, ResourceKind } from "../src/coolify.js";

export const targetServer: ApiRecord = { uuid: "server-target", name: "Target Server", status: "running" };
export const otherServer: ApiRecord = { uuid: "server-elsewhere", name: "Other", status: "running" };
export const appTarget: ApiRecord = { uuid: "app-alpha", name: "Alpha", server: { uuid: "server-target" }, status: "running", fqdn: "alpha.example.test", project_name: "Website", environment_name: "production", secrets: "never-return" };
export const databaseTarget: ApiRecord = { uuid: "db-alpha", name: "Main database", server: { uuid: "server-target" }, status: "running" };
export const serviceTarget: ApiRecord = { uuid: "service-alpha", name: "Worker", server: { uuid: "server-target" }, status: "running" };

export class FakeCoolify implements CoolifyProvider {
  servers: ApiRecord[] = [targetServer];
  collections: Record<ResourceKind, ApiRecord[]> = {
    application: [appTarget],
    database: [databaseTarget, { uuid: "db-outside", name: "Outside database", server: { uuid: "server-elsewhere" } }],
    service: [serviceTarget, { uuid: "service-outside", name: "Outside service", server: { uuid: "server-elsewhere" } }],
    project: [{ uuid: "project-web", name: "Website", secrets: "hidden" }],
  };
  environments: Record<string, ApiRecord[]> = {
    "project-web": [
      { uuid: "env-prod", name: "production", server: { uuid: "server-target" } },
      { uuid: "env-staging", name: "staging", server: { uuid: "server-elsewhere" } },
      { uuid: "env-unknown", name: "unknown", server: null },
    ],
  };
  envs: ApiRecord[] = [{ key: "DATABASE_PASSWORD", value: "fixture-secret-value" }, { name: "PUBLIC_URL", value: "https://example.test" }];
  deployments: ApiRecord[] = [{ uuid: "deploy-1", application_uuid: "app-alpha", status: "finished", created_at: "2026-10-13T00:00:00Z", logs: "fixture-private-log" }, { uuid: "deploy-other", application_uuid: "app-outside", status: "finished", logs: "outside-log" }];
  writes: string[] = [];
  resourceReads = 0;
  onResourceRead?: (kind: ResourceKind, uuid: string) => ApiRecord | undefined;
  failWith?: Error;

  async listServers() { this.check(); return this.servers; }
  async listResources(kind: ResourceKind) { this.check(); return this.collections[kind]; }
  async getResource(kind: ResourceKind, uuid: string) {
    this.check();
    this.resourceReads += 1;
    const changed = this.onResourceRead?.(kind, uuid);
    return changed ?? this.collections[kind].find((item) => item.uuid === uuid) ?? {};
  }
  async getEnvironments(projectUuid: string) { this.check(); return this.environments[projectUuid] ?? []; }
  async listDeployments() { this.check(); return this.deployments; }
  async listEnvironmentKeys() { this.check(); return this.envs; }
  async deploy(uuid: string) { this.check(); this.writes.push(`deploy:${uuid}`); return { message: "queued", fixtureSecret: "must-not-return" }; }
  async restart(kind: Exclude<ResourceKind, "project">, uuid: string) { this.check(); this.writes.push(`restart:${kind}:${uuid}`); return { message: "restarted", fixtureSecret: "must-not-return" }; }

  private check() { if (this.failWith) throw this.failWith; }
}
