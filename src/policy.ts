import type { ResourceKind } from "./coolify.js";

export type ConfigWriteGrant = Readonly<{
  kind: Exclude<ResourceKind, "project">;
  resourceUuid: string;
  key: string;
  value: string;
}>;

/** Empty by design until the owner approves an exact scope/key/value grant. */
export class ConfigurationWritePolicy {
  constructor(private readonly grants: readonly ConfigWriteGrant[] = []) {}

  allows(request: ConfigWriteGrant): boolean {
    return this.grants.some((grant) =>
      grant.kind === request.kind &&
      grant.resourceUuid === request.resourceUuid &&
      grant.key === request.key &&
      grant.value === request.value,
    );
  }
}
