export class AccessDeniedError extends Error {
  constructor(message = "Access denied") {
    super(message);
    this.name = "AccessDeniedError";
  }
}

export class NotConfiguredError extends Error {
  constructor(message = "Coolify MCP is not configured") {
    super(message);
    this.name = "NotConfiguredError";
  }
}

export class ResourceScopeError extends Error {
  constructor(message = "Resource is outside the approved server scope") {
    super(message);
    this.name = "ResourceScopeError";
  }
}

export function publicError(error: unknown): string {
  if (error instanceof AccessDeniedError || error instanceof NotConfiguredError || error instanceof ResourceScopeError) {
    return error.message;
  }
  return "Coolify request failed; details were withheld.";
}
