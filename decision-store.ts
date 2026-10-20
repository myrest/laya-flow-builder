import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChoiceQuestion, NoulQuestion, Question } from "../laya/src/types.js";
import { DEFAULT_MIN_CONFIDENCE, MAX_FLOW_NAME_LENGTH } from "./decision-types.js";
import { getDefaultLowConfidenceBranch, validateFlow } from "./decision-engine.js";
import { flowRevision } from "./flow-test-utils.js";
import { parseDecisionFlow, parseDecisionStoreData, parseFlowTestCases, parseFlowTestRun, parseFlowTestResult } from "./decision-schema.js";
import type { DecisionFlow, DecisionStoreData, DecisionTemplate, EndFlowNode, FlowNode, FlowTestRun, FlowTestSuite, FlowDraft, FlowDraftRun, FlowHistoryEntry } from "./decision-types.js";

export class StoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreConflictError";
  }
}

export function flowVersion(flow: DecisionFlow): string {
  return createHash("sha256").update(JSON.stringify(flow)).digest("hex");
}

function monotonicTimestamp(previous: string): string {
  const now = Date.now();
  const prior = Date.parse(previous);
  return new Date(Math.max(now, Number.isFinite(prior) ? prior + 1 : now)).toISOString();
}

const DEFAULT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const MAX_PERSISTED_FLOWS = 500;
const MAX_PERSISTED_TEMPLATES = 500;

function defaultChoice(instructions: string, criteria: Record<string, string>): ChoiceQuestion {
  return { type: "choice", instructions, criteria };
}

function demoDecision(id: string, label: string, question: Question, position: { x: number; y: number }): FlowNode {
  return {
    id,
    type: "decision",
    position,
    data: {
      label,
      question,
      inputNodeIds: [],
      trueThreshold: 0.5,
      minConfidence: DEFAULT_MIN_CONFIDENCE,
      lowConfidenceBranch: getDefaultLowConfidenceBranch(question, []),
      scoreThresholds: [],
    },
  };
}

function demoEnd(id: string, label: string, position: { x: number; y: number }, fields: EndFlowNode["data"]["fields"]): EndFlowNode {
  return { id, type: "end", position, data: { label, fields } };
}

function createInitialData(): DecisionStoreData {
  const now = new Date().toISOString();
  const ids = {
    start: randomUUID(),
    request: randomUUID(),
    device: randomUUID(),
    action: randomUUID(),
    iotEnd: randomUUID(),
    sharedEnd: randomUUID(),
    flowId: randomUUID(),
  };
  const requestQuestion: NoulQuestion = {
    type: "noul",
    instructions: "這句話是否明確要求操作物聯網裝置？",
    criteria: {
      true: "明確要求控制裝置，例如打開、關閉或調整設定",
      false: "不是裝置控制要求，例如詢問資訊或一般對話",
    },
  };
  const deviceQuestion = defaultChoice("使用者想操作哪一種裝置？", {
    fan: "風扇、電風扇或循環扇",
    other: "無法識別或不是目前支援的裝置",
  });
  const actionQuestion = defaultChoice("使用者要求對風扇執行哪個操作？", {
    on: "開啟或打開風扇",
    off: "關閉或停止風扇",
    other: "無法識別的操作",
  });
  const decisionNodes: FlowNode[] = [
    { id: ids.start, type: "start", position: { x: 60, y: 240 }, data: { label: "輸入請求" } },
    demoDecision(ids.request, "#1｜是否為 IoT 操作", requestQuestion, { x: 340, y: 240 }),
    demoDecision(ids.device, "#2｜識別裝置", deviceQuestion, { x: 680, y: 240 }),
    demoDecision(ids.action, "#3｜判斷操作", actionQuestion, { x: 1020, y: 240 }),
    demoEnd(ids.iotEnd, "輸出：IoT 控制指令", { x: 1360, y: 240 }, [
      { id: randomUUID(), key: "iotRequest", value: { kind: "literal", value: true } },
      { id: randomUUID(), key: "device", value: { kind: "decision", nodeId: ids.device } },
      { id: randomUUID(), key: "action", value: { kind: "decision", nodeId: ids.action } },
    ]),
    demoEnd(ids.sharedEnd, "輸出：非 IoT 或不支援", { x: 1020, y: 480 }, [
      { id: randomUUID(), key: "iotRequest", value: { kind: "literal", value: false } },
    ]),
  ];
  const flow: DecisionFlow = {
    id: ids.flowId,
    name: "IoT 操作判斷（範例）",
    updatedAt: now,
    nodes: decisionNodes,
    edges: [
      { id: randomUUID(), source: ids.start, target: ids.request, sourceHandle: "next" },
      { id: randomUUID(), source: ids.request, target: ids.device, sourceHandle: "true" },
      { id: randomUUID(), source: ids.request, target: ids.sharedEnd, sourceHandle: "false" },
      { id: randomUUID(), source: ids.device, target: ids.action, sourceHandle: "choice:fan" },
      { id: randomUUID(), source: ids.device, target: ids.sharedEnd, sourceHandle: "choice:other" },
      { id: randomUUID(), source: ids.action, target: ids.iotEnd, sourceHandle: "choice:on" },
      { id: randomUUID(), source: ids.action, target: ids.iotEnd, sourceHandle: "choice:off" },
      { id: randomUUID(), source: ids.action, target: ids.sharedEnd, sourceHandle: "choice:other" },
    ],
  };

  const initialSuite: FlowTestSuite = {
    flowId: ids.flowId,
    revision: randomUUID(),
    cases: [
      {
        id: randomUUID(),
        name: "明確控制風扇（開啟）",
        input: "打開風扇",
        expectedOutput: { iotRequest: true, device: "fan", action: "on" },
        enabled: true,
      },
      {
        id: randomUUID(),
        name: "非 IoT 一般問句",
        input: "今天天氣如何？",
        expectedOutput: { iotRequest: false },
        enabled: true,
      },
    ],
    lastRun: null,
  };

  return { flows: [flow], templates: [], flowTestSuites: [initialSuite], flowDrafts: [], flowHistory: [] };
}

export class DecisionStore {
  private data: DecisionStoreData = { flows: [], templates: [], flowTestSuites: [], flowDrafts: [], flowHistory: [] };
  private mutationQueue: Promise<void> = Promise.resolve();

  private constructor(private readonly filePath: string) {}

  static async open(filePath = path.join(process.env.LAYA_DATA_DIR ?? path.join(DEFAULT_DIRECTORY, "data"), "decision-system.json")): Promise<DecisionStore> {
    const store = new DecisionStore(filePath);
    try {
      store.data = parseDecisionStoreData(JSON.parse(await readFile(filePath, "utf8")) as unknown);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        store.data = createInitialData();
        await store.persist(store.data);
      } else {
        throw new Error(`Cannot load decision store at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return store;
  }

  listFlows(): DecisionFlow[] {
    return structuredClone(this.data.flows);
  }

  getFlow(id: string): DecisionFlow | undefined {
    const flow = this.data.flows.find((candidate) => candidate.id === id);
    return flow ? structuredClone(flow) : undefined;
  }
  getFlowTestSuite(flowId: string): FlowTestSuite {
    if (!this.data.flows.some((flow) => flow.id === flowId)) throw new Error("找不到指定的流程。");
    const suite = this.data.flowTestSuites.find((candidate) => candidate.flowId === flowId);
    return suite ? structuredClone(suite) : { flowId, revision: "", cases: [], lastRun: null };
  }

  listDrafts(sourceFlowId?: string): FlowDraft[] {
    return structuredClone(this.data.flowDrafts.filter((draft) => sourceFlowId === undefined || draft.sourceFlowId === sourceFlowId));
  }

  getDraft(id: string): FlowDraft | undefined {
    const draft = this.data.flowDrafts.find((candidate) => candidate.id === id);
    return draft ? structuredClone(draft) : undefined;
  }

  listHistory(flowId: string): FlowHistoryEntry[] {
    return structuredClone(this.data.flowHistory.filter((entry) => entry.flowId === flowId));
  }

  async createDraft(sourceFlowId?: string, name?: string): Promise<FlowDraft> {
    return this.mutate((data) => {
      const source = sourceFlowId === undefined ? undefined : data.flows.find((flow) => flow.id === sourceFlowId);
      if (sourceFlowId !== undefined && !source) throw new Error("找不到指定的流程。");
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const sourceSuite = source ? data.flowTestSuites.find((suite) => suite.flowId === source.id) : undefined;
      const baseSuite = source ? structuredClone(sourceSuite ?? { flowId: source.id, revision: "", cases: [], lastRun: null }) : null;
      const existingName = source ? `${source.name.slice(0, Math.max(1, MAX_FLOW_NAME_LENGTH - 5))}-copy` : "New flow";
      let draftName = (name ?? existingName).slice(0, MAX_FLOW_NAME_LENGTH);
      if (name === undefined) {
        const base = draftName;
        let suffix = 2;
        while (data.flowDrafts.some((draft) => draft.name === draftName)) {
          const tail = `-${suffix++}`;
          draftName = `${base.slice(0, MAX_FLOW_NAME_LENGTH - tail.length)}${tail}`;
        }
      }
      const startId = randomUUID();
      const endId = randomUUID();
      const flow: DecisionFlow = source
        ? { ...structuredClone(source), id, updatedAt: createdAt }
        : {
            id, name: draftName, updatedAt: createdAt,
            nodes: [
              { id: startId, type: "start", position: { x: 80, y: 180 }, data: { label: "輸入請求" } },
              { id: endId, type: "end", position: { x: 420, y: 180 }, data: { label: "回傳 JSON", fields: [] } },
            ],
            edges: [{ id: randomUUID(), source: startId, target: endId, sourceHandle: "next" }],
          };
      const draft: FlowDraft = {
        id, name: draftName, sourceFlowId: source?.id ?? null, baseFlow: source ? structuredClone(source) : null,
        baseSuite, baseFlowVersion: source ? flowVersion(source) : null, revision: randomUUID(), status: "draft",
        createdAt, updatedAt: createdAt, flow: { ...flow, name: draftName }, cases: structuredClone(baseSuite?.cases ?? []), lastRun: null,
      };
      data.flowDrafts.push(draft);
      return structuredClone(draft);
    });
  }

  async updateDraft(id: string, revision: string, value: { flow?: unknown; cases?: unknown }): Promise<FlowDraft> {
    return this.mutate((data) => {
      const index = data.flowDrafts.findIndex((draft) => draft.id === id);
      if (index < 0) throw new Error("找不到指定的草稿。");
      const current = data.flowDrafts[index];
      if (!current) throw new Error("找不到指定的草稿。");
      if (current.revision !== revision) throw new StoreConflictError("草稿已更新；請重新載入後再試。");
      if (current.status !== "draft" && current.status !== "review") throw new StoreConflictError("此草稿已不可編輯。");
      const flow = value.flow === undefined ? current.flow : { ...parseDecisionFlow(value.flow), id };
      const cases = value.cases === undefined ? current.cases : parseFlowTestCases(value.cases);
      const updated: FlowDraft = {
        ...current, flow: structuredClone(flow), cases: structuredClone(cases), revision: randomUUID(),
        status: "draft", updatedAt: monotonicTimestamp(current.updatedAt), lastRun: null,
      };
      data.flowDrafts[index] = updated;
      return structuredClone(updated);
    });
  }

  async setDraftStatus(id: string, revision: string, status: "review" | "discarded"): Promise<FlowDraft> {
    return this.mutate((data) => {
      const index = data.flowDrafts.findIndex((draft) => draft.id === id);
      const current = data.flowDrafts[index];
      if (!current) throw new Error("找不到指定的草稿。");
      if (current.revision !== revision) throw new StoreConflictError("草稿已更新；請重新載入後再試。");
      if (current.status === "applied" || current.status === "discarded") throw new StoreConflictError("此草稿已不可變更。");
      const updated = { ...current, status, updatedAt: monotonicTimestamp(current.updatedAt) };
      data.flowDrafts[index] = updated;
      return structuredClone(updated);
    });
  }

  async saveDraftRun(id: string, revision: string, value: FlowDraftRun): Promise<FlowDraft> {
    const candidate = parseFlowTestRun(value.candidate);
    const baseline = value.baseline === null ? null : parseFlowTestRun(value.baseline);
    const traces = Object.fromEntries(Object.entries(value.traces).map(([caseId, trace]) => [caseId, parseFlowTestResult(trace)]));
    const baselineTraces = Object.fromEntries(Object.entries(value.baselineTraces).map(([caseId, trace]) => [caseId, parseFlowTestResult(trace)]));
    return this.mutate((data) => {
      const index = data.flowDrafts.findIndex((draft) => draft.id === id);
      const current = data.flowDrafts[index];
      if (!current) throw new Error("找不到指定的草稿。");
      if (current.revision !== revision) throw new StoreConflictError("草稿內容已更新；測試結果未儲存。");
      if (current.status === "applied" || current.status === "discarded") throw new StoreConflictError("此草稿已不可變更。");
      if (candidate.results.some((result) => !current.cases.some((testCase) => testCase.id === result.caseId)) ||
        baseline?.results.some((result) => !current.baseSuite?.cases.some((testCase) => testCase.id === result.caseId))) {
        throw new Error("草稿測試結果包含不存在的案例。");
      }
      if (Object.keys(traces).some((caseId) => !current.cases.some((testCase) => testCase.id === caseId)) ||
        Object.keys(baselineTraces).some((caseId) => !current.baseSuite?.cases.some((testCase) => testCase.id === caseId))) {
        throw new Error("草稿測試追蹤包含不存在的案例。");
      }
      const updated = { ...current, lastRun: { draftRevision: revision, candidate, baseline, traces, baselineTraces } };
      data.flowDrafts[index] = updated;
      return structuredClone(updated);
    });
  }

  async saveFlowTestCases(flowId: string, expectedRevision: string, value: unknown): Promise<FlowTestSuite> {
    const cases = parseFlowTestCases(value);
    return this.mutate((data) => {
      if (!data.flows.some((flow) => flow.id === flowId)) throw new Error("找不到指定的流程。");
      const index = data.flowTestSuites.findIndex((candidate) => candidate.flowId === flowId);
      const currentRevision = index < 0 ? "" : data.flowTestSuites[index]?.revision;
      if (currentRevision !== expectedRevision) throw new Error("測試案例已更新；請重新載入頁面後再試。");
      const suite: FlowTestSuite = { flowId, revision: randomUUID(), cases, lastRun: null };
      if (index < 0) data.flowTestSuites.push(suite);
      else data.flowTestSuites[index] = suite;
      return structuredClone(suite);
    });
  }

  async saveFlowTestRun(flowId: string, expectedRevision: string, value: unknown, partial = false): Promise<FlowTestSuite> {
    const lastRun: FlowTestRun = parseFlowTestRun(value);
    return this.mutate((data) => {
      if (!data.flows.some((flow) => flow.id === flowId)) throw new Error("找不到指定的流程。");
      const index = data.flowTestSuites.findIndex((candidate) => candidate.flowId === flowId);
      const suite = index < 0 ? { flowId, revision: "", cases: [], lastRun: null } : data.flowTestSuites[index];
      if (!suite || suite.revision !== expectedRevision) throw new Error("測試案例已更新；請重新執行批次測試。");
      if (lastRun.results.some((result) => !suite.cases.some((testCase) => testCase.id === result.caseId))) throw new Error("批次測試結果包含不存在的案例。");
      let mergedRun = lastRun;
      if (partial && suite.lastRun?.flowRevision === lastRun.flowRevision) {
        const resultsById = new Map([...suite.lastRun.results, ...lastRun.results].map((result) => [result.caseId, result]));
        mergedRun = { ...lastRun, results: suite.cases.flatMap((testCase) => {
          const result = resultsById.get(testCase.id);
          return result ? [result] : [];
        }) };
      }
      const updated = { ...suite, lastRun: mergedRun };
      if (index < 0) data.flowTestSuites.push(updated);
      else data.flowTestSuites[index] = updated;
      return structuredClone(updated);
    });
  }


  async applyDraft(id: string, revision: string, acknowledgeWarnings = false): Promise<{ flow: DecisionFlow; suite: FlowTestSuite; draft: FlowDraft }> {
    return this.mutate((data) => {
      const draftIndex = data.flowDrafts.findIndex((draft) => draft.id === id);
      const draft = data.flowDrafts[draftIndex];
      if (!draft) throw new Error("找不到指定的草稿。");
      if (draft.revision !== revision) throw new StoreConflictError("草稿已更新；請重新載入後再試。");
      if (draft.status !== "review") throw new StoreConflictError("草稿必須先提交審查才能套用。");
      if (draft.sourceFlowId !== null) {
        const source = data.flows.find((flow) => flow.id === draft.sourceFlowId);
        if (!source) throw new StoreConflictError("來源流程已不存在，草稿不能作為新流程套用。");
        const currentSuite = data.flowTestSuites.find((suite) => suite.flowId === source.id) ?? { flowId: source.id, revision: "", cases: [], lastRun: null };
        if (flowVersion(source) !== draft.baseFlowVersion || currentSuite.revision !== draft.baseSuite?.revision) {
          throw new StoreConflictError("來源流程或測試案例已更新；請重新建立草稿。");
        }
      }
      const issues = validateFlow(draft.flow);
      if (issues.length) throw new Error(`流程尚未完成，無法套用：${issues.join("；")}`);
      const enabledCases = draft.cases.filter((testCase) => testCase.enabled);
      const run = draft.lastRun;
      const results = run?.candidate.results ?? [];
      const completeRun = !!run && run.draftRevision === revision && run.candidate.flowRevision === flowRevision(draft.flow) &&
        enabledCases.every((testCase) => results.some((result) => result.caseId === testCase.id));
      const failed = enabledCases.some((testCase) => results.find((result) => result.caseId === testCase.id)?.status !== "passed");
      if ((!completeRun || failed) && !acknowledgeWarnings) throw new Error("請先完成所有啟用案例的批次測試；失敗或缺少結果時需明確確認警告。");
      const source = draft.sourceFlowId === null ? undefined : data.flows.find((flow) => flow.id === draft.sourceFlowId);
      const targetId = source?.id ?? randomUUID();
      const flow: DecisionFlow = {
        ...structuredClone(draft.flow), id: targetId, name: source?.name ?? draft.flow.name,
        updatedAt: monotonicTimestamp(source?.updatedAt ?? ""),
      };
      const suite: FlowTestSuite = {
        flowId: targetId, revision: randomUUID(), cases: structuredClone(draft.cases),
        lastRun: completeRun && run ? {
          ...structuredClone(run.candidate),
          flowRevision: flowRevision(flow),
        } : null,
      };
      if (source) {
        const oldSuite = data.flowTestSuites.find((candidate) => candidate.flowId === targetId) ?? { flowId: targetId, revision: "", cases: [], lastRun: null };
        data.flowHistory.push({
          id: randomUUID(), flowId: targetId, createdAt: new Date().toISOString(), reason: "draft-apply",
          flow: structuredClone(source), suite: structuredClone(oldSuite),
        });
        const flowIndex = data.flows.findIndex((candidate) => candidate.id === targetId);
        data.flows[flowIndex] = flow;
        const suiteIndex = data.flowTestSuites.findIndex((candidate) => candidate.flowId === targetId);
        if (suiteIndex < 0) data.flowTestSuites.push(suite);
        else data.flowTestSuites[suiteIndex] = suite;
      } else {
        if (data.flows.length >= MAX_PERSISTED_FLOWS) throw new Error(`最多只能建立 ${MAX_PERSISTED_FLOWS} 條流程。`);
        data.flows.push(flow);
        data.flowTestSuites.push(suite);
      }
      const applied = { ...draft, status: "applied" as const, updatedAt: monotonicTimestamp(draft.updatedAt) };
      data.flowDrafts[draftIndex] = applied;
      return { flow: structuredClone(flow), suite: structuredClone(suite), draft: structuredClone(applied) };
    });
  }

  async restoreHistory(flowId: string, entryId: string, expectedFlowVersion: string, expectedSuiteRevision: string): Promise<{ flow: DecisionFlow; suite: FlowTestSuite }> {
    return this.mutate((data) => {
      const flowIndex = data.flows.findIndex((flow) => flow.id === flowId);
      const current = data.flows[flowIndex];
      if (!current) throw new Error("找不到指定的流程。");
      const entry = data.flowHistory.find((candidate) => candidate.id === entryId && candidate.flowId === flowId);
      if (!entry) throw new Error("找不到指定的流程歷史紀錄。");
      const suiteIndex = data.flowTestSuites.findIndex((suite) => suite.flowId === flowId);
      const currentSuite = suiteIndex < 0 ? { flowId, revision: "", cases: [], lastRun: null } : data.flowTestSuites[suiteIndex];
      if (flowVersion(current) !== expectedFlowVersion || currentSuite?.revision !== expectedSuiteRevision) {
        throw new StoreConflictError("流程或測試案例已更新；請重新載入歷史紀錄後再試。");
      }
      const restored: DecisionFlow = {
        ...structuredClone(entry.flow), id: flowId, name: current.name, updatedAt: monotonicTimestamp(current.updatedAt),
      };
      const issues = validateFlow(restored);
      if (issues.length) throw new Error(`歷史流程無法還原：${issues.join("；")}`);
      data.flowHistory.push({
        id: randomUUID(), flowId, createdAt: new Date().toISOString(), reason: "history-restore",
        flow: structuredClone(current), suite: structuredClone(currentSuite),
      });
      const suite: FlowTestSuite = { ...structuredClone(entry.suite), flowId, revision: randomUUID(), lastRun: null };
      data.flows[flowIndex] = restored;
      if (suiteIndex < 0) data.flowTestSuites.push(suite);
      else data.flowTestSuites[suiteIndex] = suite;
      return { flow: structuredClone(restored), suite: structuredClone(suite) };
    });
  }

  listTemplates(): DecisionTemplate[] {
    return structuredClone(this.data.templates);
  }

  async createFlow(name: string): Promise<DecisionFlow> {
    return this.mutate((data) => {
      if (data.flows.length >= MAX_PERSISTED_FLOWS) throw new Error(`最多只能建立 ${MAX_PERSISTED_FLOWS} 條流程。`);
      const now = new Date().toISOString();
      const startId = randomUUID();
      const endId = randomUUID();
      const flow: DecisionFlow = {
        id: randomUUID(),
        name,
        updatedAt: now,
        nodes: [
          { id: startId, type: "start", position: { x: 80, y: 180 }, data: { label: "輸入請求" } },
          { id: endId, type: "end", position: { x: 420, y: 180 }, data: { label: "回傳 JSON", fields: [] } },
        ],
        edges: [{ id: randomUUID(), source: startId, target: endId, sourceHandle: "next" }],
      };
      data.flows.push(flow);
      return structuredClone(flow);
    });
  }

  async saveFlow(value: unknown): Promise<DecisionFlow> {
    const flow = parseDecisionFlow(value);
    return this.mutate((data) => {
      const index = data.flows.findIndex((candidate) => candidate.id === flow.id);
      if (index < 0) throw new Error("找不到要更新的流程。");
      const current = data.flows[index];
      if (!current) throw new Error("找不到要更新的流程。");
      if (flow.updatedAt !== current.updatedAt) throw new StoreConflictError("流程已更新；請重新載入頁面後再試。");
      const suite = data.flowTestSuites.find((candidate) => candidate.flowId === flow.id) ?? { flowId: flow.id, revision: "", cases: [], lastRun: null };
      data.flowHistory.push({
        id: randomUUID(), flowId: flow.id, createdAt: new Date().toISOString(), reason: "save",
        flow: structuredClone(current), suite: structuredClone(suite),
      });
      const saved = { ...flow, updatedAt: monotonicTimestamp(current.updatedAt) };
      data.flows[index] = saved;
      return structuredClone(saved);
    });
  }

  async deleteFlow(id: string): Promise<void> {
    return this.mutate((data) => {
      const index = data.flows.findIndex((flow) => flow.id === id);
      if (index < 0) throw new Error("找不到要刪除的流程。");
      data.flows.splice(index, 1);
      data.flowTestSuites = data.flowTestSuites.filter((suite) => suite.flowId !== id);
    });
  }

  async createTemplate(value: unknown): Promise<DecisionTemplate> {
    const data = parseDecisionStoreData({ flows: [], templates: [value] });
    const template = data.templates[0];
    if (!template) throw new Error("積木範本資料不正確。");
    return this.mutate((store) => {
      if (store.templates.length >= MAX_PERSISTED_TEMPLATES) throw new Error(`最多只能建立 ${MAX_PERSISTED_TEMPLATES} 個範本。`);
      if (store.templates.some((candidate) => candidate.id === template.id)) throw new Error("積木範本識別碼已存在。");
      store.templates.push(template);
      return structuredClone(template);
    });
  }

  async deleteTemplate(id: string): Promise<void> {
    return this.mutate((data) => {
      const index = data.templates.findIndex((template) => template.id === id);
      if (index < 0) throw new Error("找不到要刪除的積木範本。");
      data.templates.splice(index, 1);
    });
  }

  private async mutate<T>(change: (data: DecisionStoreData) => T): Promise<T> {
    const transaction = this.mutationQueue.then(async () => {
      const updated = structuredClone(this.data);
      const result = change(updated);
      await this.persist(updated);
      this.data = updated;
      return result;
    });
    this.mutationQueue = transaction.then(() => undefined, () => undefined);
    return transaction;
  }

  private async persist(data: DecisionStoreData): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(tempPath, JSON.stringify(data, null, 2), { encoding: "utf8", flag: "wx" });
      await rename(tempPath, this.filePath);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }
}
