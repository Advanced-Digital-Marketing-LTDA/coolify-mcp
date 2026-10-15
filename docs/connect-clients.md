# Connect ChatGPT and Claude (Phase 4)

Do not follow this page until the owner has explicitly approved deployment (COOLIFY-10) and the preflight in [owner-setup.md](owner-setup.md) passes against the deployed settings. It covers COOLIFY-11 (ChatGPT) and COOLIFY-12 (Claude). Never paste credentials, tokens or the owner subject into either client, chat or the tracker.

Both clients connect to the same bridge with the **Connector MCP URL** the preflight prints (`https://<MCP_PUBLIC_ORIGIN>/mcp`). Neither needs a client ID or secret: each registers itself through dynamic client registration, and the bridge accepts only its fixed callback.

| Client | Callback the bridge accepts | Where to add it |
| --- | --- | --- |
| ChatGPT | `https://chatgpt.com/connector/oauth/<id>` | Add the connector in the ChatGPT workspace and have a workspace admin approve it. |
| Claude (web, Desktop, mobile, Cowork) | `https://claude.ai/api/mcp/auth_callback` | Install the Claude plugin below, or add a custom connector with the MCP URL and leave the OAuth client ID and secret blank. |

Claude Code uses a loopback callback and is refused by design. If a firewall or WAF sits in front of the MCP host or the OIDC provider, allow Claude's egress range `160.79.104.0/21` ([source](https://claude.com/docs/connectors/building/authentication#network-reference)).

## Claude plugin

The `plugin/` folder is a Claude plugin that bundles the connector with a `coolify-operations` skill telling Claude to stay on the AI Agents server, look up UUIDs before acting, and leave the typed confirmations to the owner. Claude's hosted apps ignore a templated connector URL, so the URL is fixed when the plugin is built:

```sh
MCP_PUBLIC_ORIGIN=https://<your-mcp-host> npm run plugin
```

The build applies the same origin rules as the preflight and writes `dist/claude-plugin/coolify-ai-agents/` and `coolify-ai-agents.zip`. The plugin contains no credentials. In Claude, open Customize > Plugins, choose Add > Upload plugin, select the zip, then connect `coolify` from the plugin's Connectors tab and sign in as the owner. The plugin is meant for Claude's hosted apps; installing it in Claude Code is refused at sign-in like any loopback client.

## Acceptance checks

Run these once per client before using it for real work. Each one must pass; stop and report on any failure.

1. **Owner login.** Connect the client and sign in at the OIDC provider as the owner. The connection completes and the tool list loads.
2. **Non-owner denial.** Sign in with any other account at the same provider (or have someone else try). The bridge shows "Authentication could not be completed." and the client gets no token.
3. **Pinned target.** Ask the client to run `coolify_inventory`. Only resources on the **AI Agents** server (`pcrionkfci16zmkssngc6vaa`) appear.
4. **Off-target isolation.** Ask the client to run `coolify_resource_status` on the UUID of a resource on another server in the same Coolify team. The call is refused; nothing outside AI Agents is shown or changed.
5. **Audit.** Run `coolify_diagnostic_logs` and confirm the denied login and refused off-target call were recorded.

Record pass or fail for each check on COOLIFY-11 and COOLIFY-12, without screenshots that show tokens or the owner subject.
