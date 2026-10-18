import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getBranchPorts, runFlow, scorePortFor, scoreRanges, validateFlow } from "../decision-engine.js";
import { runFlowTestCases } from "../flow-test-runner.js";
import { flowRevision } from "../flow-test-utils.js";
import { parseDecisionStoreData, parseFlowTestCases } from "../decision-schema.js";
import { DecisionStore } from "../decision-store.js";
import type { DecisionFlow, FlowNode, FlowTestCase } from "../decision-types.js";
import type { Answer, Question, SystemOneResult } from "../../laya/src/types.js";

function choiceNode(id: string, label: string, y: number): FlowNode {
  return {
    id,
    type: "decision",
    position: { x: 200, y },
    data: {
      label,
      question: { type: "choice", instructions: "Choose", criteria: { yes: "yes", no: "no" } },
      inputNodeIds: [],
      trueThreshold: 0.5,
      minConfidence: 0.2,
      lowConfidenceBranch: "choice:no",
      scoreThresholds: [],
    },
  };
}
function mockLaya(answer: Answer) {
  return {
    async systemOne<Q extends Record<string, Question>>(_state: unknown, questions: Q): Promise<SystemOneResult<Q>> {
      const answers = Object.fromEntries(Object.keys(questions).map((key) => [key, answer])) as SystemOneResult<Q>["answers"];
      return { model: "laya", answers, usage: { input_tokens: 1, output_tokens: 0 } };
    },
  };
}


function branchFlow(): DecisionFlow {
  return {
    id: "flow-1",
    name: "Branch test",
    updatedAt: new Date(0).toISOString(),
    nodes: [
      { id: "start", type: "start", position: { x: 0, y: 0 }, data: { label: "Input" } },
      choiceNode("decision", "Decision", 0),
      { id: "yes-end", type: "end", position: { x: 500, y: -80 }, data: { label: "Yes", fields: [] } },
      { id: "no-end", type: "end", position: { x: 500, y: 80 }, data: { label: "No", fields: [{ id: "decision", key: "decision", value: { kind: "decision", nodeId: "decision" } }] } },
    ],
    edges: [
      { id: "start-edge", source: "start", target: "decision", sourceHandle: "next" },
      { id: "yes-edge", source: "decision", target: "yes-end", sourceHandle: "choice:yes" },
      { id: "no-edge", source: "decision", target: "no-end", sourceHandle: "choice:no" },
    ],
  };
}

test("a complete decision tree validates and every choice output has one route", () => {
  assert.deepEqual(validateFlow(branchFlow()), []);
});

test("validation rejects any unconnected choice output and cycle", () => {
  const disconnected = branchFlow();
  disconnected.edges = disconnected.edges.filter((edge) => edge.sourceHandle !== "choice:no");
  assert.ok(validateFlow(disconnected).some((message) => message.includes("no") && message.includes("尚未連線")));

  const cyclic = branchFlow();
  cyclic.edges.push({ id: "cycle", source: "yes-end", target: "start", sourceHandle: "loop" });
  assert.ok(validateFlow(cyclic).some((message) => message.includes("結束節點不能再連到其他節點")));
  assert.ok(validateFlow(cyclic).some((message) => message.includes("起點不能有輸入連線")));
});

test("minimum confidence must be a finite value from zero through one", () => {
  const flow = branchFlow();
  const decision = flow.nodes.find((node) => node.id === "decision");
  assert.ok(decision && decision.type === "decision");
  decision.data.lowConfidenceBranch = "choice:missing";
  assert.ok(validateFlow(flow).some((message) => message.includes("低信心預設")));
  decision.data.lowConfidenceBranch = "choice:no";
  decision.data.minConfidence = -0.01;
  assert.ok(validateFlow(flow).some((message) => message.includes("最低信心門檻")));
  decision.data.minConfidence = 1.01;
  assert.ok(validateFlow(flow).some((message) => message.includes("最低信心門檻")));
  decision.data.minConfidence = 0;
  assert.deepEqual(validateFlow(flow), []);
});

test("low-confidence choices take the configured fallback and continue the flow", async () => {
  const result = await runFlow(branchFlow(), "ambiguous", mockLaya({
    type: "choice",
    choice: "yes",
    probabilities: { yes: 0.5577, no: 0.4423 },
    confidence: 0.0096,
    rl_agent: { act_probability: 1 },
  }));
  assert.equal(result.status, "completed");
  assert.equal(result.trace.length, 1);
  assert.equal(result.trace[0]?.branch, "no");
  assert.equal(result.trace[0]?.value, "no");
  assert.equal(result.trace[0]?.lowConfidenceFallback, true);
  assert.equal(result.trace[0]?.confidence, 0.0096);
  assert.equal(result.output.decision, "no");
});

test("low-confidence fallback can be a designer-created choice without adding a special port", async () => {
  const flow = branchFlow();
  const decision = flow.nodes.find((node) => node.id === "decision");
  assert.ok(decision && decision.type === "decision");
  decision.data.question = { type: "choice", instructions: "Choose", criteria: { yes: "yes", no: "no", other: "uncertain" } };
  decision.data.lowConfidenceBranch = "choice:other";
  flow.nodes.push({ id: "other-end", type: "end", position: { x: 500, y: 180 }, data: { label: "Other", fields: [{ id: "decision", key: "decision", value: { kind: "decision", nodeId: "decision" } }] } });
  flow.edges.push({ id: "other-edge", source: "decision", target: "other-end", sourceHandle: "choice:other" });
  assert.deepEqual(validateFlow(flow), []);
  assert.equal(getBranchPorts(decision).some((port) => port.id === "uncertain"), false);
  const result = await runFlow(flow, "ambiguous", mockLaya({
    type: "choice",
    choice: "yes",
    probabilities: { yes: 0.7, no: 0.2, other: 0.1 },
    confidence: 0.1,
    rl_agent: { act_probability: 1 },
  }));
  assert.equal(result.trace[0]?.branch, "other");
  assert.equal(result.trace[0]?.value, "other");
  assert.equal(result.output.decision, "other");
});

test("high-confidence decisions follow the selected choice branch", async () => {
  const result = await runFlow(branchFlow(), "clear", mockLaya({
    type: "choice",
    choice: "yes",
    probabilities: { yes: 0.9, no: 0.1 },
    confidence: 0.531,
    rl_agent: { act_probability: 1 },
  }));
  assert.equal(result.trace[0]?.branch, "yes");
  assert.equal(result.trace[0]?.value, "yes");
  assert.equal(result.trace[0]?.lowConfidenceFallback, false);
});

test("confidence exactly at the minimum uses the model choice, not the fallback", async () => {
  const flow = branchFlow();
  const decision = flow.nodes.find((node) => node.id === "decision");
  assert.ok(decision && decision.type === "decision");
  decision.data.minConfidence = 0.2;
  const result = await runFlow(flow, "boundary", mockLaya({
    type: "choice",
    choice: "yes",
    probabilities: { yes: 0.6, no: 0.4 },
    confidence: 0.2,
    rl_agent: { act_probability: 1 },
  }));
  assert.equal(result.trace[0]?.branch, "yes");
  assert.equal(result.trace[0]?.lowConfidenceFallback, false);
});

test("zero confidence threshold disables fallback", async () => {
  const flow = branchFlow();
  const decision = flow.nodes.find((node) => node.id === "decision");
  assert.ok(decision && decision.type === "decision");
  decision.data.minConfidence = 0;
  const result = await runFlow(flow, "ambiguous", mockLaya({
    type: "choice",
    choice: "yes",
    probabilities: { yes: 0.5577, no: 0.4423 },
    confidence: 0.0096,
    rl_agent: { act_probability: 1 },
  }));
  assert.equal(result.trace[0]?.branch, "yes");
  assert.equal(result.trace[0]?.lowConfidenceFallback, false);
});

test("yes-no low confidence follows its configured false branch", async () => {
  const flow = branchFlow();
  const decision = flow.nodes.find((node) => node.id === "decision");
  assert.ok(decision && decision.type === "decision");
  decision.data.question = { type: "noul", instructions: "Does this apply?", criteria: { true: "yes", false: "no" } };
  decision.data.lowConfidenceBranch = "false";
  flow.edges = flow.edges.map((edge) => edge.source !== "decision"
    ? edge
    : { ...edge, sourceHandle: edge.target === "yes-end" ? "true" : "false" });
  const result = await runFlow(flow, "ambiguous", mockLaya({
    type: "noul",
    noul: 0.55,
    rl_agent: { act_probability: 1 },
  }));
  assert.equal(result.status, "completed");
  assert.equal(result.trace[0]?.branch, "否（P(true) < 門檻）");
  assert.equal(result.trace[0]?.value, false);
  assert.equal(result.trace[0]?.lowConfidenceFallback, true);
  assert.ok((result.trace[0]?.confidence ?? 1) < 0.01);
  assert.equal(result.output.decision, false);
});

test("score fallback returns the selected range's lower boundary", async () => {
  const flow = branchFlow();
  const decision = flow.nodes.find((node) => node.id === "decision");
  assert.ok(decision && decision.type === "decision");
  decision.data.question = { type: "score", instructions: "Rate", criteria: ["low", "medium", "high", "urgent"] };
  decision.data.scoreThresholds = [1.5];
  decision.data.lowConfidenceBranch = "score:1";
  flow.edges = flow.edges.map((edge) => edge.source !== "decision"
    ? edge
    : { ...edge, sourceHandle: edge.target === "yes-end" ? "score:0" : "score:1" });
  const result = await runFlow(flow, "ambiguous", mockLaya({
    type: "score",
    score: 0.4,
    legend: { 0: "low", 1: "medium", 2: "high", 3: "urgent" },
    probabilities: { 0: 0.4, 1: 0.3, 2: 0.2, 3: 0.1 },
    confidence: 0.1,
    rl_agent: { act_probability: 1 },
  }));
  assert.equal(result.trace[0]?.branch, "分數 ≥ 1.5");
  assert.equal(result.trace[0]?.value, 1.5);
  assert.equal(result.output.decision, 1.5);
});

test("legacy low-confidence output edges are reported for manual migration", () => {
  const flow = branchFlow();
  flow.nodes.push({ id: "legacy-end", type: "end", position: { x: 500, y: 180 }, data: { label: "Old low-confidence output", fields: [] } });
  flow.edges.push({ id: "legacy-edge", source: "decision", target: "legacy-end", sourceHandle: "uncertain" });
  assert.ok(validateFlow(flow).some((message) => message.includes("舊的「信心不足」出口已移除")));
});

test("legacy flows and templates receive the safe confidence default", () => {
  const legacyFlow = JSON.parse(JSON.stringify(branchFlow())) as { nodes: Array<{ type: string; data: Record<string, unknown> }>; [key: string]: unknown };
  const node = legacyFlow.nodes.find((candidate) => candidate.type === "decision");
  assert.ok(node);
  delete node.data.minConfidence;
  delete node.data.lowConfidenceBranch;
  const stored = parseDecisionStoreData({
    flows: [legacyFlow],
    templates: [
      { id: "legacy-template", name: "Legacy", createdAt: new Date(0).toISOString(), question: { type: "choice", instructions: "Choose", criteria: { a: "A", b: "B" } }, trueThreshold: 0.5, scoreThresholds: [] },
      { id: "other-template", name: "Other", createdAt: new Date(0).toISOString(), question: { type: "choice", instructions: "Choose", criteria: { yes: "Yes", no: "No", other: "Other" } }, trueThreshold: 0.5, scoreThresholds: [] },
    ],
  });
  assert.deepEqual(stored.flowTestSuites, []);
  const decision = stored.flows[0]?.nodes.find((candidate) => candidate.type === "decision");
  assert.ok(decision && decision.type === "decision");
  assert.equal(decision.data.minConfidence, 0.2);
  assert.equal(decision.data.lowConfidenceBranch, "choice:no");
  assert.equal(stored.templates[0]?.minConfidence, 0.2);
  assert.equal(stored.templates[0]?.lowConfidenceBranch, "choice:a");
  assert.equal(stored.templates[1]?.lowConfidenceBranch, "choice:other");
});

test("score cut points create complete half-open ranges, including exact boundaries", () => {
  const ranges = scoreRanges([1.5]);
  assert.deepEqual(ranges, [
    { id: "score:0", label: "分數 < 1.5" },
    { id: "score:1", label: "分數 ≥ 1.5" },
  ]);
  assert.equal(scorePortFor(1.4999, [1.5]), "score:0");
  assert.equal(scorePortFor(1.5, [1.5]), "score:1");
  assert.equal(scorePortFor(2.5, [1.5, 2.5]), "score:2");
  assert.equal(scorePortFor(2.4, [1.5, 2.5]), "score:1");
  assert.equal(scorePortFor(2, []), "score:all");
});

test("score cut points reject endpoints and unordered ranges", () => {
  const flow = branchFlow();
  const decision = flow.nodes.find((node) => node.id === "decision");
  assert.ok(decision && decision.type === "decision");
  decision.data.question = { type: "score", instructions: "Rate", criteria: ["low", "medium", "high", "urgent"] };
  decision.data.scoreThresholds = [2.5, 1.5];
  assert.ok(validateFlow(flow).some((message) => message.includes("嚴格遞增")));
  decision.data.scoreThresholds = [0];
  assert.ok(validateFlow(flow).some((message) => message.includes("不含端點")));
});

test("a stored workflow and template survive reopening the store", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "laya-decision-store-"));
  const filePath = path.join(directory, "flows.json");
  try {
    const first = await DecisionStore.open(filePath);
    const initialFlows = first.listFlows();
    const initial = initialFlows[0];
    assert.ok(initial);
    assert.equal(initialFlows.length, 1);
    assert.equal(initial.name, "IoT 操作判斷（範例）");
    assert.deepEqual(validateFlow(initial), []);
    assert.equal(first.listTemplates().length, 0);
    const created = await first.createFlow("Saved flow");
    const changed = { ...created, name: "Renamed flow" };
    await first.saveFlow(changed);
    await first.createTemplate({
      id: "template-1",
      name: "Simple choice",
      question: { type: "choice", instructions: "Choose", criteria: { a: "A", b: "B" } },
      trueThreshold: 0.5,
      minConfidence: 0.2,
      lowConfidenceBranch: "choice:a",
      scoreThresholds: [],
      createdAt: new Date(0).toISOString(),
    });

    const persistedJson = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    const parsed = parseDecisionStoreData(persistedJson);
    assert.equal(parsed.flows.length, 2);
    assert.equal(parsed.templates[0]?.lowConfidenceBranch, "choice:a");

    const reopened = await DecisionStore.open(filePath);
    assert.equal(reopened.getFlow(created.id)?.name, "Renamed flow");
    assert.equal(reopened.listTemplates().length, 1);
    assert.equal(reopened.listTemplates()[0]?.lowConfidenceBranch, "choice:a");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("batch tests compare structured JSON and isolate mismatch, execution error, and disabled cases", async () => {
  const flow = branchFlow();
  const yesEnd = flow.nodes.find((node) => node.id === "yes-end");
  assert.ok(yesEnd && yesEnd.type === "end");
  yesEnd.data.fields = [
    { id: "alpha", key: "alpha", value: { kind: "literal", value: { left: 1, right: [1, 2] } } },
    { id: "beta", key: "beta", value: { kind: "literal", value: true } },
  ];
  const answer: Answer = { type: "choice", choice: "yes", probabilities: { yes: 0.9, no: 0.1 }, confidence: 0.8, rl_agent: { act_probability: 0.9 } };
  const laya = {
    async systemOne<Q extends Record<string, Question>>(state: unknown, questions: Q): Promise<SystemOneResult<Q>> {
      if (state === "error") throw new Error("model offline");
      return mockLaya(answer).systemOne(state, questions);
    },
  };
  const cases: FlowTestCase[] = [
    { id: "pass", name: "Object key order", input: "pass", expectedOutput: { beta: true, alpha: { right: [1, 2], left: 1 } }, enabled: true },
    { id: "fail", name: "Array order matters", input: "fail", expectedOutput: { alpha: { left: 1, right: [2, 1] }, beta: true }, enabled: true },
    { id: "error", name: "Model error", input: "error", expectedOutput: {}, enabled: true },
    { id: "after-error", name: "Continues after error", input: "continues", expectedOutput: { alpha: { left: 1, right: [1, 2] }, beta: true }, enabled: true },
    { id: "disabled", name: "Disabled case", input: "disabled", expectedOutput: {}, enabled: false },
  ];

  const run = await runFlowTestCases(flow, cases, laya);
  assert.deepEqual(run.results.map((result) => result.status), ["passed", "failed", "error", "passed"]);
  assert.deepEqual(run.results[0]?.actualOutput, { alpha: { left: 1, right: [1, 2] }, beta: true });
  assert.equal(run.results[2]?.error, "model offline");
  await assert.rejects(runFlowTestCases(flow, cases, laya, ["disabled"]), /停用/);
  const fallbackRun = await runFlowTestCases(branchFlow(), [
    { id: "fallback", name: "Low-confidence branch", input: "ambiguous", expectedOutput: { decision: "no" }, enabled: true },
  ], mockLaya({
    type: "choice", choice: "yes", probabilities: { yes: 0.5577, no: 0.4423 }, confidence: 0.007, rl_agent: { act_probability: 0.55 },
  }));
  assert.equal(fallbackRun.results[0]?.status, "passed");
  assert.deepEqual(fallbackRun.results[0]?.actualOutput, { decision: "no" });

  const repositionedFlow = { ...flow, nodes: flow.nodes.map((node) => ({ ...node, position: { x: node.position.x + 10, y: node.position.y + 10 } })) };
  assert.equal(flowRevision(flow), flowRevision(repositionedFlow));
  assert.equal(flowRevision(flow), flowRevision({ ...flow, updatedAt: "later" }));
  const changedFlow = { ...flow, nodes: flow.nodes.map((node) => node.id === "yes-end" && node.type === "end" ? { ...node, data: { ...node.data, label: "Updated" } } : node) };
  assert.notEqual(flowRevision(flow), flowRevision(changedFlow));
});

test("flow test cases and latest results persist per flow, reset on edits, and reject stale writes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "laya-batch-test-store-"));
  const filePath = path.join(directory, "flows.json");
  try {
    const first = await DecisionStore.open(filePath);
    const flow = await first.createFlow("Batch test");
    const testCase: FlowTestCase = { id: "case-1", name: "Empty output", input: "anything", expectedOutput: {}, enabled: true };
    const suite = await first.saveFlowTestCases(flow.id, "", [testCase]);
    assert.notEqual(suite.revision, "");
    const run = await runFlowTestCases(flow, suite.cases, mockLaya({
      type: "choice", choice: "yes", probabilities: { yes: 0.9, no: 0.1 }, confidence: 0.8, rl_agent: { act_probability: 0.9 },
    }));
    assert.equal(run.results[0]?.status, "passed");
    await first.saveFlowTestRun(flow.id, suite.revision, run);

    const reopened = await DecisionStore.open(filePath);
    assert.deepEqual(reopened.getFlowTestSuite(flow.id).cases, [testCase]);
    assert.equal(reopened.getFlowTestSuite(flow.id).lastRun?.results[0]?.status, "passed");
    const unrelatedFlow = await reopened.createFlow("Separate suite");
    assert.deepEqual(reopened.getFlowTestSuite(unrelatedFlow.id).cases, []);

    const changedSuite = await reopened.saveFlowTestCases(flow.id, suite.revision, [{ ...testCase, name: "Updated case" }]);
    assert.equal(changedSuite.lastRun, null);
    await assert.rejects(reopened.saveFlowTestCases(flow.id, suite.revision, [testCase]), /已更新/);
    await assert.rejects(reopened.saveFlowTestRun(flow.id, suite.revision, run), /已更新/);
    await reopened.deleteFlow(flow.id);
    assert.throws(() => reopened.getFlowTestSuite(flow.id), /找不到/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("test case parsing rejects invalid JSON values, non-object outputs, and duplicate IDs", () => {
  const testCase = { id: "case-1", name: "Valid", input: "text", expectedOutput: { value: 1 }, enabled: true };
  assert.deepEqual(parseFlowTestCases([testCase]), [testCase]);
  assert.throws(() => parseFlowTestCases([{ ...testCase, input: undefined }]));
  assert.throws(() => parseFlowTestCases([{ ...testCase, expectedOutput: [] }]));
  assert.throws(() => parseFlowTestCases([testCase, testCase]));
});

test("stored workflow parser rejects malformed graph-node data", () => {
  assert.throws(() => parseDecisionStoreData({ flows: [{ id: "broken", nodes: [null], edges: [] }], templates: [] }));
});
