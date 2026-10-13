# Coolify MCP foundation

A server-side MCP tool layer that scopes one Coolify account to one pinned server. This public code foundation uses synthetic fixtures only and remains inactive until the deployment owner configures a verified identity provider, server name and UUID, origin, and team-scoped token.

## Security model

The outbound client uses Coolify's documented Streamable HTTP MCP endpoint at the deployment-configured HTTPS origin plus the fixed `/mcp` path. Origin and server settings are read once from trusted process configuration; callers cannot choose a host, URL, path, or proxy. Origins with credentials, paths, queries, fragments, non-HTTPS schemes, or nonstandard ports are rejected. Redirects are blocked.

Every operation authenticates a verified owner subject and checks the pinned server UUID and configured name against the current Coolify server list. Resource actions fetch current membership and recheck the server and resource immediately before writes. Projects and environments can span servers; project views include only environments on the target server. App-wide writes are not exposed.

The published tools provide filtered inventory, safe resource status/details, deployment metadata without logs, and environment key names without values. Normal application deploy and resource restart require a host-provided exact interactive confirmation. The MCP arguments themselves cannot represent approval. Resource-local configuration writes remain disabled until a later owner-approved exact key/value/scope allow-list exists.

Excluded capabilities include secret read/write, shared/global settings, deletion, stop/cancel, force builds, tag/bulk operations, clone, migration, creation, previews, arbitrary upstream calls, and shell execution.

The host OAuth identity adapter is an interface, not a custom header or email-based implementation. The host must supply a principal derived from its validated OAuth session through `VerifiedIdentityProvider`. The adapter defaults to no identity. Check the selected host's supported MCP identity contract before connecting it; this foundation does not invent a Sites claim/header API.

## Local development

Requirements: Node 22 or newer.

```sh
npm ci
npm run build
npm test
npm run mutation
```

All fixtures are synthetic. Tests use the MCP SDK in-memory transport and mock Coolify tool responses; they make no network or infrastructure requests. CI runs the build, protocol/security tests, and focused StrykerJS mutation testing over owner identity, configuration, allow-list, scope, confirmation, and error-redaction code. The upstream adapter and MCP server wiring are covered by functional protocol and pagination tests but excluded from mutation runs to keep CI bounded.

## Activation gates

1. Select a supported host OAuth integration and implement `VerifiedIdentityProvider` using its validated session identity. Pin the owner's stable, non-email subject. No first-login enrollment is supported.
2. The owner must confirm the exact Coolify server name and UUID. Set both `COOLIFY_TARGET_SERVER_NAME` and `COOLIFY_TARGET_SERVER_UUID`; a name-only match does not activate the integration.
3. Set `COOLIFY_ORIGIN` in trusted deployment configuration to the approved HTTPS origin. Do not pass it from MCP callers. The example uses the reserved `.invalid` domain and cannot activate the integration.
4. Enter the live token through the host's approved secret settings in a separately authorized activation. Use a team-scoped token with only the required `read`, `deploy`, and `write` permissions; do not grant `read:sensitive` or `root`. Never put a live token in source control, `.env`, a prompt, or logs.
5. Confirm the host's plugin approval and network access settings allow only the Coolify hostname. Verify the upstream published schemas and response shapes before enabling tools.
6. Test a non-owner session and target/off-target resources. Do not enable deploy/restart until the host presents an explicit per-resource confirmation and rechecks current server/resource scope before writing.

This task creates no live connection and does not configure credentials or deploy the service. The owner must complete identity integration, confirm the server name and UUID, and enter the token securely before activation. Any future resource-local configuration writes need their own exact allow-list approval.

## Supported interfaces checked

- [OpenAI Sites administration](https://developers.openai.com/codex/enterprise/sites): visitor-owned connected accounts, workspace plugin approval, and network access controls.
- [OpenAI Apps SDK MCP server guidance](https://developers.openai.com/plugins/build/mcp-server): MCP authorization is enforced server-side on every request.
- [Coolify MCP overview](https://coolify.io/docs/mcp/overview) and [how it works](https://coolify.io/docs/mcp/how-mcp-works): `/mcp`, Streamable HTTP, team-bound Bearer token, and response boundaries.
- [Coolify MCP pagination](https://coolify.io/docs/mcp/capabilities/pagination): list tools use pagination arguments and return continuation metadata.
- [Coolify MCP security](https://coolify.io/docs/mcp/security) and [API permissions](https://coolify.io/docs/api/permissions): least privilege and sensitive data constraints.
