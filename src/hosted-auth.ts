import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { InvalidClientMetadataError, InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Response } from "express";
import * as oidc from "openid-client";
import { isStableOwnerSubject } from "./config.js";

type PendingLogin = { state: string; nonce: string; verifier: string; params: AuthorizationParams; clientId: string; expiresAt: number };
type AuthCode = { challenge: string; owner: string; clientId: string; resource: string; redirectUri: string; expiresAt: number };
type IssuedToken = AuthInfo & { expiresAt: number; grantId: string };
type RefreshToken = { owner: string; clientId: string; resource: string; scopes: string[]; expiresAt: number; grantId: string };
const MAX_ENTRIES = 2_000;
const TTL_MS = 10 * 60_000;
const randomToken = () => randomBytes(32).toString("base64url");

/** OAuth 2.1 adapter using MCP SDK endpoints and panva's maintained OIDC client. */
export class HostedOAuthProvider implements OAuthServerProvider {
  // Registration holds no per-client state. These public metadata envelopes are
  // authenticated with a process-local MAC; they contain no tokens or secrets.
  private readonly registrationKey = randomBytes(32);
  private readonly logins = new Map<string, PendingLogin>();
  private readonly codes = new Map<string, AuthCode>();
  private readonly tokens = new Map<string, IssuedToken>();
  private readonly refresh = new Map<string, RefreshToken>();
  private readonly usedRefresh = new Map<string, RefreshToken>();
  private constructor(private readonly config: oidc.Configuration, private readonly clientId: string, readonly resourceUri: string, private readonly ownerSubject: string) {}

  static async create(options: { issuer: string; clientId: string; clientSecret: string; resourceUri: string; ownerSubject: string }): Promise<HostedOAuthProvider> {
    const issuer = new URL(options.issuer);
    const resource = new URL(options.resourceUri);
    if (issuer.protocol !== "https:" || resource.protocol !== "https:" || !options.clientId || !options.clientSecret || !isStableOwnerSubject(options.ownerSubject)) throw new Error("Hosted OAuth configuration is incomplete or unsafe");
    const config = await oidc.discovery(issuer, options.clientId, options.clientSecret, undefined, { execute: [oidc.enableNonRepudiationChecks] });
    if (!config.serverMetadata().code_challenge_methods_supported?.includes("S256")) throw new Error("Identity provider must advertise PKCE S256");
    return new HostedOAuthProvider(config, options.clientId, resource.href, options.ownerSubject);
  }

  get clientsStore() {
    return {
      getClient: async (id: string) => this.readClient(id),
      registerClient: async (metadata: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">) => {
        this.prune();
        const grants = metadata.grant_types ?? ["authorization_code", "refresh_token"];
        const responseTypes = metadata.response_types ?? ["code"];
        const scopes = metadata.scope?.split(/\s+/).filter(Boolean) ?? ["mcp"];
        if (metadata.token_endpoint_auth_method !== "none" ||
          !Array.isArray(metadata.redirect_uris) || metadata.redirect_uris.length !== 1 || !metadata.redirect_uris.every(isChatGptCallback) ||
          !grants.includes("authorization_code") || grants.some((grant) => grant !== "authorization_code" && grant !== "refresh_token") ||
          responseTypes.length !== 1 || responseTypes[0] !== "code" || scopes.length !== 1 || scopes[0] !== "mcp") {
          throw new InvalidClientMetadataError("Only the supported ChatGPT OAuth client registration is accepted");
        }
        const payload = Buffer.from(JSON.stringify({ redirect: String(metadata.redirect_uris[0]), issuedAt: Math.floor(Date.now() / 1000) })).toString("base64url");
        const id = `${payload}.${this.clientMac(payload).toString("base64url")}`;
        return this.readClient(id)!;
      },
    };
  }

  private clientMac(payload: string): Buffer { return createHmac("sha256", this.registrationKey).update(payload).digest(); }

  private readClient(id: string): OAuthClientInformationFull | undefined {
    if (id.length > 2_048) return undefined;
    const [payload, signature, extra] = id.split(".");
    if (!payload || !signature || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(payload + signature)) return undefined;
    const provided = Buffer.from(signature, "base64url"), expected = this.clientMac(payload);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return undefined;
    try {
      const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as { redirect: unknown; issuedAt: unknown };
      const now = Date.now() / 1000;
      if (!isChatGptCallback(data.redirect) || typeof data.issuedAt !== "number" || !Number.isSafeInteger(data.issuedAt) || data.issuedAt > now || now - data.issuedAt >= 30 * 86_400) return undefined;
      return { client_id: id, client_id_issued_at: data.issuedAt, redirect_uris: [String(data.redirect)], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], client_name: "ChatGPT", scope: "mcp" } as OAuthClientInformationFull;
    } catch { return undefined; }
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, response: Response): Promise<void> {
    this.prune();
    if (params.resource?.href !== this.resourceUri || !params.scopes?.includes("mcp") || params.scopes.some((s) => s !== "mcp") || this.logins.size >= MAX_ENTRIES) throw new Error("Invalid OAuth scope or resource");
    const state = randomToken();
    const nonce = oidc.randomNonce();
    const verifier = oidc.randomPKCECodeVerifier();
    const challenge = await oidc.calculatePKCECodeChallenge(verifier);
    this.logins.set(state, { state, nonce, verifier, params: { ...params }, clientId: client.client_id, expiresAt: Date.now() + TTL_MS });
    const callback = new URL("/oauth/callback", this.resourceUri).href;
    const url = oidc.buildAuthorizationUrl(this.config, {
      response_type: "code", client_id: this.clientId, redirect_uri: callback,
      scope: "openid profile", state, nonce, code_challenge: challenge, code_challenge_method: "S256",
    });
    response.redirect(302, url.href);
  }

  async completeLogin(callbackUrl: URL): Promise<string> {
    const state = callbackUrl.searchParams.get("state");
    const pending = state ? this.logins.get(state) : undefined;
    if (!pending || pending.expiresAt < Date.now()) throw new Error("Invalid authorization callback");
    this.logins.delete(state!);
    const tokens = await oidc.authorizationCodeGrant(this.config, callbackUrl, {
      expectedState: pending.state, expectedNonce: pending.nonce,
      pkceCodeVerifier: pending.verifier,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    const subject = typeof claims?.sub === "string" ? claims.sub : "";
    if (!isStableOwnerSubject(subject) || subject !== this.ownerSubject) throw new Error("Identity provider returned a different owner");
    if (this.codes.size >= MAX_ENTRIES) throw new Error("OAuth authorization-code store is full");
    const code = randomToken();
    this.codes.set(code, { challenge: pending.params.codeChallenge, owner: subject, clientId: pending.clientId, resource: pending.params.resource?.href ?? "", redirectUri: pending.params.redirectUri, expiresAt: Date.now() + TTL_MS });
    const redirect = new URL(pending.params.redirectUri);
    redirect.searchParams.set("code", code);
    if (pending.params.state) redirect.searchParams.set("state", pending.params.state);
    return redirect.href;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const row = this.codes.get(code);
    if (!row || row.clientId !== client.client_id || row.expiresAt <= Date.now()) throw new InvalidGrantError("Invalid authorization code");
    return row.challenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const row = this.codes.get(code);
    if (!row || row.clientId !== client.client_id || row.expiresAt <= Date.now() || row.resource !== resource?.href || row.redirectUri !== redirectUri) throw new InvalidGrantError("Invalid authorization code");
    this.codes.delete(code);
    return this.issue(row.owner, client.client_id, row.resource, ["mcp"]);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, token: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    this.prune();
    const replayed = this.usedRefresh.get(token);
    if (replayed?.clientId === client.client_id) { this.revokeFamily(replayed.grantId); throw new InvalidGrantError("Invalid refresh token"); }
    const row = this.refresh.get(token);
    if (!row || row.clientId !== client.client_id || row.expiresAt <= Date.now() || row.resource !== resource?.href || (scopes && scopes.some((s) => !row.scopes.includes(s)))) throw new InvalidGrantError("Invalid refresh token");
    if (this.usedRefresh.size >= MAX_ENTRIES) throw new Error("OAuth replay store is full");
    this.refresh.delete(token);
    this.usedRefresh.set(token, row);
    return this.issue(row.owner, row.clientId, row.resource, scopes ?? row.scopes, row.grantId);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    this.prune();
    const row = this.tokens.get(token);
    if (!row || row.expiresAt <= Date.now() / 1000) throw new InvalidTokenError("Invalid access token");
    return row;
  }

  async revokeToken(client: OAuthClientInformationFull, request: { token: string }): Promise<void> {
    const access = this.tokens.get(request.token);
    const row = access ?? this.refresh.get(request.token);
    if (row?.clientId === client.client_id) this.revokeFamily(row.grantId);
  }

  private revokeFamily(grantId: string): void {
    for (const [key, row] of this.tokens) if (row.grantId === grantId) this.tokens.delete(key);
    for (const [key, row] of this.refresh) if (row.grantId === grantId) this.refresh.delete(key);
  }

  private issue(owner: string, clientId: string, resource: string, scopes: string[], grantId: string = randomUUID()): OAuthTokens {
    this.prune();
    if (this.tokens.size >= MAX_ENTRIES || this.refresh.size >= MAX_ENTRIES) throw new Error("OAuth token store is full");
    const token = randomToken();
    const refreshToken = randomToken();
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    this.tokens.set(token, { token, clientId, scopes, resource: new URL(resource), expiresAt, grantId, extra: { ownerSubject: owner } });
    this.refresh.set(refreshToken, { owner, clientId, resource, scopes, expiresAt: Date.now() + 30 * 86_400_000, grantId });
    return { access_token: token, token_type: "Bearer", expires_in: 3600, scope: scopes.join(" "), refresh_token: refreshToken };
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, row] of this.logins) if (row.expiresAt < now) this.logins.delete(key);
    for (const [key, row] of this.codes) if (row.expiresAt < now) this.codes.delete(key);
    for (const [key, row] of this.tokens) if (row.expiresAt * 1000 < now) this.tokens.delete(key);
    for (const [key, row] of this.refresh) if (row.expiresAt < now) this.refresh.delete(key);
    for (const [key, row] of this.usedRefresh) if (row.expiresAt < now) this.usedRefresh.delete(key);
  }
}

function isChatGptCallback(value: unknown): value is URL {
  try {
    const url = value instanceof URL ? value : new URL(String(value));
    return url.origin === "https://chatgpt.com" && !url.username && !url.password && /^\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname) && !url.search && !url.hash;
  } catch { return false; }
}
