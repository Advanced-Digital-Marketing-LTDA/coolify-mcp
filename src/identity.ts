import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { isStableOwnerSubject } from "./config.js";
import { AccessDeniedError, NotConfiguredError } from "./errors.js";

export type Principal = Readonly<{ subject: string }>;

/**
 * Implementations resolve identity only from server-verified OAuth token data.
 * The hosted adapter uses the pinned OIDC subject; it does not interpret
 * HTTP headers, email, or caller-supplied tool arguments as identity.
 */
export interface VerifiedIdentityProvider {
  resolve(authInfo: AuthInfo | undefined): Promise<Principal>;
}

export class UnconfiguredIdentityProvider implements VerifiedIdentityProvider {
  async resolve(_authInfo: AuthInfo | undefined): Promise<Principal> {
    throw new NotConfiguredError("Verified OAuth owner identity is not configured");
  }
}

export class OwnerIdentityGate {
  constructor(private readonly ownerSubject: string | undefined, private readonly provider: VerifiedIdentityProvider) {}

  async requireOwner(authInfo: AuthInfo | undefined): Promise<Principal> {
    if (!isStableOwnerSubject(this.ownerSubject)) {
      throw new NotConfiguredError("Pinned non-email owner subject is not configured");
    }
    const principal = await this.provider.resolve(authInfo);
    if (!isStableOwnerSubject(principal.subject) || principal.subject !== this.ownerSubject) {
      throw new AccessDeniedError("Authenticated identity is not the pinned owner");
    }
    return principal;
  }
}
