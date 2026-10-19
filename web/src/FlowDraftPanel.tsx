import { useCallback, useEffect, useRef, useState } from "react";
import type { DecisionFlow, FlowDraft, FlowDraftChange, FlowDraftPreview, FlowHistoryEntry, FlowTestCase, FlowTestCaseResult, FlowTestRun, FlowTestSuite } from "../../decision-types";
import { applyFlowDraft, createFlowDraft, discardFlowDraft, getFlowDraft, listFlowDrafts, listFlowHistory, previewFlowDraft, restoreFlowHistory, runFlowDraftBatch, submitFlowDraft } from "./api";

type Props = {
  flow: DecisionFlow | null;
  blocked: boolean;
  adminAuthenticated: boolean;
  onPublish: (operation: () => Promise<{ flow: DecisionFlow; suite: FlowTestSuite }>) => Promise<void>;
};
const json = (value: unknown) => JSON.stringify(value ?? null, null, 2);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

function reviewSnapshot(preview: FlowDraftPreview): string {
  return JSON.stringify([
    preview.draft.id, preview.draft.revision, preview.draft.status,
    preview.currentFlow?.id, preview.currentFlowVersion, preview.currentSuite?.revision,
    preview.warnings, preview.draft.lastRun?.candidate, preview.draft.lastRun?.baseline,
  ]);
}

export function FlowDraftPanel({ flow, blocked, adminAuthenticated, onPublish }: Props) {
  const [drafts, setDrafts] = useState<FlowDraft[]>([]);
  const [draft, setDraft] = useState<FlowDraft | null>(null);
  const [preview, setPreview] = useState<FlowDraftPreview | null>(null);
  const [history, setHistory] = useState<FlowHistoryEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [acknowledgedReview, setAcknowledgedReview] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [restoreConfirm, setRestoreConfirm] = useState<{ id: string; snapshot: string } | null>(null);
  const [newName, setNewName] = useState("");
  const [newFlowDraft, setNewFlowDraft] = useState(false);
  const [showAllDrafts, setShowAllDrafts] = useState(false);
  const requestId = useRef(0);
  const transitionLocked = blocked || busy;
  const mutationsLocked = transitionLocked || !adminAuthenticated;
  const reviewKey = preview && draft?.id === preview.draft.id && draft.revision === preview.draft.revision
    ? reviewSnapshot(preview) : null;
  const ackWarnings = reviewKey !== null && acknowledgedReview === reviewKey;

  useEffect(() => {
    setAcknowledgedReview(null);
    setConfirm(null);
    setRestoreConfirm(null);
  }, [reviewKey, adminAuthenticated]);

  const refresh = useCallback(async (selectId?: string, published = false) => {
    const request = ++requestId.current;
    setBusy(true); setError("");
    try {
      const items = await listFlowDrafts(showAllDrafts ? undefined : flow?.id);
      if (request !== requestId.current) return;
      setDrafts(items);
      const selected = items.find((item) => item.id === (selectId ?? draft?.id)) ?? null;
      setDraft(selected); setPreview(null);
      if (selected) {
        const [nextPreview, nextHistory] = await Promise.all([previewFlowDraft(selected.id), selected.sourceFlowId && adminAuthenticated ? listFlowHistory(selected.sourceFlowId) : Promise.resolve([])]);
        if (request !== requestId.current) return;
        setPreview(nextPreview); setHistory(nextHistory);
      } else setHistory([]);
    } catch (reason) {
      if (request === requestId.current) setError(`${published ? "正式流程已更新，但草稿審查資訊無法重新整理：" : ""}${errorText(reason)}`);
    }
    finally { if (request === requestId.current) setBusy(false); }
  }, [adminAuthenticated, draft?.id, flow?.id, showAllDrafts]);

  useEffect(() => { void refresh(); return () => { requestId.current += 1; }; }, [flow?.id, showAllDrafts, adminAuthenticated]);

  const selectDraft = async (id: string) => {
    if (transitionLocked) return;
    if (!id) { setDraft(null); setPreview(null); setHistory([]); setNotice(""); setError(""); return; }
    const request = ++requestId.current;
    setBusy(true); setError(""); setNotice(""); setDraft(null); setPreview(null); setHistory([]);
    try {
      const selected = await getFlowDraft(id);
      if (request !== requestId.current) return;
      setDraft(selected);
      const [nextPreview, nextHistory] = await Promise.all([previewFlowDraft(id), selected.sourceFlowId && adminAuthenticated ? listFlowHistory(selected.sourceFlowId) : Promise.resolve([])]);
      if (request === requestId.current) { setPreview(nextPreview); setHistory(nextHistory); }
    } catch (reason) { if (request === requestId.current) setError(errorText(reason)); }
    finally { if (request === requestId.current) setBusy(false); }
  };
  const refreshSelected = async (value: FlowDraft) => {
    const request = ++requestId.current;
    const [next, nextPreview, nextHistory] = await Promise.all([
      listFlowDrafts(value.sourceFlowId === null || showAllDrafts ? undefined : flow?.id),
      previewFlowDraft(value.id),
      value.sourceFlowId && adminAuthenticated ? listFlowHistory(value.sourceFlowId) : Promise.resolve([]),
    ]);
    if (request !== requestId.current) return;
    setDrafts(next); setDraft(value); setPreview(nextPreview); setHistory(nextHistory);
  };

  const create = async () => {
    if (transitionLocked || !adminAuthenticated) return;
    setBusy(true); setError("");
    try {
      const isNewFlow = newFlowDraft;
      const created = await createFlowDraft(isNewFlow ? undefined : flow?.id, newName.trim() || undefined);
      if (isNewFlow) {
        setShowAllDrafts(true);
        setDraft(created); setPreview(null); setHistory([]);
      }
      setNewName("");
      await refreshSelected(created);
      setNotice("草稿已建立；尚未建立正式流程。");
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };

  const mutateDraft = async (action: (id: string, revision: string) => Promise<FlowDraft>, success: string) => {
    if (!draft || transitionLocked || !adminAuthenticated) return;
    setBusy(true); setError("");
    try { const updated = await action(draft.id, draft.revision); await refreshSelected(updated); setNotice(success); }
    catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };

  const runBatch = () => mutateDraft(runFlowDraftBatch, "批次測試完成，結果已更新。");
  const submit = () => mutateDraft(submitFlowDraft, "草稿已送交人工審查。");
  const discard = () => mutateDraft(discardFlowDraft, "草稿已捨棄；不會影響正式流程。");

  const apply = async () => {
    if (!draft || !preview || !reviewKey || confirm !== reviewKey || transitionLocked || !adminAuthenticated) return;
    if (preview.warnings.length > 0 && !ackWarnings) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await onPublish(async () => {
        const fresh = await previewFlowDraft(draft.id);
        if (draft.sourceFlowId && (!fresh.currentFlow || !fresh.currentFlowVersion || !fresh.currentSuite)) throw new Error("來源流程不存在或缺少最新版本資訊；無法覆寫。");
        setPreview(fresh);
        if (fresh.conflict || reviewSnapshot(fresh) !== confirm) {
          setDraft(fresh.draft); setConfirm(null); setAcknowledgedReview(null);
          throw new Error("正式流程、草稿或測試結果已變更。預覽已更新，請重新確認後再操作。");
        }
        const result = await applyFlowDraft(draft.id, fresh.draft.revision, ackWarnings);
        setDraft(result.draft);
        return result;
      });
      setNotice("草稿已套用至正式流程。"); setConfirm(null);
      await refresh(draft.id, true);
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };

  const restore = async (entry: FlowHistoryEntry) => {
    if (!draft?.sourceFlowId || !preview || !reviewKey || restoreConfirm?.id !== entry.id ||
      restoreConfirm.snapshot !== reviewKey || transitionLocked || !adminAuthenticated) return;
    const sourceFlowId = draft.sourceFlowId;
    setBusy(true); setError(""); setNotice("");
    try {
      await onPublish(async () => {
        const fresh = await previewFlowDraft(draft.id);
        if (entry.flowId !== sourceFlowId || fresh.currentFlow?.id !== sourceFlowId ||
          fresh.currentSuite?.flowId !== sourceFlowId || !fresh.currentFlowVersion) {
          throw new Error("歷史紀錄、來源流程或測試套件不一致，無法安全還原。");
        }
        setPreview(fresh);
        if (reviewSnapshot(fresh) !== restoreConfirm.snapshot) {
          setDraft(fresh.draft); setRestoreConfirm(null);
          throw new Error("正式流程或審查資訊已變更。請重新確認最新預覽後再還原。");
        }
        return restoreFlowHistory(sourceFlowId, entry.id, fresh.currentFlowVersion, fresh.currentSuite.revision);
      });
      setRestoreConfirm(null); setNotice("歷史版本已還原為新的正式版本。");
      await refresh(draft.id, true);
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };

  const canOverwrite = Boolean(draft && preview && draft.status === "review" && !preview.conflict && preview.issues.length === 0 && (draft.sourceFlowId ? Boolean(preview.currentFlow && preview.currentFlowVersion && preview.currentSuite) : preview.currentFlow === null));
  const run = draft?.lastRun;
  return <section className="flow-draft panel" aria-labelledby="flow-draft-title">
    <header className="panel__heading"><div><span className="eyebrow">人工審查</span><h2 id="flow-draft-title">流程草稿</h2></div><button type="button" className="button button--small" onClick={() => void refresh()} disabled={transitionLocked}>重新整理</button></header>
    <div className="flow-draft__body">
      {!adminAuthenticated && <p className="flow-draft__auth-note" role="status">登入管理員後可建立草稿、執行批次測試、送審、套用或還原；目前可檢視草稿與預覽。</p>}
      <p className="helper-copy">草稿與正式流程隔離；只有人工確認後才會建立或覆寫正式流程。</p>
      <div className="flow-draft__create"><label className="field"><span>新草稿名稱（選填）</span><input value={newName} maxLength={120} onChange={(event) => setNewName(event.target.value)} disabled={transitionLocked} /></label><button type="button" className="button button--subtle" onClick={() => void create()} disabled={mutationsLocked}>＋ 建立草稿</button></div>
      <label className="check-row"><input type="checkbox" checked={newFlowDraft} onChange={(event) => setNewFlowDraft(event.target.checked)} disabled={transitionLocked} />建立全新流程草稿（不連結目前流程）</label>
      <label className="check-row"><input type="checkbox" checked={showAllDrafts} onChange={(event) => { setShowAllDrafts(event.target.checked); setDraft(null); setPreview(null); setHistory([]); }} disabled={transitionLocked} />顯示所有流程草稿（含新流程）</label>
      {busy && <p className="muted" role="status">載入或處理中…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="flow-draft__notice" role="status">{notice}</p>}
      {drafts.length === 0 && !busy ? <div className="batch-test__empty"><strong>尚無流程草稿</strong><span>建立草稿後，可比較候選流程與基準測試結果。</span></div> : <label className="field"><span>草稿</span><select value={draft?.id ?? ""} onChange={(event) => void selectDraft(event.target.value)} disabled={transitionLocked}><option value="">選擇草稿…</option>{drafts.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.status}</option>)}</select></label>}
      {draft && <>
        <div className="flow-draft__meta"><strong>{draft.name}</strong><span>狀態：{draft.status}</span><span>來源：{draft.sourceFlowId ? preview?.currentFlow?.name ?? draft.sourceFlowId : "新流程"}</span><span>修訂：{draft.revision}</span></div>
        {preview?.conflict && <p className="form-error" role="alert">來源流程或測試案例已變更，草稿目前有衝突；不可套用。</p>}
        {preview?.issues.map((issue) => <p className="form-error" key={issue}>{issue}</p>)}
        {preview && <details open><summary>預覽變更（{preview.changes.length + preview.caseChanges.length} 項）</summary><ChangeList title="流程欄位" changes={preview.changes} /><ChangeList title="測試案例" changes={preview.caseChanges} />{preview.warnings.map((warning) => <p className="flow-draft__warning" key={warning}>{warning}</p>)}</details>}
        <details><summary>候選流程內容</summary><pre>{json(draft.flow)}</pre></details>
        {run ? <><h3>基準與候選批次結果</h3><RunComparison baseline={run.baseline} candidate={run.candidate} traces={run.traces} baselineTraces={run.baselineTraces} cases={draft.cases} /></> : <p className="batch-test__empty">尚未執行草稿批次測試。</p>}
        <div className="flow-draft__actions"><button type="button" className="button" onClick={() => void runBatch()} disabled={mutationsLocked || draft.status === "applied" || draft.status === "discarded"}>執行批次測試</button><button type="button" className="button" onClick={() => void submit()} disabled={mutationsLocked || draft.status !== "draft"}>送交審查</button><button type="button" className="button button--danger" onClick={() => void discard()} disabled={mutationsLocked || draft.status === "applied" || draft.status === "discarded"}>捨棄草稿</button></div>
        {canOverwrite && <div className="flow-draft__apply">
          <h3>{draft.sourceFlowId ? "正式套用（人工操作）" : "建立正式流程（人工操作）"}</h3>
          <p>{draft.sourceFlowId ? `目標：覆寫「${preview?.currentFlow?.name ?? draft.name}」；正式流程 ID 與名稱會保留。` : `將建立新的正式流程「${draft.flow.name}」；草稿本身不會成為正式流程選項。`}此動作不可用草稿強制覆寫衝突版本。</p>
          {preview?.warnings.map((warning) => <p className="flow-draft__warning" key={warning}>{warning}</p>)}
          {Boolean(preview?.warnings.length) && <label className="check-row"><input type="checkbox" checked={ackWarnings} onChange={(event) => setAcknowledgedReview(event.target.checked ? reviewKey : null)} disabled={transitionLocked} />我已閱讀並接受以上所有警告</label>}
          <button type="button" className="button button--primary" onClick={() => setConfirm(reviewKey)} disabled={mutationsLocked || !reviewKey || (Boolean(preview?.warnings.length) && !ackWarnings)}>{draft.sourceFlowId ? "確認覆寫正式流程…" : "建立並發布正式流程…"}</button>
        </div>}
        {draft.sourceFlowId && <section className="flow-draft__history">
          <h3>正式流程歷史與還原</h3>
          {!adminAuthenticated ? <p className="muted">登入管理員後可檢視與還原歷史版本。</p> : history.length === 0 ? <p className="muted">尚無歷史版本。</p> : history.map((entry) => <article key={entry.id}>
            <strong>{entry.createdAt} · {entry.reason}</strong>
            <details><summary>檢視歷史內容</summary><pre>{json({ flow: entry.flow, suite: entry.suite })}</pre></details>
            <button type="button" className="button button--small" onClick={() => reviewKey && setRestoreConfirm({ id: entry.id, snapshot: reviewKey })} disabled={mutationsLocked || !reviewKey}>還原此版本…</button>
            {restoreConfirm?.id === entry.id && restoreConfirm.snapshot === reviewKey && <div className="flow-draft__restore-confirm" role="group" aria-label={`確認還原 ${entry.flow.name}`}>
              <p>將以新版本還原「{entry.flow.name}」（ID：{entry.flowId}），並替換目前流程及案例。確認目標版本：{preview?.currentFlowVersion ?? "未知"}；案例 revision：{preview?.currentSuite?.revision ?? "未知"}。</p>
              <button type="button" className="button button--small" onClick={() => setRestoreConfirm(null)} disabled={transitionLocked}>取消</button>
              <button type="button" className="button button--primary button--small" autoFocus onClick={() => void restore(entry)} disabled={mutationsLocked}>確認還原 {entry.flow.name}</button>
            </div>}
          </article>)}
        </section>}
      </>}
    </div>
    {confirm !== null && confirm === reviewKey && <div className="flow-draft__confirm" role="alertdialog" aria-modal="true" aria-labelledby="draft-confirm-title" tabIndex={-1} onKeyDown={(event) => { if (event.key === "Escape" && !busy) setConfirm(null); }}><div><h3 id="draft-confirm-title">{draft?.sourceFlowId ? "確認覆寫正式流程" : "確認建立正式流程"}</h3><p>目標：{preview?.currentFlow?.name ?? draft?.flow.name}（ID：{preview?.currentFlow?.id ?? "將由系統指派"}）</p><p>預覽版本：{preview?.currentFlowVersion ?? "新流程"}；測試套件 revision：{preview?.currentSuite?.revision ?? "無"}；草稿修訂：{draft?.revision}</p><p>請確認此為預期目標。若版本變更，操作會以衝突停止。</p><div className="flow-draft__actions"><button type="button" className="button" autoFocus onClick={() => setConfirm(null)} disabled={busy}>取消</button><button type="button" className="button button--primary" onClick={() => void apply()} disabled={mutationsLocked}>{draft?.sourceFlowId ? "確認並覆寫" : "確認建立正式流程"}</button></div></div></div>}
  </section>;
}

function ChangeList({ title, changes }: { title: string; changes: FlowDraftChange[] }) {
  return <section className="flow-draft__changes"><h3>{title}</h3>{changes.length ? changes.map((change) => <details key={`${title}-${change.path}`}><summary>{change.path}</summary><div className="flow-draft__comparison"><div><span>原值</span><pre>{json(change.before)}</pre></div><div><span>候選值</span><pre>{json(change.after)}</pre></div></div></details>) : <p className="muted">沒有差異。</p>}</section>;
}

function RunComparison({ baseline, candidate, traces, baselineTraces, cases }: { baseline: FlowTestRun | null; candidate: FlowTestRun; traces: Record<string, unknown>; baselineTraces: Record<string, unknown>; cases: FlowTestCase[] }) {
  const resultFor = (run: FlowTestRun | null, id: string): FlowTestCaseResult | undefined => run?.results.find((result) => result.caseId === id);
  return <ol className="flow-draft__runs">{cases.map((testCase) => <li key={testCase.id}><strong>{testCase.name}</strong><p className="flow-draft__case-input">輸入：{json(testCase.input)}</p><div className="flow-draft__comparison"><ResultCell title="基準" result={resultFor(baseline, testCase.id)} trace={baselineTraces[testCase.id]} /><ResultCell title="候選" result={resultFor(candidate, testCase.id)} trace={traces[testCase.id]} /></div></li>)}</ol>;
}

function ResultCell({ title, result, trace }: { title: string; result?: FlowTestCaseResult; trace: unknown }) {
  return <div><span>{title} · {result?.status ?? "無結果"}</span>{result?.error && <p className="form-error">{result.error}</p>}<pre>{json(result?.actualOutput)}</pre>{trace !== undefined && <details><summary>檢視追蹤</summary><pre>{json(trace)}</pre></details>}</div>;
}
