import { describe, expect, it } from "vitest";
import { createServer, type IncomingMessage } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

describe("container loopback health probe", () => {
  it.each([
    { status: 200, body: '{"status":"ok"}', exit: 0 },
    { status: 503, body: '{"status":"ok"}', exit: 1 },
    { status: 200, body: '{"status":"starting"}', exit: 1 },
    { status: 200, body: '{"status":"ok","extra":"unexpected"}', exit: 1 },
    { status: 200, body: 'invalid-json', exit: 1 },
    { status: 302, body: '', exit: 1 },
  ])("accepts only fixed successful health response: $status $body", async ({ status, body, exit }) => {
    let request: IncomingMessage | undefined;
    const server = createServer((req, res) => {
      request = req;
      res.writeHead(status, { "Content-Type": "application/json", ...(status === 302 ? { Location: "https://never-follow.example.test" } : {}) });
      res.end(body);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    try {
      const probe = spawn(process.execPath, ["docker/healthcheck.mjs"], { env: { PORT: String(address.port), COOLIFY_API_TOKEN: "synthetic-never-forward" }, stdio: "pipe" });
      expect((await once(probe, "exit"))[0]).toBe(exit);
      expect(request?.url).toBe("/healthz");
      expect(request?.headers.host).toBe(`127.0.0.1:${address.port}`);
      for (const header of ["origin", "authorization", "x-forwarded-for", "x-forwarded-host"]) expect(request?.headers[header]).toBeUndefined();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(["0", "-1", "65536", "not-a-port"])("fails closed for invalid PORT %s", async (port) => {
    const probe = spawn(process.execPath, ["docker/healthcheck.mjs"], { env: { PORT: port }, stdio: "pipe" });
    expect((await once(probe, "exit"))[0]).toBe(1);
  });
});
