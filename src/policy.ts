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

export const APPLICATION_CONFIG_FIELDS = [
  "name", "description", "git_branch", "base_directory", "publish_directory",
  "ports_exposes", "watch_paths", "health_check_enabled", "health_check_path",
] as const;
export type ApplicationConfigField = typeof APPLICATION_CONFIG_FIELDS[number];
export type ApplicationConfigValue = string | boolean;

const BOOLEAN_FIELDS = new Set<ApplicationConfigField>(["health_check_enabled"]);
const PORTS_FIELD = "ports_exposes";

/** Small allowlist of non-secret settings. Only one field can be changed per operation. */
export function validateApplicationConfig(field: string, value: unknown): value is ApplicationConfigValue {
  if (!(APPLICATION_CONFIG_FIELDS as readonly string[]).includes(field)) return false;
  const key = field as ApplicationConfigField;
  if (BOOLEAN_FIELDS.has(key)) return typeof value === "boolean";
  if (typeof value !== "string" || value.length > 2_000 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value)) return false;
  if (key === PORTS_FIELD) return value === "" || (/^\d+(,\d+)*$/.test(value) && value.split(",").every((port) => Number(port) >= 1 && Number(port) <= 65_535));
  if (key === "health_check_path") return value === "" || (value.startsWith("/") && !value.includes("..") && !value.includes("://"));
  return true;
}
