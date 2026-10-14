import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";

/** Reject occupied listener ports before probing an unrelated local service. */
export async function requireFreePort(port) {
  const listener = createServer();
  listener.listen(port, "0.0.0.0");
  await once(listener, "listening");
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
}

/** Watch startup exits and preserve the original check error during cleanup. */
export async function verifyHostedChild(host, check, shutdownMs = 5000) {
  const stopped = once(host, "exit");
  const abort = new AbortController();
  const prematureExit = stopped.then(([code, signal]) => {
    abort.abort();
    throw new Error(`Smoke host exited before checks completed (code=${code}, signal=${signal})`);
  });
  let passed = false;
  try {
    await Promise.race([Promise.resolve().then(() => check(abort.signal)), prematureExit]);
    passed = true;
  } finally {
    abort.abort();
    if (host.exitCode === null && host.signalCode === null) host.kill("SIGTERM");
    const deadline = setTimeout(() => host.kill("SIGKILL"), shutdownMs);
    try {
      const status = await stopped;
      if (passed) assert.deepEqual(status, [0, null], "Host did not shut down cleanly on SIGTERM");
    } catch (error) {
      if (passed) throw error;
    } finally { clearTimeout(deadline); }
  }
}
