import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Laya } from "../laya/src/index.js";
import { DecisionFlowError, runFlow, validateFlow } from "./decision-engine.js";
import { runFlowTestCases } from "./flow-test-runner.js";
import { isRecord } from "./decision-guards.js";
import { parseDecisionFlow, parseQuestionDefinition } from "./decision-schema.js";
import { DecisionStore } from "./decision-store.js";
import type { Question } from "../laya/src/types.js";
import type { DecisionFlow, FlowTestRun } from "./decision-types.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const MAX_REQUEST_BYTES = 1_048_576;
const APP_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
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

function getFlowOrThrow(store: DecisionStore, id: string): DecisionFlow {
  const flow = store.getFlow(id);
  if (!flow) throw new HttpError(404, "找不到指定的流程。");
  return flow;
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
console.log("載入 Laya 多語言模型 (alexdoandev/laya-multilingual-onnx)...");
const laya = await Laya.load({
  repo: "alexdoandev/laya-multilingual-onnx",
  sessionOptions: { intraOpNumThreads: 2 },
  onProgress: ({ file, received, total }) => {
    if (total) process.stdout.write(`\r[模型] ${file}: ${((received / total) * 100).toFixed(1)}%`);
  },
});
console.log("\n[OK] 模型就緒。流程資料儲存於：", process.env.LAYA_DATA_DIR ?? path.join(APP_DIRECTORY, "data"));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname;
  try {
    if (pathname === "/health" && req.method === "GET") {
      respondJson(res, 200, { status: "ok", model: "alexdoandev/laya-multilingual-onnx", pr: 11 });
      return;
    }

    if (pathname === "/api/system-one" && req.method === "POST") {
      const payload = await readJson(req);
      if (!isRecord(payload) || !Object.hasOwn(payload, "state") || !isRecord(payload.questions)) throw new HttpError(400, "請求必須包含 state 與 questions 欄位。");
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
        throw new HttpError(400, error instanceof Error ? error.message : String(error));
      }
      return;
    }

    const testCasesMatch = pathname.match(/^\/api\/flows\/([^/]+)\/test-cases(?:\/(run))?$/);
    if (testCasesMatch) {
      const id = decodeURIComponent(testCasesMatch[1] ?? "");
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
        if (selectedCaseIds && suite.lastRun?.flowRevision === run.flowRevision) {
          const resultsById = new Map([...suite.lastRun.results, ...run.results].map((result) => [result.caseId, result]));
          run = { ...run, results: suite.cases.flatMap((testCase) => {
            const result = resultsById.get(testCase.id);
            return result ? [result] : [];
          }) };
        }
        try {
          respondJson(res, 200, await store.saveFlowTestRun(id, suite.revision, run));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new HttpError(message.startsWith("測試案例已更新") ? 409 : 400, message);
        }
        return;
      }
      throw new HttpError(405, "不支援此流程測試案例 API 操作。");
    }

    const flowMatch = pathname.match(/^\/api\/flows\/([^/]+)(?:\/(validate|test|run))?$/);
    if (flowMatch) {
      const id = decodeURIComponent(flowMatch[1] ?? "");
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
        await store.deleteTemplate(decodeURIComponent(templateMatch[1] ?? ""));
      } catch (error) {
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
