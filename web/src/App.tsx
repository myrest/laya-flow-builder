import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { getDefaultLowConfidenceBranch, validateFlow } from "../../decision-engine";
import type { DecisionFlow, DecisionFlowNode, DecisionTemplate, FlowNode, FlowTestResult } from "../../decision-types";
import { DEFAULT_MIN_CONFIDENCE } from "../../decision-types";
import {
  choiceQuestion,
  createFlow,
  createTemplate,
  deleteFlow,
  deleteTemplate,
  listFlows,
  listTemplates,
  saveFlow,
  testFlow,
  validateFlow as validateSavedFlow,
} from "./api";
import { createId } from "./id";
import { FlowCanvas, beginBlockDrag } from "./FlowCanvas";
import { Inspector } from "./Inspector";
import { BatchTestPanel } from "./BatchTestPanel";
import { removeFlowNodes } from "./flow-editing";

type BlockType = "choice" | "noul" | "score" | "end" | `template:${string}`;
type InputMode = "text" | "json";

function makeDecisionNode(type: "choice" | "noul" | "score", position: { x: number; y: number }, template?: DecisionTemplate): DecisionFlowNode {
  const question = template?.question ?? (type === "noul"
    ? { type: "noul" as const, instructions: "這個敘述是否成立？", criteria: { true: "符合", false: "不符合" } }
    : type === "score"
      ? { type: "score" as const, instructions: "要評估的程度？", criteria: ["一般", "稍微", "緊急", "非常緊急"] }
      : choiceQuestion());
  return {
    id: createId(),
    type: "decision",
    position,
    data: {
      label: template?.name ?? (type === "choice" ? "單選判斷" : type === "noul" ? "是非判斷" : "程度評分"),
      question: structuredClone(question),
      inputNodeIds: [],
      trueThreshold: template?.trueThreshold ?? 0.5,
      minConfidence: template?.minConfidence ?? DEFAULT_MIN_CONFIDENCE,
      lowConfidenceBranch: template?.lowConfidenceBranch ?? getDefaultLowConfidenceBranch(question, template?.scoreThresholds ?? []),
      scoreThresholds: [...(template?.scoreThresholds ?? [])],
    },
  };
}

function createNode(type: BlockType, position: { x: number; y: number }, templates: DecisionTemplate[]): FlowNode | null {
  if (type.startsWith("template:")) {
    const template = templates.find((candidate) => candidate.id === type.slice("template:".length));
    return template ? makeDecisionNode(template.question.type, position, template) : null;
  }
  if (type === "choice" || type === "noul" || type === "score") return makeDecisionNode(type, position);
  if (type === "end") return { id: createId(), type: "end", position, data: { label: "回傳 JSON", fields: [] } };
  return null;
}

function answerSummary(result: FlowTestResult): string {
  return `${result.trace.length} 個決策節點 · ${result.durationMs} ms`;
}

function describeAnswer(result: FlowTestResult["trace"][number]): string {
  if (result.answer.type === "choice") {
    return result.lowConfidenceFallback
      ? `低信心預設：${String(result.value)}（模型答案：${result.answer.choice}）`
      : `分類：${String(result.value)}`;
  }
  if (result.answer.type === "score") {
    const score = typeof result.value === "number" ? result.value.toFixed(2) : String(result.value);
    return result.lowConfidenceFallback
      ? `低信心預設：${score}（模型分數：${result.answer.score.toFixed(2)}）`
      : `分數：${score}`;
  }
  return result.lowConfidenceFallback
    ? `低信心預設：${result.value ? "是" : "否"}（模型 P(是)：${(result.answer.noul * 100).toFixed(1)}%）`
    : `P(是)：${(result.answer.noul * 100).toFixed(1)}%`;
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back if clipboard permissions are unavailable.
    }
  }

  // Clipboard API is unavailable on LAN HTTP origins; keep a click-triggered fallback.
  const activeElement = document.activeElement;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  let copied = false;
  try {
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    copied = typeof document.execCommand === "function" && document.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    textarea.remove();
    if (activeElement instanceof HTMLElement) activeElement.focus({ preventScroll: true });
  }
  if (!copied) throw new Error("無法自動複製。請手動選取下方 curl 指令，或改用 HTTPS 連線。");
}

function AppContent() {
  const [flows, setFlows] = useState<DecisionFlow[]>([]);
  const [flow, setFlow] = useState<DecisionFlow | null>(null);
  const flowRef = useRef<DecisionFlow | null>(null);
  const viewRevision = useRef(0);
  const [templates, setTemplates] = useState<DecisionTemplate[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [newFlowName, setNewFlowName] = useState("");
  const [dirty, setDirty] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [flowTransitioning, setFlowTransitioning] = useState(false);
  const [pageError, setPageError] = useState("");
  const [inputMode, setInputMode] = useState<InputMode>("text");
  const [testInput, setTestInput] = useState("打開風扇");
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState("");
  const [result, setResult] = useState<FlowTestResult | null>(null);
  const [testMode, setTestMode] = useState<"single" | "batch">("single");
  const [copied, setCopied] = useState(false);
  const [inspectorValid, setInspectorValid] = useState(true);
  const [caseDraftDirty, setCaseDraftDirty] = useState(false);
  const [savingCases, setSavingCases] = useState(false);
  const apiUrl = useMemo(() => {
    const url = new URL(window.location.origin);
    if (import.meta.env.DEV) url.port = import.meta.env.VITE_API_PORT;
    return url.origin;
  }, []);

  const setCurrentFlow = useCallback((next: DecisionFlow | null) => {
    flowRef.current = next;
    setFlow(next);
  }, []);

  const clearTest = useCallback(() => {
    viewRevision.current += 1;
    setResult(null);
    setTestError("");
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([listFlows(), listTemplates()]).then(async ([loadedFlows, loadedTemplates]) => {
      if (!active) return;
      setFlows(loadedFlows);
      setTemplates(loadedTemplates);
      const first = loadedFlows[0];
      if (first) {
        const [latest, validation] = await Promise.all([Promise.resolve(first), validateSavedFlow(first.id)]);
        if (!active) return;
        setCurrentFlow(latest);
        setIssues(validation.issues);
      }
    }).catch((error: unknown) => {
      if (active) setPageError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [setCurrentFlow]);

  const onChangeFlow = useCallback((updated: DecisionFlow) => {
    setCurrentFlow(updated);
    setDirty(true);
    setIssues(validateFlow(updated));
    clearTest();
  }, [clearTest, setCurrentFlow]);

  const selectedNode = flowTransitioning ? null : flow?.nodes.find((node) => node.id === selectedNodeId) ?? null;

  async function selectFlow(id: string): Promise<void> {
    if (flow?.id === id || loading || saving || savingCases || flowTransitioning) return;
    if ((dirty || caseDraftDirty) && !window.confirm("目前有尚未儲存的流程或測試案例變更；捨棄並切換流程？")) return;
    clearTest();
    setLoading(true);
    setFlowTransitioning(true);
    setPageError("");
    setSelectedNodeId(null);
    setInspectorValid(true);
    try {
      const [next, validation] = await Promise.all([listFlows().then((all) => all.find((candidate) => candidate.id === id)).then((candidate) => {
        if (!candidate) throw new Error("找不到指定流程。");
        return candidate;
      }), validateSavedFlow(id)]);
      setCurrentFlow(next);
      setIssues(validation.issues);
      setCaseDraftDirty(false);
      setDirty(false);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error));
    } finally {
      setFlowTransitioning(false);
      setLoading(false);
    }
  }

  async function handleCreateFlow(): Promise<void> {
    if (newFlowName.trim().length === 0 || loading || saving || savingCases || flowTransitioning) return;
    if ((dirty || caseDraftDirty) && !window.confirm("目前有尚未儲存的流程或測試案例變更；捨棄並建立新流程？")) return;
    clearTest();
    setFlowTransitioning(true);
    setSelectedNodeId(null);
    setSaving(true);
    setPageError("");
    try {
      const created = await createFlow(newFlowName.trim());
      setFlows((current) => [...current, created]);
      setCurrentFlow(created);
      setNewFlowName("");
      setSelectedNodeId(null);
      setInspectorValid(true);
      setCaseDraftDirty(false);
      setDirty(false);
      setIssues(validateFlow(created));
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error));
    } finally {
      setFlowTransitioning(false);
      setSaving(false);
    }
  }

  async function handleSave(): Promise<void> {
    if (!flow || !inspectorValid || loading || saving || savingCases) return;
    const snapshot = flow;
    const revision = viewRevision.current;
    setSaving(true);
    setPageError("");
    try {
      const saved = await saveFlow(snapshot);
      setFlows((current) => current.map((candidate) => candidate.id === saved.id ? saved : candidate));
      if (flowRef.current === snapshot && viewRevision.current === revision) {
        setCurrentFlow(saved);
        setIssues(validateFlow(saved));
        setDirty(false);
      }
    } catch (error) {
      if (flowRef.current?.id === snapshot.id) setPageError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteFlow(): Promise<void> {
    if (!flow || flows.length < 2 || loading || saving || savingCases || flowTransitioning || !window.confirm(`確定刪除「${flow.name}」及其測試案例？此動作無法復原。`)) return;
    clearTest();
    setFlowTransitioning(true);
    setSelectedNodeId(null);
    setPageError("");
    setSaving(true);
    try {
      await deleteFlow(flow.id);
      const remaining = flows.filter((candidate) => candidate.id !== flow.id);
      setFlows(remaining);
      const next = remaining[0] ?? null;
      setCurrentFlow(next);
      setCaseDraftDirty(false);
      setDirty(false);
      setSelectedNodeId(null);
      setInspectorValid(true);
      setIssues(next ? validateFlow(next) : []);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error));
    } finally {
      setFlowTransitioning(false);
      setSaving(false);
    }
  }

  function handleAddAt(type: BlockType, position: { x: number; y: number }): void {
    if (!flow || loading || flowTransitioning) return;
    const node = createNode(type, position, templates);
    if (!node) return;
    const next = { ...flow, nodes: [...flow.nodes, node] };
    onChangeFlow(next);
    setSelectedNodeId(node.id);
  }

  function handleDeleteNode(nodeId: string): void {
    if (!flow) return;
    const updated = removeFlowNodes(flow, new Set([nodeId]));
    onChangeFlow(updated);
    setSelectedNodeId(null);
  }

  async function handleCreateTemplate(template: DecisionTemplate): Promise<void> {
    const saved = await createTemplate(template);
    setTemplates((current) => [...current, saved]);
  }

  async function handleDeleteTemplate(id: string): Promise<void> {
    if (!window.confirm("刪除此積木範本？已放入流程的節點不受影響。")) return;
    try {
      await deleteTemplate(id);
      setTemplates((current) => current.filter((template) => template.id !== id));
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleTest(): Promise<void> {
    if (!flow || loading || saving || testing || issues.length > 0 || !inspectorValid) return;
    const snapshot = flow;
    const revision = viewRevision.current;
    setTesting(true);
    setTestError("");
    setResult(null);
    try {
      const input: unknown = inputMode === "json" ? JSON.parse(testInput) : testInput;
      const tested = await testFlow(snapshot, input);
      if (flowRef.current === snapshot && viewRevision.current === revision) setResult(tested);
    } catch (error) {
      if (flowRef.current === snapshot && viewRevision.current === revision) setTestError(error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  }

  const apiExample = flow ? `curl -X POST '${apiUrl}/api/flows/${flow.id}/run' -H 'Content-Type: application/json' -d '{"input":"打開風扇"}'` : "";
  async function copyApiExample(): Promise<void> {
    if (!apiExample) return;
    setPageError("");
    try {
      await copyTextToClipboard(apiExample);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch (error) {
      setCopied(false);
      setPageError(error instanceof Error ? error.message : "無法自動複製。請手動選取下方 curl 指令。");
    }
  }

  const readyToRun = Boolean(flow) && !loading && !saving && issues.length === 0 && inspectorValid && !testing;
  const selectedFlowName = flow?.name ?? "尚未建立流程";

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand__mark">L</span><div><strong>決策流程</strong><small>Laya Workbench</small></div></div>
        <div className="topbar__flow">
          <label className="sr-only" htmlFor="flow-select">選擇流程</label>
          <select id="flow-select" value={flow?.id ?? ""} onChange={(event) => void selectFlow(event.target.value)} disabled={loading || saving || savingCases || flowTransitioning || flows.length === 0}>
            {flows.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
            {flows.length === 0 && <option value="">尚未建立流程</option>}
          </select>
          <input aria-label="新流程名稱" placeholder="新流程名稱" maxLength={120} value={newFlowName} onChange={(event) => setNewFlowName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void handleCreateFlow(); }} disabled={loading || saving || savingCases || flowTransitioning} />
          <button type="button" className="button button--subtle" onClick={() => void handleCreateFlow()} disabled={loading || saving || savingCases || flowTransitioning || newFlowName.trim().length === 0}>＋ 建立流程</button>
        </div>
        <div className="topbar__actions">
          <span className={`save-state${dirty ? " is-dirty" : ""}`} aria-live="polite">{saving ? "儲存中…" : dirty ? "未儲存" : "已儲存"}</span>
          <button type="button" className="button button--primary" onClick={() => void handleSave()} disabled={!flow || !dirty || loading || saving || savingCases || !inspectorValid}>{saving ? "儲存中…" : "儲存流程"}</button>
          <button type="button" className="icon-button danger" aria-label="刪除目前流程" title="刪除目前流程" onClick={() => void handleDeleteFlow()} disabled={!flow || flows.length < 2 || loading || saving || savingCases || flowTransitioning}>刪除</button>
        </div>
      </header>

      {pageError && <div className="alert-banner" role="alert"><span>{pageError}</span><button type="button" className="icon-button" aria-label="關閉錯誤訊息" onClick={() => setPageError("")}>×</button></div>}

      <div className="workspace">
        <aside className="palette panel" aria-label="積木面板">
          <header className="panel__heading"><div><span className="eyebrow">建立流程</span><h2>積木</h2></div></header>
          <p className="panel__hint">拖曳到畫布或按「＋」新增；點擊積木不會新增。</p>
          <section className="palette__section"><h3>基本決策</h3>
            <PaletteBlock type="choice" title="單選分類" description="多個文字選項" onAdd={handleAddAt} />
            <PaletteBlock type="noul" title="是／否判斷" description="依 P(true) 門檻分流" onAdd={handleAddAt} />
            <PaletteBlock type="score" title="程度評分" description="以數值切分點分流" onAdd={handleAddAt} />
          </section>
          <section className="palette__section"><h3>輸出</h3><PaletteBlock type="end" title="回傳 JSON" description="設定固定值或決策結果" onAdd={handleAddAt} /></section>
          <section className="palette__section palette__templates"><div className="section-heading"><h3>我的積木範本</h3><span>{templates.length}</span></div>
            {templates.length === 0 ? <p className="muted small-copy">選取決策節點後，可儲存為範本。</p> : <>
              <p className="muted small-copy">基本積木從預設設定開始；範本會帶入已儲存的問題與分流設定。</p>
              {templates.map((template) => (
                <div className="template-row" key={template.id}>
                  <button type="button" className="template-row__add" draggable onDragStart={(event) => beginBlockDrag(event, `template:${template.id}`)}>
                    <span className="drag-grip" aria-hidden="true">⠿</span><span><strong>{template.name}</strong><small>{template.question.type === "choice" ? "單選" : template.question.type === "noul" ? "是非" : "評分"} · 問題、分流與信心門檻副本</small></span>
                  </button>
                  <button type="button" className="add-sign" aria-label={`新增範本 ${template.name}`} title={`新增範本 ${template.name}`} onClick={() => handleAddAt(`template:${template.id}`, { x: 530, y: 260 })}>＋</button>
                  <button type="button" className="icon-button danger template-delete" aria-label={`刪除範本 ${template.name}`} onClick={() => void handleDeleteTemplate(template.id)}>×</button>
                </div>
              ))}
            </>}
          </section>
          <div className="palette__foot"><span className="status-dot" />本機推論 · 多語言模型</div>
        </aside>

        <section className="canvas-panel" aria-label="流程編輯區">
          <div className="canvas-toolbar"><div><strong>{selectedFlowName}</strong><span>{flow?.nodes.length ?? 0} 個節點 · {flow?.edges.length ?? 0} 條連線</span></div><span className={`validation-badge${issues.length > 0 ? " validation-badge--invalid" : dirty ? " validation-badge--dirty" : " validation-badge--valid"}`}>{issues.length > 0 ? `未完成 · ${issues.length}` : dirty ? "未儲存" : "可執行"}</span></div>
          {loading || flowTransitioning ? <div className="canvas-placeholder"><div className="spinner" /><span>{loading ? "載入流程…" : "處理流程…"}</span></div> : flow ? <FlowCanvas flow={flow} selectedNodeId={selectedNodeId} onSelectNode={setSelectedNodeId} onChange={onChangeFlow} onAddAt={handleAddAt} onNodeDrop={setSelectedNodeId} /> : <div className="canvas-placeholder"><strong>建立或選擇一條流程</strong><span>流程會在重新啟動後保留。</span></div>}
          <div className="validation-strip" aria-live="polite">
          {issues.length > 0 ? <><strong>流程尚未完成</strong><span>{issues.slice(0, 2).join("　")}{issues.length > 2 ? `　及其他 ${issues.length - 2} 項` : ""}</span></> : dirty ? <span>目前有未儲存變更；可依目前設定測試，儲存後才會保留。</span> : <span>分類與評分出口需連線；低於信心門檻時會採用指定選項並沿用其出口。</span>}
          </div>
        </section>

        <div className="right-rail">
          <Inspector flow={flow ?? EMPTY_FLOW} node={selectedNode} templates={templates} onChangeFlow={onChangeFlow} onDeleteNode={handleDeleteNode} onCreateTemplate={handleCreateTemplate} onValidityChange={setInspectorValid} />
          <section className="test-panel panel" aria-label="流程測試">
            <header className="panel__heading"><div><span className="eyebrow">本機推論</span><h2>測試流程</h2></div><span className="model-pill">Laya</span></header>
            <div className="test-mode-tabs" role="tablist" aria-label="測試方式">
              <button id="test-mode-single" type="button" role="tab" aria-selected={testMode === "single"} aria-controls="single-test-panel" className={testMode === "single" ? "is-active" : ""} onClick={() => setTestMode("single")} disabled={testing}>單次測試</button>
              <button id="test-mode-batch" type="button" role="tab" aria-selected={testMode === "batch"} aria-controls="batch-test-panel" className={testMode === "batch" ? "is-active" : ""} onClick={() => setTestMode("batch")} disabled={testing}>批次測試</button>
            </div>
            <div role="tabpanel" id="single-test-panel" aria-labelledby="test-mode-single" hidden={testMode !== "single"}>
              <div className="test-panel__body">
                <div className="input-toggle" role="group" aria-label="輸入格式"><button type="button" className={inputMode === "text" ? "is-active" : ""} onClick={() => setInputMode("text")} disabled={testing}>文字</button><button type="button" className={inputMode === "json" ? "is-active" : ""} onClick={() => setInputMode("json")} disabled={testing}>JSON</button></div>
                <label className="field"><span>{inputMode === "text" ? "測試文字" : "JSON 輸入"}</span><textarea rows={inputMode === "text" ? 2 : 4} value={testInput} onChange={(event) => setTestInput(event.target.value)} placeholder={inputMode === "text" ? "例如：打開風扇" : '{ "text": "打開風扇" }'} disabled={testing} /></label>
                <button type="button" className="button button--primary button--wide" onClick={() => void handleTest()} disabled={!readyToRun}>{testing ? "模型判斷中…" : "執行測試"}</button>
                {dirty && <p className="helper-copy">測試使用目前未儲存的設定；測試不會自動儲存流程。</p>}
                {!inspectorValid && <p className="form-error" role="alert">JSON 欄位尚未完成或格式不正確，修正後才能儲存與測試。</p>}
                {issues.length > 0 && <ul className="issue-list">{issues.slice(0, 3).map((issue) => <li key={issue}>{issue}</li>)}</ul>}
                {testError && <p className="form-error" role="alert">{testError}</p>}
                {result && <div className="test-result" aria-live="polite">
                  <div className="test-result__summary"><strong>測試結果</strong><span>{answerSummary(result)}</span></div>
                  <ol className="trace-list">
                    {result.trace.map((step, index) => (
                      <li key={`${step.nodeId}-${index}`}>
                        <div><strong>{step.label}</strong><span>{describeAnswer(step)}</span></div>
                        <small>分支：{step.branch} · 信心 {(step.confidence * 100).toFixed(2)}% · {step.durationMs} ms</small>
                        {(step.answer.type === "choice" || step.answer.type === "score") && <details><summary>查看機率</summary><ul>{Object.entries(step.answer.probabilities).map(([key, probability]) => <li key={key}><span>{key}</span><span>{(probability * 100).toFixed(1)}%</span></li>)}</ul></details>}
                      </li>
                    ))}
                  </ol>
                  <div className="result-output"><span>回傳 JSON</span><pre>{JSON.stringify(result.output, null, 2)}</pre></div>
                </div>}
              </div>
            </div>
            <BatchTestPanel key={flow?.id ?? "no-flow"} flow={flow} issues={issues} inspectorValid={inspectorValid} dirty={dirty} testing={testing} onTestingChange={setTesting} onDraftDirtyChange={setCaseDraftDirty} onSavingCasesChange={setSavingCases} flowBusy={flowTransitioning} hidden={testMode !== "batch"} />
          </section>
          <section className="api-card panel"><div className="api-card__heading"><span className="eyebrow">同網段呼叫</span><button type="button" className="button button--subtle button--small" disabled={!flow} onClick={() => void copyApiExample()}>{copied ? "已複製" : "複製 curl"}</button></div><pre className="api-card__curl" aria-label="curl 指令">{apiExample || "選擇流程後會顯示 curl 指令。"}</pre><small>POST · 只回傳流程設定的 JSON；不執行裝置操作。若無法自動複製，可手動選取上方指令。</small></section>
        </div>
      </div>
    </main>
  );
}

const EMPTY_FLOW: DecisionFlow = { id: "", name: "", nodes: [], edges: [], updatedAt: "" };

function PaletteBlock({ type, title, description, onAdd }: { type: Exclude<BlockType, `template:${string}`>; title: string; description: string; onAdd: (type: BlockType, position: { x: number; y: number }) => void }) {
  return <div className={`palette-block palette-block--${type}`}>
    <button type="button" draggable className="palette-block__drag" onDragStart={(event) => beginBlockDrag(event, type)}>
      <span className="drag-grip" aria-hidden="true">⠿</span><span className="palette-block__text"><strong>{title}</strong><small>{description}</small></span>
    </button><button type="button" className="add-sign" aria-label={`新增${title}`} title={`新增${title}`} onClick={() => onAdd(type, { x: 530, y: 260 })}>＋</button>
  </div>;
}

export default function App() {
  return <ReactFlowProvider><AppContent /></ReactFlowProvider>;
}
