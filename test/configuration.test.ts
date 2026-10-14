import { describe, expect, it, vi } from "vitest";
import { CoolifyApplicationConfigWriter } from "../src/coolify-rest.js";
import { DiagnosticLog } from "../src/diagnostics.js";
import { APPLICATION_CONFIG_FIELDS, validateApplicationConfig } from "../src/policy.js";

describe("application configuration writes", () => {
  it("sends a single safe field to the fixed HTTPS Coolify API route", async () => {
    const request = vi.fn(async (_input: URL | RequestInfo, _init?: RequestInit) => new Response(JSON.stringify({ uuid: "app-one" }), { status: 200 }));
    const writer = new CoolifyApplicationConfigWriter("https://coolify.example.test", "synthetic-token", request as typeof fetch);
    await writer.update("app-one", "description", "A safe description");
    expect(request).toHaveBeenCalledOnce();
    const [input, init] = request.mock.calls[0]!;
    expect((input as URL).href).toBe("https://coolify.example.test/api/v1/applications/app-one");
    expect(init).toMatchObject({ method: "PATCH", redirect: "error", headers: { Authorization: "Bearer synthetic-token", "Content-Type": "application/json" }, body: '{"description":"A safe description"}' });
  });

  it("rejects unsafe origins, path identifiers, fields, and control characters", async () => {
    const request = vi.fn();
    const writer = new CoolifyApplicationConfigWriter("http://169.58.185.96:8000", "synthetic-token", request as typeof fetch);
    await expect(writer.update("app-one", "description", "x")).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    expect(validateApplicationConfig("manual_webhook_secret_github", "x")).toBe(false);
    expect(validateApplicationConfig("is_auto_deploy_enabled", true)).toBe(false);
    expect(validateApplicationConfig("is_force_https_enabled", true)).toBe(false);
    expect(validateApplicationConfig("description", "line\nbreak")).toBe(false);
    const valid = new CoolifyApplicationConfigWriter("https://coolify.example.test", "synthetic-token", request as typeof fetch);
    await expect(valid.update("app/../one", "name", "x")).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects nonmatching response UUIDs without returning response details", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ uuid: "other-app", secret: "fixture-secret" }), { status: 200 }));
    const writer = new CoolifyApplicationConfigWriter("https://coolify.example.test", "synthetic-token", request as typeof fetch);
    await expect(writer.update("app-one", "name", "safe")).rejects.toThrow(/did not match/);
  });

  it.each(["deadline", "caller"])("bounds the PATCH with a 30-second deadline and caller cancellation: %s", async (source) => {
    const caller = new AbortController();
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let observed: AbortSignal | undefined;
    const request = vi.fn((_input: URL | RequestInfo, init?: RequestInit) => {
      observed = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => observed?.addEventListener("abort", () => reject(new Error("Synthetic request aborted")), { once: true }));
    });
    try {
      const writer = new CoolifyApplicationConfigWriter("https://coolify.example.test", "synthetic-token", request as typeof fetch);
      const pending = writer.update("app-one", "name", "safe", caller.signal);
      expect(observed).toBeDefined();
      expect(timeout).toHaveBeenCalledWith(30_000);
      (source === "caller" ? caller : deadline).abort();
      await expect(pending).rejects.toThrow("Synthetic request aborted");
    } finally { timeout.mockRestore(); }
  });

  it("refuses a cancelled configuration write before opening an upstream request", async () => {
    const caller = new AbortController();
    caller.abort();
    const request = vi.fn();
    const writer = new CoolifyApplicationConfigWriter("https://coolify.example.test", "synthetic-token", request as typeof fetch);
    await expect(writer.update("app-one", "name", "safe", caller.signal)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("cancels an upstream error body without reading sensitive content", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    const request = vi.fn(async () => new Response(body, { status: 500 }));
    const writer = new CoolifyApplicationConfigWriter("https://coolify.example.test", "synthetic-token", request as typeof fetch);
    await expect(writer.update("app-one", "name", "safe")).rejects.toThrow("Coolify application configuration update failed");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds the upstream configuration response body", async () => {
    const request = vi.fn(async () => new Response("x".repeat(5_000), { status: 200 }));
    const writer = new CoolifyApplicationConfigWriter("https://coolify.example.test", "synthetic-token", request as typeof fetch);
    await expect(writer.update("app-one", "name", "safe")).rejects.toThrow("response was invalid");
  });

  it.each(["/health;fixture", "/$(fixture)", "/`fixture`", "/health|fixture", "/health&fixture", "/health>fixture", "/health<fixture", "/health'fixture", '/health"fixture', "/health fixture", "/health\\fixture", "/health?query=value", "/health#fragment", "/%24%28fixture%29"])("rejects shell-significant or ambiguous health-check paths: %s", (path) => {
    expect(validateApplicationConfig("health_check_path", path)).toBe(false);
  });

  it.each(["/", "/health", "/health/ready", "/health-check_v1.0~ready"])("permits literal unreserved health-check paths: %s", (path) => {
    expect(validateApplicationConfig("health_check_path", path)).toBe(true);
  });

  it("validates every allowlisted field type and value boundary", () => {
    const booleanFields = new Set(["health_check_enabled", "is_auto_deploy_enabled", "is_force_https_enabled"]);
    for (const field of APPLICATION_CONFIG_FIELDS) {
      const sample = field === "ports_exposes" ? "80,3000" : field === "health_check_path" ? "/health" : "safe value";
      expect(validateApplicationConfig(field, booleanFields.has(field) ? true : sample)).toBe(true);
      expect(validateApplicationConfig(field, booleanFields.has(field) ? "true" : false)).toBe(false);
    }
    expect(validateApplicationConfig("description", "x".repeat(2_000))).toBe(true);
    expect(validateApplicationConfig("description", "x".repeat(2_001))).toBe(false);
    expect(validateApplicationConfig("description", "bidi\u202eattack")).toBe(false);
    expect(validateApplicationConfig("description", "line\u2028separator")).toBe(false);
    expect(validateApplicationConfig("description", "paragraph\u2029separator")).toBe(false);
    expect(validateApplicationConfig("ports_exposes", "80,3000")).toBe(true);
    expect(validateApplicationConfig("ports_exposes", "1")).toBe(true);
    expect(validateApplicationConfig("ports_exposes", "65535")).toBe(true);
    expect(validateApplicationConfig("ports_exposes", "0,80000")).toBe(false);
    expect(validateApplicationConfig("ports_exposes", "65536")).toBe(false);
    expect(validateApplicationConfig("ports_exposes", "80,")).toBe(false);
    expect(validateApplicationConfig("ports_exposes", "")).toBe(true);
    expect(validateApplicationConfig("health_check_path", "/ready")).toBe(true);
    expect(validateApplicationConfig("health_check_path", "")).toBe(true);
    expect(validateApplicationConfig("health_check_path", "health")).toBe(false);
    expect(validateApplicationConfig("health_check_path", "https://example.test/health")).toBe(false);
    expect(validateApplicationConfig("health_check_path", "/https://example.test/health")).toBe(false);
    expect(validateApplicationConfig("health_check_path", "/../outside")).toBe(false);
    expect(validateApplicationConfig("unknown", "x")).toBe(false);
  });
});

describe("diagnostic ring buffer", () => {
  it("keeps only a bounded fixed metadata shape", () => {
    const log = new DiagnosticLog(2);
    log.record("inventory", "ok", 12);
    log.record("deploy", "failed", 10_000_000);
    log.record("restart", "denied", -100);
    expect(log.read(50)).toHaveLength(2);
    expect(log.read(1)[0]).toMatchObject({ operation: "restart", outcome: "denied", durationMs: 0 });
    expect(JSON.stringify(log.read())).not.toMatch(/token|secret|payload|resourceUuid/i);
    expect(log.read(999)).toHaveLength(2);
  });
});
