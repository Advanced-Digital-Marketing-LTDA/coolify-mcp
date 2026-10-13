export const MAX_PAGES = 1_000;
export const PAGE_SIZE = 100;

export type RuntimeConfig = Readonly<{
  origin?: string;
  targetServerName?: string;
  ownerSubject?: string;
  targetServerUuid?: string;
  apiToken?: string;
}>;

export function readRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return Object.freeze({
    ...(isSafeCoolifyOrigin(env.COOLIFY_ORIGIN) ? { origin: new URL(env.COOLIFY_ORIGIN).origin } : {}),
    ...(env.COOLIFY_TARGET_SERVER_NAME?.trim() ? { targetServerName: env.COOLIFY_TARGET_SERVER_NAME.trim() } : {}),
    ...(env.COOLIFY_OWNER_SUBJECT?.trim() ? { ownerSubject: env.COOLIFY_OWNER_SUBJECT.trim() } : {}),
    ...(env.COOLIFY_TARGET_SERVER_UUID?.trim() ? { targetServerUuid: env.COOLIFY_TARGET_SERVER_UUID.trim() } : {}),
    ...(env.COOLIFY_API_TOKEN?.trim() ? { apiToken: env.COOLIFY_API_TOKEN.trim() } : {}),
  });
}

export function isActivated(config: RuntimeConfig): boolean {
  return Boolean(
    isSafeCoolifyOrigin(config.origin) && new URL(config.origin!).hostname !== "coolify.example.invalid" &&
    config.targetServerName?.trim() && config.targetServerUuid?.trim() &&
    isStableOwnerSubject(config.ownerSubject) && config.apiToken?.trim(),
  );
}

/** The origin is deployment configuration, fixed for the process, and never an MCP argument. */
export function isSafeCoolifyOrigin(value: string | undefined): value is string {
  if (!value?.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      (url.pathname === "/" || url.pathname === "") && !url.search && !url.hash &&
      url.port === "";
  } catch {
    return false;
  }
}

export function isStableOwnerSubject(subject: string | undefined): subject is string {
  return Boolean(subject?.trim() && !subject.includes("@"));
}
