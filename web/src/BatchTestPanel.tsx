import { useEffect, useMemo, useState } from "react";
import { MAX_FLOW_TEST_CASES } from "../../decision-types";
import type { DecisionFlow, FlowTestCase, FlowTestCaseResult, FlowTestSuite, JsonValue } from "../../decision-types";
import { parseJsonObject } from "../../decision-schema";
import { createId } from "./id";
import { flowRevision } from "../../flow-test-utils";
import { getFlowTestSuite, runFlowTestBatch, saveFlowTestCases } from "./api";

interface BatchTestPanelProps {
  flow: DecisionFlow | null;
  issues: string[];
  inspectorValid: boolean;
  dirty: boolean;
  flowBusy: boolean;
  testing: boolean;
  onTestingChange: (testing: boolean) => void;
  onDraftDirtyChange: (dirty: boolean) => void;
  onSavingCasesChange: (saving: boolean) => void;
  hidden: boolean;
}

interface TestCaseDraft {
  id: string | null;
  name: string;
  inputMode: "text" | "json";
  inputText: string;
  expectedJson: string;
}

function resultLabel(result: FlowTestCaseResult | undefined, stale: boolean): string {
  if (stale) return "舊結果";
  if (!result) return "尚未執行";
  if (result.status === "passed") return "通過";
  if (result.status === "failed") return "未通過";
  return "執行錯誤";
}

export function BatchTestPanel({ flow, issues, inspectorValid, dirty, testing, onTestingChange, onDraftDirtyChange, onSavingCasesChange, flowBusy, hidden }: BatchTestPanelProps) {
  const [suite, setSuite] = useState<FlowTestSuite | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingCases, setSavingCases] = useState(false);
  const [caseError, setCaseError] = useState("");
  const [draft, setDraft] = useState<TestCaseDraft | null>(null);
  const [draftDirty, setDraftDirtyState] = useState(false);
  const [runningError, setRunningError] = useState("");

  function changeDraftDirty(value: boolean): void {
    setDraftDirtyState(value);
    onDraftDirtyChange(value);
  }

  function changeSavingCases(value: boolean): void {
    setSavingCases(value);
    onSavingCasesChange(value);
  }

  useEffect(() => {
    if (!flow) {
      setSuite(null);
      setLoading(false);
      changeDraftDirty(false);
      return;
    }
    let active = true;
    setLoading(true);
    setCaseError("");
    setDraft(null);
    changeDraftDirty(false);
    getFlowTestSuite(flow.id).then((loaded) => {
      if (active) setSuite(loaded);
    }).catch((error: unknown) => {
      if (active) setCaseError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [flow?.id, onDraftDirtyChange]);

  const currentRevision = useMemo(() => flow ? flowRevision(flow) : "", [flow]);
  const stale = Boolean(suite?.lastRun && suite.lastRun.flowRevision !== currentRevision);
  const resultsById = useMemo(() => new Map(suite?.lastRun?.results.map((result) => [result.caseId, result]) ?? []), [suite?.lastRun]);
  const failures = suite?.lastRun?.results.filter((result) => result.status !== "passed") ?? [];
  const passedCount = suite?.lastRun?.results.filter((result) => result.status === "passed").length ?? 0;
  const failedCount = suite?.lastRun?.results.filter((result) => result.status === "failed").length ?? 0;
  const errorCount = suite?.lastRun?.results.filter((result) => result.status === "error").length ?? 0;
  const enabledCount = suite?.cases.filter((testCase) => testCase.enabled).length ?? 0;
  const blocked = !flow || loading || savingCases || testing || flowBusy || Boolean(draft) || issues.length > 0 || !inspectorValid;

  function openDraft(testCase?: FlowTestCase): void {
    if (flowBusy || (draftDirty && !window.confirm("捨棄尚未儲存的測試案例變更？"))) return;
    setCaseError("");
    setDraft(testCase
      ? {
          id: testCase.id,
          name: testCase.name,
          inputMode: typeof testCase.input === "string" ? "text" : "json",
          inputText: typeof testCase.input === "string" ? testCase.input : JSON.stringify(testCase.input, null, 2),
          expectedJson: JSON.stringify(testCase.expectedOutput, null, 2),
        }
      : { id: null, name: "", inputMode: "text", inputText: "", expectedJson: "{}" });
    changeDraftDirty(false);
  }

  function changeDraftInputMode(inputMode: "text" | "json"): void {
    if (!draft || draft.inputMode === inputMode) return;
    let inputText = draft.inputText;
    if (inputMode === "json" && draft.inputMode === "text") inputText = JSON.stringify(inputText);
    if (inputMode === "text" && draft.inputMode === "json") {
      try {
        const value: unknown = JSON.parse(inputText);
        if (typeof value === "string") inputText = value;
      } catch {
        // Keep the current text so an invalid JSON draft can still be edited.
      }
    }
    setDraft({ ...draft, inputMode, inputText });
    changeDraftDirty(true);
  }

  function cancelDraft(): void {
    if (draftDirty && !window.confirm("捨棄尚未儲存的測試案例變更？")) return;
    setDraft(null);
    changeDraftDirty(false);
  }

  async function saveDraft(): Promise<void> {
    if (!flow || !suite || !draft || savingCases || flowBusy) return;
    if (draft.name.trim().length === 0 || draft.name.trim().length > 120) {
      setCaseError("案例名稱需為 1～120 個字元。");
      return;
    }
    let input: JsonValue;
    let expectedOutput: Record<string, JsonValue>;
    try {
      input = draft.inputMode === "text" ? draft.inputText : JSON.parse(draft.inputText) as JsonValue;
      expectedOutput = parseJsonObject(JSON.parse(draft.expectedJson) as unknown);
    } catch (error) {
      setCaseError(error instanceof Error ? `JSON 格式不正確：${error.message}` : "JSON 格式不正確。");
      return;
    }
    const updated: FlowTestCase = { id: draft.id ?? createId(), name: draft.name.trim(), input, expectedOutput, enabled: true };
    const cases = draft.id
      ? suite.cases.map((testCase) => testCase.id === draft.id ? { ...updated, enabled: testCase.enabled } : testCase)
      : [...suite.cases, updated];
    changeSavingCases(true);
    setCaseError("");
    try {
      setSuite(await saveFlowTestCases(flow.id, suite.revision, cases));
      setDraft(null);
      changeDraftDirty(false);
    } catch (error) {
      setCaseError(error instanceof Error ? error.message : String(error));
    } finally {
      changeSavingCases(false);
    }
  }

  async function updateCases(cases: FlowTestCase[]): Promise<void> {
    if (!flow || !suite || savingCases || flowBusy) return;
    changeSavingCases(true);
    setCaseError("");
    try {
      setSuite(await saveFlowTestCases(flow.id, suite.revision, cases));
    } catch (error) {
      setCaseError(error instanceof Error ? error.message : String(error));
    } finally {
      changeSavingCases(false);
    }
  }

  async function deleteCase(testCase: FlowTestCase): Promise<void> {
    if (!suite || savingCases || flowBusy || !window.confirm(`確定刪除測試案例「${testCase.name}」？`)) return;
    await updateCases(suite.cases.filter((candidate) => candidate.id !== testCase.id));
    if (draft?.id === testCase.id) {
      setDraft(null);
      changeDraftDirty(false);
    }
  }

  async function runBatch(caseIds?: string[]): Promise<void> {
    if (!flow || !suite || blocked || enabledCount === 0) return;
    onTestingChange(true);
    setRunningError("");
    try {
      setSuite(await runFlowTestBatch(flow, caseIds));
    } catch (error) {
      setRunningError(error instanceof Error ? error.message : String(error));
    } finally {
      onTestingChange(false);
    }
  }

  return (
    <div className="test-panel__body batch-test-panel" role="tabpanel" id="batch-test-panel" aria-labelledby="test-mode-batch" hidden={hidden}>
      <div className="batch-test__toolbar">
        <div><strong>{suite?.cases.length ?? 0} 個案例</strong><span>{enabledCount} 個啟用</span></div>
        <button type="button" className="button button--subtle button--small" onClick={() => openDraft()} disabled={!flow || !suite || loading || savingCases || testing || flowBusy || suite.cases.length >= MAX_FLOW_TEST_CASES}>＋ 新增案例</button>
      </div>
      <p className="helper-copy">案例輸入可用文字或 JSON。批次測試會使用目前流程（包含未儲存變更），逐案執行並比對輸出 JSON；物件欄位順序不影響結果，陣列順序有影響。</p>
      {dirty && <p className="batch-test__notice">流程尚未儲存。本次執行會測試畫布上的版本。</p>}
      {issues.length > 0 && <p className="form-error" role="alert">先完成流程連線才能執行批次測試。</p>}
      {!inspectorValid && <p className="form-error" role="alert">先修正積木中的未完成欄位才能執行批次測試。</p>}
      {caseError && <p className="form-error" role="alert">{caseError}</p>}
      {runningError && <p className="form-error" role="alert">{runningError}</p>}
      {loading ? <div className="batch-test__empty"><span className="spinner" /><span>載入測試案例…</span></div> : suite && <>
        {suite.lastRun && <div className={`batch-test__summary${stale ? " is-stale" : ""}`} aria-live="polite">
          {stale
            ? <><strong>流程已變更，結果可能過期</strong><span>上次執行：{new Date(suite.lastRun.ranAt).toLocaleString()}</span></>
            : <><strong>{passedCount} 通過 · {failedCount} 未通過 · {errorCount} 錯誤</strong><span>目前結果涵蓋 {suite.lastRun.results.length} 個案例 · 最近更新：{new Date(suite.lastRun.ranAt).toLocaleString()}</span></>}
        </div>}
        {suite.cases.length === 0 ? <div className="batch-test__empty"><strong>還沒有測試案例</strong><span>新增案例並設定輸入與預期 JSON，之後可用同一批案例檢查流程修改。</span></div> : <ol className="batch-case-list">
          {suite.cases.map((testCase) => {
            const result = resultsById.get(testCase.id);
            const status = testCase.enabled ? resultLabel(result, stale) : "已停用";
            return <li className="batch-case" key={testCase.id}>
              <div className="batch-case__head">
                <label className="batch-case__enabled"><input type="checkbox" checked={testCase.enabled} disabled={savingCases || testing || flowBusy || Boolean(draft)} onChange={(event) => void updateCases(suite.cases.map((candidate) => candidate.id === testCase.id ? { ...candidate, enabled: event.target.checked } : candidate))} /><span className="sr-only">啟用 {testCase.name}</span></label>
                <div className="batch-case__title"><strong>{testCase.name}</strong><span className={`batch-status batch-status--${stale ? "stale" : result?.status ?? "new"}`}>{status}</span></div>
                <button type="button" className="icon-button" aria-label={`編輯測試案例 ${testCase.name}`} onClick={() => openDraft(testCase)} disabled={savingCases || testing || flowBusy || Boolean(draft)}>編輯</button>
                <button type="button" className="icon-button danger" aria-label={`刪除測試案例 ${testCase.name}`} onClick={() => void deleteCase(testCase)} disabled={savingCases || testing || flowBusy || Boolean(draft)}>刪除</button>
              </div>
              <p className="batch-case__input">輸入：<code>{JSON.stringify(testCase.input)}</code></p>
              {result?.status === "error" && !stale && <p className="batch-case__error" role="alert">{result.error}</p>}
              <details className="batch-case__details">
                <summary>{result ? "查看預期與實際 JSON" : "查看預期輸出 JSON"}</summary>
                <div className="batch-case__comparison">
                  <div><span>預期輸出</span><pre>{JSON.stringify(testCase.expectedOutput, null, 2)}</pre></div>
                  <div><span>實際輸出</span><pre>{result?.actualOutput ? JSON.stringify(result.actualOutput, null, 2) : result?.status === "error" ? "執行錯誤" : "尚未執行"}</pre></div>
                </div>
              </details>
            </li>;
          })}
        </ol>}
        {draft && <form className="batch-case-editor" onSubmit={(event) => { event.preventDefault(); void saveDraft(); }}>
          <div className="batch-case-editor__heading"><strong>{draft.id ? "編輯測試案例" : "新增測試案例"}</strong><button type="button" className="icon-button" aria-label="取消編輯測試案例" onClick={cancelDraft} disabled={savingCases || flowBusy}>×</button></div>
          <label className="field"><span>案例名稱</span><input maxLength={120} value={draft.name} onChange={(event) => { setDraft({ ...draft, name: event.target.value }); changeDraftDirty(true); }} placeholder="例如：明確要求開啟風扇" disabled={flowBusy} /></label>
          <div className="input-toggle" role="group" aria-label="測試輸入格式"><button type="button" className={draft.inputMode === "text" ? "is-active" : ""} onClick={() => changeDraftInputMode("text")} disabled={flowBusy}>文字</button><button type="button" className={draft.inputMode === "json" ? "is-active" : ""} onClick={() => changeDraftInputMode("json")} disabled={flowBusy}>JSON</button></div>
          <label className="field"><span>{draft.inputMode === "text" ? "測試文字" : "JSON 輸入"}</span><textarea rows={draft.inputMode === "text" ? 2 : 4} spellCheck={false} value={draft.inputText} onChange={(event) => { setDraft({ ...draft, inputText: event.target.value }); changeDraftDirty(true); }} placeholder={draft.inputMode === "text" ? "例如：打開風扇" : '{ "text": "打開風扇" }'} disabled={flowBusy} /></label>
          <label className="field"><span>預期輸出 JSON</span><textarea rows={5} value={draft.expectedJson} onChange={(event) => { setDraft({ ...draft, expectedJson: event.target.value }); changeDraftDirty(true); }} disabled={flowBusy} /></label>
          <div className="batch-case-editor__actions"><button type="button" className="button button--subtle" onClick={cancelDraft} disabled={savingCases || flowBusy}>取消</button><button type="submit" className="button button--primary" disabled={savingCases || flowBusy}>{savingCases ? "儲存中…" : "儲存案例"}</button></div>
        </form>}
        <div className="batch-test__actions">
          <button type="button" className="button button--primary button--wide" onClick={() => void runBatch()} disabled={blocked || enabledCount === 0}>{testing ? "逐案執行中…" : "執行啟用案例"}</button>
          <button type="button" className="button button--wide" onClick={() => void runBatch(failures.map((result) => result.caseId))} disabled={blocked || stale || failures.length === 0}>重跑未通過與錯誤</button>
        </div>
        {draft && <p className="helper-copy">先儲存或取消案例編輯，再執行批次測試。</p>}
      </>}
      {!loading && !flow && <div className="batch-test__empty"><strong>先建立或選擇一條流程</strong><span>測試案例會分別保存於各條流程。</span></div>}
    </div>
  );
}
