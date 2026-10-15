import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";
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

/**
 * Zips a directory in-process (deflate, fixed 1980 timestamps) so the build
 * needs no external zip binary and the archive is reproducible.
 */
export function zipDirectory(root: string): Buffer {
  const entries = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of entries) {
    const name = Buffer.from(relative(root, file).split(sep).join("/"));
    const data = readFileSync(file);
    const packed = deflateRawSync(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt16LE(0x21, 12); // 1980-01-01
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    header.copy(record, 6, 4, 28);
    record.writeUInt32LE(offset, 42);
    locals.push(header, name, packed);
    central.push(record, name);
    offset += header.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

if (basename(process.argv[1] ?? "") === "plugin-build.js" || basename(process.argv[1] ?? "") === "plugin-build.ts") {
  try {
    const outRoot = resolve("dist/claude-plugin");
    const zip = join(outRoot, `${PLUGIN_NAME}.zip`);
    // A failed rebuild must not leave an older archive at the upload path.
    rmSync(zip, { force: true });
    const { dir, mcpUrl } = buildPlugin(process.env.MCP_PUBLIC_ORIGIN, outRoot);
    writeFileSync(zip, zipDirectory(dir));
    console.log(`Plugin folder: ${dir}\nUpload file:   ${zip}\nConnector URL: ${mcpUrl}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
