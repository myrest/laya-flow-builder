import type { Laya } from "@receptron/laya";
import { DecisionFlowError, getBranchPorts, getDefaultLowConfidenceBranch, runFlow, validateFlow } from "./decision-engine.js";
import { isRecord } from "./decision-guards.js";
import { MAX_FLOW_NAME_LENGTH, MAX_FLOW_NODES, MAX_FLOW_TEST_CASES, MAX_FLOW_TEST_NAME_LENGTH, MAX_INPUT_NODE_REFS, MAX_QUESTION_OPTIONS } from "./decision-types.js";
import type { DecisionFlow, DecisionFlowNode, FlowDraft, FlowDraftChange, FlowDraftPreview, FlowHistoryEntry, FlowTestCase, FlowTestCaseResult, FlowTestRun, FlowTestResult, FlowTestSuite } from "./decision-types.js";
import { DecisionStore, StoreConflictError, flowVersion } from "./decision-store.js";
import { flowRevision, outputsEqual } from "./flow-test-utils.js";

export class FlowDraftServiceError extends Error {
  constructor(readonly status: number, message: string, readonly issues?: string[]) {
    super(message);
    this.name = "FlowDraftServiceError";
  }
}

function draftOrThrow(store: DecisionStore, id: string): FlowDraft {
  const draft = store.getDraft(id);
  if (!draft) throw new FlowDraftServiceError(404, "找不到指定的流程草稿。");
  return draft;
}

function requireDraftRevision(draft: FlowDraft, revision: unknown): void {
  if (typeof revision !== "string" || revision !== draft.revision) {
    throw new StoreConflictError("流程草稿已更新；請重新載入草稿後再試。");
  }
}


function compareJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => compareJson(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined);
  const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.hasOwn(right, key) && right[key] !== undefined && compareJson(left[key], right[key]));
}

function pathPart(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function diffValues(before: unknown, after: unknown, path: string, changes: FlowDraftChange[]): void {
  if (compareJson(before, after)) return;
  if (isRecord(before) && isRecord(after)) {
    const beforeKeys = Object.keys(before).filter((key) => before[key] !== undefined);
    const afterKeys = Object.keys(after).filter((key) => after[key] !== undefined);
    for (const key of new Set([...beforeKeys, ...afterKeys])) {
      const nextPath = `${path}/${pathPart(key)}`;
      const hasBefore = Object.hasOwn(before, key) && before[key] !== undefined;
      const hasAfter = Object.hasOwn(after, key) && after[key] !== undefined;
      if (!hasBefore) changes.push({ path: nextPath, after: after[key] });
      else if (!hasAfter) changes.push({ path: nextPath, before: before[key] });
      else diffValues(before[key], after[key], nextPath, changes);
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)
    && before.every((value) => isRecord(value) && typeof value.id === "string")
    && after.every((value) => isRecord(value) && typeof value.id === "string")) {
    const beforeById = new Map(before.map((value) => [String((value as Record<string, unknown>).id), value]));
    const afterById = new Map(after.map((value) => [String((value as Record<string, unknown>).id), value]));
    for (const id of new Set([...beforeById.keys(), ...afterById.keys()])) {
      const nextPath = `${path}[${id}]`;
      if (!beforeById.has(id)) changes.push({ path: nextPath, after: afterById.get(id) });
      else if (!afterById.has(id)) changes.push({ path: nextPath, before: beforeById.get(id) });
      else diffValues(beforeById.get(id), afterById.get(id), nextPath, changes);
    }
    return;
  }
  changes.push({ path, before, after });
}


function flowChanges(before: DecisionFlow | null, after: DecisionFlow): FlowDraftChange[] {
  const changes: FlowDraftChange[] = [];
  if (!before) changes.push({ path: "/flow", after });
  else diffValues(before, after, "/flow", changes);
  return changes;
}

function testCaseChanges(before: FlowTestCase[], after: FlowTestCase[]): FlowDraftChange[] {
  const changes: FlowDraftChange[] = [];
  diffValues(before, after, "/cases", changes);
  return changes;
}

function enabledCases(cases: FlowTestCase[]): FlowTestCase[] {
  return cases.filter((testCase) => testCase.enabled);
}

async function executeBatch(
  flow: DecisionFlow,
  cases: FlowTestCase[],
  laya: Pick<Laya, "systemOne">,
): Promise<{ run: FlowTestRun; traces: Record<string, FlowTestResult> }> {
  const results: FlowTestCaseResult[] = [];
  const traces: Record<string, FlowTestResult> = {};
  for (const testCase of enabledCases(cases)) {
    const caseStarted = performance.now();
    try {
      const result = await runFlow(flow, testCase.input, laya);
      const status = outputsEqual(result.output, testCase.expectedOutput) ? "passed" : "failed";
      results.push({ caseId: testCase.id, status, actualOutput: result.output, durationMs: result.durationMs });
      if (status !== "passed") traces[testCase.id] = result;
    } catch (error) {
      results.push({
        caseId: testCase.id,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        durationMs: Math.round(performance.now() - caseStarted),
      });
    }
  }
  return {
    run: { ranAt: new Date().toISOString(), flowRevision: flowRevision(flow), results },
    traces,
  };
}

function currentRunWarnings(draft: FlowDraft): string[] {
  const warnings: string[] = [];
  const enabled = enabledCases(draft.cases);
  const run = draft.lastRun;
  if (enabled.length === 0) warnings.push("草稿沒有啟用中的測試案例。");
  if (!run || run.draftRevision !== draft.revision || run.candidate.flowRevision !== flowRevision(draft.flow)) {
    warnings.push("目前草稿版本尚未完成批次測試。");
    return warnings;
  }
  const resultIds = new Set(run.candidate.results.map((result) => result.caseId));
  if (run.candidate.results.length !== enabled.length || enabled.some((testCase) => !resultIds.has(testCase.id))) {
    warnings.push("批次測試沒有涵蓋所有啟用案例。");
  }
  const failures = run.candidate.results.filter((result) => result.status !== "passed");
  if (failures.length > 0) warnings.push(`草稿有 ${failures.length} 個案例未通過或發生錯誤。`);
  return warnings;
}

export class FlowDraftService {
  constructor(private readonly store: DecisionStore, private readonly laya: Pick<Laya, "systemOne">) {}

  list(sourceFlowId?: string): FlowDraft[] {
    return this.store.listDrafts(sourceFlowId);
  }

  get(id: string): FlowDraft {
    return draftOrThrow(this.store, id);
  }

  create(sourceFlowId?: string, name?: string): Promise<FlowDraft> {
    return this.store.createDraft(sourceFlowId, name);
  }

  async update(id: string, revision: unknown, value: { flow?: unknown; cases?: unknown }): Promise<FlowDraft> {
    const draft = draftOrThrow(this.store, id);
    requireDraftRevision(draft, revision);
    return this.store.updateDraft(id, draft.revision, value);
  }

  async validate(id: string, revision: unknown): Promise<{ issues: string[] }> {
    const draft = draftOrThrow(this.store, id);
    requireDraftRevision(draft, revision);
    return { issues: validateFlow(draft.flow) };
  }

  async test(id: string, revision: unknown, input: unknown): Promise<FlowTestResult> {
    const draft = draftOrThrow(this.store, id);
    requireDraftRevision(draft, revision);
    const issues = validateFlow(draft.flow);
    if (issues.length > 0) throw new DecisionFlowError("流程尚未完成，無法執行草稿測試。", issues);
    return runFlow(draft.flow, input, this.laya);
  }

  async runBatch(id: string, revision: unknown): Promise<FlowDraft> {
    const draft = draftOrThrow(this.store, id);
    requireDraftRevision(draft, revision);
    const issues = validateFlow(draft.flow);
    if (issues.length > 0) throw new DecisionFlowError("流程尚未完成，無法執行批次測試。", issues);
    if (draft.cases.length > MAX_FLOW_TEST_CASES) throw new FlowDraftServiceError(400, `測試案例不可超過 ${MAX_FLOW_TEST_CASES} 筆。`);
    const baseline = draft.baseFlow && draft.baseSuite
      ? await executeBatch(draft.baseFlow, draft.baseSuite.cases, this.laya)
      : null;
    const candidate = await executeBatch(draft.flow, draft.cases, this.laya);
    const run = {
      draftRevision: draft.revision,
      baseline: baseline?.run ?? null,
      candidate: candidate.run,
      traces: candidate.traces,
      baselineTraces: baseline?.traces ?? {},
    };
    return this.store.saveDraftRun(draft.id, draft.revision, run);
  }

  async submit(id: string, revision: unknown): Promise<FlowDraft> {
    const draft = draftOrThrow(this.store, id);
    requireDraftRevision(draft, revision);
    const issues = validateFlow(draft.flow);
    if (issues.length > 0) throw new DecisionFlowError("流程尚未完成，無法送交人工審查。", issues);
    return this.store.setDraftStatus(id, draft.revision, "review");
  }

  async discard(id: string, revision: unknown): Promise<FlowDraft> {
    const draft = draftOrThrow(this.store, id);
    requireDraftRevision(draft, revision);
    return this.store.setDraftStatus(id, draft.revision, "discarded");
  }

  preview(id: string): FlowDraftPreview {
    const draft = draftOrThrow(this.store, id);
    const currentFlow = draft.sourceFlowId === null ? null : this.store.getFlow(draft.sourceFlowId) ?? null;
    const currentSuite = currentFlow ? this.store.getFlowTestSuite(currentFlow.id) : null;
    const currentFlowVersion = currentFlow ? flowVersion(currentFlow) : null;
    const conflict = (draft.status === "draft" || draft.status === "review")
      && draft.sourceFlowId !== null
      && (
        currentFlow === null
        || currentFlowVersion !== draft.baseFlowVersion
        || currentSuite?.revision !== draft.baseSuite?.revision
      );
    const issues = validateFlow(draft.flow);
    const proposedFlow = draft.baseFlow
      ? { ...draft.flow, id: draft.baseFlow.id, name: draft.baseFlow.name, updatedAt: draft.baseFlow.updatedAt }
      : draft.flow;
    const changes = flowChanges(draft.baseFlow, proposedFlow);
    const caseChanges = testCaseChanges(draft.baseSuite?.cases ?? [], draft.cases);
    const warnings = currentRunWarnings(draft);
    if (conflict) warnings.unshift("來源流程或測試套件已在草稿建立後變更；此草稿不可覆蓋現行版。");
    if (issues.length > 0) warnings.unshift("草稿流程尚未通過結構驗證。");
    if (caseChanges.length > 0) warnings.push("草稿修改了基準測試案例；請人工檢查預期輸出、輸入與啟用狀態。");
    const baselineFailures = draft.lastRun?.baseline?.results.filter((result) => result.status !== "passed") ?? [];
    if (baselineFailures.length > 0) warnings.push(`現行版基準有 ${baselineFailures.length} 個案例未通過或發生錯誤；請與草稿結果分開檢視。`);
    return { draft, currentFlow, currentSuite, currentFlowVersion, conflict, issues, changes, caseChanges, warnings };
  }

  async apply(id: string, revision: unknown, acknowledgeWarnings: boolean): Promise<{ flow: DecisionFlow; suite: FlowTestSuite; draft: FlowDraft }> {
    const draft = draftOrThrow(this.store, id);
    requireDraftRevision(draft, revision);
    if (draft.status !== "review") throw new FlowDraftServiceError(409, "只有已送交人工審查的草稿可以覆蓋現行版。");
    const preview = this.preview(id);
    if (preview.conflict) throw new StoreConflictError("來源流程或測試套件已更新；請以最新版本重新建立草稿。");
    if (preview.issues.length > 0) throw new DecisionFlowError("流程尚未完成，無法覆蓋現行版。", preview.issues);
    if (preview.warnings.length > 0 && !acknowledgeWarnings) {
      throw new FlowDraftServiceError(409, "草稿有未解決的測試或案例警告；請先檢查，並在人工確認後勾選繼續。", preview.warnings);
    }
    return this.store.applyDraft(id, draft.revision, acknowledgeWarnings);
  }

  history(flowId: string): FlowHistoryEntry[] {
    if (!this.store.getFlow(flowId)) throw new FlowDraftServiceError(404, "找不到指定的流程。");
    return this.store.listHistory(flowId);
  }

  async restore(flowId: string, entryId: string, flowVersionValue: string, suiteRevision: string): Promise<{ flow: DecisionFlow; suite: FlowTestSuite }> {
    try {
      return await this.store.restoreHistory(flowId, entryId, flowVersionValue, suiteRevision);
    } catch (error) {
      if (error instanceof StoreConflictError) throw error;
      if (error instanceof Error && error.message.includes("找不到")) throw new FlowDraftServiceError(404, error.message);
      throw error;
    }
  }
}

function contractDecisionNode(question: DecisionFlowNode["data"]["question"], scoreThresholds: number[]): DecisionFlowNode {
  return {
    id: "decision-example",
    type: "decision",
    position: { x: 0, y: 0 },
    data: {
      label: "Decision example",
      question,
      inputNodeIds: [],
      trueThreshold: 0.5,
      minConfidence: 0.2,
      lowConfidenceBranch: getDefaultLowConfidenceBranch(question, scoreThresholds),
      scoreThresholds,
    },
  };
}

export function flowDraftContract(store: DecisionStore) {
  const choiceQuestion: DecisionFlowNode["data"]["question"] = {
    type: "choice",
    instructions: "Choose one category.",
    criteria: { yes: "Accepted", no: "Rejected", other: "Unclear or unsupported" },
  };
  const noulQuestion: DecisionFlowNode["data"]["question"] = {
    type: "noul",
    instructions: "Does this match?",
    criteria: { true: "Yes", false: "No" },
  };
  const scoreQuestion: DecisionFlowNode["data"]["question"] = {
    type: "score",
    instructions: "How strongly does this match?",
    criteria: ["low", "medium", "high"],
  };
  const choiceNode = contractDecisionNode(choiceQuestion, []);
  const noulNode = contractDecisionNode(noulQuestion, []);
  const scoreNode = contractDecisionNode(scoreQuestion, [1]);
  return {
    schemaVersion: 2,
    model: { name: "alexdoandev/laya-multilingual-onnx", loadedBy: "API server; MCP clients must reuse the running server" },
    limits: {
      maxFlowNameLength: MAX_FLOW_NAME_LENGTH,
      maxFlowNodes: MAX_FLOW_NODES,
      maxQuestionOptions: MAX_QUESTION_OPTIONS,
      maxInputNodeRefs: MAX_INPUT_NODE_REFS,
      maxTestCases: MAX_FLOW_TEST_CASES,
      maxTestNameLength: MAX_FLOW_TEST_NAME_LENGTH,
    },
    flow: {
      fields: { id: "string", name: "string", updatedAt: "ISO timestamp", nodes: "FlowNode[]", edges: "FlowEdge[]" },
      nodeTypes: {
        start: { data: { label: "string" }, outgoingPort: "next", exactlyOneOutgoing: true },
        decision: {
          data: {
            label: "string",
            question: {
              choice: { type: "choice", instructions: "string or supported instruction object", criteria: "object mapping option key to explanation" },
              noul: { type: "noul", instructions: "string or supported instruction object", criteria: { true: "explanation", false: "explanation" } },
              score: { type: "score", instructions: "string or supported instruction object", criteria: "ordered explanation strings" },
            },
            inputNodeIds: "upstream decision node IDs",
            trueThreshold: "number 0..1",
            minConfidence: "number 0..1; 0 disables fallback",
            lowConfidenceBranch: "an existing branch ID for this question",
            scoreThresholds: "strictly increasing score boundaries",
          },
          branchIdRules: {
            choice: "choice:${encodeURIComponent(optionKey)}",
            noul: ["true", "false"],
            score: "score:all when no thresholds; otherwise score:<zero-based range index>",
          },
          branchIds: {
            choice: getBranchPorts(choiceNode).map((port) => ({ id: port.id, label: port.label })),
            noul: getBranchPorts(noulNode).map((port) => ({ id: port.id, label: port.label })),
            score: getBranchPorts(scoreNode).map((port) => ({ id: port.id, label: port.label })),
          },
          lowConfidenceDefault: {
            choice: choiceNode.data.lowConfidenceBranch,
            noul: noulNode.data.lowConfidenceBranch,
            score: scoreNode.data.lowConfidenceBranch,
          },
          fallbackSemantics: "Low confidence routes through an existing selected branch; it never creates another output port.",
        },
        end: { data: { label: "string", fields: "[{id,key,value:{kind:'literal',value:JsonValue}|{kind:'decision',nodeId:upstreamDecisionId}}]" }, outgoingPort: null },
      },
      edge: { fields: { id: "string", source: "node ID", target: "node ID", sourceHandle: "valid source port ID" } },
      validation: [
        "Exactly one start and at least one end.",
        "Start has exactly one outgoing edge from 'next'; every decision node has exactly one incoming edge.",
        "Each required decision branch has exactly one outgoing edge; mutually exclusive branches may share an end node.",
        "All nodes are reachable from start; no cycles; decision input references point to decision ancestors on the executed path.",
        "End output references may point to any upstream decision; if that decision did not run on this branch, the output is null.",
        "The complete flow must pass validate_flow_draft before test or submission.",
      ],
    },
    tests: {
      case: {
        fields: { id: "unique string", name: "string", input: "any JsonValue", expectedOutput: "JSON object of JsonValue values", enabled: "boolean" },
        maxCases: MAX_FLOW_TEST_CASES,
        semantics: "Only enabled cases run; output equality ignores object key order and preserves array order.",
      },
      draftBatch: "Runs baseline source cases and candidate draft cases separately; results and failing traces are saved only on the draft.",
    },
    draftLifecycle: {
      statuses: ["draft", "review", "applied", "discarded"],
      isolation: "MCP writes only draft.flow and draft.cases; live flow and live test history remain unchanged until a human applies.",
      sourceApply: "Human admin only; preserve the live flow ID and name, atomically replace flow and test cases, and archive the prior snapshot.",
      newFlowApply: "Human admin only; create a fresh live flow ID from a new-flow draft.",
      staleSource: "Apply is rejected if any live-flow snapshot field or the live test-suite revision changed after draft creation.",
      history: "Human admin only; restore creates a new live revision, archives the current version, and clears old test results.",
      mcpRestrictions: "MCP cannot apply drafts or restore history.",
    },
    execution: {
      resultTraceFields: ["answer", "value", "confidence", "lowConfidenceFallback", "branch", "durationMs"],
      testExpectedOutput: "Complete JSON object equality; object key order is ignored, array order matters.",
      noExternalSideEffects: true,
    },
    templates: store.listTemplates().map((template) => ({ id: template.id, name: template.name, questionType: template.question.type })),
    utilities: { getBranchPorts: "returns each decision node's current branch ids and labels", flowRevision: "semantic execution revision; ignores canvas positions and edge IDs" },
  };
}
