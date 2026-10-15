---
name: coolify-operations
description: Use when the owner asks about apps, databases, services, deployments or restarts on the Coolify AI Agents server through the coolify connector.
---

# Coolify AI Agents operations

The `coolify` connector reaches one Coolify server only: **AI Agents** (`pcrionkfci16zmkssngc6vaa`). Anything on another server is out of scope and the bridge refuses it.

## Read first

1. Start with `coolify_inventory` to find resource UUIDs. Never guess or invent a UUID.
2. Use `coolify_resource_status`, `coolify_deployment_history` and `coolify_environment_key_names` to answer questions. Environment values and build logs are never returned; do not try to obtain them another way.

## Changes need the owner's typed confirmation

`coolify_deploy_application`, `coolify_restart_resource` and `coolify_update_application_configuration` each ask the owner to type an exact confirmation string in a form. Before calling one:

- Say which resource (name and UUID) and what will change, and call the tool only when the owner asked for that change.
- Never fill in or suggest the confirmation text on the owner's behalf. If the owner declines or the text does not match, the change is not made; report that and stop.
- Make one change at a time. Force builds, previews, stop and cancel are not supported.

## Never

- Ask for, repeat or store tokens, secrets, environment values or the owner's OIDC subject.
- Retry a refused call against a different server or resource to work around scope.

If a call is refused or fails, run `coolify_diagnostic_logs` and report the operation and outcome it shows.
