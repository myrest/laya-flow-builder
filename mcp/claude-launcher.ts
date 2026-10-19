import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (!process.env.LAYA_MCP_TOKEN) {
  const dataDirectory = process.env.LAYA_DATA_DIR
    ? path.resolve(projectDirectory, process.env.LAYA_DATA_DIR)
    : path.join(projectDirectory, "data");
  const tokenPath = path.join(dataDirectory, "mcp-token");
  try {
    process.env.LAYA_MCP_TOKEN = (await readFile(tokenPath, "utf8")).trim();
  } catch (error) {
    throw new Error(`Cannot read MCP credentials at ${tokenPath}; start the API once or set LAYA_MCP_TOKEN.`, { cause: error });
  }
}

// Import after token injection; a static import would start the server before it is available.
await import("./mcp-server.js");
