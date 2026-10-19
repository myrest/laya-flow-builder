import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ApiSecrets {
  admin: string;
  mcp: string;
}

export interface ApiRequestIdentity {
  pathname: string;
  role: "admin" | "mcp" | "anonymous";
}

export class ApiAuthorizationError extends Error {
  constructor(readonly status: 401 | 403, message: string) {
    super(message);
    this.name = "ApiAuthorizationError";
  }
}

function validSecret(value: string | undefined, name: string): string | null {
  if (value === undefined || value.length === 0) return null;
  if (Buffer.byteLength(value) < 32) throw new Error(`${name} must contain at least 32 bytes.`);
  return value;
}

async function readSecret(filePath: string): Promise<string> {
  const value = (await readFile(filePath, "utf8")).trim();
  if (Buffer.byteLength(value) < 32) throw new Error(`The secret file ${path.basename(filePath)} is invalid.`);
  await chmod(filePath, 0o600);
  return value;
}

async function loadSecret(directory: string, fileName: string, envName: string): Promise<string> {
  const configured = validSecret(process.env[envName], envName);
  if (configured) return configured;
  const filePath = path.join(directory, fileName);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    return await readSecret(filePath);
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const generated = randomBytes(32).toString("hex");
  try {
    await writeFile(filePath, `${generated}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return generated;
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
    return readSecret(filePath);
  }
}

export async function loadApiSecrets(directory: string): Promise<ApiSecrets> {
  const [admin, mcp] = await Promise.all([
    loadSecret(directory, "admin-token", "LAYA_ADMIN_TOKEN"),
    loadSecret(directory, "mcp-token", "LAYA_MCP_TOKEN"),
  ]);
  if (admin === mcp) throw new Error("LAYA_ADMIN_TOKEN and LAYA_MCP_TOKEN must be different.");
  return { admin, mcp };
}

function matchesSecret(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function mcpRouteAllowed(pathname: string, method: string): boolean {
  if (pathname === "/api/mcp/draft-contract" || pathname === "/api/mcp/flows") return method === "GET";
  if (/^\/api\/mcp\/flows\/[^/]+$/.test(pathname)) return method === "GET";
  if (pathname === "/api/mcp/flow-drafts") return method === "GET" || method === "POST";
  if (/^\/api\/mcp\/flow-drafts\/[^/]+$/.test(pathname)) return method === "GET" || method === "PUT";
  if (/^\/api\/mcp\/flow-drafts\/[^/]+\/preview$/.test(pathname)) return method === "GET";
  if (/^\/api\/mcp\/flow-drafts\/[^/]+\/(validate|test|test-batch|submit|discard)$/.test(pathname)) return method === "POST";
  return false;
}

function requiresAdmin(pathname: string, method: string): boolean {
  if (pathname === "/api/admin/check") return true;
  if (/^\/api\/flows\/[^/]+\/history$/.test(pathname)) return true;
  if (method === "GET" || method === "HEAD") return false;
  if (pathname === "/api/system-one") return false;
  if (/^\/api\/flows\/[^/]+\/(validate|test|run)$/.test(pathname)) return false;
  if (/^\/api\/flow-drafts\/[^/]+\/(validate|test)$/.test(pathname)) return false;
  return pathname === "/api" || pathname.startsWith("/api/");
}

export function authorizeApiRequest(
  pathname: string,
  method: string,
  authorization: string | undefined,
  origin: string | undefined,
  host: string | undefined,
  secrets: ApiSecrets,
): ApiRequestIdentity {
  const bearer = /^Bearer ([^\s]+)$/.exec(authorization ?? "")?.[1];
  const isMcpPath = pathname === "/api/mcp" || pathname.startsWith("/api/mcp/");
  if (isMcpPath) {
    if (!matchesSecret(bearer, secrets.mcp)) throw new ApiAuthorizationError(401, "MCP 憑證無效或未提供。");
    if (!mcpRouteAllowed(pathname, method)) throw new ApiAuthorizationError(403, "MCP 身份不可執行此操作。");
    return { pathname: pathname.slice("/api/mcp".length) === "" ? "/api" : `/api${pathname.slice("/api/mcp".length)}`, role: "mcp" };
  }
  if (matchesSecret(bearer, secrets.mcp)) throw new ApiAuthorizationError(403, "MCP 憑證只能呼叫副本專用 API。");

  const isAdmin = matchesSecret(bearer, secrets.admin);
  if (requiresAdmin(pathname, method) && !isAdmin) throw new ApiAuthorizationError(401, "此操作需要人工管理憑證。");
  if (isAdmin && origin !== undefined) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      throw new ApiAuthorizationError(403, "管理請求的來源不正確。");
    }
    if (!host || originHost.toLowerCase() !== host.toLowerCase()) throw new ApiAuthorizationError(403, "管理請求的來源與伺服器不一致。");
  }
  return { pathname, role: isAdmin ? "admin" : "anonymous" };
}
