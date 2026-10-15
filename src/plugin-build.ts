import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPublicOrigin } from "./preflight.js";

export const PLUGIN_NAME = "coolify-ai-agents";
export const MCP_SERVER_NAME = "coolify";

// Works from src/ under tsx and from dist/src/ after a build.
const here = dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_DIR = [resolve(here, "../plugin"), resolve(here, "../../plugin")].find((dir) => existsSync(join(dir, ".claude-plugin", "plugin.json"))) ?? resolve(here, "../plugin");

export type PluginBuild = Readonly<{ dir: string; mcpUrl: string }>;

/**
 * Writes the Claude plugin with the connector URL fixed to the validated
 * public origin. Hosted Claude surfaces ignore templated MCP URLs, so the
 * URL is baked in at build time. The output holds no credentials.
 */
export function buildPlugin(origin: string | undefined, outRoot: string, templateDir = TEMPLATE_DIR): PluginBuild {
  const check = checkPublicOrigin(origin);
  if (check.status !== "ok") throw new Error(`MCP_PUBLIC_ORIGIN ${check.status}: ${check.detail}`);
  const mcpUrl = `${check.detail}/mcp`;
  const dir = join(outRoot, PLUGIN_NAME);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(outRoot, { recursive: true });
  cpSync(templateDir, dir, { recursive: true });
  writeFileSync(join(dir, ".mcp.json"), `${JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: "http", url: mcpUrl } } }, null, 2)}\n`);
  return { dir, mcpUrl };
}

if (basename(process.argv[1] ?? "") === "plugin-build.js" || basename(process.argv[1] ?? "") === "plugin-build.ts") {
  try {
    const outRoot = resolve("dist/claude-plugin");
    const { dir, mcpUrl } = buildPlugin(process.env.MCP_PUBLIC_ORIGIN, outRoot);
    const zip = join(outRoot, `${PLUGIN_NAME}.zip`);
    rmSync(zip, { force: true });
    try {
      execFileSync("zip", ["-qr", zip, "."], { cwd: dir });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`The zip command is not installed. Zip the contents of ${dir} by hand, or install zip and rerun.`);
      throw error;
    }
    console.log(`Plugin folder: ${dir}\nUpload file:   ${zip}\nConnector URL: ${mcpUrl}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
