import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { check } from "./check.mjs";
import { requireFreePort, verifyHostedChild } from "./lifecycle.mjs";

// Test the production entrypoint's fail-closed behavior with no activation settings.
const inactive = spawn(process.execPath, ["dist/src/host.js"], { env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
let inactiveError = "";
inactive.stderr.on("data", chunk => { inactiveError += chunk; });
assert.equal((await once(inactive, "exit"))[0], 1);
assert.equal(inactiveError.trim(), "Hosted MCP startup failed; verify activation settings and connectivity.");

await requireFreePort(3000);
const host = spawn(process.execPath, ["--import", "./test/smoke/fixture.mjs", "dist/src/host.js"], { stdio: ["ignore", "inherit", "inherit"] });
await verifyHostedChild(host, check);
