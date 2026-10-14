import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { requireFreePort, verifyHostedChild } from "./smoke/lifecycle.mjs";

async function child(cleanShutdown: boolean) {
  const host = spawn(process.execPath, ["-e", `${cleanShutdown ? 'process.once("SIGTERM", () => process.exit(0));' : ''} process.send("ready"); setInterval(() => {}, 1000);`], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  await once(host, "message");
  return host;
}

describe("local smoke lifecycle", () => {
  it("preserves the check failure even when cleanup ends by signal", async () => {
    const host = await child(false);
    const original = new Error("Synthetic original check failure");
    await expect(verifyHostedChild(host, () => { throw original; })).rejects.toBe(original);
    expect(host.signalCode).toBe("SIGTERM");
  });

  it("still rejects dirty shutdown after successful checks", async () => {
    const host = await child(false);
    await expect(verifyHostedChild(host, async () => {})).rejects.toThrow("Host did not shut down cleanly");
  });

  it("preserves the original failure when a stuck host requires SIGKILL", async () => {
    const host = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); process.send("ready"); setInterval(() => {}, 1000);'], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    await once(host, "message");
    const original = new Error("Synthetic failure before forced cleanup");
    await expect(verifyHostedChild(host, () => { throw original; }, 25)).rejects.toBe(original);
    expect(host.signalCode).toBe("SIGKILL");
  });

  it("accepts a clean shutdown after successful checks", async () => {
    const host = await child(true);
    await expect(verifyHostedChild(host, async () => {})).resolves.toBeUndefined();
    expect(host.exitCode).toBe(0);
  });

  it("fails promptly on early host exit and aborts the pending check", async () => {
    const host = spawn(process.execPath, ["-e", "process.exit(7)"], { stdio: "ignore" });
    let checkSignal: AbortSignal | undefined;
    await expect(verifyHostedChild(host, (signal: AbortSignal) => {
      checkSignal = signal;
      return new Promise(() => {});
    })).rejects.toThrow("Smoke host exited before checks completed (code=7");
    expect(checkSignal?.aborted).toBe(true);
  });

  it("rejects an occupied port before making any request to its listener", async () => {
    let connections = 0;
    const held = createServer(() => { connections++; });
    held.listen(0, "0.0.0.0");
    await once(held, "listening");
    const address = held.address();
    if (!address || typeof address === "string") throw new Error("Missing held port");
    try {
      await expect(requireFreePort(address.port)).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(connections).toBe(0);
    } finally { await new Promise<void>(resolve => held.close(() => resolve())); }
    await expect(requireFreePort(address.port)).resolves.toBeUndefined();
  });
});
