import express, { type NextFunction, type Request, type Response } from "express";
import { basename } from "node:path";
import { isIP } from "node:net";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { isHostedConfigured, readRuntimeConfig } from "./config.js";
import { CoolifyMcpProvider } from "./coolify.js";
import { CoolifyApplicationConfigWriter } from "./coolify-rest.js";
import { DiagnosticLog } from "./diagnostics.js";
import { HostedOAuthProvider } from "./hosted-auth.js";
import type { VerifiedIdentityProvider } from "./identity.js";
import { createCoolifyMcpServer } from "./server.js";

export async function createHostedApp(env: NodeJS.ProcessEnv = process.env) {
  const config = readRuntimeConfig(env);
  if (!isHostedConfigured(config)) throw new Error("Hosted MCP is inactive: complete owner, final HTTPS origin, OIDC, Coolify target, and Coolify token setup");
  // Only explicit ingress addresses may supply client IPs for OAuth quotas.
  const trustedProxies = (env.MCP_TRUSTED_PROXY_CIDRS ?? "").split(",").map((value) => value.trim());
  if (trustedProxies.length > 32 || trustedProxies.some((value) => {
    const parts = value.split("/");
    const version = isIP(parts[0] ?? "");
    return !version || parts.length > 2 || (parts.length === 2 && (!/^[1-9][0-9]*$/.test(parts[1]!) || Number(parts[1]) > (version === 4 ? 32 : 128)));
  })) throw new Error("Hosted MCP is inactive: configure explicit trusted ingress IP addresses or CIDRs");
  const resourceUri = new URL("/mcp", config.publicOrigin!).href;
  const issuerUrl = new URL(config.publicOrigin!);
  const oauth = await HostedOAuthProvider.create({ issuer: config.oidcIssuer!, clientId: config.oidcClientId!, clientSecret: config.oidcClientSecret!, resourceUri, ownerSubject: config.ownerSubject! });
  const { provider, close } = await CoolifyMcpProvider.connect(config.apiToken, config.origin);
  const configWriter = new CoolifyApplicationConfigWriter(config.origin, config.apiToken);
  const diagnostics = new DiagnosticLog(100);
  const identity: VerifiedIdentityProvider = { resolve: async (authInfo: AuthInfo | undefined) => {
    const subject = (await oauth.verifyAccessToken(authInfo?.token ?? "")).extra?.ownerSubject;
    if (typeof subject !== "string") throw new Error("Authenticated owner identity is unavailable");
    return { subject };
  } };

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", trustedProxies);
  // Validate the direct Host, never caller-supplied forwarding headers. The TLS
  // proxy must preserve the public Host. Browser requests use these fixed origins.
  const host = new URL(config.publicOrigin!).host;
  const allowedOrigins = new Set([config.publicOrigin!, "https://chatgpt.com"]);
  app.use((req, res, next) => {
    if (req.headers.host !== host || (req.headers.origin !== undefined && !allowedOrigins.has(req.headers.origin))) {
      res.status(403).json({ error: "Request origin is not permitted" }); return;
    }
    next();
  });
  app.use(express.json({ limit: "64kb", strict: true }));
  app.get("/.well-known/oauth-authorization-server", (_req, res) => res.set("Cache-Control", "no-store").json({
    issuer: issuerUrl.href,
    authorization_endpoint: `${config.publicOrigin}/authorize`,
    token_endpoint: `${config.publicOrigin}/token`,
    registration_endpoint: `${config.publicOrigin}/register`,
    revocation_endpoint: `${config.publicOrigin}/revoke`,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    scopes_supported: ["mcp"],
  }));
  app.use(mcpAuthRouter({
    provider: oauth,
    issuerUrl,
    baseUrl: new URL(config.publicOrigin!),
    resourceServerUrl: new URL(resourceUri),
    scopesSupported: ["mcp"],
    resourceName: "Coolify MCP",
  }));
  app.get("/oauth/callback", async (req, res) => {
    const started = Date.now();
    try {
      const url = new URL(req.originalUrl, config.publicOrigin);
      res.redirect(302, await oauth.completeLogin(url));
      diagnostics.record("auth", "ok", Date.now() - started);
    } catch {
      diagnostics.record("auth", "denied", Date.now() - started);
      res.status(400).type("text/plain").send("Authentication could not be completed.");
    }
  });
  app.use("/mcp", (req, res, next) => {
    const started = Date.now();
    res.once("finish", () => {
      if (!(req as typeof req & { auth?: AuthInfo }).auth) diagnostics.record("auth", "denied", Date.now() - started);
    });
    next();
  });
  const auth = requireBearerAuth({ verifier: oauth, requiredScopes: ["mcp"], expectedResource: new URL(resourceUri), resourceMetadataUrl: `${config.publicOrigin}/.well-known/oauth-protected-resource/mcp` });
  type Session = { mcp: ReturnType<typeof createCoolifyMcpServer>; transport: StreamableHTTPServerTransport; clientId: string; subject: string; createdAt: number; lastUsed: number };
  const sessions = new Map<string, Session>();
  const maxSessions = 100;
  const idleTtl = 15 * 60_000;
  const absoluteTtl = 60 * 60_000;
  let pendingSessions = 0;
  const closeSession = async (id: string, session: Session) => {
    sessions.delete(id);
    await session.mcp.close().catch(() => undefined);
  };
  const pruneSessions = async () => {
    const now = Date.now();
    await Promise.all([...sessions].filter(([, row]) => now - row.lastUsed >= idleTtl || now - row.createdAt >= absoluteTtl).map(([id, row]) => closeSession(id, row)));
  };
  const sweep = setInterval(() => { void pruneSessions(); }, 60_000);
  sweep.unref();
  app.all("/mcp", auth, async (req, res) => {
    await pruneSessions();
    const subject = req.auth?.extra?.ownerSubject;
    if (typeof subject !== "string" || subject !== config.ownerSubject || !req.auth?.clientId) { res.status(403).json({ error: "Owner access is required" }); return; }
    const id = req.headers["mcp-session-id"];
    if (id) {
      const row = typeof id === "string" ? sessions.get(id) : undefined;
      if (!row || row.clientId !== req.auth.clientId || row.subject !== subject) { res.status(404).json({ error: "Session not found" }); return; }
      row.lastUsed = Date.now();
      try { await row.transport.handleRequest(req, res, req.body); }
      catch { if (!res.headersSent) res.status(500).json({ error: "MCP request failed" }); }
      return;
    }
    if (req.method !== "POST" || !isInitializeRequest(req.body)) { res.status(400).json({ error: "MCP initialization is required" }); return; }
    if (sessions.size + pendingSessions >= maxSessions) { res.status(503).json({ error: "MCP session capacity reached" }); return; }
    pendingSessions++;
    const mcp = createCoolifyMcpServer({ config, identity, provider, configWriter, diagnostics });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      allowedHosts: [host], allowedOrigins: [...allowedOrigins], enableDnsRebindingProtection: true,
      onsessioninitialized: (sessionId) => {
        const now = Date.now();
        sessions.set(sessionId, { mcp, transport, clientId: req.auth!.clientId, subject, createdAt: now, lastUsed: now });
      },
      onsessionclosed: (sessionId) => { sessions.delete(sessionId); },
    });
    transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
    try {
      await mcp.connect(transport as unknown as Transport);
      // connect installs its own onclose handler; preserve protocol cleanup and
      // remove the host's ownership record whenever this transport closes.
      const onclose = transport.onclose;
      transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); onclose?.(); };
      await transport.handleRequest(req, res, req.body);
    } catch {
      await mcp.close().catch(() => undefined);
      if (!res.headersSent) res.status(500).json({ error: "MCP request failed" });
    } finally {
      pendingSessions--;
      if (!transport.sessionId) await mcp.close().catch(() => undefined);
    }
  });
  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  // Express's default parser error page can echo input or stack traces. Neither
  // the HTTP response nor console diagnostics may include those error objects.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
    if (!res.headersSent) res.status(status === 400 || status === 413 ? status : 500).json({ error: "Request could not be processed" });
    else res.end();
  });
  return { app, close: async () => { clearInterval(sweep); await Promise.all([...sessions].map(([id, row]) => closeSession(id, row))); await close(); } };
}

/** Close transports before waiting for long-lived HTTP streams to finish. */
export async function closeHostedListener(listener: Server, close: () => Promise<void>): Promise<void> {
  const stopped = new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  try { await close(); }
  finally { listener.closeAllConnections(); await stopped; }
}

if (basename(process.argv[1] ?? "") === "host.js" || basename(process.argv[1] ?? "") === "host.ts") {
  void createHostedApp().then(({ app, close }) => {
    const port = Number(process.env.PORT ?? "3000");
    const listener = app.listen(port, "0.0.0.0");
    const shutdown = () => { void closeHostedListener(listener, close).catch(() => { process.exitCode = 1; }); };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }).catch(() => {
    console.error("Hosted MCP startup failed; verify activation settings and connectivity.");
    process.exitCode = 1;
  });
}
