import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPlugin, PLUGIN_NAME, TEMPLATE_DIR } from "../src/plugin-build.js";

const roots: string[] = [];
const outRoot = () => {
  const dir = mkdtempSync(join(tmpdir(), "plugin-build-"));
  roots.push(dir);
  return dir;
};
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("Claude plugin build", () => {
  it("fixes the connector URL to the validated public origin", () => {
    const { dir, mcpUrl } = buildPlugin("https://mcp.bridge-owner.dev/", outRoot());
    expect(mcpUrl).toBe("https://mcp.bridge-owner.dev/mcp");
    expect(JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"))).toEqual({ mcpServers: { coolify: { type: "http", url: "https://mcp.bridge-owner.dev/mcp" } } });
  });

  it("ships the manifest and skill with a matching plugin name", () => {
    const { dir } = buildPlugin("https://mcp.bridge-owner.dev", outRoot());
    expect(JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8")).name).toBe(PLUGIN_NAME);
    expect(readFileSync(join(dir, "skills", "coolify-operations", "SKILL.md"), "utf8")).toMatch(/^---\nname: coolify-operations\ndescription: /);
  });

  it.each([undefined, "", "http://mcp.bridge-owner.dev", "https://mcp.example.com", "https://10.0.0.5", "https://mcp.bridge-owner.dev:8443", "https://mcp.bridge-owner.dev/mcp"])("refuses %s without writing anything", (origin) => {
    const root = outRoot();
    expect(() => buildPlugin(origin, root)).toThrow(/MCP_PUBLIC_ORIGIN/);
    expect(readdirSync(root)).toEqual([]);
  });

  it("keeps credentials and templated URLs out of the template", () => {
    const manifest = readFileSync(join(TEMPLATE_DIR, ".claude-plugin", "plugin.json"), "utf8");
    expect(manifest).not.toMatch(/user_config|token|secret|clientId/i);
  });
});
