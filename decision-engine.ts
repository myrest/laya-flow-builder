import type { Laya } from "../laya/src/index.js";
import type { Answer, Question } from "../laya/src/types.js";
import type {
  BranchPort,
  DecisionFlow,
  DecisionFlowNode,
  DecisionNodeTrace,
  EndFlowNode,
  FlowEdge,
  FlowNode,
  FlowTestResult,
  JsonValue,
} from "./decision-types.js";
import { MAX_FLOW_NODES, MAX_FLOW_NAME_LENGTH, MAX_INPUT_NODE_REFS, MAX_QUESTION_OPTIONS } from "./decision-types.js";
import { isRecord } from "./decision-guards.js";

export class DecisionFlowError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = "DecisionFlowError";
  }
}


function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isQuestion(value: unknown): value is Question {
  if (!isRecord(value) || (typeof value.instructions !== "string" && !isRecord(value.instructions)) || (typeof value.instructions === "string" && value.instructions.trim().length === 0)) return false;
  if (value.type === "choice") {
    if (!isRecord(value.criteria)) return false;
    const options = Object.entries(value.criteria);
    return options.length >= 2 && options.length <= MAX_QUESTION_OPTIONS && options.every(([key, text]) => key.trim().length > 0 && (typeof text === "string" || text === null));
  }
  if (value.type === "score") {
    return Array.isArray(value.criteria) && value.criteria.length >= 2 && value.criteria.length <= MAX_QUESTION_OPTIONS && value.criteria.every((item) => typeof item === "string" && item.trim().length > 0);
  }
  return value.type === "noul" && (value.criteria === undefined || isRecord(value.criteria));
}

function decisionNode(node: FlowNode): node is DecisionFlowNode {
  return node.type === "decision";
}

export function getBranchPorts(node: DecisionFlowNode): BranchPort[] {
  const question = node.data.question;
  if (question.type === "choice") return Object.keys(question.criteria).map((key) => ({ id: choicePortId(key), label: key }));
  if (question.type === "noul") {
    return [
      { id: "true", label: "是（P(true) ≥ 門檻）" },
      { id: "false", label: "否（P(true) < 門檻）" },
    ];
  }
  return scoreRanges(node.data.scoreThresholds);
}

export function choicePortId(key: string): string {
  return `choice:${encodeURIComponent(key)}`;
}

export function scoreRanges(thresholds: number[]): BranchPort[] {
  if (thresholds.length === 0) return [{ id: "score:all", label: "所有分數" }];
  return Array.from({ length: thresholds.length + 1 }, (_, index) => {
    const lower = thresholds[index - 1];
    const upper = thresholds[index];
    const label = lower === undefined ? `分數 < ${upper}` : upper === undefined ? `分數 ≥ ${lower}` : `${lower} ≤ 分數 < ${upper}`;
    return { id: `score:${index}`, label };
  });
}

export function scorePortFor(score: number, thresholds: number[]): string {
  if (thresholds.length === 0) return "score:all";
  const index = thresholds.findIndex((threshold) => score < threshold);
  return `score:${index < 0 ? thresholds.length : index}`;
}
export function getDefaultLowConfidenceBranch(question: Question, scoreThresholds: number[]): string {
  if (question.type === "choice") {
    const keys = Object.keys(question.criteria);
    const fallback = keys.includes("other") ? "other" : keys.includes("no") ? "no" : keys[0];
    return fallback === undefined ? "" : choicePortId(fallback);
  }
  if (question.type === "noul") return "false";
  return scoreRanges(scoreThresholds)[0]?.id ?? "";
}

function issue(issues: string[], node: FlowNode, message: string): void {
  issues.push(`${node.data.label || node.id}: ${message}`);
}

export function validateFlow(flow: DecisionFlow): string[] {
  const issues: string[] = [];
  if (!isRecord(flow) || typeof flow.id !== "string" || typeof flow.name !== "string") return ["流程資料格式不正確。"];
  if (flow.name.trim().length === 0 || flow.name.length > MAX_FLOW_NAME_LENGTH) issues.push(`流程名稱必須是 1～${MAX_FLOW_NAME_LENGTH} 個字元。`);
  if (!Array.isArray(flow.nodes) || flow.nodes.length > MAX_FLOW_NODES) return [...issues, `流程節點數不可超過 ${MAX_FLOW_NODES}。`];
  if (!Array.isArray(flow.edges)) return [...issues, "流程連線資料格式不正確。"];

  const ids = new Set<string>();
  const nodeById = new Map<string, FlowNode>();
  for (const node of flow.nodes) {
    if (!isRecord(node) || typeof node.id !== "string" || node.id.length === 0) {
      issues.push("每個節點都需要唯一識別碼。");
      continue;
    }
    if (ids.has(node.id)) issues.push(`節點識別碼重複：${node.id}。`);
    ids.add(node.id);
    nodeById.set(node.id, node);
    if (!isRecord(node.position) || !isFiniteNumber(node.position.x) || !isFiniteNumber(node.position.y)) issue(issues, node, "畫布位置不正確。");
    if (!isRecord(node.data) || typeof node.data.label !== "string" || node.data.label.trim().length === 0) issue(issues, node, "請設定節點名稱。");
    if (node.type === "decision") {
      if (!isQuestion(node.data.question)) issue(issues, node, "題目格式不正確，請檢查題型、說明與選項。");
      if (!Array.isArray(node.data.inputNodeIds) || node.data.inputNodeIds.length > MAX_INPUT_NODE_REFS || node.data.inputNodeIds.some((id) => typeof id !== "string")) {
        issue(issues, node, `前置結果引用最多 ${MAX_INPUT_NODE_REFS} 個。`);
      }
      if (!isFiniteNumber(node.data.trueThreshold) || node.data.trueThreshold < 0 || node.data.trueThreshold > 1) issue(issues, node, "是非題門檻必須介於 0 與 1。");
      if (!isFiniteNumber(node.data.minConfidence) || node.data.minConfidence < 0 || node.data.minConfidence > 1) {
        issue(issues, node, "最低信心門檻必須介於 0 與 1。");
      }
      if (typeof node.data.lowConfidenceBranch !== "string" || !getBranchPorts(node).some((port) => port.id === node.data.lowConfidenceBranch)) {
        issue(issues, node, "低信心預設必須是此題型的有效出口。");
      }
      if (!Array.isArray(node.data.scoreThresholds) || node.data.scoreThresholds.some((value) => !isFiniteNumber(value))) issue(issues, node, "評分切分點必須是有限數值。");
      else if (node.data.question?.type === "score") {
        const max = node.data.question.criteria.length - 1;
        const thresholds = node.data.scoreThresholds;
        if (thresholds.some((value, index) => value <= 0 || value >= max || (index > 0 && value <= thresholds[index - 1]!))) {
          issue(issues, node, `評分切分點需嚴格遞增，且介於 0 與 ${max} 之間（不含端點）。`);
        }
      } else if (node.data.scoreThresholds.length > 0) issue(issues, node, "只有評分題可設定數值切分點。");
    } else if (node.type === "end") {
      if (!Array.isArray(node.data.fields)) issue(issues, node, "結束節點需要 JSON 回傳欄位。");
      else {
        const keys = new Set<string>();
        for (const field of node.data.fields) {
          if (!isRecord(field) || typeof field.key !== "string" || field.key.trim().length === 0) {
            issue(issues, node, "回傳欄位需要非空欄位名稱。");
            continue;
          }
          if (keys.has(field.key)) issue(issues, node, `回傳欄位名稱重複：${field.key}。`);
          keys.add(field.key);
          if (field.value?.kind !== "literal" && !(field.value?.kind === "decision" && typeof field.value.nodeId === "string")) {
            issue(issues, node, `回傳欄位「${field.key}」的值設定不正確。`);
          }
        }
      }
    } else if (node.type !== "start") issue(issues, node, "不支援的節點類型。");
  }

  const starts = flow.nodes.filter((node) => node.type === "start");
  const ends = flow.nodes.filter((node) => node.type === "end");
  if (starts.length !== 1) issues.push("每條流程必須且只能有一個起點。");
  if (ends.length === 0) issues.push("流程至少需要一個結束節點。");
  if (flow.nodes.length === 0) return [...issues, "流程尚無節點。"];

  const incoming = new Map<string, FlowEdge[]>();
  const outgoing = new Map<string, FlowEdge[]>();
  const usedPorts = new Set<string>();
  const edgeIds = new Set<string>();
  for (const edge of flow.edges) {
    if (!isRecord(edge) || typeof edge.id !== "string" || typeof edge.source !== "string" || typeof edge.target !== "string" || typeof edge.sourceHandle !== "string") {
      issues.push("有一條連線格式不正確。");
      continue;
    }
    if (edgeIds.has(edge.id)) issues.push(`連線識別碼重複：${edge.id}。`);
    edgeIds.add(edge.id);
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) {
      issues.push(`連線 ${edge.id} 指向不存在的節點。`);
      continue;
    }
    if (target.type === "start") issues.push("起點不能有輸入連線。");
    if (source.type === "end") issues.push("結束節點不能再連到其他節點。");
    const portKey = `${edge.source}\u0000${edge.sourceHandle}`;
    if (usedPorts.has(portKey)) issues.push(`節點「${source.data.label}」的出口「${edge.sourceHandle}」連到多個節點；每個出口只能接一個下一步。`);
    usedPorts.add(portKey);
    if (source.type === "start" && edge.sourceHandle !== "next") issues.push("起點只能使用 next 出口。");
    if (source.type === "decision" && !getBranchPorts(source).some((port) => port.id === edge.sourceHandle)) {
      issue(issues, source, edge.sourceHandle === "uncertain"
        ? "舊的「信心不足」出口已移除；請改用有效選項並指定低信心預設。"
        : `連線使用了不存在的出口「${edge.sourceHandle}」。`);
    }
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge]);
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
  }

  for (const node of flow.nodes) {
    const parents = incoming.get(node.id) ?? [];
    if (node.type === "start" && parents.length > 0) issue(issues, node, "起點不能有上游節點。");
    if (node.type !== "start" && parents.length !== 1) issue(issues, node, "每個非起點節點必須且只能有一個上游節點。");
    if (node.type === "start" && (outgoing.get(node.id) ?? []).length !== 1) issue(issues, node, "起點必須連到一個下一步。");
    if (node.type === "decision") {
      for (const port of getBranchPorts(node)) {
        if (!port.optional && !usedPorts.has(`${node.id}\u0000${port.id}`)) issue(issues, node, `出口「${port.label}」尚未連線。`);
      }
      for (const ref of node.data.inputNodeIds) {
        const target = nodeById.get(ref);
        if (!target || target.type !== "decision") issue(issues, node, `前置結果引用「${ref}」不是有效的決策節點。`);
      }
    }
    if (node.type === "end" && (outgoing.get(node.id) ?? []).length !== 0) issue(issues, node, "結束節點不能有下一步。");
  }

  const start = starts[0];
  if (start) {
    const visited = new Set<string>();
    const active = new Set<string>();
    const walk = (id: string): void => {
      if (active.has(id)) {
        issues.push("流程包含迴圈；決策流程只能向前執行。");
        return;
      }
      if (visited.has(id)) return;
      visited.add(id);
      active.add(id);
      for (const edge of outgoing.get(id) ?? []) walk(edge.target);
      active.delete(id);
    };
    walk(start.id);
    for (const node of flow.nodes) if (!visited.has(node.id)) issue(issues, node, "節點無法從起點到達。");

    for (const node of flow.nodes) {
      if (!decisionNode(node) && node.type !== "end") continue;
      const ancestors = new Set<string>();
      const traversed = new Set<string>();
      let cursor = incoming.get(node.id)?.[0]?.source;
      while (cursor && !traversed.has(cursor)) {
        traversed.add(cursor);
        ancestors.add(cursor);
        cursor = incoming.get(cursor)?.[0]?.source;
      }
      if (decisionNode(node)) {
        for (const ref of node.data.inputNodeIds) if (!ancestors.has(ref)) issue(issues, node, `前置結果「${nodeById.get(ref)?.data.label ?? ref}」必須位於此節點上游。`);
      } else if (node.type === "end" && Array.isArray(node.data.fields)) {
        for (const field of node.data.fields) {
          if (field?.value?.kind !== "decision") continue;
          const target = nodeById.get(field.value.nodeId);
          if (!target || target.type !== "decision") issue(issues, node, `回傳欄位「${field.key}」引用了無效的決策節點。`);
          else if (!ancestors.has(target.id)) issue(issues, node, `回傳欄位「${field.key}」引用的決策必須位於此節點上游。`);
        }
      }
    }
  }

  return [...new Set(issues)];
}

function normalizedConfidence(probabilities: number[]): number {
  if (probabilities.length < 2) return 1;
  let entropy = 0;
  for (const probability of probabilities) entropy -= probability * Math.log(Math.max(probability, 1e-12));
  return Math.max(0, Math.min(1, 1 - entropy / Math.log(probabilities.length)));
}

function answerConfidence(answer: Answer): number {
  if (answer.type !== "noul") return answer.confidence;
  const probability = Math.max(0, Math.min(1, answer.noul));
  return normalizedConfidence([probability, 1 - probability]);
}

function routeId(node: DecisionFlowNode, answer: Answer): string {
  if (answer.type === "choice") return choicePortId(answer.choice);
  if (answer.type === "noul") return answer.noul >= node.data.trueThreshold ? "true" : "false";
  if (answer.type === "score") return scorePortFor(answer.score, node.data.scoreThresholds);
  throw new DecisionFlowError("Laya 回傳了不符合題型的答案。");
}

function normalizeValue(answer: Answer, threshold: number): string | number | boolean {
  if (answer.type === "choice") return answer.choice;
  if (answer.type === "score") return answer.score;
  return answer.noul >= threshold;
}
function lowConfidenceValue(node: DecisionFlowNode, branch: string): string | number | boolean {
  const question = node.data.question;
  if (question.type === "choice") {
    const key = Object.keys(question.criteria).find((candidate) => choicePortId(candidate) === branch);
    if (key === undefined) throw new DecisionFlowError(`決策「${node.data.label}」的低信心預設不是有效分類。`);
    return key;
  }
  if (question.type === "noul") {
    if (branch !== "true" && branch !== "false") throw new DecisionFlowError(`決策「${node.data.label}」的低信心預設不是有效的是非選項。`);
    return branch === "true";
  }
  const index = scoreRanges(node.data.scoreThresholds).findIndex((port) => port.id === branch);
  if (index < 0) throw new DecisionFlowError(`決策「${node.data.label}」的低信心預設不是有效評分區間。`);
  return node.data.scoreThresholds[index - 1] ?? 0;
}

function endOutput(node: EndFlowNode, completed: Map<string, DecisionNodeTrace>): Record<string, JsonValue> {
  const output: Record<string, JsonValue> = {};
  for (const field of node.data.fields) {
    if (field.value.kind === "literal") output[field.key] = field.value.value;
    else {
      const trace = completed.get(field.value.nodeId);
      if (!trace) throw new DecisionFlowError(`結束節點「${node.data.label}」引用了尚未執行的決策「${field.value.nodeId}」。`);
      output[field.key] = trace.value;
    }
  }
  return output;
}

export async function runFlow(flow: DecisionFlow, input: unknown, laya: Pick<Laya, "systemOne">): Promise<FlowTestResult> {
  const issues = validateFlow(flow);
  if (issues.length > 0) throw new DecisionFlowError("流程尚未完成，無法執行。", issues);
  const nodes = new Map(flow.nodes.map((node) => [node.id, node]));
  const outgoing = new Map(flow.edges.map((edge) => [`${edge.source}\u0000${edge.sourceHandle}`, edge]));
  const completed = new Map<string, DecisionNodeTrace>();
  const trace: DecisionNodeTrace[] = [];
  const started = performance.now();
  const start = flow.nodes.find((node) => node.type === "start");
  if (!start || start.type !== "start") throw new DecisionFlowError("流程缺少起點。");
  let current: FlowNode = start;
  let branch = "next";

  for (let step = 0; step < flow.nodes.length; step += 1) {
    const edge = outgoing.get(`${current.id}\u0000${branch}`);
    if (!edge) throw new DecisionFlowError(`節點「${current.data.label}」的出口「${branch}」未連線。`);
    const next = nodes.get(edge.target);
    if (!next) throw new DecisionFlowError("流程連線指向不存在的節點。");
    current = next;
    if (current.type === "end") {
      return {
        status: "completed",
        output: endOutput(current, completed),
        trace,
        durationMs: Math.round(performance.now() - started),
      };
    }
    if (current.type !== "decision") throw new DecisionFlowError("流程遇到無效節點。");

    const state = current.data.inputNodeIds.length === 0
      ? input
      : {
          input,
          previousDecisions: Object.fromEntries(
            current.data.inputNodeIds.map((id) => {
              const result = completed.get(id);
              if (!result) throw new DecisionFlowError(`決策「${current.data.label}」引用了未執行的上游結果。`);
              return [id, { name: result.label, value: result.value }];
            }),
          ),
        };
    const startedNode = performance.now();
    const response = await laya.systemOne(state, { decision: current.data.question });
    const answer = response.answers.decision as Answer;
    const confidence = answerConfidence(answer);
    const lowConfidenceFallback = current.data.minConfidence > 0 && confidence < current.data.minConfidence;
    const nextBranch = lowConfidenceFallback ? current.data.lowConfidenceBranch : routeId(current, answer);
    const port = getBranchPorts(current).find((candidate) => candidate.id === nextBranch);
    if (!port) throw new DecisionFlowError(`決策「${current.data.label}」選到未定義的出口「${nextBranch}」。`);
    const result: DecisionNodeTrace = {
      nodeId: current.id,
      label: current.data.label,
      answer,
      value: lowConfidenceFallback ? lowConfidenceValue(current, nextBranch) : normalizeValue(answer, current.data.trueThreshold),
      confidence,
      lowConfidenceFallback,
      branch: port.label,
      durationMs: Math.round(performance.now() - startedNode),
    };
    completed.set(current.id, result);
    trace.push(result);
    branch = nextBranch;
  }

  throw new DecisionFlowError("流程執行超過節點數上限，可能包含迴圈。");
}

export function questionTypeLabel(question: Question): string {
  return question.type === "choice" ? "單選" : question.type === "noul" ? "是非" : "評分";
}

export function questionOptions(question: Question): string[] {
  if (question.type === "choice") return Object.keys(question.criteria);
  if (question.type === "score") return question.criteria;
  return ["false", "true"];
}
