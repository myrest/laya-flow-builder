import type { Answer, Question } from "../laya/src/types.js";
import type { DecisionFlow, DecisionNodeTrace, DecisionStoreData, DecisionTemplate, EndFlowNode, FlowEdge, FlowNode, FlowTestCase, FlowTestCaseResult, FlowTestRun, FlowTestSuite, FlowTestResult, JsonValue } from "./decision-types.js";
import { DEFAULT_MIN_CONFIDENCE, MAX_FLOW_TEST_CASES, MAX_FLOW_TEST_NAME_LENGTH } from "./decision-types.js";
import { getDefaultLowConfidenceBranch } from "./decision-engine.js";
import { isRecord } from "./decision-guards.js";

function fail(path: string): never {
  throw new Error(`Invalid decision system data at ${path}.`);
}

function parseQuestion(value: unknown, path: string): Question {
  if (!isRecord(value)) fail(path);
  if (typeof value.instructions !== "string" && !isRecord(value.instructions)) fail(`${path}.instructions`);
  const instructions = value.instructions;
  if (typeof instructions === "string" && instructions.trim().length === 0) fail(`${path}.instructions`);
  if (value.type === "choice") {
    const criteria: Record<string, string | null> = {};
    if (Array.isArray(value.criteria)) {
      const items: unknown[] = value.criteria;
      for (const item of items) {
        if (typeof item !== "string" || item.trim().length === 0) fail(`${path}.criteria`);
        criteria[item] = null;
      }
    } else {
      if (!isRecord(value.criteria)) fail(`${path}.criteria`);
      for (const [key, text] of Object.entries(value.criteria)) {
        if (key.trim().length === 0 || (typeof text !== "string" && text !== null)) fail(`${path}.criteria.${key}`);
        criteria[key] = text;
      }
    }
    if (Object.keys(criteria).length < 2 || Object.keys(criteria).length > 64) fail(`${path}.criteria`);
    return { type: "choice", instructions, criteria };
  }
  if (value.type === "score") {
    if (!Array.isArray(value.criteria) || value.criteria.length < 2 || value.criteria.length > 64) fail(`${path}.criteria`);
    const criteria: string[] = [];
    const items: unknown[] = value.criteria;
    for (const item of items) {
      if (typeof item !== "string" || item.trim().length === 0) fail(`${path}.criteria`);
      criteria.push(item);
    }
    return { type: "score", instructions, criteria };
  }
  if (value.type === "noul") {
    if (value.criteria !== undefined && !isRecord(value.criteria)) fail(`${path}.criteria`);
    const criteria = value.criteria;
    if (isRecord(criteria) && Object.values(criteria).some((text) => typeof text !== "string")) fail(`${path}.criteria`);
    return {
      type: "noul",
      instructions,
      criteria: isRecord(criteria) ? { true: typeof criteria.true === "string" ? criteria.true : undefined, false: typeof criteria.false === "string" ? criteria.false : undefined } : undefined,
    };
  }
  return fail(`${path}.type`);
}

export function parseQuestionDefinition(value: unknown): Question {
  return parseQuestion(value, "question");
}

function parseNode(value: unknown, index: number): FlowNode {
  const path = `flows.nodes[${index}]`;
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0 || !isRecord(value.position) || !isRecord(value.data)) fail(path);
  if (!Number.isFinite(value.position.x) || typeof value.position.x !== "number" || !Number.isFinite(value.position.y) || typeof value.position.y !== "number" || typeof value.data.label !== "string") fail(path);
  const position = { x: value.position.x, y: value.position.y };
  if (value.type === "start") return { id: value.id, type: "start", position, data: { label: value.data.label } };
  if (value.type === "decision") {
    if (!Array.isArray(value.data.inputNodeIds) || !value.data.inputNodeIds.every((id) => typeof id === "string")) fail(`${path}.data.inputNodeIds`);
    if (!Array.isArray(value.data.scoreThresholds) || !value.data.scoreThresholds.every((num) => typeof num === "number" && Number.isFinite(num))) fail(`${path}.data.scoreThresholds`);
    if (typeof value.data.trueThreshold !== "number" || !Number.isFinite(value.data.trueThreshold)) fail(`${path}.data.trueThreshold`);
    const minConfidence = value.data.minConfidence === undefined ? DEFAULT_MIN_CONFIDENCE : value.data.minConfidence;
    if (typeof minConfidence !== "number" || !Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) fail(`${path}.data.minConfidence`);
    const question = parseQuestion(value.data.question, `${path}.data.question`);
    const lowConfidenceBranch = value.data.lowConfidenceBranch === undefined
      ? getDefaultLowConfidenceBranch(question, value.data.scoreThresholds)
      : value.data.lowConfidenceBranch;
    if (typeof lowConfidenceBranch !== "string") fail(`${path}.data.lowConfidenceBranch`);
    return {
      id: value.id,
      type: "decision",
      position,
      data: {
        label: value.data.label,
        question,
        inputNodeIds: value.data.inputNodeIds,
        trueThreshold: value.data.trueThreshold,
        minConfidence,
        lowConfidenceBranch,
        scoreThresholds: value.data.scoreThresholds,
      },
    };
  }
  if (value.type === "end") {
    if (!Array.isArray(value.data.fields)) fail(`${path}.data.fields`);
    const fields = value.data.fields.map((field, fieldIndex) => {
      const fieldPath = `${path}.data.fields[${fieldIndex}]`;
      if (!isRecord(field) || typeof field.id !== "string" || typeof field.key !== "string" || !isRecord(field.value)) fail(fieldPath);
      if (field.value.kind === "decision" && typeof field.value.nodeId === "string") return { id: field.id, key: field.key, value: { kind: "decision" as const, nodeId: field.value.nodeId } };
      if (field.value.kind === "literal" && isJsonValue(field.value.value)) return { id: field.id, key: field.key, value: { kind: "literal" as const, value: field.value.value } };
      return fail(`${fieldPath}.value`);
    });
    const node: EndFlowNode = { id: value.id, type: "end", position, data: { label: value.data.label, fields } };
    return node;
  }
  return fail(`${path}.type`);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function parseEdge(value: unknown, index: number): FlowEdge {
  const path = `flows.edges[${index}]`;
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.source !== "string" || typeof value.target !== "string" || typeof value.sourceHandle !== "string") fail(path);
  if (value.targetHandle !== undefined && value.targetHandle !== null && typeof value.targetHandle !== "string") fail(`${path}.targetHandle`);
  return {
    id: value.id,
    source: value.source,
    target: value.target,
    sourceHandle: value.sourceHandle,
    targetHandle: typeof value.targetHandle === "string" || value.targetHandle === null ? value.targetHandle : undefined,
  };
}

export function parseDecisionFlow(value: unknown): DecisionFlow {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string" || typeof value.updatedAt !== "string" || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) fail("flow");
  return {
    id: value.id,
    name: value.name,
    updatedAt: value.updatedAt,
    nodes: value.nodes.map(parseNode),
    edges: value.edges.map(parseEdge),
  };
}

function parseTemplate(value: unknown, index: number): DecisionTemplate {
  const path = `templates[${index}]`;
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string" || typeof value.createdAt !== "string") fail(path);
  if (typeof value.trueThreshold !== "number" || !Number.isFinite(value.trueThreshold)) fail(`${path}.trueThreshold`);
  if (!Array.isArray(value.scoreThresholds) || !value.scoreThresholds.every((num) => typeof num === "number" && Number.isFinite(num))) fail(`${path}.scoreThresholds`);
  const minConfidence = value.minConfidence === undefined ? DEFAULT_MIN_CONFIDENCE : value.minConfidence;
  if (typeof minConfidence !== "number" || !Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) fail(`${path}.minConfidence`);
  const question = parseQuestion(value.question, `${path}.question`);
  const lowConfidenceBranch = value.lowConfidenceBranch === undefined
    ? getDefaultLowConfidenceBranch(question, value.scoreThresholds)
    : value.lowConfidenceBranch;
  if (typeof lowConfidenceBranch !== "string") fail(`${path}.lowConfidenceBranch`);
  return {
    id: value.id,
    name: value.name,
    createdAt: value.createdAt,
    question,
    trueThreshold: value.trueThreshold,
    minConfidence,
    lowConfidenceBranch,
    scoreThresholds: value.scoreThresholds,
  };
}

function parseFlowTestCase(value: unknown, index: number): FlowTestCase {
  const path = `flowTestCases[${index}]`;
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0 || typeof value.name !== "string" || value.name.trim().length === 0 || value.name.length > MAX_FLOW_TEST_NAME_LENGTH) fail(path);
  if (!isJsonValue(value.input) || !isRecord(value.expectedOutput) || typeof value.enabled !== "boolean") fail(path);
  const expectedOutput: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value.expectedOutput)) {
    if (!isJsonValue(item)) fail(`${path}.expectedOutput.${key}`);
    expectedOutput[key] = item;
  }
  return { id: value.id, name: value.name, input: value.input, expectedOutput, enabled: value.enabled };
}

export function parseFlowTestCases(value: unknown): FlowTestCase[] {
  if (!Array.isArray(value) || value.length > MAX_FLOW_TEST_CASES) fail("flowTestCases");
  const cases = value.map(parseFlowTestCase);
  if (new Set(cases.map((testCase) => testCase.id)).size !== cases.length) fail("flowTestCases.ids");
  return cases;
}

function parseFlowTestCaseResult(value: unknown, index: number): FlowTestCaseResult {
  const path = `flowTestRun.results[${index}]`;
  if (!isRecord(value) || typeof value.caseId !== "string" || value.caseId.length === 0 || (value.status !== "passed" && value.status !== "failed" && value.status !== "error") || typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs) || value.durationMs < 0) fail(path);
  if (value.status === "error") {
    if (typeof value.error !== "string" || value.error.length === 0) fail(`${path}.error`);
    return { caseId: value.caseId, status: "error", error: value.error, durationMs: value.durationMs };
  }
  if (!isRecord(value.actualOutput)) fail(`${path}.actualOutput`);
  const actualOutput: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value.actualOutput)) {
    if (!isJsonValue(item)) fail(`${path}.actualOutput.${key}`);
    actualOutput[key] = item;
  }
  return { caseId: value.caseId, status: value.status, actualOutput, durationMs: value.durationMs };
}

export function parseFlowTestRun(value: unknown): FlowTestRun {
  if (!isRecord(value) || typeof value.ranAt !== "string" || typeof value.flowRevision !== "string" || !Array.isArray(value.results) || value.results.length > MAX_FLOW_TEST_CASES) fail("flowTestRun");
  const results = value.results.map(parseFlowTestCaseResult);
  if (new Set(results.map((result) => result.caseId)).size !== results.length) fail("flowTestRun.results.caseIds");
  return { ranAt: value.ranAt, flowRevision: value.flowRevision, results };
}

export function parseFlowTestSuite(value: unknown): FlowTestSuite {
  if (!isRecord(value) || typeof value.flowId !== "string" || value.flowId.length === 0 || typeof value.revision !== "string") fail("flowTestSuite");
  const cases = parseFlowTestCases(value.cases);
  const lastRun = value.lastRun === null ? null : parseFlowTestRun(value.lastRun);
  if (lastRun && lastRun.results.some((result) => !cases.some((testCase) => testCase.id === result.caseId))) fail("flowTestSuite.lastRun");
  return { flowId: value.flowId, revision: value.revision, cases, lastRun };
}

export function parseDecisionStoreData(value: unknown): DecisionStoreData {
  if (!isRecord(value) || !Array.isArray(value.flows) || !Array.isArray(value.templates)) fail("store");
  const flows = value.flows.map(parseDecisionFlow);
  const templates = value.templates.map(parseTemplate);
  const rawSuites = value.flowTestSuites === undefined ? [] : value.flowTestSuites;
  if (!Array.isArray(rawSuites)) fail("flowTestSuites");
  const flowTestSuites = rawSuites.map(parseFlowTestSuite);
  const flowIds = new Set(flows.map((flow) => flow.id));
  if (new Set(flowTestSuites.map((suite) => suite.flowId)).size !== flowTestSuites.length || flowTestSuites.some((suite) => !flowIds.has(suite.flowId))) fail("flowTestSuites.flowId");
  return { flows, templates, flowTestSuites };
}

export function parseJsonObject(value: unknown): Record<string, JsonValue> {
  if (!isRecord(value)) fail("json-object");
  const output: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!isJsonValue(item)) fail(`json-object.${key}`);
    output[key] = item;
  }
  return output;
}

function parseAnswer(value: unknown, path: string): Answer {
  if (!isRecord(value) || !isRecord(value.rl_agent) || typeof value.rl_agent.act_probability !== "number" || !Number.isFinite(value.rl_agent.act_probability)) fail(path);
  const rlAgent = { act_probability: value.rl_agent.act_probability };
  if (value.type === "choice") {
    if (typeof value.choice !== "string" || !isRecord(value.probabilities) || typeof value.confidence !== "number" || !Number.isFinite(value.confidence)) fail(path);
    const probabilities: Record<string, number> = {};
    for (const [key, probability] of Object.entries(value.probabilities)) {
      if (typeof probability !== "number" || !Number.isFinite(probability)) fail(`${path}.probabilities`);
      probabilities[key] = probability;
    }
    return { type: "choice", choice: value.choice, probabilities, confidence: value.confidence, rl_agent: rlAgent };
  }
  if (value.type === "score") {
    if (typeof value.score !== "number" || !Number.isFinite(value.score) || !isRecord(value.legend) || !isRecord(value.probabilities) || typeof value.confidence !== "number" || !Number.isFinite(value.confidence)) fail(path);
    const legend: Record<string, string> = {};
    const probabilities: Record<string, number> = {};
    for (const [key, label] of Object.entries(value.legend)) {
      if (typeof label !== "string") fail(`${path}.legend`);
      legend[key] = label;
    }
    for (const [key, probability] of Object.entries(value.probabilities)) {
      if (typeof probability !== "number" || !Number.isFinite(probability)) fail(`${path}.probabilities`);
      probabilities[key] = probability;
    }
    return { type: "score", score: value.score, legend, probabilities, confidence: value.confidence, rl_agent: rlAgent };
  }
  if (value.type === "noul" && typeof value.noul === "number" && Number.isFinite(value.noul)) return { type: "noul", noul: value.noul, rl_agent: rlAgent };
  return fail(`${path}.type`);
}

function confidenceFromProbabilities(probabilities: number[]): number {
  if (probabilities.length < 2) return 1;
  let entropy = 0;
  for (const probability of probabilities) entropy -= probability * Math.log(Math.max(probability, 1e-12));
  return Math.max(0, Math.min(1, 1 - entropy / Math.log(probabilities.length)));
}


export function parseFlowTestResult(value: unknown): FlowTestResult {
  if (!isRecord(value) || !isRecord(value.output) || !Array.isArray(value.trace) || typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs)) fail("test-result");
  if (value.status !== undefined && value.status !== "completed") fail("test-result.status");
  const output: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value.output)) {
    if (!isJsonValue(item)) fail(`test-result.output.${key}`);
    output[key] = item;
  }
  const trace: DecisionNodeTrace[] = value.trace.map((entry, index) => {
    const path = `test-result.trace[${index}]`;
    if (!isRecord(entry) || typeof entry.nodeId !== "string" || typeof entry.label !== "string" || !isJsonValue(entry.value) || typeof entry.lowConfidenceFallback !== "boolean" || typeof entry.branch !== "string" || typeof entry.durationMs !== "number" || !Number.isFinite(entry.durationMs)) fail(path);
    const answer = parseAnswer(entry.answer, `${path}.answer`);
    const confidence = entry.confidence === undefined
      ? answer.type === "noul" ? confidenceFromProbabilities([answer.noul, 1 - answer.noul]) : answer.confidence
      : entry.confidence;
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) fail(`${path}.confidence`);
    return {
      nodeId: entry.nodeId,
      label: entry.label,
      answer,
      value: entry.value,
      confidence,
      lowConfidenceFallback: entry.lowConfidenceFallback,
      branch: entry.branch,
      durationMs: entry.durationMs,
    };
  });
  return {
    status: "completed",
    output,
    trace,
    durationMs: value.durationMs,
  };
}
