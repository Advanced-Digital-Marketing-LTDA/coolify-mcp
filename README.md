# Coolify MCP foundation

A hosted ChatGPT MCP integration that scopes one Coolify team to one pinned server. It implements MCP OAuth endpoints and an OpenID Connect login bridge. It uses synthetic fixtures locally and remains inactive until the owner configures the final HTTPS origin, OIDC client, stable owner subject, and Coolify team token.

## Security model

The outbound client uses Coolify's documented Streamable HTTP MCP endpoint at the deployment-configured HTTPS origin plus the fixed `/mcp` path. Origin and server settings are read once from trusted process configuration; callers cannot choose a host, URL, path, or proxy. Origins with credentials, paths, queries, fragments, non-HTTPS schemes, or nonstandard ports are rejected. Redirects are blocked. At runtime, the adapter validates the published tool schemas and uses Coolify's `server_uuid` and `environment_uuid` filters for resource membership; incompatible schemas or response envelopes fail closed.

Every operation authenticates a verified owner subject and checks the pinned server UUID and configured name against the current Coolify server list. Resource details are returned only after membership is confirmed through the current server-filtered resource list. Projects and environments can span servers; project views include only environments with current resources returned by target-server-filtered lists. Application deploy/restart is denied if `get_server_resources` reports the app on another server or if any server's membership cannot be checked.

Coolify exposes membership checks and writes separately, without an atomic conditional write. The integration rechecks server identity, resource membership, and all visible application destinations immediately before deploy, restart, or configuration writes. A move in the narrow interval between the final check and Coolify's write can still race; no atomicity is claimed.

The published tools provide filtered inventory, safe resource status/details, deployment metadata without logs, and environment key names without values. Normal application deploy and resource restart require exact interactive confirmation. Application configuration updates allow only `name`, `description`, `git_branch`, `base_directory`, `publish_directory`, `ports_exposes`, `watch_paths`, `health_check_enabled`, and `health_check_path`. One field is changed per operation; secrets, source URLs, commands, environment variables, domains, labels, and arbitrary payloads are excluded. The tool displays the exact current-to-proposed diff, requires exact elicitation confirmation, rechecks pinned server and single-server membership, and refuses if the current field changed. The final detail read validates UUID and server evidence. The initiating token and cancellation signal are rechecked immediately before every upstream write. The write uses only Coolify's fixed `PATCH /api/v1/applications/{uuid}` REST route and a one-field JSON body.

Coolify's current `GetApplication` clears loaded relations before serializing the application. `health_check_enabled` is a top-level application field; `is_auto_deploy_enabled` and `is_force_https_enabled` belong to `ApplicationSetting` and are excluded from this tool because MCP does not reliably supply their current values. Missing, null, or incorrectly typed current fields fail closed; no guessed defaults or Boolean coercion are used.

Diagnostics use a 100-entry in-memory ring buffer. A diagnostic event is fixed to an opaque ID, timestamp, operation enum, outcome enum, and bounded duration. It does not accept or serialize request arguments, resource identifiers, upstream responses, error text, tokens, or payloads. At most 50 entries are returned to the authenticated owner.

Excluded capabilities include secret read/write, shared/global settings, deletion, stop/cancel, force builds, tag/bulk operations, clone, migration, creation, previews, arbitrary upstream calls, and shell execution.

The host uses the MCP SDK OAuth router and `openid-client` for provider discovery, OAuth code exchange, PKCE S256, ID token validation including JWKS signature verification, nonce/state checks, and issuer/audience validation. It accepts a fixed OIDC issuer/client, pins one non-email `sub`, and denies login for any other subject. The SDK serves RFC 9728 protected-resource metadata and OAuth authorization-server metadata, and access tokens are bound to the exact `https://<public-origin>/mcp` resource. DCR is restricted to a single ChatGPT callback URI on the exact `https://chatgpt.com` origin. Public client metadata uses authenticated, process-local HMAC envelopes valid for 30 days, so unauthenticated registrations allocate no client-store entries. SDK endpoint rate limits remain enabled. Refresh tokens rotate; replay revokes the associated grant's access and refresh tokens. Token responses do not expose upstream issuer information. No undocumented Sites identity header is used. Client bearer tokens are verified locally and never forwarded to Coolify; only the deployment-configured Coolify team token is sent upstream.

The host retains one SDK server/transport per authenticated session, preserving initialization capabilities and pending elicitation responses. Sessions are bound to the owner subject and OAuth client ID, limited to 100, and expire after 15 minutes idle or one hour absolute. Every HTTP request requires the configured public Host and, when present, either the public origin or `https://chatgpt.com` as Origin. Forwarded headers do not override these checks; the TLS proxy must preserve the public Host. Session IDs confer no authorization without a current bearer token. Termination cancels pending work; a write already dispatched upstream cannot be undone.

OAuth signing keys, authorization-code, refresh-token/replay, access-token, and MCP session state are bounded and process-local. Access tokens last one hour; refresh tokens last up to 30 days, subject to the client's 30-day registration lifetime. Run one application replica; restart invalidates sessions and requires reconnecting. Multi-replica or restart-persistent hosting needs a shared, encrypted OAuth/session store and key management before that topology is enabled.

## Local development

Requirements: Node 22 or newer.

```sh
npm ci
npm run build
npm test
npm run mutation
```

After the activation gates below are satisfied, `npm start` runs the hosted HTTP server from `dist/src/host.js`.

All fixtures are synthetic. Tests cover SDK in-memory protocol plus real loopback HTTP sockets for discovery, OAuth endpoints, and stateful MCP elicitation. A synthetic signed OIDC issuer exercises the real `openid-client` discovery, claim, signature, and token validation. Test transport mapping permits only fixture destinations; no live infrastructure is accessed. HTTP tests cover PKCE, replay, expiry, revocation, cross-client binding, session isolation/limits, Host/Origin rejection, exact approvals, target drift, and write cancellation. CI runs the build, tests, and focused StrykerJS mutation testing over owner identity, configuration, allow-list, scope, confirmation, and error-redaction code. Hosted transport/authentication and upstream adapters have functional coverage but remain excluded from mutation runs to preserve the bounded scope.

The normal test command runs the full suite. Mutation test commands cap Vitest at two workers and stop at the first failed assertion: that already detects the mutant and avoids spending multiple approval-test deadlines on the same injected fault. Mutation scope and score thresholds remain unchanged.

## Activation gates

1. Choose an OIDC provider and register its confidential client with callback `https://<final-mcp-origin>/oauth/callback`. Set `OIDC_ISSUER`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET` in trusted deployment settings. The issuer must advertise PKCE S256. Store the client secret only in the host's secret manager.
2. Set `MCP_PUBLIC_ORIGIN` to the final trusted HTTPS origin, without path, query, fragment, credentials, or nonstandard port. This value must match the origin ChatGPT connects to. The previous HTTP dashboard address is not accepted for token-bearing traffic.
3. Pin the owner's stable non-email subject in `COOLIFY_OWNER_SUBJECT`. First-login enrollment is not supported.
4. The approved Coolify target is server **AI Agents**, UUID **pcrionkfci16zmkssngc6vaa**. Set both `COOLIFY_TARGET_SERVER_NAME` and `COOLIFY_TARGET_SERVER_UUID`; both are checked against current Coolify state on each tool call.
5. Set `COOLIFY_ORIGIN` to the confirmed HTTPS Coolify origin and provide the team-scoped token through the host secret manager. The token needs `read`, `deploy`, and `write` abilities for the enabled tools. Do not grant `read:sensitive` or `root`. Never put a live token in source control, `.env`, a prompt, or logs.
6. Confirm the host's connector approval and network access settings. Run one replica, and verify an owner session, a non-owner session, target resources, and off-target resources before activation. No live test or activation is part of this repository change.

This change creates no live connection and does not configure credentials or deploy the service. Remaining owner setup: choose the OIDC issuer/client, securely configure its client secret and stable owner subject, confirm the final HTTPS MCP and Coolify origins, enter a team token with `write`, configure the already-approved AI Agents server pin, and approve the ChatGPT connector in the hosting workspace. Do not use the cleartext dashboard address for bearer-token traffic.

## Supported interfaces checked

- [OpenAI Sites administration](https://developers.openai.com/codex/enterprise/sites): visitor-owned connected accounts, workspace plugin approval, and network access controls.
- [OpenAI Apps SDK MCP server guidance](https://developers.openai.com/plugins/build/mcp-server): MCP authorization is enforced server-side on every request.
- [Coolify MCP overview](https://coolify.io/docs/mcp/overview) and [how it works](https://coolify.io/docs/mcp/how-mcp-works): `/mcp`, Streamable HTTP, team-bound Bearer token, and response boundaries.
- [Coolify MCP pagination](https://coolify.io/docs/mcp/capabilities/pagination): list tools use pagination arguments and return continuation metadata.
- [Coolify MCP security](https://coolify.io/docs/mcp/security) and [API permissions](https://coolify.io/docs/api/permissions): least privilege and sensitive data constraints.
- [Coolify API route](https://github.com/coollabsio/coolify/blob/main/routes/api.php) and [application update controller](https://github.com/coollabsio/coolify/blob/main/app/Http/Controllers/Api/ApplicationsController.php): application PATCH route is guarded by `api.ability:write`; the current controller applies allowlisted request fields.
- [Coolify MCP application detail](https://github.com/coollabsio/coolify/blob/main/app/Mcp/Tools/GetApplication.php), [Application](https://github.com/coollabsio/coolify/blob/main/app/Models/Application.php), and [ApplicationSetting](https://github.com/coollabsio/coolify/blob/main/app/Models/ApplicationSetting.php): relation clearing, top-level field definitions, and settings placement checked on 2026-10-14.
