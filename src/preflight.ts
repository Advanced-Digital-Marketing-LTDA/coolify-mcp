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
// Loopback, unspecified and documentation-only (RFC 5737/3849) IP literals
// are unreachable for remote clients.
const LOCAL_ADDRESSES = new BlockList();
LOCAL_ADDRESSES.addSubnet("127.0.0.0", 8, "ipv4");
LOCAL_ADDRESSES.addSubnet("0.0.0.0", 8, "ipv4");
LOCAL_ADDRESSES.addAddress("::1", "ipv6");
LOCAL_ADDRESSES.addAddress("::", "ipv6");
LOCAL_ADDRESSES.addSubnet("::ffff:127.0.0.0", 104, "ipv6");
for (const net of ["192.0.2.0", "198.51.100.0", "203.0.113.0"]) LOCAL_ADDRESSES.addSubnet(net, 24, "ipv4");
LOCAL_ADDRESSES.addSubnet("2001:db8::", 32, "ipv6");
// Private, shared (CGNAT), link-local and unique-local addresses can still be a
// valid internal Coolify origin, but never the public connector origin.
const PRIVATE_ADDRESSES = new BlockList();
for (const [net, prefix] of [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["169.254.0.0", 16], ["100.64.0.0", 10]] as const) {
  PRIVATE_ADDRESSES.addSubnet(net, prefix, "ipv4");
  PRIVATE_ADDRESSES.addSubnet(`::ffff:${net}`, 96 + prefix, "ipv6");
}
PRIVATE_ADDRESSES.addSubnet("fc00::", 7, "ipv6");
PRIVATE_ADDRESSES.addSubnet("fe80::", 10, "ipv6");

function isReservedHost(origin: string, publicOnly = false): boolean {
  // A fully qualified name may end in a root dot; it names the same host.
  const host = new URL(origin).hostname.toLowerCase().replace(/\.$/, "");
  const address = host.replace(/^\[|\]$/g, "");
  const version = isIP(address);
  if (version) {
    const family = version === 4 ? "ipv4" : "ipv6";
    return LOCAL_ADDRESSES.check(address, family) || (publicOnly && PRIVATE_ADDRESSES.check(address, family));
  }
  return RESERVED_NAMES.some((name) => host === name || host.endsWith(`.${name}`));
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

/**
 * Validates activation settings offline. Output contains only non-secret
 * settings and derived public URLs; secret values are never echoed.
 */
export function runPreflight(env: NodeJS.ProcessEnv = process.env): PreflightReport {
  const publicOrigin = originCheck("MCP_PUBLIC_ORIGIN", env.MCP_PUBLIC_ORIGIN, true);
  const issuer = env.OIDC_ISSUER?.trim();
  const config = readRuntimeConfig(env);
  const uuid = env.COOLIFY_TARGET_SERVER_UUID?.trim();
  const proxies = parseTrustedProxies(env.MCP_TRUSTED_PROXY_CIDRS);
  const checks: Check[] = [
    publicOrigin,
    originCheck("COOLIFY_ORIGIN", env.COOLIFY_ORIGIN),
    !issuer ? { setting: "OIDC_ISSUER", status: "missing", detail: "set the provider's HTTPS issuer URL" }
      : !config.oidcIssuer ? { setting: "OIDC_ISSUER", status: "invalid", detail: "must be an HTTPS URL without credentials, query or fragment" }
        : isReservedHost(config.oidcIssuer) ? { setting: "OIDC_ISSUER", status: "invalid", detail: "reserved example or local hostname" }
          : { setting: "OIDC_ISSUER", status: "ok", detail: config.oidcIssuer },
    env.OIDC_CLIENT_ID?.trim() ? { setting: "OIDC_CLIENT_ID", status: "ok", detail: env.OIDC_CLIENT_ID.trim() }
      : { setting: "OIDC_CLIENT_ID", status: "missing", detail: "set the confidential client ID" },
    hiddenCheck("OIDC_CLIENT_SECRET", env.OIDC_CLIENT_SECRET),
    hiddenCheck("COOLIFY_OWNER_SUBJECT", env.COOLIFY_OWNER_SUBJECT, isStableOwnerSubject, "must be the stable OIDC sub claim, not an email"),
    hiddenCheck("COOLIFY_API_TOKEN", env.COOLIFY_API_TOKEN),
    !env.COOLIFY_TARGET_SERVER_NAME?.trim() ? { setting: "COOLIFY_TARGET_SERVER_NAME", status: "missing", detail: `set ${APPROVED_SERVER_NAME}` }
      : env.COOLIFY_TARGET_SERVER_NAME.trim() === APPROVED_SERVER_NAME ? { setting: "COOLIFY_TARGET_SERVER_NAME", status: "ok", detail: APPROVED_SERVER_NAME }
        : { setting: "COOLIFY_TARGET_SERVER_NAME", status: "invalid", detail: "differs from the owner-approved server name" },
    !uuid ? { setting: "COOLIFY_TARGET_SERVER_UUID", status: "missing", detail: `set ${APPROVED_SERVER_UUID}` }
      : uuid === APPROVED_SERVER_UUID ? { setting: "COOLIFY_TARGET_SERVER_UUID", status: "ok", detail: uuid }
        : { setting: "COOLIFY_TARGET_SERVER_UUID", status: "invalid", detail: "differs from the owner-approved server" },
    !env.MCP_TRUSTED_PROXY_CIDRS?.trim() ? { setting: "MCP_TRUSTED_PROXY_CIDRS", status: "missing", detail: "set the ingress peer IPs/CIDRs" }
      : proxies ? { setting: "MCP_TRUSTED_PROXY_CIDRS", status: "ok", detail: proxies.join(",") }
        : { setting: "MCP_TRUSTED_PROXY_CIDRS", status: "invalid", detail: "use at most 32 explicit IPs/CIDRs; no wildcards or hop counts" },
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

/** Optional online check of the issuer's public discovery document; sends no credentials. */
export async function checkDiscovery(issuer: string, request: typeof fetch = fetch): Promise<DiscoveryResult> {
  const base = new URL(issuer);
  const url = new URL(`${base.pathname.replace(/\/$/, "")}/.well-known/openid-configuration`, base.origin);
  try {
    const response = await request(url, { redirect: "error", signal: AbortSignal.timeout(10_000), headers: { Accept: "application/json" } });
    if (!response.ok) return { ok: false, detail: `discovery returned HTTP ${response.status}` };
    const metadata = await response.json() as Record<string, unknown>;
    // Match openid-client's startup check exactly: URL-normalized, otherwise byte-equal.
    let advertised: string | undefined;
    try { advertised = typeof metadata.issuer === "string" ? new URL(metadata.issuer).href : undefined; } catch { advertised = undefined; }
    if (advertised !== new URL(issuer).href) return { ok: false, detail: "discovery issuer does not match OIDC_ISSUER" };
    if (!Array.isArray(metadata.code_challenge_methods_supported) || !metadata.code_challenge_methods_supported.includes("S256")) return { ok: false, detail: "provider does not advertise PKCE S256" };
    const responseTypes = metadata.response_types_supported;
    if (!Array.isArray(responseTypes) || !responseTypes.includes("code")) return { ok: false, detail: "provider does not support the authorization code flow" };
    return { ok: true, detail: "discovery document advertises the code flow and PKCE S256" };
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
