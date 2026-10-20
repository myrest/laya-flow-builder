import type { Answer, Question } from "../laya/src/types.js";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface FlowPosition {
  x: number;
  y: number;
}

export interface StartFlowNode {
  id: string;
  type: "start";
  position: FlowPosition;
  data: { label: string };
}

export interface DecisionFlowNode {
  id: string;
  type: "decision";
  position: FlowPosition;
  data: {
    label: string;
    question: Question;
    inputNodeIds: string[];
    trueThreshold: number;
    minConfidence: number;
    lowConfidenceBranch: string;
    scoreThresholds: number[];
  };
}

export type OutputValue =
  | { kind: "literal"; value: JsonValue }
  | { kind: "decision"; nodeId: string };

export interface EndOutputField {
  id: string;
  key: string;
  value: OutputValue;
}


export interface EndFlowNode {
  id: string;
  type: "end";
  position: FlowPosition;
  data: { label: string; fields: EndOutputField[] };
}

export type FlowNode = StartFlowNode | DecisionFlowNode | EndFlowNode;

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle?: string | null;
}

export interface DecisionFlow {
  id: string;
  name: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  updatedAt: string;
}

export interface DecisionTemplate {
  id: string;
  name: string;
  question: Question;
  trueThreshold: number;
  minConfidence: number;
  lowConfidenceBranch: string;
  scoreThresholds: number[];
  createdAt: string;
}

export interface FlowTestCase {
  id: string;
  name: string;
  input: JsonValue;
  expectedOutput: Record<string, JsonValue>;
  enabled: boolean;
}

export interface FlowTestCaseResult {
  caseId: string;
  status: "passed" | "failed" | "error";
  actualOutput?: Record<string, JsonValue>;
  error?: string;
  durationMs: number;
}

export interface FlowTestRun {
  ranAt: string;
  flowRevision: string;
  results: FlowTestCaseResult[];
}

export interface FlowTestSuite {
  flowId: string;
  revision: string;
  cases: FlowTestCase[];
  lastRun: FlowTestRun | null;
}

export interface FlowDraftRun {
  draftRevision: string;
  baseline: FlowTestRun | null;
  candidate: FlowTestRun;
  traces: Record<string, FlowTestResult>;
  baselineTraces: Record<string, FlowTestResult>;
}

export interface FlowDraft {
  id: string;
  name: string;
  sourceFlowId: string | null;
  baseFlow: DecisionFlow | null;
  baseSuite: FlowTestSuite | null;
  baseFlowVersion: string | null;
  revision: string;
  status: "draft" | "review" | "applied" | "discarded";
  createdAt: string;
  updatedAt: string;
  flow: DecisionFlow;
  cases: FlowTestCase[];
  lastRun: FlowDraftRun | null;
}

export interface FlowHistoryEntry {
  id: string;
  flowId: string;
  createdAt: string;
  reason: string;
  flow: DecisionFlow;
  suite: FlowTestSuite;
}

export interface FlowDraftChange {
  path: string;
  before?: unknown;
  after?: unknown;
}

export interface FlowDraftPreview {
  draft: FlowDraft;
  currentFlow: DecisionFlow | null;
  currentSuite: FlowTestSuite | null;
  currentFlowVersion: string | null;
  conflict: boolean;
  issues: string[];
  changes: FlowDraftChange[];
  caseChanges: FlowDraftChange[];
  warnings: string[];
}

export interface DecisionStoreData {
  flows: DecisionFlow[];
  templates: DecisionTemplate[];
  flowTestSuites: FlowTestSuite[];
  flowDrafts: FlowDraft[];
  flowHistory: FlowHistoryEntry[];
}
export interface BranchPort {
  id: string;
  label: string;
}

export interface DecisionNodeTrace {
  nodeId: string;
  label: string;
  answer: Answer;
  value: JsonValue;
  confidence: number;
  lowConfidenceFallback: boolean;
  branch: string;
  durationMs: number;
}

export interface FlowTestResult {
  status: "completed";
  output: Record<string, JsonValue>;
  trace: DecisionNodeTrace[];
  durationMs: number;
}

export const MAX_FLOW_NODES = 200;
export const MAX_FLOW_NAME_LENGTH = 120;
export const MAX_FLOW_TEST_CASES = 200;
export const MAX_FLOW_TEST_NAME_LENGTH = 120;
export const MAX_QUESTION_OPTIONS = 64;
export const MAX_INPUT_NODE_REFS = 32;
export const DEFAULT_MIN_CONFIDENCE = 0.2;
