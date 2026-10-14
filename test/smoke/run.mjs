import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { check } from "./check.mjs";

// Test the production entrypoint's fail-closed behavior with no activation settings.
const inactive = spawn(process.execPath, ["dist/src/host.js"], { env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
let inactiveError = "";
inactive.stderr.on("data", chunk => { inactiveError += chunk; });
assert.equal((await once(inactive, "exit"))[0], 1);
assert.equal(inactiveError.trim(), "Hosted MCP startup failed; verify activation settings and connectivity.");

const host = spawn(process.execPath, ["--import", "./test/smoke/fixture.mjs", "dist/src/host.js"], { stdio: ["ignore", "inherit", "inherit"] });
const stopped = once(host, "exit");
try { await check(); }
finally {
  host.kill("SIGTERM");
  const deadline = setTimeout(() => host.kill("SIGKILL"), 5000);
  try { assert.deepEqual(await stopped, [0, null], "Host did not shut down cleanly on SIGTERM"); }
  finally { clearTimeout(deadline); }
}
