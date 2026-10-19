import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Laya } from "../laya/src/index.js";
import { DecisionFlowError, runFlow, validateFlow } from "./decision-engine.js";
import { runFlowTestCases } from "./flow-test-runner.js";
import { authorizeApiRequest, ApiAuthorizationError, loadApiSecrets } from "./api-auth.js";
import { isRecord } from "./decision-guards.js";
import { parseDecisionFlow, parseQuestionDefinition } from "./decision-schema.js";
import { DecisionStore, StoreConflictError } from "./decision-store.js";
import { FlowDraftService, FlowDraftServiceError, flowDraftContract } from "./flow-draft-service.js";
import type { Question } from "../laya/src/types.js";
import type { DecisionFlow, FlowTestRun } from "./decision-types.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const MAX_REQUEST_BYTES = 1_048_576;
const APP_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIRECTORY = process.env.LAYA_DATA_DIR ?? path.join(APP_DIRECTORY, "data");
const WEB_BUILD_DIRECTORY = path.join(APP_DIRECTORY, "web", "dist");

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues?: string[],
  ) {
    super(message);
  }
}

function respondJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const content = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += content.byteLength;
    if (bytes > MAX_REQUEST_BYTES) throw new HttpError(413, `請求內容不可超過 ${MAX_REQUEST_BYTES} bytes。`);
    chunks.push(content);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "請求本文必須是有效的 JSON。");
  }
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new HttpError(400, `缺少有效的「${field}」。`);
  return value.trim();
}

function decodePathParameter(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "路徑參數必須使用有效的 URL 編碼。");
  }
}

function getFlowOrThrow(store: DecisionStore, id: string): DecisionFlow {
  const flow = store.getFlow(id);
  if (!flow) throw new HttpError(404, "找不到指定的流程。");
  return flow;
}

async function draftOperation<T>(operation: () => Promise<T> | T): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HttpError || error instanceof DecisionFlowError || error instanceof FlowDraftServiceError || error instanceof StoreConflictError) throw error;
    if (error instanceof Error && error.message.startsWith("Invalid decision system data at ")) {
      throw new HttpError(400, error.message);
    }
    if (error instanceof Error && error.message.startsWith("找不到")) throw new HttpError(404, error.message);
    throw error;
  }
}

function requireDraftRevision(payload: Record<string, unknown>): string {
  if (typeof payload.revision !== "string" || payload.revision.length === 0) throw new HttpError(400, "請求必須包含草稿版本識別碼。");
  return payload.revision;
}

function parseRunInput(value: unknown): unknown {
  if (!isRecord(value) || !Object.hasOwn(value, "input")) throw new HttpError(400, "請求必須包含 input 欄位。");
  return value.input;
}

async function serveStatic(pathname: string, method: string, res: ServerResponse): Promise<boolean> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const candidate = path.resolve(WEB_BUILD_DIRECTORY, relative);
  if (candidate !== WEB_BUILD_DIRECTORY && !candidate.startsWith(`${WEB_BUILD_DIRECTORY}${path.sep}`)) return false;
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return false;
    const contents = await readFile(candidate);
    const extension = path.extname(candidate);
    const contentType = extension === ".html" ? "text/html; charset=utf-8"
      : extension === ".js" ? "text/javascript; charset=utf-8"
      : extension === ".css" ? "text/css; charset=utf-8"
      : extension === ".svg" ? "image/svg+xml"
      : extension === ".json" ? "application/json; charset=utf-8"
      : extension === ".png" ? "image/png"
      : extension === ".woff2" ? "font/woff2"
      : "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType, "Content-Length": contents.byteLength, "Cache-Control": extension === ".html" ? "no-cache" : "public, max-age=3600" });
    res.end(method === "HEAD" ? undefined : contents);
    return true;
  } catch {
    if (path.extname(relative) !== "") return false;
    return serveStatic("/", method, res);
  }
}

const store = await DecisionStore.open();
const apiSecrets = await loadApiSecrets(DATA_DIRECTORY);
console.error(`API 管理憑證檔案：${path.join(DATA_DIRECTORY, "admin-token")}`);
console.error(`MCP 憑證檔案：${path.join(DATA_DIRECTORY, "mcp-token")}`);
console.log("載入 Laya 多語言模型 (alexdoandev/laya-multilingual-onnx)...");
const laya = await Laya.load({
  repo: "alexdoandev/laya-multilingual-onnx",
  sessionOptions: { intraOpNumThreads: 2 },
  onProgress: ({ file, received, total }) => {
    if (total) process.stdout.write(`\r[模型] ${file}: ${((received / total) * 100).toFixed(1)}%`);
  },
});
const draftService = new FlowDraftService(store, laya);
console.log("\n[OK] 模型就緒。流程資料儲存於：", DATA_DIRECTORY);

const server = http.createServer(async (req, res) => {
  try {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      throw new HttpError(400, "請求路徑必須是有效的 URL。");
    }
    let pathname = url.pathname;
    try {
      const identity = authorizeApiRequest(
        pathname,
        req.method ?? "GET",
        req.headers.authorization,
        req.headers.origin,
        req.headers.host,
        apiSecrets,
      );
      pathname = identity.pathname;
    } catch (error) {
      if (error instanceof ApiAuthorizationError) throw new HttpError(error.status, error.message);
      throw error;
    }
    if (pathname === "/api/admin/check" && req.method === "GET") {
      respondJson(res, 200, { ok: true });
      return;
    }
    if (pathname === "/api/draft-contract" && req.method === "GET") {
      respondJson(res, 200, flowDraftContract(store));
      return;
    }
    if (pathname === "/health" && req.method === "GET") {
      respondJson(res, 200, { status: "ok", model: "alexdoandev/laya-multilingual-onnx", pr: 11 });
      return;
    }

    if (pathname === "/api/system-one" && req.method === "POST") {
      const payload = await readJson(req);
      if (!isRecord(payload) || !Object.hasOwn(payload, "state") || !isRecord(payload.questions)) throw new HttpError(400, "請求必須包含 state 與 questions 欄位。");
      if (Object.keys(payload.questions).length === 0) throw new HttpError(400, "questions 至少必須包含一個問題。");
      const questions: Record<string, Question> = {};
      try {
        for (const [key, question] of Object.entries(payload.questions)) questions[key] = parseQuestionDefinition(question);
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : String(error));
      }
      const result = await laya.systemOne(payload.state, questions);
      respondJson(res, 200, result);
      return;
    }

    if (pathname === "/api/flow-drafts" && req.method === "GET") {
      const sourceFlowId = url.searchParams.get("flowId") ?? undefined;
      respondJson(res, 200, draftService.list(sourceFlowId));
      return;
    }
    if (pathname === "/api/flow-drafts" && req.method === "POST") {
      const payload = await readJson(req);
      if (!isRecord(payload)) throw new HttpError(400, "請求本文必須是 JSON 物件。");
      if (payload.sourceFlowId !== undefined && typeof payload.sourceFlowId !== "string") throw new HttpError(400, "來源流程識別碼格式不正確。");
      if (payload.name !== undefined && typeof payload.name !== "string") throw new HttpError(400, "流程草稿名稱格式不正確。");
      const draft = await draftOperation(() => draftService.create(
        typeof payload.sourceFlowId === "string" ? payload.sourceFlowId : undefined,
        typeof payload.name === "string" ? requiredText(payload.name, "流程草稿名稱") : undefined,
      ));
      respondJson(res, 201, draft);
      return;
    }
    const draftMatch = pathname.match(/^\/api\/flow-drafts\/([^/]+)(?:\/(validate|test|test-batch|submit|discard|preview|apply))?$/);
    if (draftMatch) {
      const id = decodePathParameter(draftMatch[1] ?? "");
      const action = draftMatch[2];
      if (!action && req.method === "GET") {
        respondJson(res, 200, await draftOperation(() => draftService.get(id)));
        return;
      }
      if (action === "preview" && req.method === "GET") {
        respondJson(res, 200, draftService.preview(id));
        return;
      }
      if (!action && req.method === "PUT") {
        const payload = await readJson(req);
        if (!isRecord(payload)) throw new HttpError(400, "請求本文必須是 JSON 物件。");
        if (!Object.hasOwn(payload, "flow") && !Object.hasOwn(payload, "cases")) throw new HttpError(400, "至少需要提供流程或測試案例草稿。");
        const revision = requireDraftRevision(payload);
        respondJson(res, 200, await draftOperation(() => draftService.update(id, revision, {
          ...(Object.hasOwn(payload, "flow") ? { flow: payload.flow } : {}),
          ...(Object.hasOwn(payload, "cases") ? { cases: payload.cases } : {}),
        })));
        return;
      }
      if (action === "validate" && req.method === "POST") {
        const payload = await readJson(req);
        if (!isRecord(payload)) throw new HttpError(400, "請求本文必須是 JSON 物件。");
        respondJson(res, 200, await draftOperation(() => draftService.validate(id, requireDraftRevision(payload))));
        return;
      }
      if (action === "test" && req.method === "POST") {
        const payload = await readJson(req);
        if (!isRecord(payload) || !Object.hasOwn(payload, "input")) throw new HttpError(400, "請求必須包含 input 欄位。");
        respondJson(res, 200, await draftOperation(() => draftService.test(id, requireDraftRevision(payload), payload.input)));
        return;
      }
      if (action === "test-batch" && req.method === "POST") {
        const payload = await readJson(req);
        if (!isRecord(payload)) throw new HttpError(400, "請求本文必須是 JSON 物件。");
        respondJson(res, 200, await draftOperation(() => draftService.runBatch(id, requireDraftRevision(payload))));
        return;
      }
      if (action === "submit" && req.method === "POST") {
        const payload = await readJson(req);
        if (!isRecord(payload)) throw new HttpError(400, "請求本文必須是 JSON 物件。");
        respondJson(res, 200, await draftOperation(() => draftService.submit(id, requireDraftRevision(payload))));
        return;
      }
      if (action === "discard" && req.method === "POST") {
        const payload = await readJson(req);
        if (!isRecord(payload)) throw new HttpError(400, "請求本文必須是 JSON 物件。");
        respondJson(res, 200, await draftOperation(() => draftService.discard(id, requireDraftRevision(payload))));
        return;
      }
      if (action === "apply" && req.method === "POST") {
        const payload = await readJson(req);
        if (!isRecord(payload) || typeof payload.acknowledgeWarnings !== "boolean") {
          throw new HttpError(400, "請求必須明確提供 acknowledgeWarnings 布林值。");
        }
        const acknowledgeWarnings = payload.acknowledgeWarnings;
        const revision = requireDraftRevision(payload);
        respondJson(res, 200, await draftOperation(() => draftService.apply(id, revision, acknowledgeWarnings)));
        return;
      }
      throw new HttpError(405, "不支援此流程草稿 API 操作。");
    }

    if (pathname === "/api/flows" && req.method === "GET") {
      respondJson(res, 200, store.listFlows());
      return;
    }
    if (pathname === "/api/flows" && req.method === "POST") {
      const payload = await readJson(req);
      if (!isRecord(payload)) throw new HttpError(400, "請求本文必須是 JSON 物件。");
      try {
        respondJson(res, 201, await store.createFlow(requiredText(payload.name, "流程名稱")));
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (pathname === "/api/templates" && req.method === "GET") {
      respondJson(res, 200, store.listTemplates());
      return;
    }
    if (pathname === "/api/templates" && req.method === "POST") {
      try {
        respondJson(res, 201, await store.createTemplate(await readJson(req)));
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, error instanceof Error ? error.message : String(error));
      }
      return;
    }

    const testCasesMatch = pathname.match(/^\/api\/flows\/([^/]+)\/test-cases(?:\/(run))?$/);
    if (testCasesMatch) {
      const id = decodePathParameter(testCasesMatch[1] ?? "");
      const action = testCasesMatch[2];
      getFlowOrThrow(store, id);
      if (!action && req.method === "GET") {
        respondJson(res, 200, store.getFlowTestSuite(id));
        return;
      }
      if (!action && req.method === "PUT") {
        const payload = await readJson(req);
        if (!isRecord(payload) || !Object.hasOwn(payload, "cases") || typeof payload.revision !== "string") throw new HttpError(400, "請求必須包含測試案例與版本識別碼。");
        try {
          respondJson(res, 200, await store.saveFlowTestCases(id, payload.revision, payload.cases));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new HttpError(message.startsWith("測試案例已更新") ? 409 : 400, message);
        }
        return;
      }
      if (action === "run" && req.method === "POST") {
        const payload = await readJson(req);
        if (!isRecord(payload) || !Object.hasOwn(payload, "flow")) throw new HttpError(400, "請求必須包含流程快照。");
        let flow: DecisionFlow;
        try {
          flow = parseDecisionFlow(payload.flow);
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : String(error));
        }
        if (flow.id !== id) throw new HttpError(400, "流程路徑與本文的流程識別碼不同。");
        const issues = validateFlow(flow);
        if (issues.length > 0) throw new DecisionFlowError("流程尚未完成，無法執行批次測試。", issues);
        let selectedCaseIds: string[] | undefined;
        if (Object.hasOwn(payload, "caseIds")) {
          if (!Array.isArray(payload.caseIds) || !payload.caseIds.every((caseId) => typeof caseId === "string")) throw new HttpError(400, "測試案例識別碼格式不正確。");
          selectedCaseIds = payload.caseIds;
        }
        const suite = store.getFlowTestSuite(id);
        let run: FlowTestRun;
        try {
          run = await runFlowTestCases(flow, suite.cases, laya, selectedCaseIds);
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : String(error));
        }
        try {
          respondJson(res, 200, await store.saveFlowTestRun(id, suite.revision, run, selectedCaseIds !== undefined));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new HttpError(message.startsWith("測試案例已更新") ? 409 : 400, message);
        }
        return;
      }
      throw new HttpError(405, "不支援此流程測試案例 API 操作。");
    }

    const restoreMatch = pathname.match(/^\/api\/flows\/([^/]+)\/history\/([^/]+)\/restore$/);
    if (restoreMatch && req.method === "POST") {
      const flowId = decodePathParameter(restoreMatch[1] ?? "");
      const entryId = decodePathParameter(restoreMatch[2] ?? "");
      const payload = await readJson(req);
      if (!isRecord(payload) || typeof payload.flowVersion !== "string" || typeof payload.suiteRevision !== "string") {
        throw new HttpError(400, "請求必須包含現行流程及測試套件版本。");
      }
      const { flowVersion, suiteRevision } = payload;
      respondJson(res, 200, await draftOperation(() => draftService.restore(flowId, entryId, flowVersion, suiteRevision)));
      return;
    }
    const historyMatch = pathname.match(/^\/api\/flows\/([^/]+)\/history$/);
    if (historyMatch && req.method === "GET") {
      const flowId = decodePathParameter(historyMatch[1] ?? "");
      respondJson(res, 200, draftService.history(flowId));
      return;
    }

    const flowMatch = pathname.match(/^\/api\/flows\/([^/]+)(?:\/(validate|test|run))?$/);
    if (flowMatch) {
      const id = decodePathParameter(flowMatch[1] ?? "");
      const action = flowMatch[2];
      if (action === "validate" && req.method === "POST") {
        respondJson(res, 200, { issues: validateFlow(getFlowOrThrow(store, id)) });
        return;
      }
      if ((action === "test" || action === "run") && req.method === "POST") {
        const payload = await readJson(req);
        const input = parseRunInput(payload);
        let flow = getFlowOrThrow(store, id);
        if (action === "test" && isRecord(payload) && Object.hasOwn(payload, "flow")) {
          try {
            flow = parseDecisionFlow(payload.flow);
          } catch (error) {
            throw new HttpError(400, error instanceof Error ? error.message : String(error));
          }
          if (flow.id !== id) throw new HttpError(400, "流程路徑與本文的流程識別碼不同。");
        }
        const result = await runFlow(flow, input, laya);
        if (action === "test") respondJson(res, 200, result);
        else respondJson(res, 200, result.output);
        return;
      }
      if (!action && req.method === "GET") {
        respondJson(res, 200, getFlowOrThrow(store, id));
        return;
      }
      if (!action && req.method === "PUT") {
        let body: DecisionFlow;
        try {
          body = parseDecisionFlow(await readJson(req));
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw new HttpError(400, error instanceof Error ? error.message : String(error));
        }
        if (body.id !== id) throw new HttpError(400, "流程路徑與本文的流程識別碼不同。");
        try {
          respondJson(res, 200, await store.saveFlow(body));
        } catch (error) {
          if (error instanceof StoreConflictError) throw error;
          throw new HttpError(400, error instanceof Error ? error.message : String(error));
        }
        return;
      }
      if (!action && req.method === "DELETE") {
        try {
          await store.deleteFlow(id);
        } catch (error) {
          throw new HttpError(404, error instanceof Error ? error.message : String(error));
        }
        res.writeHead(204);
        res.end();
        return;
      }
      throw new HttpError(405, "不支援此流程 API 操作。");
    }

    const templateMatch = pathname.match(/^\/api\/templates\/([^/]+)$/);
    if (templateMatch && req.method === "DELETE") {
      try {
        await store.deleteTemplate(decodePathParameter(templateMatch[1] ?? ""));
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(404, error instanceof Error ? error.message : String(error));
      }
      res.writeHead(204);
      res.end();
      return;
    }

    if (!pathname.startsWith("/api/") && (req.method === "GET" || req.method === "HEAD") && await serveStatic(pathname, req.method, res)) return;
    throw new HttpError(404, "找不到此 API 或網頁路徑。");
  } catch (error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (error instanceof Error && error.message.includes("options do not fit in head_max_len=")) {
      respondJson(res, 400, { error: error.message });
      return;
    }
    if (error instanceof StoreConflictError) {
      respondJson(res, 409, { error: error.message });
      return;
    }
    if (error instanceof FlowDraftServiceError) {
      respondJson(res, error.status, { error: error.message, ...(error.issues ? { issues: error.issues } : {}) });
      return;
    }
    if (error instanceof Error && error.message.startsWith("Invalid decision system data at ")) {
      respondJson(res, 400, { error: error.message });
      return;
    }
    if (error instanceof DecisionFlowError) {
      respondJson(res, 422, { error: error.message, issues: error.issues });
      return;
    }
    if (error instanceof HttpError) {
      respondJson(res, error.status, { error: error.message, ...(error.issues ? { issues: error.issues } : {}) });
      return;
    }
    respondJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`
決策編輯器與 API 已監聽 ${HOST}:${PORT}`);
  const interfaces = os.networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) console.log(`區網網址：http://${address.address}:${PORT}`);
    }
  }
  console.log(`健康檢查：http://localhost:${PORT}/health`);
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n正在關閉 HTTP 伺服器與釋放模型…");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await laya.close();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
