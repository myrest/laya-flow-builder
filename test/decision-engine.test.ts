import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getAncestorDecisions, getBranchPorts, runFlow, scorePortFor, scoreRanges, validateFlow } from "../decision-engine.js";
import { runFlowTestCases } from "../flow-test-runner.js";
import { flowRevision } from "../flow-test-utils.js";
import { parseDecisionStoreData, parseFlowTestCases } from "../decision-schema.js";
import { DecisionStore, flowVersion } from "../decision-store.js";
import type { DecisionFlow, FlowNode, FlowTestCase, FlowDraftRun } from "../decision-types.js";
import type { Answer, Question, SystemOneResult } from "@receptron/laya";

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
test("duplicate node IDs are rejected before inference", async () => {
  const flow = branchFlow();
  const end = flow.nodes.find((node) => node.id === "yes-end");
  assert.ok(end && end.type === "end");
  flow.nodes.push({ ...structuredClone(end), position: { x: 700, y: -80 } });
  assert.ok(validateFlow(flow).some((message) => message.includes("節點識別碼重複")));
  let calls = 0;
  await assert.rejects(runFlow(flow, "input", {
    async systemOne() {
      calls++;
      throw new Error("inference must not run");
    },
  }), /流程尚未完成/);
  assert.equal(calls, 0);
});


test("end output references execute independently of node array order", async () => {
  const flow = branchFlow();
  flow.nodes.reverse();
  assert.deepEqual(validateFlow(flow), []);
  const result = await runFlow(flow, "no", mockLaya({
    type: "choice", choice: "no", probabilities: { yes: 0.1, no: 0.9 }, confidence: 0.8, rl_agent: { act_probability: 0.9 },
  }));
  assert.deepEqual(result.output, { decision: "no" });
});

test("shared End resolves only the selected branch and rejects non-ancestor references", async () => {
  const flow = branchFlow();
  flow.nodes = flow.nodes.filter((node) => node.id !== "no-end");
  flow.nodes.push(choiceNode("left", "Left", -80), choiceNode("right", "Right", 80));
  const end = flow.nodes.find((node) => node.id === "yes-end");
  assert.ok(end && end.type === "end");
  end.data.fields = ["decision", "left", "right"].map((nodeId) => ({
    id: nodeId, key: nodeId, value: { kind: "decision", nodeId },
  }));
  flow.edges = [
    { id: "start-edge", source: "start", target: "decision", sourceHandle: "next" },
    { id: "left-edge", source: "decision", target: "left", sourceHandle: "choice:yes" },
    { id: "right-edge", source: "decision", target: "right", sourceHandle: "choice:no" },
    ...["left", "right"].flatMap((source) => ["yes", "no"].map((choice) => ({
      id: `${source}-${choice}`, source, target: end.id, sourceHandle: `choice:${choice}`,
    }))),
  ];
  assert.deepEqual(validateFlow(flow), []);
  assert.deepEqual(getAncestorDecisions(flow, end.id).map((node) => node.id), ["left", "right", "decision"]);
  for (const choice of ["yes", "no"]) {
    const result = await runFlow(flow, "input", mockLaya({
      type: "choice", choice, probabilities: { yes: choice === "yes" ? 0.9 : 0.1, no: choice === "no" ? 0.9 : 0.1 },
      confidence: 0.8, rl_agent: { act_probability: 0.9 },
    }));
    assert.equal(result.status, "completed");
    assert.deepEqual(result.trace.map((entry) => entry.nodeId), ["decision", choice === "yes" ? "left" : "right"]);
    assert.deepEqual(result.output, {
      decision: choice, left: choice === "yes" ? "yes" : null, right: choice === "no" ? "no" : null,
    });
  }
  flow.nodes.push({
    id: "right-only-end", type: "end", position: { x: 700, y: 80 },
    data: { label: "Right only", fields: [{ id: "left", key: "left", value: { kind: "decision", nodeId: "left" } }] },
  });
  flow.edges = flow.edges.map((edge) => edge.id === "right-no" ? { ...edge, target: "right-only-end" } : edge);
  assert.ok(validateFlow(flow).some((message) => message.includes("Right only") && message.includes("必須位於此節點上游")));
  let calls = 0;
  await assert.rejects(runFlow(flow, "input", {
    async systemOne() {
      calls++;
      throw new Error("inference must not run");
    },
  }), /流程尚未完成/);
  assert.equal(calls, 0);
});

test("ancestor lookup preserves breadth-first order, skips missing parents and terminates cycles", () => {
  const flow = branchFlow();
  flow.edges.push(
    { id: "missing-parent", source: "missing", target: "no-end", sourceHandle: "next" },
    { id: "cycle", source: "no-end", target: "decision", sourceHandle: "next" },
    { id: "missing-link", source: "decision", target: "unknown-target", sourceHandle: "next" },
  );
  assert.deepEqual(getAncestorDecisions(flow, "no-end").map((node) => node.id), ["decision"]);
  assert.deepEqual(getAncestorDecisions(flow, "decision").map((node) => node.id), ["decision"]);
  assert.deepEqual(getAncestorDecisions(flow, "unknown-target").map((node) => node.id), ["decision"]);
  assert.deepEqual(getAncestorDecisions(flow, "absent"), []);
});

test("a legal 48-node graph supports 64 options per decision converging on one End", () => {
  const flow = branchFlow();
  flow.nodes = flow.nodes.filter((node) => node.type !== "decision" && node.id !== "no-end");
  flow.edges = [{ id: "entry", source: "start", target: "decision-0", sourceHandle: "next" }];
  const criteria = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`option-${index}`, `Option ${index}`]));
  for (let index = 0; index < 46; index++) {
    const node = choiceNode(`decision-${index}`, `Decision ${index}`, index * 100);
    assert.ok(node.type === "decision");
    node.data.question = { type: "choice", instructions: "Choose", criteria };
    node.data.lowConfidenceBranch = "choice:option-0";
    node.data.inputNodeIds = index === 0 ? [] : [`decision-${index - 1}`];
    flow.nodes.push(node);
    for (let option = 0; option < 64; option++) {
      flow.edges.push({
        id: `${index}-${option}`, source: node.id, sourceHandle: `choice:option-${option}`,
        target: option === 0 && index < 45 ? `decision-${index + 1}` : "yes-end",
      });
    }
  }
  const end = flow.nodes.find((node) => node.id === "yes-end");
  assert.ok(end && end.type === "end");
  end.data.fields = ["decision-0", "decision-45"].map((nodeId) => ({
    id: nodeId, key: nodeId, value: { kind: "decision", nodeId },
  }));
  assert.equal(flow.nodes.length, 48);
  assert.equal(flow.edges.length, 2945);
  assert.deepEqual(validateFlow(flow), []);
});

test("invalid end output references reject before model inference", async () => {
  for (const ref of ["start", "yes-end", "missing", "other-decision"]) {
    const flow = branchFlow();
    const end = flow.nodes.find((node) => node.id === "no-end");
    assert.ok(end && end.type === "end");
    end.data.fields = [{ id: "output", key: "output", value: { kind: "decision", nodeId: ref } }];
    if (ref === "other-decision") {
      flow.nodes.push(
        choiceNode("other-decision", "Other branch", 100),
        { id: "other-end", type: "end", position: { x: 700, y: 100 }, data: { label: "Other end", fields: [] } },
      );
      flow.edges = flow.edges.map((edge) => edge.id === "yes-edge" ? { ...edge, target: "other-decision" } : edge);
      flow.edges.push(
        { id: "other-yes", source: "other-decision", target: "yes-end", sourceHandle: "choice:yes" },
        { id: "other-no", source: "other-decision", target: "other-end", sourceHandle: "choice:no" },
      );
    }
    assert.ok(validateFlow(flow).some((message) => message.includes("回傳欄位")), ref);
    let calls = 0;
    await assert.rejects(runFlow(flow, "input", {
      async systemOne() {
        calls++;
        throw new Error("inference must not run");
      },
    }), /流程尚未完成/);
    assert.equal(calls, 0, ref);
  }
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

test("partial batch saves merge atomically while full and changed-flow runs replace", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "laya-partial-batch-store-"));
  try {
    const store = await DecisionStore.open(path.join(directory, "flows.json"));
    const flow = await store.createFlow("Partial batch");
    const cases: FlowTestCase[] = ["first", "second"].map((id) => ({
      id, name: id, input: id, expectedOutput: {}, enabled: true,
    }));
    const suite = await store.saveFlowTestCases(flow.id, "", cases);
    const run = (caseId: string, revision = flowRevision(flow), status: "passed" | "failed" = "passed") => ({
      ranAt: new Date(0).toISOString(),
      flowRevision: revision,
      results: [{ caseId, status, actualOutput: {}, durationMs: 1 }],
    });
    await Promise.all([
      store.saveFlowTestRun(flow.id, suite.revision, run("second"), true),
      store.saveFlowTestRun(flow.id, suite.revision, run("first"), true),
    ]);
    assert.deepEqual(store.getFlowTestSuite(flow.id).lastRun?.results.map((result) => result.caseId), ["first", "second"]);

    await store.saveFlowTestRun(flow.id, suite.revision, run("first", flowRevision(flow), "failed"), true);
    assert.deepEqual(store.getFlowTestSuite(flow.id).lastRun?.results.map((result) => [result.caseId, result.status]), [
      ["first", "failed"], ["second", "passed"],
    ]);

    await store.saveFlowTestRun(flow.id, suite.revision, run("second"));
    assert.deepEqual(store.getFlowTestSuite(flow.id).lastRun?.results.map((result) => result.caseId), ["second"]);
    await store.saveFlowTestRun(flow.id, suite.revision, run("first"), true);
    assert.equal(store.getFlowTestSuite(flow.id).lastRun?.results.length, 2);

    const changedFlow = await store.saveFlow({
      ...flow,
      nodes: flow.nodes.map((node) => ({ ...node, data: { ...node.data, label: `${node.data.label} updated` } })),
    });
    const changedRevision = flowRevision(changedFlow);
    assert.notEqual(changedRevision, flowRevision(flow));
    await store.saveFlowTestRun(flow.id, suite.revision, run("second", changedRevision), true);
    assert.equal(store.getFlowTestSuite(flow.id).lastRun?.flowRevision, changedRevision);
    assert.deepEqual(store.getFlowTestSuite(flow.id).lastRun?.results.map((result) => result.caseId), ["second"]);
    await store.saveFlowTestRun(flow.id, suite.revision, run("first"), true);
    assert.equal(store.getFlowTestSuite(flow.id).lastRun?.flowRevision, flowRevision(flow));
    assert.deepEqual(store.getFlowTestSuite(flow.id).lastRun?.results.map((result) => result.caseId), ["first"]);

    await store.saveFlowTestCases(flow.id, suite.revision, [{ ...cases[0]!, name: "Edited case" }, cases[1]!]);
    await assert.rejects(store.saveFlowTestRun(flow.id, suite.revision, run("second"), true), /已更新/);
    assert.equal(store.getFlowTestSuite(flow.id).lastRun, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy store data defaults draft and history arrays and rejects malformed records", () => {
  assert.deepEqual(parseDecisionStoreData({ flows: [], templates: [] }), {
    flows: [], templates: [], flowTestSuites: [], flowDrafts: [], flowHistory: [],
  });
  assert.throws(() => parseDecisionStoreData({ flows: [], templates: [], flowDrafts: [null] }), /flowDraft/);
  assert.throws(() => parseDecisionStoreData({ flows: [], templates: [], flowHistory: [{ id: "history", flowId: "missing" }] }), /flowHistory/);
});

test("drafts isolate source flows and cloned cases and reject stale source apply without partial writes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "laya-flow-draft-isolation-"));
  try {
    const store = await DecisionStore.open(path.join(directory, "flows.json"));
    const source = await store.createFlow("Live workflow");
    const cases: FlowTestCase[] = [{ id: "live-case", name: "Live case", input: "hello", expectedOutput: {}, enabled: true }];
    await store.saveFlowTestCases(source.id, "", cases);
    const draft = await store.createDraft(source.id);
    assert.equal(draft.flow.id, draft.id);
    assert.equal(draft.name, "Live workflow-copy");
    const secondCopy = await store.createDraft(source.id);
    const firstNewFlowDraft = await store.createDraft();
    const secondNewFlowDraft = await store.createDraft();
    assert.equal(secondCopy.name, "Live workflow-copy-2");
    assert.equal(firstNewFlowDraft.name, "New flow");
    assert.equal(secondNewFlowDraft.name, "New flow-2");
    assert.deepEqual(draft.cases, cases);

    draft.flow.nodes[0]!.data.label = "mutated detached result";
    draft.cases[0]!.name = "mutated detached case";
    const untouched = store.getDraft(draft.id);
    assert.ok(untouched);
    assert.notEqual(untouched.flow.nodes[0]?.data.label, "mutated detached result");
    assert.equal(store.getFlow(source.id)?.nodes[0]?.data.label, "輸入請求");
    assert.equal(store.getFlowTestSuite(source.id).cases[0]?.name, "Live case");

    const editable = await store.updateDraft(draft.id, draft.revision, {
      cases: [{ ...cases[0]!, id: "candidate-case", name: "Candidate case" }],
    });
    await assert.rejects(store.updateDraft(draft.id, draft.revision, {}), /已更新/);
    const review = await store.setDraftStatus(editable.id, editable.revision, "review");
    const sourceAtReview = store.getFlow(source.id);
    assert.ok(sourceAtReview);
    const updatedSource = await store.saveFlow({
      ...sourceAtReview,
      nodes: sourceAtReview.nodes.map((node) => ({ ...node, position: { x: node.position.x + 10, y: node.position.y + 10 } })),
    });
    assert.equal(flowRevision(updatedSource), flowRevision(sourceAtReview));
    assert.notEqual(flowVersion(updatedSource), flowVersion(sourceAtReview));
    const beforeFlow = store.getFlow(source.id);
    const beforeSuite = store.getFlowTestSuite(source.id);
    const beforeHistory = store.listHistory(source.id);
    await assert.rejects(store.applyDraft(review.id, review.revision, true), /來源流程或測試案例已更新/);
    assert.deepEqual(store.getFlow(source.id), beforeFlow);
    assert.deepEqual(store.getFlowTestSuite(source.id), beforeSuite);
    assert.deepEqual(store.listHistory(source.id), beforeHistory);
    assert.equal(store.getDraft(review.id)?.status, "review");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("applying a draft atomically replaces cases while preserving live identity and history restores prior content", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "laya-flow-draft-apply-"));
  try {
    const store = await DecisionStore.open(path.join(directory, "flows.json"));
    const source = await store.createFlow("Human name");
    const originalCase: FlowTestCase = { id: "original", name: "Original", input: "before", expectedOutput: {}, enabled: true };
    const originalSuite = await store.saveFlowTestCases(source.id, "", [originalCase]);
    const draft = await store.createDraft(source.id);
    const candidateCase: FlowTestCase = { id: "candidate", name: "Candidate", input: "after", expectedOutput: {}, enabled: true };
    const changed = await store.updateDraft(draft.id, draft.revision, {
      flow: { ...draft.flow, name: "Candidate flow" },
      cases: [candidateCase],
    });
    const run = await runFlowTestCases(changed.flow, changed.cases, mockLaya({
      type: "choice", choice: "yes", probabilities: { yes: 0.9, no: 0.1 }, confidence: 0.8, rl_agent: { act_probability: 0.9 },
    }));
    const draftRun: FlowDraftRun = {
      draftRevision: changed.revision, baseline: null, candidate: run, traces: {}, baselineTraces: {},
    };
    const tested = await store.saveDraftRun(changed.id, changed.revision, draftRun);
    const review = await store.setDraftStatus(tested.id, tested.revision, "review");
    const applied = await store.applyDraft(review.id, review.revision);
    assert.equal(applied.flow.id, source.id);
    assert.equal(applied.flow.name, "Human name");
    assert.deepEqual(applied.suite.cases, [candidateCase]);
    assert.equal(applied.suite.lastRun?.flowRevision, flowRevision(applied.flow));
    assert.equal(applied.draft.status, "applied");
    assert.equal(store.listHistory(source.id).length, 1);
    assert.deepEqual(store.listHistory(source.id)[0]?.suite, originalSuite);

    const history = store.listHistory(source.id)[0];
    assert.ok(history);
    const restored = await store.restoreHistory(source.id, history.id, flowVersion(applied.flow), applied.suite.revision);
    assert.equal(restored.flow.id, source.id);
    assert.equal(restored.flow.name, "Human name");
    assert.deepEqual(restored.suite.cases, [originalCase]);
    assert.equal(restored.suite.lastRun, null);
    assert.equal(store.listHistory(source.id).length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the sample follows one selected path and lets mutually exclusive branches share an End", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "laya-sequential-flow-"));
  try {
    const store = await DecisionStore.open(path.join(directory, "flows.json"));
    const flow = store.listFlows()[0];
    assert.ok(flow);
    assert.equal(flow.name, "IoT 操作判斷（範例）");
    assert.deepEqual(validateFlow(flow), []);

    const runWithAnswers = async (answers: Answer[]) => {
      const questionsSeen: Question[] = [];
      const result = await runFlow(flow, "test input", {
        async systemOne<Q extends Record<string, Question>>(_state: unknown, questions: Q): Promise<SystemOneResult<Q>> {
          const question = Object.values(questions)[0];
          assert.ok(question);
          questionsSeen.push(question);
          const answer = answers[questionsSeen.length - 1];
          assert.ok(answer, "the engine must not run an unselected decision");
          const returnedAnswers = Object.fromEntries(Object.keys(questions).map((key) => [key, answer])) as SystemOneResult<Q>["answers"];
          return { model: "laya", answers: returnedAnswers, usage: { input_tokens: 1, output_tokens: 0 } };
        },
      });
      return { result, questionsSeen };
    };

    const gateYes: Answer = { type: "noul", noul: 0.95, rl_agent: { act_probability: 0.95 } };
    const gateNo: Answer = { type: "noul", noul: 0.05, rl_agent: { act_probability: 0.05 } };
    const fan: Answer = { type: "choice", choice: "fan", probabilities: { fan: 0.9, other: 0.1 }, confidence: 0.8, rl_agent: { act_probability: 0.9 } };
    const on: Answer = { type: "choice", choice: "on", probabilities: { on: 0.9, off: 0.05, other: 0.05 }, confidence: 0.8, rl_agent: { act_probability: 0.9 } };
    const otherDevice: Answer = { type: "choice", choice: "other", probabilities: { fan: 0.1, other: 0.9 }, confidence: 0.8, rl_agent: { act_probability: 0.9 } };
    const otherAction: Answer = { type: "choice", choice: "other", probabilities: { on: 0.05, off: 0.05, other: 0.9 }, confidence: 0.8, rl_agent: { act_probability: 0.9 } };

    const success = await runWithAnswers([gateYes, fan, on]);
    assert.deepEqual(success.result.output, { iotRequest: true, device: "fan", action: "on" });
    assert.deepEqual(success.questionsSeen.map((question) => question.type), ["noul", "choice", "choice"]);
    assert.equal(success.result.trace.length, 3);

    const notIot = await runWithAnswers([gateNo]);
    assert.deepEqual(notIot.result.output, { iotRequest: false });
    assert.equal(notIot.result.trace.length, 1);

    const unsupportedDevice = await runWithAnswers([gateYes, otherDevice]);
    assert.deepEqual(unsupportedDevice.result.output, { iotRequest: false });
    assert.equal(unsupportedDevice.result.trace.length, 2);

    const unsupportedAction = await runWithAnswers([gateYes, fan, otherAction]);
    assert.deepEqual(unsupportedAction.result.output, { iotRequest: false });
    assert.equal(unsupportedAction.result.trace.length, 3);

    const fanOutFlow = structuredClone(flow);
    const gate = fanOutFlow.nodes.find((node) => node.type === "decision" && node.data.label.includes("是否為 IoT 操作"));
    const sharedEnd = fanOutFlow.nodes.find((node) => node.type === "end" && node.data.label.includes("不支援"));
    assert.ok(gate && gate.type === "decision" && sharedEnd && sharedEnd.type === "end");
    fanOutFlow.edges.push({ id: "fan-out", source: gate.id, target: sharedEnd.id, sourceHandle: "true" });
    assert.ok(validateFlow(fanOutFlow).some((message) => message.includes("只能連接一個下一步")));

    const mergedDecisionFlow = structuredClone(flow);
    const mergeGate = mergedDecisionFlow.nodes.find((node) => node.type === "decision" && node.data.label.includes("是否為 IoT 操作"));
    const device = mergedDecisionFlow.nodes.find((node) => node.type === "decision" && node.data.label.includes("識別裝置"));
    assert.ok(mergeGate && mergeGate.type === "decision" && device && device.type === "decision");
    mergedDecisionFlow.edges.push({ id: "second-parent", source: mergeGate.id, target: device.id, sourceHandle: "false" });
    assert.ok(validateFlow(mergedDecisionFlow).some((message) => message.includes("必須且只能有一個上游節點")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
