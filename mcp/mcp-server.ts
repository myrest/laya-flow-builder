import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { isRecord } from "../decision-guards.js";

const apiUrl = new URL(process.env.LAYA_API_URL ?? "http://127.0.0.1:3000");
const mcpToken = process.env.LAYA_MCP_TOKEN;

if (apiUrl.protocol !== "http:" && apiUrl.protocol !== "https:") throw new Error("LAYA_API_URL must use HTTP or HTTPS.");
if (!mcpToken || Buffer.byteLength(mcpToken) < 32) throw new Error("Set LAYA_MCP_TOKEN to the MCP token from the API data directory.");

interface ApiFailure {
  status: number;
  code: string;
  message: string;
  issues?: string[];
}

async function requestApi(pathname: string, method = "GET", body?: unknown): Promise<unknown> {
  const response = await fetch(new URL(pathname, apiUrl), {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${mcpToken}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let data: unknown;
  try {
    data = text.length > 0 ? JSON.parse(text) as unknown : null;
  } catch {
    data = { error: `API returned invalid JSON (${response.status}).` };
  }
  if (!response.ok) {
    const message = isRecord(data) && typeof data.error === "string" ? data.error : `API request failed with HTTP ${response.status}.`;
    const issues = isRecord(data) && Array.isArray(data.issues)
      ? data.issues.filter((issue): issue is string => typeof issue === "string")
      : undefined;
    const failure: ApiFailure = {
      status: response.status,
      code: response.status === 401 ? "unauthorized" : response.status === 403 ? "forbidden" : response.status === 409 ? "conflict" : "api_error",
      message,
      ...(issues && issues.length > 0 ? { issues } : {}),
    };
    throw failure;
  }
  return data;
}

function success(data: unknown) {
  const structuredContent = isRecord(data) ? data : { result: data };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent,
  };
}

function failure(error: unknown) {
  const details: ApiFailure = isRecord(error)
    && typeof error.status === "number"
    && typeof error.code === "string"
    && typeof error.message === "string"
    ? {
        status: error.status,
        code: error.code,
        message: error.message,
        ...(Array.isArray(error.issues) ? { issues: error.issues.filter((issue): issue is string => typeof issue === "string") } : {}),
      }
    : { status: 0, code: "transport_error", message: error instanceof Error ? error.message : String(error) };
  const payload = {
    error: {
      status: details.status,
      code: details.code,
      message: details.message,
      ...(details.issues ? { issues: details.issues } : {}),
    },
  };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

async function callTool(operation: () => Promise<unknown>) {
  try {
    return success(await operation());
  } catch (error) {
    return failure(error);
  }
}

function draftPath(draftId: string, action = ""): string {
  return `/api/mcp/flow-drafts/${encodeURIComponent(draftId)}${action.length > 0 ? `/${action}` : ""}`;
}

const server = new McpServer({ name: "laya-flow-workbench", version: "1.0.0" });

server.registerResource(
  "flow-contract",
  "laya://flow-contract",
  { mimeType: "application/json", description: "Supported flow graph, node data, branches, validation rules, and model execution semantics." },
  async () => {
    const contract = await requestApi("/api/mcp/draft-contract");
    return { contents: [{ uri: "laya://flow-contract", mimeType: "application/json", text: JSON.stringify(contract, null, 2) }] };
  },
);

server.registerTool("list_flows", {
  title: "List live flows",
  description: "Read live flows. Does not modify them; create a draft before editing.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => callTool(() => requestApi("/api/mcp/flows")));

server.registerTool("get_flow", {
  title: "Read a live flow",
  description: "Read a live flow and use it only as the source for a draft; MCP cannot write the live flow.",
  inputSchema: { flowId: z.string().min(1) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ flowId }) => callTool(() => requestApi(`/api/mcp/flows/${encodeURIComponent(flowId)}`)));

server.registerTool("get_flow_contract", {
  title: "Read flow capabilities",
  description: "Read the authoritative node, branch, validation, test, and execution contract.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => callTool(() => requestApi("/api/mcp/draft-contract")));

server.registerTool("list_flow_drafts", {
  title: "List flow drafts",
  description: "List isolated AI drafts, optionally for one source flow.",
  inputSchema: { sourceFlowId: z.string().min(1).optional() },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ sourceFlowId }) => callTool(() => requestApi(`/api/mcp/flow-drafts${sourceFlowId ? `?flowId=${encodeURIComponent(sourceFlowId)}` : ""}`)));

server.registerTool("get_flow_draft", {
  title: "Read a flow draft",
  description: "Read a draft, its base version, test cases, and latest draft run.",
  inputSchema: { draftId: z.string().min(1) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ draftId }) => callTool(() => requestApi(draftPath(draftId))));

server.registerTool("create_flow_draft", {
  title: "Create an isolated flow draft",
  description: "Create an AI copy of a live flow, or an isolated blank flow draft. A draft is never used by the live run endpoint.",
  inputSchema: { sourceFlowId: z.string().min(1).optional(), name: z.string().trim().min(1).max(120).optional() },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ sourceFlowId, name }) => callTool(() => requestApi("/api/mcp/flow-drafts", "POST", { ...(sourceFlowId ? { sourceFlowId } : {}), ...(name ? { name } : {}) })));

server.registerTool("update_flow_draft", {
  title: "Update an isolated flow draft",
  description: "Replace the flow graph and/or draft test cases using the current draft revision. This cannot change a live flow.",
  inputSchema: {
    draftId: z.string().min(1),
    revision: z.string().min(1),
    flow: z.unknown().optional(),
    cases: z.unknown().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ draftId, revision, flow, cases }) => callTool(() => requestApi(draftPath(draftId), "PUT", { revision, ...(flow === undefined ? {} : { flow }), ...(cases === undefined ? {} : { cases }) })));

server.registerTool("validate_flow_draft", {
  title: "Validate a flow draft",
  description: "Run the same structural and graph validator used by the editor and flow engine.",
  inputSchema: { draftId: z.string().min(1), revision: z.string().min(1) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ draftId, revision }) => callTool(() => requestApi(draftPath(draftId, "validate"), "POST", { revision })));

server.registerTool("test_flow_draft", {
  title: "Run one flow draft test",
  description: "Run a single JSON input against the draft and return the full node trace without saving a live result.",
  inputSchema: { draftId: z.string().min(1), revision: z.string().min(1), input: z.json() },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ draftId, revision, input }) => callTool(() => requestApi(draftPath(draftId, "test"), "POST", { revision, input })));

server.registerTool("run_batch_tests_draft", {
  title: "Run draft regression tests",
  description: "Run enabled baseline and draft cases, retain results only on this draft, and return failed-case traces. Never writes live test history.",
  inputSchema: { draftId: z.string().min(1), revision: z.string().min(1) },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ draftId, revision }) => callTool(() => requestApi(draftPath(draftId, "test-batch"), "POST", { revision })));

server.registerTool("submit_flow_draft", {
  title: "Submit a draft for human review",
  description: "Mark a structurally valid draft ready for human review. This does not overwrite or activate a live flow.",
  inputSchema: { draftId: z.string().min(1), revision: z.string().min(1) },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ draftId, revision }) => callTool(() => requestApi(draftPath(draftId, "submit"), "POST", { revision })));

server.registerTool("discard_flow_draft", {
  title: "Discard a flow draft",
  description: "Mark an AI draft discarded. This does not delete or modify its live source flow.",
  inputSchema: { draftId: z.string().min(1), revision: z.string().min(1) },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}, async ({ draftId, revision }) => callTool(() => requestApi(draftPath(draftId, "discard"), "POST", { revision })));

await server.connect(new StdioServerTransport());
