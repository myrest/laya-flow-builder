import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { authorizeApiRequest, loadApiSecrets } from "../api-auth.js";

const secrets = { admin: "a".repeat(64), mcp: "b".repeat(64) };

test("API credentials keep MCP restricted to draft routes and require admin for persistent writes", () => {
  assert.deepEqual(authorizeApiRequest("/api/flows", "GET", undefined, undefined, undefined, secrets), {
    pathname: "/api/flows", role: "anonymous",
  });
  assert.throws(
    () => authorizeApiRequest("/api/flows", "POST", undefined, undefined, undefined, secrets),
    (error: unknown) => error instanceof Error && "status" in error && error.status === 401,
  );
  assert.deepEqual(authorizeApiRequest("/api/mcp/flows", "GET", `Bearer ${secrets.mcp}`, undefined, undefined, secrets), {
    pathname: "/api/flows", role: "mcp",
  });
  assert.deepEqual(authorizeApiRequest("/api/mcp/flow-drafts/draft-1/test-batch", "POST", `Bearer ${secrets.mcp}`, undefined, undefined, secrets), {
    pathname: "/api/flow-drafts/draft-1/test-batch", role: "mcp",
  });
  assert.throws(
    () => authorizeApiRequest("/api/mcp/flow-drafts/draft-1/apply", "POST", `Bearer ${secrets.mcp}`, undefined, undefined, secrets),
    (error: unknown) => error instanceof Error && "status" in error && error.status === 403,
  );
  assert.throws(
    () => authorizeApiRequest("/api/flows/flow-1", "PUT", `Bearer ${secrets.mcp}`, undefined, undefined, secrets),
    (error: unknown) => error instanceof Error && "status" in error && error.status === 403,
  );
  assert.deepEqual(authorizeApiRequest("/api/flows", "POST", `Bearer ${secrets.admin}`, "http://localhost:3000", "localhost:3000", secrets), {
    pathname: "/api/flows", role: "admin",
  });
  assert.throws(
    () => authorizeApiRequest("/api/flows", "POST", `Bearer ${secrets.admin}`, "http://attacker.invalid", "localhost:3000", secrets),
    (error: unknown) => error instanceof Error && "status" in error && error.status === 403,
  );
  assert.throws(
    () => authorizeApiRequest("/api/flows/flow-1/history", "GET", undefined, undefined, undefined, secrets),
    (error: unknown) => error instanceof Error && "status" in error && error.status === 401,
  );
});

test("API secrets are distinct, persistent and stored with owner-only permissions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "laya-api-secrets-"));
  try {
    const first = await loadApiSecrets(directory);
    const second = await loadApiSecrets(directory);
    assert.equal(first.admin, second.admin);
    assert.equal(first.mcp, second.mcp);
    assert.notEqual(first.admin, first.mcp);
    assert.equal(Buffer.byteLength(first.admin), 64);
    assert.equal(Buffer.byteLength(first.mcp), 64);
    assert.equal((await stat(path.join(directory, "admin-token"))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(directory, "mcp-token"))).mode & 0o777, 0o600);
    assert.equal((await readFile(path.join(directory, "admin-token"), "utf8")).trim(), first.admin);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
