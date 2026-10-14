# Owner setup (Phase 3)

These steps resolve the two owner gates before any deployment: choosing the HTTPS origin and OIDC client (COOLIFY-8) and entering owner-only runtime secrets (COOLIFY-9). Nothing here deploys the service or connects a client; Phase 4 stays gated on the owner's explicit approval.

Never paste secret values into chat, issues, source, `.env`, Compose overrides, shell history or CI logs. The preflight below only ever reports secrets as present or absent.

## 1. Choose the HTTPS origin and OIDC client (COOLIFY-8)

Record these non-secret decisions in the tracker:

| Decision | Rule |
| --- | --- |
| `MCP_PUBLIC_ORIGIN` | Final `https://host` the connector will use. No path, query, credentials or port. Do not reuse the cleartext dashboard address; reserved names such as `*.example.com`, `*.test` and `localhost` are rejected. |
| OIDC provider and `OIDC_ISSUER` | HTTPS issuer URL exactly as the provider's discovery document states it. The provider must advertise the authorization code flow and PKCE `S256`. |
| `OIDC_CLIENT_ID` | A confidential web client registered for this bridge only. |
| Redirect URI | Register exactly `<MCP_PUBLIC_ORIGIN>/oauth/callback` with the client. The preflight prints the exact value. |
| `COOLIFY_OWNER_SUBJECT` | The owner's stable `sub` claim, never an email. Some providers issue a different subject per client, so read it from an ID token issued to this exact client. It is not a credential, but keep it with the secrets so it is not published. |
| `COOLIFY_ORIGIN` | Confirmed HTTPS Coolify origin, no port. |

The bridge requests only the `openid profile` scopes and pins exactly one subject; there is no first-login enrollment.

## 2. Enter owner-only runtime settings (COOLIFY-9)

Enter these in the host's secret manager as runtime environment variables (never build arguments or files in the image):

| Setting | Notes |
| --- | --- |
| `OIDC_CLIENT_SECRET` | From the client registered in step 1. |
| `COOLIFY_OWNER_SUBJECT` | From step 1. |
| `COOLIFY_API_TOKEN` | A team-scoped Coolify API token with `read`, `deploy` and `write` only. Do not grant `read:sensitive` or `root`. |
| `COOLIFY_ORIGIN`, `MCP_PUBLIC_ORIGIN`, `OIDC_ISSUER`, `OIDC_CLIENT_ID` | Non-secret values decided in step 1. |
| `COOLIFY_TARGET_SERVER_NAME` | `AI Agents` |
| `COOLIFY_TARGET_SERVER_UUID` | `pcrionkfci16zmkssngc6vaa` (the approved server; the preflight rejects any other) |
| `MCP_TRUSTED_PROXY_CIDRS` | The TLS ingress peer address as seen inside the container, at most 32 explicit IPs or CIDRs. See the Docker section of the README for how to find it; do not trust the whole bridge subnet. |

## 3. Run the preflight

With the settings injected into the process environment (for example `docker compose run --rm mcp node dist/src/preflight.js`, which Compose refuses to start until every required variable is set, or `npm run build && npm run preflight` from a checkout), the preflight checks every setting offline and prints the redirect URI to register and the connector MCP URL:

```text
ok      MCP_PUBLIC_ORIGIN           https://<your-mcp-host>
ok      OIDC_CLIENT_SECRET          set (value hidden)
...
Register this OIDC redirect URI: https://<your-mcp-host>/oauth/callback
Connector MCP URL:              https://<your-mcp-host>/mcp
```

Add `--discover` to also fetch the issuer's public discovery document and confirm it advertises the code flow and PKCE `S256`. This sends no credentials. The command exits non-zero until every check passes. A passing preflight does not deploy anything or approve Phase 4.
