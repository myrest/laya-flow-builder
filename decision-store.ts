import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChoiceQuestion } from "../laya/src/types.js";
import { DEFAULT_MIN_CONFIDENCE } from "./decision-types.js";
import { getDefaultLowConfidenceBranch } from "./decision-engine.js";
import { parseDecisionFlow, parseDecisionStoreData, parseFlowTestCases, parseFlowTestRun } from "./decision-schema.js";
import type { DecisionFlow, DecisionStoreData, DecisionTemplate, EndFlowNode, FlowNode, FlowTestRun, FlowTestSuite } from "./decision-types.js";

const DEFAULT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const MAX_PERSISTED_FLOWS = 500;
const MAX_PERSISTED_TEMPLATES = 500;

function defaultChoice(instructions: string, criteria: Record<string, string>): ChoiceQuestion {
  return { type: "choice", instructions, criteria };
}

function demoDecision(id: string, label: string, question: ChoiceQuestion, position: { x: number; y: number }): FlowNode {
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
    notRequest: randomUUID(),
    unknownDevice: randomUUID(),
    actionOn: randomUUID(),
    actionOff: randomUUID(),
    actionOther: randomUUID(),
  };
  const requestQuestion = defaultChoice("這句話是否明確要求操作物聯網裝置？", {
    yes: "明確要求控制裝置，例如打開、關閉或調整設定",
    no: "不是裝置控制要求，例如詢問資訊或一般對話",
  });
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
    { id: ids.start, type: "start", position: { x: 60, y: 280 }, data: { label: "輸入請求" } },
    demoDecision(ids.request, "#1｜是否為 IoT 操作", requestQuestion, { x: 350, y: 280 }),
    demoDecision(ids.device, "#2｜識別裝置", deviceQuestion, { x: 700, y: 180 }),
    demoDecision(ids.action, "#3｜判斷操作", actionQuestion, { x: 1050, y: 180 }),
    demoEnd(ids.notRequest, "非 IoT 操作", { x: 700, y: 500 }, [
      { id: randomUUID(), key: "iotRequest", value: { kind: "literal", value: false } },
    ]),
    demoEnd(ids.unknownDevice, "其他裝置", { x: 1050, y: 470 }, [
      { id: randomUUID(), key: "iotRequest", value: { kind: "literal", value: true } },
      { id: randomUUID(), key: "acceptedDevice", value: { kind: "literal", value: false } },
      { id: randomUUID(), key: "device", value: { kind: "literal", value: "other" } },
    ]),
    demoEnd(ids.actionOn, "輸出：開啟", { x: 1430, y: 100 }, [
      { id: randomUUID(), key: "iotRequest", value: { kind: "literal", value: true } },
      { id: randomUUID(), key: "acceptedDevice", value: { kind: "literal", value: true } },
      { id: randomUUID(), key: "device", value: { kind: "literal", value: "fan" } },
      { id: randomUUID(), key: "action", value: { kind: "literal", value: "on" } },
    ]),
    demoEnd(ids.actionOff, "輸出：關閉", { x: 1430, y: 280 }, [
      { id: randomUUID(), key: "iotRequest", value: { kind: "literal", value: true } },
      { id: randomUUID(), key: "acceptedDevice", value: { kind: "literal", value: true } },
      { id: randomUUID(), key: "device", value: { kind: "literal", value: "fan" } },
      { id: randomUUID(), key: "action", value: { kind: "literal", value: "off" } },
    ]),
    demoEnd(ids.actionOther, "輸出：其他操作", { x: 1430, y: 460 }, [
      { id: randomUUID(), key: "iotRequest", value: { kind: "literal", value: true } },
      { id: randomUUID(), key: "acceptedDevice", value: { kind: "literal", value: true } },
      { id: randomUUID(), key: "device", value: { kind: "literal", value: "fan" } },
      { id: randomUUID(), key: "action", value: { kind: "literal", value: "other" } },
    ]),
  ];
  const flow: DecisionFlow = {
    id: randomUUID(),
    name: "IoT 操作判斷（範例）",
    updatedAt: now,
    nodes: decisionNodes,
    edges: [
      { id: randomUUID(), source: ids.start, target: ids.request, sourceHandle: "next" },
      { id: randomUUID(), source: ids.request, target: ids.device, sourceHandle: "choice:yes" },
      { id: randomUUID(), source: ids.request, target: ids.notRequest, sourceHandle: "choice:no" },
      { id: randomUUID(), source: ids.device, target: ids.action, sourceHandle: "choice:fan" },
      { id: randomUUID(), source: ids.device, target: ids.unknownDevice, sourceHandle: "choice:other" },
      { id: randomUUID(), source: ids.action, target: ids.actionOn, sourceHandle: "choice:on" },
      { id: randomUUID(), source: ids.action, target: ids.actionOff, sourceHandle: "choice:off" },
      { id: randomUUID(), source: ids.action, target: ids.actionOther, sourceHandle: "choice:other" },
    ],
  };

  return { flows: [flow], templates: [], flowTestSuites: [] };
}

export class DecisionStore {
  private data: DecisionStoreData = { flows: [], templates: [], flowTestSuites: [] };
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
      const saved = { ...flow, updatedAt: new Date().toISOString() };
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
