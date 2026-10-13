import { describe, expect, it, vi } from "vitest";
import { requestExactConfirmation, sanitizeConfirmationName } from "../src/confirmation.js";

describe("resource confirmation", () => {
  it("bounds and normalizes names, with a safe fallback for empty names", () => {
    expect(sanitizeConfirmationName(`\n\u202e ${"x".repeat(140)}`)).toBe("x".repeat(100));
    expect(sanitizeConfirmationName("\n\u202e : ()")).toBe("Unnamed resource");
  });

  it("uses a UUID-bound exact phrase and bounded elicitation request", async () => {
    const signal = AbortSignal.timeout(1_000);
    const sendRequest = vi.fn(async () => ({ action: "accept" as const, content: { confirmation: "DEPLOY app-alpha" } }));
    const extra = { signal, sendRequest } as never;

    await expect(requestExactConfirmation(extra, "deploy", "alpha", "app-alpha")).resolves.toBe(true);
    expect(sendRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "elicitation/create",
        params: expect.objectContaining({ message: "Confirm deploy for alpha (app-alpha). Type exactly: DEPLOY app-alpha" }),
      }),
      expect.anything(),
      { signal, timeout: 120_000 },
    );
    sendRequest.mockResolvedValueOnce({ action: "decline", content: { confirmation: "DEPLOY app-alpha" } });
    await expect(requestExactConfirmation(extra, "deploy", "alpha", "app-alpha")).resolves.toBe(false);
  });
});
