import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { getDefaultLowConfidenceBranch, validateFlow } from "../../decision-engine";
import type { DecisionFlow, DecisionFlowNode, DecisionTemplate, FlowNode, FlowTestResult, FlowTestSuite } from "../../decision-types";
import { DEFAULT_MIN_CONFIDENCE } from "../../decision-types";
import {
  checkAdminToken,
  choiceQuestion,
  clearAdminToken,
  createFlow,
  createTemplate,
  deleteFlow,
  deleteTemplate,
  getAdminToken,
  listFlows,
  listTemplates,
  saveFlow,
  setAdminToken,
  testFlow,
  validateFlow as validateSavedFlow,
} from "./api";
import { FlowDraftPanel } from "./FlowDraftPanel";
import { createId } from "./id";
import { FlowCanvas, beginBlockDrag } from "./FlowCanvas";
import { Inspector } from "./Inspector";
import { BatchTestPanel } from "./BatchTestPanel";
import { removeFlowNodes } from "./flow-editing";

type BlockType = "choice" | "noul" | "score" | "end" | `template:${string}`;
type InputMode = "text" | "json";
type Workspace = "design" | "test" | "drafts";

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

  // Keep the fallback inside a modal dialog; elements outside it are inert.
  const activeElement = document.activeElement;
  const activeDialog = activeElement instanceof HTMLElement ? activeElement.closest("dialog") : null;
  const container = activeDialog?.open ? activeDialog : document.body;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  textarea.style.opacity = "0";
  container.append(textarea);
  let copied = false;
  try {
    textarea.focus({ preventScroll: true });
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
  const [flowOptionsError, setFlowOptionsError] = useState("");
  const [inputMode, setInputMode] = useState<InputMode>("text");
  const [testInput, setTestInput] = useState("打開風扇");
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState("");
  const [result, setResult] = useState<FlowTestResult | null>(null);
  const [testMode, setTestMode] = useState<"single" | "batch">("single");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [inspectorValid, setInspectorValid] = useState(true);
  const [caseDraftDirty, setCaseDraftDirty] = useState(false);
  const [savingCases, setSavingCases] = useState(false);
  const [adminToken, setAdminTokenState] = useState(() => getAdminToken() !== null);
  const [loginToken, setLoginToken] = useState("");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [batchMount, setBatchMount] = useState(0);
  const [publishedSuite, setPublishedSuite] = useState<FlowTestSuite | null>(null);
  const publicationInFlight = useRef(false);
  const [workspace, setWorkspace] = useState<Workspace>("design");
  const [designPanel, setDesignPanel] = useState<"palette" | "inspector" | null>(null);
  const apiDialog = useRef<HTMLDialogElement>(null);
  const flowDialog = useRef<HTMLDialogElement>(null);
  const authMenu = useRef<HTMLDetailsElement>(null);
  const adminTokenInput = useRef<HTMLInputElement>(null);
  const requestAdminLogin = useCallback(() => {
    const menu = authMenu.current;
    if (!menu) return;
    menu.open = true;
    menu.scrollIntoView({ block: "start" });
    requestAnimationFrame(() => {
      const input = adminTokenInput.current;
      if (!input) return;
      input.scrollIntoView({ block: "center", inline: "nearest" });
      input.focus({ preventScroll: true });
    });
  }, []);
  const selectNode = useCallback((id: string | null) => {
    setSelectedNodeId(id);
    setDesignPanel(id ? "inspector" : null);
  }, []);
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

  const loginAdmin = async () => {
    if (!loginToken || authBusy) return;
    setAuthBusy(true); setAuthError("");
    try {
      await checkAdminToken(loginToken);
      setAdminToken(loginToken);
      setAdminTokenState(true);
      setLoginToken("");
    } catch (error) { setAuthError(error instanceof Error ? error.message : String(error)); }
    finally { setAuthBusy(false); }
  };

  const logoutAdmin = () => {
    clearAdminToken();
    setAdminTokenState(false);
    setAuthError("");
  };

  const handleDraftPublish = async (operation: () => Promise<{ flow: DecisionFlow; suite: FlowTestSuite }>): Promise<void> => {
    if (publicationInFlight.current) throw new Error("正式流程更新正在進行中。");
    publicationInFlight.current = true;
    setFlowTransitioning(true);
    setPageError("");
    try {
      const { flow: publishedFlow, suite } = await operation();
      setFlows((current) => current.some((candidate) => candidate.id === publishedFlow.id)
        ? current.map((candidate) => candidate.id === publishedFlow.id ? publishedFlow : candidate)
        : [...current, publishedFlow]);
      setCurrentFlow(publishedFlow);
      setPublishedSuite(suite);
      setDirty(false);
      setCaseDraftDirty(false);
      setIssues(validateFlow(publishedFlow));
      setSelectedNodeId(null);
      setDesignPanel(null);
      setInspectorValid(true);
      clearTest();
      setBatchMount((value) => value + 1);
    } finally {
      publicationInFlight.current = false;
      setFlowTransitioning(false);
    }
  };

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
    if (publicationInFlight.current) return;
    setCurrentFlow(updated);
    setDirty(true);
    setIssues(validateFlow(updated));
    clearTest();
  }, [clearTest, setCurrentFlow]);

  const selectedNode = flowTransitioning ? null : flow?.nodes.find((node) => node.id === selectedNodeId) ?? null;

  async function selectFlow(id: string): Promise<void> {
    if (flow?.id === id || loading || saving || savingCases || flowTransitioning || publicationInFlight.current) return;
    if ((dirty || caseDraftDirty) && !window.confirm("目前有尚未儲存的流程或測試案例變更；捨棄並切換流程？")) return;
    clearTest();
    setLoading(true);
    setFlowTransitioning(true);
    setPageError("");
    setSelectedNodeId(null);
    setDesignPanel(null);
    setInspectorValid(true);
    try {
      const [next, validation] = await Promise.all([listFlows().then((all) => all.find((candidate) => candidate.id === id)).then((candidate) => {
        if (!candidate) throw new Error("找不到指定流程。");
        return candidate;
      }), validateSavedFlow(id)]);
      setCurrentFlow(next);
      setPublishedSuite(null);
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
    if (newFlowName.trim().length === 0 || loading || saving || savingCases || flowTransitioning || publicationInFlight.current) return;
    if ((dirty || caseDraftDirty) && !window.confirm("目前有尚未儲存的流程或測試案例變更；捨棄並建立新流程？")) return;
    clearTest();
    setFlowTransitioning(true);
    setSelectedNodeId(null);
    setSaving(true);
    setPageError("");
    setFlowOptionsError("");
    try {
      const created = await createFlow(newFlowName.trim());
      setFlows((current) => [...current, created]);
      setCurrentFlow(created);
      setPublishedSuite(null);
      setNewFlowName("");
      setSelectedNodeId(null);
      setInspectorValid(true);
      setCaseDraftDirty(false);
      setDirty(false);
      setIssues(validateFlow(created));
      setWorkspace("design");
      setDesignPanel(null);
      flowDialog.current?.close();
    } catch (error) {
      setFlowOptionsError(error instanceof Error ? error.message : String(error));
    } finally {
      setFlowTransitioning(false);
      setSaving(false);
    }
  }

  async function handleSave(): Promise<void> {
    if (!flow || !inspectorValid || loading || saving || savingCases || flowTransitioning || publicationInFlight.current) return;
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
    if (!flow || flows.length < 2 || loading || saving || savingCases || flowTransitioning || publicationInFlight.current || !window.confirm(`確定刪除「${flow.name}」及其測試案例？此動作無法復原。`)) return;
    clearTest();
    setFlowTransitioning(true);
    setSelectedNodeId(null);
    setPageError("");
    setFlowOptionsError("");
    setSaving(true);
    try {
      await deleteFlow(flow.id);
      const remaining = flows.filter((candidate) => candidate.id !== flow.id);
      setFlows(remaining);
      const next = remaining[0] ?? null;
      setCurrentFlow(next);
      setIssues(next ? validateFlow(next) : []);
      setPublishedSuite(null);
      setCaseDraftDirty(false);
      setDirty(false);
      setSelectedNodeId(null);
      setInspectorValid(true);
      setWorkspace("design");
      setDesignPanel(null);
      flowDialog.current?.close();
    } catch (error) {
      setFlowOptionsError(error instanceof Error ? error.message : String(error));
    } finally {
      setFlowTransitioning(false);
      setSaving(false);
    }
  }

  function handleAddAt(type: BlockType, position: { x: number; y: number }): void {
    if (!flow || loading || flowTransitioning || publicationInFlight.current) return;
    const node = createNode(type, position, templates);
    if (!node) return;
    const next = { ...flow, nodes: [...flow.nodes, node] };
    onChangeFlow(next);
    selectNode(node.id);
  }

  function handleDeleteNode(nodeId: string): void {
    if (!flow || flowTransitioning || publicationInFlight.current) return;
    const updated = removeFlowNodes(flow, new Set([nodeId]));
    onChangeFlow(updated);
    selectNode(null);
  }

  async function handleCreateTemplate(template: DecisionTemplate): Promise<void> {
    if (publicationInFlight.current) return;
    const saved = await createTemplate(template);
    setTemplates((current) => [...current, saved]);
  }

  async function handleDeleteTemplate(id: string): Promise<void> {
    if (publicationInFlight.current || flowTransitioning || !window.confirm("刪除此積木範本？已放入流程的節點不受影響。")) return;
    try {
      await deleteTemplate(id);
      setTemplates((current) => current.filter((template) => template.id !== id));
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleTest(): Promise<void> {
    if (!flow || loading || saving || testing || flowTransitioning || publicationInFlight.current || issues.length > 0 || !inspectorValid) return;
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
    setCopyError("");
    try {
      await copyTextToClipboard(apiExample);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch (error) {
      setCopied(false);
      setCopyError(error instanceof Error ? error.message : "無法自動複製。請手動選取下方 curl 指令。");
    }
  }

  const readyToRun = Boolean(flow) && !loading && !saving && !flowTransitioning && !publicationInFlight.current && issues.length === 0 && inspectorValid && !testing;
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
          <button type="button" className="button button--subtle" onClick={() => { setFlowOptionsError(""); flowDialog.current?.showModal(); }} disabled={loading || saving || savingCases || flowTransitioning}>流程選項</button>
        </div>
        <div className="topbar__actions">
          <span className={`save-state${dirty ? " is-dirty" : ""}`} aria-live="polite">{saving ? "儲存中…" : dirty ? "未儲存" : "已儲存"}</span>
          <button type="button" className="button button--primary" onClick={() => void handleSave()} disabled={!flow || !dirty || loading || saving || savingCases || flowTransitioning || !inspectorValid}>{saving ? "儲存中…" : "儲存流程"}</button>
        </div>
        <details ref={authMenu} className="auth-menu">
          <summary>{adminToken ? "管理員已登入" : "管理員登入"}</summary>
          <div className="admin-auth" aria-label="管理員驗證">
            {adminToken ? <button type="button" className="button" onClick={logoutAdmin}>登出管理員</button> : <form onSubmit={(event) => { event.preventDefault(); void loginAdmin(); }}>
              <label className="sr-only" htmlFor="admin-token">管理員權杖</label>
              <input ref={adminTokenInput} id="admin-token" type="password" autoComplete="current-password" value={loginToken} onChange={(event) => setLoginToken(event.target.value)} placeholder="管理員權杖" aria-describedby={authError ? "admin-auth-error" : undefined} />
              <button type="submit" className="button" disabled={authBusy || loginToken.length === 0}>{authBusy ? "驗證中…" : "登入"}</button>
            </form>}
            {authError && <span id="admin-auth-error" className="form-error" role="alert">{authError}</span>}
          </div>
        </details>
      </header>

      <nav className="workspace-nav" aria-label="工作區">
        <div className="workspace-nav__items">
          {([["design", "流程設計"], ["test", "測試"], ["drafts", "草稿"]] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={workspace === key} aria-controls={`workspace-${key}`} onClick={() => setWorkspace(key)} disabled={flowTransitioning}>{label}</button>)}
        </div>
        <button type="button" className="button" onClick={() => apiDialog.current?.showModal()} disabled={!flow || flowTransitioning}>API 呼叫</button>
      </nav>
      {pageError && <div className="alert-banner" role="alert"><span>{pageError}</span><button type="button" className="icon-button" aria-label="關閉錯誤訊息" onClick={() => setPageError("")}>×</button></div>}

      <div id="workspace-design" className="workspace" data-panel={designPanel ?? ""} hidden={workspace !== "design"}>
        <div className="design-tools">
          <button type="button" className="button" aria-expanded={designPanel === "palette"} aria-controls="design-palette" onClick={() => setDesignPanel(designPanel === "palette" ? null : "palette")}>積木與範本</button>
          <button type="button" className="button" aria-expanded={designPanel === "inspector"} aria-controls="design-inspector" onClick={() => setDesignPanel(designPanel === "inspector" ? null : "inspector")}>節點設定</button>
        </div>
        <aside id="design-palette" className="palette panel" aria-label="積木面板">
          <header className="panel__heading"><h2>積木與範本</h2><button type="button" className="icon-button design-panel-close" aria-label="關閉積木面板" onClick={() => setDesignPanel(null)}>×</button></header>
          <p className="panel__hint">拖曳到畫布或按「＋」新增。</p>
          <section className="palette__section"><h3>基本決策</h3>
            <PaletteBlock type="choice" title="單選分類" description="多個文字選項" onAdd={handleAddAt} disabled={flowTransitioning} />
            <PaletteBlock type="noul" title="是／否判斷" description="依 P(true) 門檻分流" onAdd={handleAddAt} disabled={flowTransitioning} />
            <PaletteBlock type="score" title="程度評分" description="以數值切分點分流" onAdd={handleAddAt} disabled={flowTransitioning} />
          </section>
          <section className="palette__section"><h3>輸出</h3>
            <PaletteBlock type="end" title="回傳 JSON" description="設定固定值或決策結果" onAdd={handleAddAt} disabled={flowTransitioning} />
          </section>
          <details className="palette__section palette__templates" open><summary>我的積木範本（{templates.length}）</summary>
            {templates.length === 0 ? <p className="muted small-copy">選取決策節點後，可儲存為範本。</p> : <>
              <p className="muted small-copy">加入範本會建立獨立副本。</p>
              {templates.map((template) => (
                <div className="template-row" key={template.id}>
                  <button type="button" className="template-row__add" draggable={!flowTransitioning} disabled={flowTransitioning} onDragStart={(event) => beginBlockDrag(event, `template:${template.id}`)}>
                    <span className="drag-grip" aria-hidden="true">⠿</span><span><strong>{template.name}</strong><small>{template.question.type === "choice" ? "單選" : template.question.type === "noul" ? "是非" : "評分"} · 問題、分流與信心門檻副本</small></span>
                  </button>
                  <button type="button" className="add-sign" aria-label={`新增範本 ${template.name}`} title={`新增範本 ${template.name}`} onClick={() => handleAddAt(`template:${template.id}`, { x: 530, y: 260 })} disabled={flowTransitioning}>＋</button>
                  <button type="button" className="icon-button danger template-delete" aria-label={`刪除範本 ${template.name}`} onClick={() => void handleDeleteTemplate(template.id)} disabled={flowTransitioning}>×</button>
                </div>
              ))}
            </>}
          </details>
          <div className="palette__foot"><span className="status-dot" />本機推論 · 多語言模型</div>
        </aside>

        <section className="canvas-panel" aria-label="流程編輯區">
          <div className="canvas-toolbar"><div><strong>{selectedFlowName}</strong><span>{flow?.nodes.length ?? 0} 個節點 · {flow?.edges.length ?? 0} 條連線</span></div><span className={`validation-badge${issues.length > 0 ? " validation-badge--invalid" : dirty ? " validation-badge--dirty" : " validation-badge--valid"}`}>{issues.length > 0 ? `未完成 · ${issues.length}` : dirty ? "未儲存" : "可執行"}</span></div>
          {loading || flowTransitioning ? <div className="canvas-placeholder"><div className="spinner" /><span>{loading ? "載入流程…" : "處理流程…"}</span></div> : flow ? <FlowCanvas flow={flow} selectedNodeId={selectedNodeId} active={workspace === "design"} onSelectNode={selectNode} onChange={onChangeFlow} onAddAt={handleAddAt} onNodeDrop={selectNode} /> : <div className="canvas-placeholder"><strong>建立或選擇一條流程</strong><span>流程會在重新啟動後保留。</span></div>}
          <div className="validation-strip" aria-live="polite">
            {issues.length > 0 ? <><strong>流程尚未完成</strong><span>{issues.slice(0, 2).join("　")}{issues.length > 2 ? `　及其他 ${issues.length - 2} 項` : ""}</span></> : dirty ? <span>目前有未儲存變更；可依目前設定測試，儲存後才會保留。</span> : <span>所有必要出口皆已連線，可切換至「測試」驗證輸出。</span>}
          </div>
        </section>
        <div id="design-inspector" className="design-inspector">
          <button type="button" className="button design-panel-close" onClick={() => setDesignPanel(null)}>返回畫布</button>
          <Inspector flow={flow ?? EMPTY_FLOW} node={selectedNode} templates={templates} onChangeFlow={onChangeFlow} onDeleteNode={handleDeleteNode} onCreateTemplate={handleCreateTemplate} onValidityChange={setInspectorValid} />
        </div>
      </div>

      <section id="workspace-test" className="work-area test-workspace" aria-label="流程測試" hidden={workspace !== "test"}>
        <header className="work-area__heading"><div><h1>測試流程</h1><p>{selectedFlowName} · {dirty ? "使用畫布上未儲存的版本" : "使用目前流程設定"}</p></div><span className="model-pill">Laya 本機推論</span></header>
        <div className="test-mode-tabs" role="tablist" aria-label="測試方式">
          <button id="test-mode-single" type="button" role="tab" aria-selected={testMode === "single"} aria-controls="single-test-panel" className={testMode === "single" ? "is-active" : ""} onClick={() => setTestMode("single")} disabled={testing || flowTransitioning}>單次測試</button>
          <button id="test-mode-batch" type="button" role="tab" aria-selected={testMode === "batch"} aria-controls="batch-test-panel" className={testMode === "batch" ? "is-active" : ""} onClick={() => setTestMode("batch")} disabled={testing || flowTransitioning}>批次測試</button>
        </div>
        <div role="tabpanel" id="single-test-panel" aria-labelledby="test-mode-single" hidden={testMode !== "single"}>
          <div className="single-test-layout">
            <section className="test-input panel">
              <h2>測試輸入</h2>
              <div className="input-toggle" role="group" aria-label="輸入格式"><button type="button" className={inputMode === "text" ? "is-active" : ""} onClick={() => setInputMode("text")} disabled={testing || flowTransitioning}>文字</button><button type="button" className={inputMode === "json" ? "is-active" : ""} onClick={() => setInputMode("json")} disabled={testing || flowTransitioning}>JSON</button></div>
              <label className="field"><span>{inputMode === "text" ? "測試文字" : "JSON 輸入"}</span><textarea rows={6} value={testInput} onChange={(event) => setTestInput(event.target.value)} placeholder={inputMode === "text" ? "例如：打開風扇" : '{ "text": "打開風扇" }'} disabled={testing || flowTransitioning} /></label>
              <button type="button" className="button button--primary button--wide" onClick={() => void handleTest()} disabled={!readyToRun}>{testing ? "模型判斷中…" : "執行測試"}</button>
              <p className="helper-copy">只回傳判斷結果，不操作裝置，也不會自動儲存流程。</p>
              {!inspectorValid && <p className="form-error" role="alert">節點欄位尚未完成或格式不正確，請回「流程設計」修正。</p>}
              {issues.length > 0 && <ul className="issue-list">{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
              {testError && <p className="form-error" role="alert">{testError}</p>}
            </section>
            <section className="test-result panel" aria-live="polite">
              <div className="test-result__summary"><h2>執行結果</h2><span>{result ? answerSummary(result) : testing ? "模型判斷中…" : "尚未執行"}</span></div>
              {result ? <>
                <div className="result-output"><h3>回傳 JSON</h3><pre>{JSON.stringify(result.output, null, 2)}</pre></div>
                <h3>決策追蹤</h3>
                <ol className="trace-list">
                  {result.trace.map((step, index) => (
                    <li key={`${step.nodeId}-${index}`}>
                      <div><strong>{step.label}</strong><span>{describeAnswer(step)}</span></div>
                      <small>分支：{step.branch} · 信心 {(step.confidence * 100).toFixed(2)}% · {step.durationMs} ms</small>
                      {(step.answer.type === "choice" || step.answer.type === "score") && <details><summary>查看機率</summary><ul>{Object.entries(step.answer.probabilities).map(([key, probability]) => <li key={key}><span>{key}</span><span>{(probability * 100).toFixed(1)}%</span></li>)}</ul></details>}
                    </li>
                  ))}
                </ol>
              </> : <p className="muted">執行後會顯示輸出 JSON、經過的節點、分支與信心值。</p>}
            </section>
          </div>
        </div>
        <BatchTestPanel key={`${flow?.id ?? "no-flow"}-${batchMount}`} flow={flow} publishedSuite={publishedSuite} issues={issues} inspectorValid={inspectorValid} dirty={dirty} testing={testing} onTestingChange={setTesting} onDraftDirtyChange={setCaseDraftDirty} onSavingCasesChange={setSavingCases} flowBusy={flowTransitioning} hidden={testMode !== "batch"} />
      </section>

      <div id="workspace-drafts" className="work-area draft-workspace" hidden={workspace !== "drafts"}>
        <FlowDraftPanel flow={flow} blocked={dirty || caseDraftDirty || testing || saving || savingCases || flowTransitioning || loading || !inspectorValid} adminAuthenticated={adminToken} onRequestAdminLogin={requestAdminLogin} onPublish={handleDraftPublish} />
      </div>

      <dialog ref={apiDialog} className="api-drawer" aria-labelledby="api-title" onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
        <section className="api-drawer__content">
          <header className="panel__heading"><h2 id="api-title">API 呼叫</h2><button type="button" className="button" autoFocus onClick={() => apiDialog.current?.close()}>關閉</button></header>
          <p>{selectedFlowName}</p>
          <p className="helper-copy">呼叫使用已儲存的正式流程。只回傳設定的 JSON，不操作裝置。</p>
          {dirty && <p className="form-error">畫布有未儲存變更；請先儲存，API 才會使用新設定。</p>}
          <pre className="api-card__curl" aria-label="curl 指令">{apiExample || "選擇流程後會顯示 curl 指令。"}</pre>
          <button type="button" className="button button--primary" disabled={!flow} onClick={() => void copyApiExample()}>{copied ? "已複製" : "複製 curl"}</button>
          {copyError && <p className="form-error" role="alert">{copyError}</p>}
          <p className="helper-copy">若無法自動複製，可手動選取上方指令。不要在呼叫中放入管理員憑證。</p>
        </section>
      </dialog>
      <dialog ref={flowDialog} className="flow-options" aria-labelledby="flow-options-title" onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
        <section>
          <header className="panel__heading"><h2 id="flow-options-title">流程選項</h2><button type="button" className="button" onClick={() => flowDialog.current?.close()}>關閉</button></header>
          {flowOptionsError && <p className="form-error" role="alert">{flowOptionsError}</p>}
          <form onSubmit={(event) => { event.preventDefault(); void handleCreateFlow(); }}>
            <label className="field"><span>新流程名稱</span><input autoFocus maxLength={120} value={newFlowName} onChange={(event) => setNewFlowName(event.target.value)} disabled={loading || saving || savingCases || flowTransitioning} /></label>
            <button type="submit" className="button button--primary" disabled={loading || saving || savingCases || flowTransitioning || newFlowName.trim().length === 0}>＋ 建立流程</button>
          </form>
          <p className="helper-copy">目前流程：{selectedFlowName}</p>
          <button type="button" className="button button--danger" onClick={() => void handleDeleteFlow()} disabled={!flow || flows.length < 2 || loading || saving || savingCases || flowTransitioning}>刪除目前流程</button>
        </section>
      </dialog>
    </main>
  );
}

const EMPTY_FLOW: DecisionFlow = { id: "", name: "", nodes: [], edges: [], updatedAt: "" };

function PaletteBlock({ type, title, description, onAdd, disabled = false }: { type: Exclude<BlockType, `template:${string}`>; title: string; description: string; onAdd: (type: BlockType, position: { x: number; y: number }) => void; disabled?: boolean }) {
  return <div className={`palette-block palette-block--${type}`}>
    <button type="button" draggable={!disabled} disabled={disabled} className="palette-block__drag" onDragStart={(event) => beginBlockDrag(event, type)}>
      <span className="drag-grip" aria-hidden="true">⠿</span><span className="palette-block__text"><strong>{title}</strong><small>{description}</small></span>
    </button><button type="button" className="add-sign" aria-label={`新增${title}`} title={`新增${title}`} onClick={() => onAdd(type, { x: 530, y: 260 })} disabled={disabled}>＋</button>
  </div>;
}

export default function App() {
  return <ReactFlowProvider><AppContent /></ReactFlowProvider>;
}
