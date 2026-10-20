import { runFlow } from "./decision-engine.js";
import type { Laya } from "@receptron/laya";
import type { DecisionFlow, FlowTestCase, FlowTestCaseResult, FlowTestRun } from "./decision-types.js";
import { flowRevision, outputsEqual } from "./flow-test-utils.js";


export async function runFlowTestCases(
  flow: DecisionFlow,
  cases: FlowTestCase[],
  laya: Pick<Laya, "systemOne">,
  selectedCaseIds?: string[],
): Promise<FlowTestRun> {
  let selected: FlowTestCase[];
  if (selectedCaseIds === undefined) {
    selected = cases.filter((testCase) => testCase.enabled);
  } else {
    const requested = new Set(selectedCaseIds);
    if (requested.size !== selectedCaseIds.length) throw new Error("批次測試包含重複的案例識別碼。");
    if (selectedCaseIds.some((id) => !cases.some((testCase) => testCase.id === id))) throw new Error("批次測試包含不存在的案例。");
    selected = cases.filter((testCase) => testCase.enabled && requested.has(testCase.id));
    if (selected.length !== requested.size) throw new Error("停用的測試案例不能執行。");
  }
  if (selected.length === 0) throw new Error("請先啟用至少一個測試案例。");

  const revision = flowRevision(flow);
  const results: FlowTestCaseResult[] = [];
  for (const testCase of selected) {
    const started = performance.now();
    try {
      const result = await runFlow(flow, testCase.input, laya);
      results.push({
        caseId: testCase.id,
        status: outputsEqual(result.output, testCase.expectedOutput) ? "passed" : "failed",
        actualOutput: result.output,
        durationMs: result.durationMs,
      });
    } catch (error) {
      results.push({
        caseId: testCase.id,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        durationMs: Math.round(performance.now() - started),
      });
    }
  }

  return { ranAt: new Date().toISOString(), flowRevision: revision, results };
}
