import { BlockList, isIP } from "node:net";
import { basename } from "node:path";
import { isHostedConfigured, isSafeCoolifyOrigin, isStableOwnerSubject, parseTrustedProxies, readRuntimeConfig } from "./config.js";

/** The owner-approved AI Agents server; the bridge must stay pinned to it. */
export const APPROVED_SERVER_UUID = "pcrionkfci16zmkssngc6vaa";
export const APPROVED_SERVER_NAME = "AI Agents";

export type CheckStatus = "ok" | "missing" | "invalid";
export type Check = Readonly<{ setting: string; status: CheckStatus; detail: string }>;
export type PreflightReport = Readonly<{ ready: boolean; checks: readonly Check[]; mcpUrl?: string; oidcCallbackUri?: string }>;

// RFC 2606/6761 names cannot be the final public or Coolify origin.
const RESERVED_NAMES = ["invalid", "example", "test", "localhost", "local", "example.com", "example.net", "example.org"];
// Private-use namespaces (ICANN .internal, RFC 8375, RFC 9476) never resolve in
// global DNS, so they can only be an internal Coolify origin.
const PRIVATE_NAMES = ["internal", "home.arpa", "alt", "onion"];
// IPv4 special-purpose ranges (RFC 6890). "any" ranges can never serve HTTPS
// to anyone; "public" ranges may still be a valid internal Coolify origin but
// never the public connector origin. IPv4-mapped IPv6 forms are blocked too.
const IPV4_SPECIAL = [
  ["0.0.0.0", 8, "any"], ["127.0.0.0", 8, "any"], ["224.0.0.0", 3, "any"],
  ["192.0.2.0", 24, "any"], ["198.51.100.0", 24, "any"], ["203.0.113.0", 24, "any"],
  ["10.0.0.0", 8, "public"], ["172.16.0.0", 12, "public"], ["192.168.0.0", 16, "public"],
  ["169.254.0.0", 16, "public"], ["100.64.0.0", 10, "public"], ["192.0.0.0", 24, "public"], ["198.18.0.0", 15, "public"],
  ["192.88.99.0", 24, "public"],
] as const;
const LOCAL_ADDRESSES = new BlockList();
const PRIVATE_ADDRESSES = new BlockList();
for (const [net, prefix, scope] of IPV4_SPECIAL) {
  const list = scope === "any" ? LOCAL_ADDRESSES : PRIVATE_ADDRESSES;
  list.addSubnet(net, prefix, "ipv4");
  list.addSubnet(`::ffff:${net}`, 96 + prefix, "ipv6");
}
LOCAL_ADDRESSES.addAddress("::1", "ipv6");
LOCAL_ADDRESSES.addAddress("::", "ipv6");
LOCAL_ADDRESSES.addSubnet("ff00::", 8, "ipv6");
LOCAL_ADDRESSES.addSubnet("2001:db8::", 32, "ipv6");
// A public IPv6 origin must be global unicast (or an IPv4-mapped address,
// judged by the IPv4 ranges above); this excludes unique-local and link-local.
const PUBLIC_IPV6 = new BlockList();
PUBLIC_IPV6.addSubnet("2000::", 3, "ipv6");
PUBLIC_IPV6.addSubnet("::ffff:0:0", 96, "ipv6");
// Non-global special-purpose blocks inside 2000::/3 (IANA IPv6 registry):
// IETF protocol assignments, 6to4, documentation and SRv6 SIDs.
for (const [net, prefix] of [["2001::", 23], ["2002::", 16], ["3fff::", 20], ["5f00::", 16]] as const) PRIVATE_ADDRESSES.addSubnet(net, prefix, "ipv6");

function isReservedHost(origin: string, publicOnly = false): boolean {
  // A fully qualified name may end in a root dot; it names the same host.
  const host = new URL(origin).hostname.toLowerCase().replace(/\.$/, "");
  const address = host.replaceAll(/^\[|\]$/g, "");
  const version = isIP(address);
  if (version) {
    const family = version === 4 ? "ipv4" : "ipv6";
    if (LOCAL_ADDRESSES.check(address, family)) return true;
    return publicOnly && (PRIVATE_ADDRESSES.check(address, family) || (family === "ipv6" && !PUBLIC_IPV6.check(address, family)));
  }
  const names = publicOnly ? [...RESERVED_NAMES, ...PRIVATE_NAMES] : RESERVED_NAMES;
  return names.some((name) => host === name || host.endsWith(`.${name}`));
}

function originCheck(setting: string, value: string | undefined, publicOnly = false): Check {
  if (!value?.trim()) return { setting, status: "missing", detail: "set an HTTPS origin" };
  if (!isSafeCoolifyOrigin(value)) return { setting, status: "invalid", detail: "must be https://host with no path, query, credentials or port" };
  const origin = new URL(value).origin;
  if (isReservedHost(origin, publicOnly)) return { setting, status: "invalid", detail: publicOnly ? "reserved, local or private address; must be reachable from the internet" : "reserved example or local hostname" };
  return { setting, status: "ok", detail: origin };
}

// Secrets and the owner subject are only ever reported as present or absent.
function hiddenCheck(setting: string, value: string | undefined, valid = (_v: string) => true, rule = ""): Check {
  if (!value?.trim()) return { setting, status: "missing", detail: "inject through the host secret manager" };
  if (!valid(value.trim())) return { setting, status: "invalid", detail: `${rule} (value hidden)` };
  return { setting, status: "ok", detail: "set (value hidden)" };
}

function issuerCheck(raw: string | undefined, issuer: string | undefined): Check {
  const setting = "OIDC_ISSUER";
  if (!raw) return { setting, status: "missing", detail: "set the provider's HTTPS issuer URL" };
  if (!issuer) return { setting, status: "invalid", detail: "must be an HTTPS URL without credentials, query or fragment" };
  if (isReservedHost(issuer)) return { setting, status: "invalid", detail: "reserved example or local hostname" };
  return { setting, status: "ok", detail: issuer };
}

// Settings pinned to an owner-approved value.
function pinnedCheck(setting: string, value: string | undefined, approved: string, mismatch: string): Check {
  const trimmed = value?.trim();
  if (!trimmed) return { setting, status: "missing", detail: `set ${approved}` };
  if (trimmed !== approved) return { setting, status: "invalid", detail: mismatch };
  return { setting, status: "ok", detail: approved };
}

function proxyCheck(value: string | undefined): Check {
  const setting = "MCP_TRUSTED_PROXY_CIDRS";
  if (!value?.trim()) return { setting, status: "missing", detail: "set the ingress peer IPs/CIDRs" };
  const proxies = parseTrustedProxies(value);
  if (!proxies) return { setting, status: "invalid", detail: "use at most 32 explicit IPs/CIDRs; no wildcards or hop counts" };
  return { setting, status: "ok", detail: proxies.join(",") };
}

/**
 * Validates activation settings offline. Output contains only non-secret
 * settings and derived public URLs; secret values are never echoed.
 */
export function runPreflight(env: NodeJS.ProcessEnv = process.env): PreflightReport {
  const publicOrigin = originCheck("MCP_PUBLIC_ORIGIN", env.MCP_PUBLIC_ORIGIN, true);
  const issuer = env.OIDC_ISSUER?.trim();
  const config = readRuntimeConfig(env);
  const checks: Check[] = [
    publicOrigin,
    originCheck("COOLIFY_ORIGIN", env.COOLIFY_ORIGIN),
    issuerCheck(issuer, config.oidcIssuer),
    env.OIDC_CLIENT_ID?.trim() ? { setting: "OIDC_CLIENT_ID", status: "ok", detail: env.OIDC_CLIENT_ID.trim() }
      : { setting: "OIDC_CLIENT_ID", status: "missing", detail: "set the confidential client ID" },
    hiddenCheck("OIDC_CLIENT_SECRET", env.OIDC_CLIENT_SECRET),
    hiddenCheck("COOLIFY_OWNER_SUBJECT", env.COOLIFY_OWNER_SUBJECT, isStableOwnerSubject, "must be the stable OIDC sub claim, not an email"),
    hiddenCheck("COOLIFY_API_TOKEN", env.COOLIFY_API_TOKEN),
    pinnedCheck("COOLIFY_TARGET_SERVER_NAME", env.COOLIFY_TARGET_SERVER_NAME, APPROVED_SERVER_NAME, "differs from the owner-approved server name"),
    pinnedCheck("COOLIFY_TARGET_SERVER_UUID", env.COOLIFY_TARGET_SERVER_UUID, APPROVED_SERVER_UUID, "differs from the owner-approved server"),
    proxyCheck(env.MCP_TRUSTED_PROXY_CIDRS),
  ];
  // Backstop: if the runtime gate ever disagrees with the checks above, say so
  // rather than failing with every line green.
  if (checks.every((check) => check.status === "ok") && !isHostedConfigured(config)) {
    checks.push({ setting: "ACTIVATION_GATE", status: "invalid", detail: "settings pass individually but the runtime activation gate rejects them" });
  }
  const ready = checks.every((check) => check.status === "ok");
  const origin = publicOrigin.status === "ok" ? publicOrigin.detail : undefined;
  return {
    ready,
    checks,
    ...(origin ? { mcpUrl: `${origin}/mcp`, oidcCallbackUri: `${origin}/oauth/callback` } : {}),
  };
}

export function formatReport(report: PreflightReport): string {
  const width = report.checks.reduce((max, check) => Math.max(max, check.setting.length), 0);
  const lines = report.checks.map((check) => `${check.status.padEnd(7)} ${check.setting.padEnd(width)}  ${check.detail}`);
  if (report.oidcCallbackUri) lines.push("", `Register this OIDC redirect URI: ${report.oidcCallbackUri}`, `Connector MCP URL:              ${report.mcpUrl}`);
  lines.push("", report.ready ? "Preflight passed. Activation settings are complete; deployment still needs owner approval." : "Preflight failed. Fix the settings above before activation.");
  return lines.join("\n");
}

type DiscoveryResult = Readonly<{ ok: boolean; detail: string }>;

function isHttpsUrl(value: unknown): boolean {
  return typeof value === "string" && URL.canParse(value) && new URL(value).protocol === "https:";
}

function normalizedIssuer(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).href;
  } catch {
    return null;
  }
}

/** Optional online check of the issuer's public discovery document; sends no credentials. */
export async function checkDiscovery(issuer: string, request: typeof fetch = fetch): Promise<DiscoveryResult> {
  const base = new URL(issuer);
  const url = new URL(`${base.pathname.replace(/\/$/, "")}/.well-known/openid-configuration`, base.origin);
  try {
    const response = await request(url, { redirect: "error", signal: AbortSignal.timeout(10_000), headers: { Accept: "application/json" } });
    if (!response.ok) return { ok: false, detail: `discovery returned HTTP ${response.status}` };
    const metadata = await response.json() as Record<string, unknown>;
    // Match openid-client's startup check exactly: URL-normalized, otherwise byte-equal.
    if (normalizedIssuer(metadata.issuer) !== new URL(issuer).href) return { ok: false, detail: "discovery issuer does not match OIDC_ISSUER" };
    if (!isHttpsUrl(metadata.authorization_endpoint) || !isHttpsUrl(metadata.token_endpoint)) return { ok: false, detail: "provider does not advertise HTTPS authorization and token endpoints" };
    // The host builds plain authorization URLs, not pushed authorization requests.
    if (metadata.require_pushed_authorization_requests === true) return { ok: false, detail: "provider requires pushed authorization requests, which the bridge does not send" };
    if (!Array.isArray(metadata.code_challenge_methods_supported) || !metadata.code_challenge_methods_supported.includes("S256")) return { ok: false, detail: "provider does not advertise PKCE S256" };
    const responseTypes = metadata.response_types_supported;
    if (!Array.isArray(responseTypes) || !responseTypes.includes("code")) return { ok: false, detail: "provider does not support the authorization code flow" };
    // The host authenticates to the token endpoint with openid-client's default,
    // client_secret_post. An absent list means client_secret_basic only.
    const authMethods = metadata.token_endpoint_auth_methods_supported;
    if (!Array.isArray(authMethods) || !authMethods.includes("client_secret_post")) return { ok: false, detail: "provider does not advertise client_secret_post token authentication" };
    return { ok: true, detail: "discovery document advertises the code flow, PKCE S256 and client_secret_post" };
  } catch {
    return { ok: false, detail: "discovery document could not be fetched or parsed" };
  }
}

if (basename(process.argv[1] ?? "") === "preflight.js" || basename(process.argv[1] ?? "") === "preflight.ts") {
  const report = runPreflight();
  console.log(formatReport(report));
  let ok = report.ready;
  if (process.argv.includes("--discover")) {
    const issuer = readRuntimeConfig().oidcIssuer;
    const result = issuer ? await checkDiscovery(issuer) : { ok: false, detail: "OIDC_ISSUER is not valid" };
    console.log(`${result.ok ? "ok     " : "invalid"} OIDC discovery  ${result.detail}`);
    ok &&= result.ok;
  }
  process.exitCode = ok ? 0 : 1;
}
