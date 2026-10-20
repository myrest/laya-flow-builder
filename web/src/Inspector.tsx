import { useEffect, useState } from "react";
import type { Question } from "@receptron/laya";
import { getAncestorDecisions, getBranchPorts, getDefaultLowConfidenceBranch } from "../../decision-engine";
import type { DecisionFlow, DecisionFlowNode, DecisionTemplate, EndFlowNode, FlowNode, JsonValue, OutputValue } from "../../decision-types";
import { MAX_INPUT_NODE_REFS } from "../../decision-types";
import { createId } from "./id";

interface InspectorProps {
  flow: DecisionFlow;
  node: FlowNode | null;
  templates: DecisionTemplate[];
  onChangeFlow: (flow: DecisionFlow) => void;
  onDeleteNode: (nodeId: string) => void;
  onCreateTemplate: (template: DecisionTemplate) => Promise<void>;
  onValidityChange: (valid: boolean) => void;
}

function getText(question: Question): string {
  return typeof question.instructions === "string" ? question.instructions : JSON.stringify(question.instructions, null, 2);
}

function makeQuestion(type: Question["type"], instructions: string): Question {
  if (type === "noul") return { type, instructions, criteria: { true: "符合", false: "不符合" } };
  if (type === "score") return { type, instructions, criteria: ["一般", "稍微緊急", "緊急", "非常緊急"] };
  return { type, instructions, criteria: { yes: "符合", no: "不符合", other: "其他／無法判斷" } };
}

function withLabel(node: FlowNode, label: string): FlowNode {
  if (node.type === "start") return { ...node, data: { ...node.data, label } };
  if (node.type === "end") return { ...node, data: { ...node.data, label } };
  return { ...node, data: { ...node.data, label } };
}

function referenceProblem(flow: DecisionFlow, nodeId: string, ancestors: DecisionFlowNode[]): string | null {
  const referenced = flow.nodes.find((candidate) => candidate.id === nodeId);
  if (!referenced) return `找不到節點：${nodeId}`;
  if (referenced.type !== "decision") return `不是決策節點：${referenced.data.label || nodeId}`;
  if (!ancestors.some((ancestor) => ancestor.id === nodeId)) return `不在上游路徑：${referenced.data.label || nodeId}`;
  return null;
}
function uniqueOutputKey(base: string, usedKeys: Set<string>): string {
  let key = base;
  let suffix = 2;
  while (usedKeys.has(key)) key = `${base}_${suffix++}`;
  usedKeys.add(key);
  return key;
}


function parseScoreThresholds(raw: string, max: number): { thresholds: number[]; error: string } {
  if (raw.trim() === "") return { thresholds: [], error: "" };
  const parts = raw.split(",").map((part) => part.trim());
  if (parts.some((part) => part.length === 0)) return { thresholds: [], error: "每個逗號之間都必須填入數值，不可留空。" };
  const thresholds = parts.map(Number);
  if (thresholds.some((threshold) => !Number.isFinite(threshold))) return { thresholds, error: "切分點必須是有限數值。" };
  if (thresholds.some((threshold, index) => threshold <= 0 || threshold >= max || (index > 0 && threshold <= thresholds[index - 1]!))) {
    return { thresholds, error: `切分點需嚴格遞增，且介於 0 與 ${max} 之間（不含端點）。` };
  }
  return { thresholds, error: "" };
}

export function Inspector({ flow, node, templates, onChangeFlow, onDeleteNode, onCreateTemplate, onValidityChange }: InspectorProps) {
  const [templateName, setTemplateName] = useState("");
  const [templateError, setTemplateError] = useState("");
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [jsonDrafts, setJsonDrafts] = useState<Record<string, string>>({});
  const [jsonErrors, setJsonErrors] = useState<Record<string, string>>({});
  const [scoreDrafts, setScoreDrafts] = useState<Record<string, string>>({});
  const [draftNodeId, setDraftNodeId] = useState(node?.id);
  const draftsCurrent = draftNodeId === node?.id;
  const scoreNode = node?.type === "decision" && node.data.question.type === "score" ? node : null;
  const appliedScoreText = scoreNode?.data.scoreThresholds.join(", ") ?? "";
  const scoreDraft = scoreNode && draftsCurrent ? scoreDrafts[scoreNode.id] ?? appliedScoreText : appliedScoreText;
  const scoreDraftPending = scoreDraft !== appliedScoreText;
  const scoreValidation = parseScoreThresholds(scoreDraft, scoreNode?.data.question.type === "score" ? scoreNode.data.question.criteria.length - 1 : 0);
  const scoreError = scoreNode ? scoreValidation.error : "";

  useEffect(() => {
    setDraftNodeId(node?.id);
    setTemplateName(node?.type === "decision" ? `${node.data.label || "決策"} 範本`.slice(0, 120) : "");
    setTemplateError("");
    setJsonErrors({});
    setJsonDrafts({});
    setScoreDrafts({});
  }, [node?.id]);

  useEffect(() => {
    onValidityChange((!draftsCurrent || Object.values(jsonErrors).every((error) => error.length === 0)) && !scoreDraftPending && !scoreError);
  }, [draftsCurrent, jsonErrors, scoreDraftPending, scoreError, onValidityChange]);

  function commitNode(updated: FlowNode, portRenames = new Map<string, string>()): void {
    let nextNode = updated;
    let edges = flow.edges.map((edge) => edge.source === updated.id && portRenames.has(edge.sourceHandle)
      ? { ...edge, sourceHandle: portRenames.get(edge.sourceHandle) ?? edge.sourceHandle }
      : edge);
    if (nextNode.type === "decision") {
      const validPorts = new Set(getBranchPorts(nextNode).map((port) => port.id));
      const renamedBranch = portRenames.get(nextNode.data.lowConfidenceBranch) ?? nextNode.data.lowConfidenceBranch;
      const lowConfidenceBranch = validPorts.has(renamedBranch)
        ? renamedBranch
        : getDefaultLowConfidenceBranch(nextNode.data.question, nextNode.data.scoreThresholds);
      nextNode = { ...nextNode, data: { ...nextNode.data, lowConfidenceBranch } };
      edges = edges.filter((edge) => edge.source !== nextNode.id || validPorts.has(edge.sourceHandle));
    }
    onChangeFlow({ ...flow, nodes: flow.nodes.map((candidate) => candidate.id === nextNode.id ? nextNode : candidate), edges });
  }

  if (!node) return (
    <aside className="inspector panel" aria-label="節點設定">
      <header className="panel__heading"><div><span className="eyebrow">編輯器</span><h2>節點設定</h2></div></header>
      <div className="empty-state"><span className="empty-state__mark">⌖</span><strong>選取一個積木</strong><p>點選畫布節點以編輯問題、分支與 JSON 輸出。</p><p className="muted">連線：拖曳節點右側出口至下一個節點。</p></div>
    </aside>
  );

  const ancestors = getAncestorDecisions(flow, node.id);
  const canReference = ancestors;
  const decisionNode = node.type === "decision" ? node : null;
  const endNode = node.type === "end" ? node : null;
  const question = decisionNode?.data.question;
  const commitDecision = (updated: DecisionFlowNode, renames?: Map<string, string>) => commitNode(updated, renames);

  return (
    <aside className="inspector panel" aria-label="節點設定">
      <header className="panel__heading"><div><span className="eyebrow">{node.type === "start" ? "流程輸入" : node.type === "end" ? "JSON 回傳" : "決策節點"}</span><h2>{node.data.label || "未命名節點"}</h2></div></header>
      <div className="inspector__body">
        <label className="field"><span>節點名稱</span><input value={node.data.label} maxLength={120} onChange={(event) => commitNode(withLabel(node, event.target.value))} /></label>
        {node.type === "start" && <p className="helper-copy">此節點接收執行 API 的 <code>input</code>，不會呼叫裝置。起點必須只連到一個下一步；互斥出口可共用同一個結束節點。</p>}
        {decisionNode && question && (
          <>
            <label className="field"><span>判斷類型</span>
              <select value={question.type} onChange={(event) => {
                const type = event.target.value === "noul" || event.target.value === "score" ? event.target.value : "choice";
                const nextQuestion = makeQuestion(type, getText(question));
                setScoreDrafts({});
                commitDecision({ ...decisionNode, data: { ...decisionNode.data, question: nextQuestion, scoreThresholds: [] } });
              }}>
                <option value="choice">單選分類</option><option value="noul">是／否（機率門檻）</option><option value="score">程度評分</option>
              </select>
            </label>
            <label className="field"><span>要判斷的問題</span><textarea rows={3} value={getText(question)} onChange={(event) => commitDecision({ ...decisionNode, data: { ...decisionNode.data, question: { ...question, instructions: event.target.value } } })} /></label>
            <label className="field"><span>最低信心門檻（0–1）</span><input type="number" min="0" max="1" step="0.01" value={decisionNode.data.minConfidence} onChange={(event) => commitDecision({ ...decisionNode, data: { ...decisionNode.data, minConfidence: Number(event.target.value) } })} /></label>
            <label className="field"><span>低於門檻時採用</span><select value={decisionNode.data.lowConfidenceBranch} onChange={(event) => commitDecision({ ...decisionNode, data: { ...decisionNode.data, lowConfidenceBranch: event.target.value } })}>
              {getBranchPorts(decisionNode).map((port) => <option key={port.id} value={port.id}>{port.label}</option>)}
            </select></label>
            <p className="helper-copy">低於門檻時以指定選項作為結果，並沿用該出口；也可新增「信心不足」分類後選用。{question.type === "score" ? " 評分結果採用所選分段的下界。" : ""} 0 代表停用。Laya 信心表示答案分布集中度，不是答對機率。</p>
            {question.type === "choice" && (
              <fieldset className="field-group"><legend>分類選項</legend>
                {Object.entries(question.criteria).map(([key, description], index) => (
                  <div className="option-row" key={`${decisionNode.id}-choice-${index}`}>
                    <label className="field"><span>分支 key</span><input value={key} aria-label={`選項 ${index + 1} key`} onChange={(event) => {
                      const nextKey = event.target.value;
                      if (nextKey !== key && Object.hasOwn(question.criteria, nextKey)) return;
                      const criteria: Record<string, string | null> = {};
                      for (const [oldKey, text] of Object.entries(question.criteria)) criteria[oldKey === key ? nextKey : oldKey] = text;
                      commitDecision({ ...decisionNode, data: { ...decisionNode.data, question: { ...question, criteria } } }, new Map([[`choice:${encodeURIComponent(key)}`, `choice:${encodeURIComponent(nextKey)}`]]));
                    }} /></label>
                    <label className="field"><span>說明</span><input value={description ?? ""} aria-label={`選項 ${index + 1} 說明`} onChange={(event) => commitDecision({ ...decisionNode, data: { ...decisionNode.data, question: { ...question, criteria: { ...question.criteria, [key]: event.target.value } } } })} /></label>
                    <button type="button" className="icon-button danger" aria-label={`刪除選項 ${key}`} onClick={() => {
                      const criteria = Object.fromEntries(Object.entries(question.criteria).filter(([candidate]) => candidate !== key));
                      commitDecision({ ...decisionNode, data: { ...decisionNode.data, question: { ...question, criteria } } });
                    }}>×</button>
                  </div>
                ))}
                <button type="button" className="button button--subtle button--small" onClick={() => {
                  const criteria: Record<string, string | null> = Object.fromEntries(Object.entries(question.criteria));
                  let index = Object.keys(criteria).length + 1;
                  while (Object.hasOwn(criteria, `option${index}`)) index += 1;
                  criteria[`option${index}`] = "";
                  commitDecision({ ...decisionNode, data: { ...decisionNode.data, question: { ...question, criteria } } });
                }}>＋ 新增選項</button>
              </fieldset>
            )}
            {question.type === "noul" && (
              <>
                <label className="field"><span>判定為「是」的最低 P(true)</span><input type="number" min="0" max="1" step="0.01" value={decisionNode.data.trueThreshold} onChange={(event) => commitDecision({ ...decisionNode, data: { ...decisionNode.data, trueThreshold: Number(event.target.value) } })} /></label>
                <div className="option-row"><label className="field"><span>是分支說明</span><input value={question.criteria?.true ?? ""} onChange={(event) => commitDecision({ ...decisionNode, data: { ...decisionNode.data, question: { ...question, criteria: { ...question.criteria, true: event.target.value } } } })} /></label><label className="field"><span>否分支說明</span><input value={question.criteria?.false ?? ""} onChange={(event) => commitDecision({ ...decisionNode, data: { ...decisionNode.data, question: { ...question, criteria: { ...question.criteria, false: event.target.value } } } })} /></label></div>
                <p className="helper-copy">P(true) ≥ 門檻走「是」；低於門檻走「否」。</p>
              </>
            )}
            {question.type === "score" && (
              <>
                <fieldset className="field-group"><legend>分數等級（由低到高）</legend>
                  {question.criteria.map((level, index) => <div className="option-row" key={`${decisionNode.id}-level-${index}`}><label className="field"><span>分數 {index}</span><input value={level} onChange={(event) => {
                    const criteria = [...question.criteria];
                    criteria[index] = event.target.value;
                    commitDecision({ ...decisionNode, data: { ...decisionNode.data, question: { ...question, criteria } } });
                  }} /></label><button type="button" className="icon-button danger" aria-label={`刪除分數等級 ${index}`} onClick={() => {
                    const criteria = question.criteria.filter((_item, levelIndex) => levelIndex !== index);
                    setScoreDrafts({});
                    commitDecision({ ...decisionNode, data: { ...decisionNode.data, question: { ...question, criteria }, scoreThresholds: decisionNode.data.scoreThresholds.filter((threshold) => threshold < criteria.length - 1) } });
                  }}>×</button></div>)}
                  <button type="button" className="button button--subtle button--small" onClick={() => {
                    setScoreDrafts({});
                    commitDecision({ ...decisionNode, data: { ...decisionNode.data, question: { ...question, criteria: [...question.criteria, `新等級 ${question.criteria.length}`] } } });
                  }}>＋ 新增等級</button>
                </fieldset>
                <label className="field"><span>數值切分點</span><input aria-label="數值切分點，以逗號分隔" aria-invalid={Boolean(scoreError)} placeholder="例如：1.5" value={scoreDraft} onChange={(event) => {
                  setScoreDrafts((current) => ({ ...current, [decisionNode.id]: event.target.value }));
                }} /></label>
                <div className="option-row">
                  <button type="button" className="button button--subtle button--small" disabled={!scoreDraftPending || Boolean(scoreError)} onClick={() => {
                    setScoreDrafts({});
                    commitDecision({ ...decisionNode, data: { ...decisionNode.data, scoreThresholds: scoreValidation.thresholds } });
                  }}>套用切分點</button>
                  <button type="button" className="button button--subtle button--small" disabled={!scoreDraftPending} onClick={() => setScoreDrafts({})}>取消修改</button>
                </div>
                {scoreError && <p className="form-error" role="alert">{scoreError}</p>}
                {scoreDraftPending && <p className="helper-copy">切分點尚未套用；請套用或取消修改後再儲存或測試流程。</p>}
                <p className="helper-copy">切分點 1.5：低於 1.5 與大於等於 1.5 分流。每段都要接線。留空表示不切分；套用後，已移除出口的連線也會刪除。切換節點或調整等級數量會取消未套用的修改。</p>
              </>
            )}
            <fieldset className="field-group"><legend>提供前置決策結果（可選）</legend>
              {ancestors.length === 0 ? <p className="muted">目前沒有可引用的上游決策。</p> : ancestors.map((ancestor) => (
                <label className="check-row" key={ancestor.id}><input type="checkbox" checked={decisionNode.data.inputNodeIds.includes(ancestor.id)} disabled={!decisionNode.data.inputNodeIds.includes(ancestor.id) && decisionNode.data.inputNodeIds.length >= MAX_INPUT_NODE_REFS} onChange={(event) => {
                  const inputNodeIds = event.target.checked ? [...decisionNode.data.inputNodeIds, ancestor.id] : decisionNode.data.inputNodeIds.filter((id) => id !== ancestor.id);
                  commitDecision({ ...decisionNode, data: { ...decisionNode.data, inputNodeIds } });
                }} /><span>{ancestor.data.label}</span></label>
              ))}
              {[...new Set(decisionNode.data.inputNodeIds)].filter((id) => !ancestors.some((ancestor) => ancestor.id === id)).map((id) => (
                <label className="check-row" key={id}><input type="checkbox" checked onChange={() => {
                  commitDecision({ ...decisionNode, data: { ...decisionNode.data, inputNodeIds: decisionNode.data.inputNodeIds.filter((candidate) => candidate !== id) } });
                }} /><span>無效引用（{referenceProblem(flow, id, ancestors)}）</span></label>
              ))}
            </fieldset>
            <fieldset className="field-group"><legend>存成可重用積木</legend>
              <label className="field"><span>範本名稱</span><input value={templateName} maxLength={120} onChange={(event) => setTemplateName(event.target.value)} /></label>
              <button type="button" className="button button--subtle" disabled={savingTemplate || scoreDraftPending || Boolean(scoreError) || templateName.trim().length === 0 || templates.some((template) => template.name === templateName.trim())} onClick={async () => {
                setSavingTemplate(true);
                setTemplateError("");
                try {
                  await onCreateTemplate({ id: createId(), name: templateName.trim(), question: structuredClone(question), trueThreshold: decisionNode.data.trueThreshold, minConfidence: decisionNode.data.minConfidence, lowConfidenceBranch: decisionNode.data.lowConfidenceBranch, scoreThresholds: [...decisionNode.data.scoreThresholds], createdAt: new Date().toISOString() });
                } catch (error) {
                  setTemplateError(error instanceof Error ? error.message : String(error));
                } finally {
                  setSavingTemplate(false);
                }
              }}>{savingTemplate ? "儲存中…" : "儲存為積木範本"}</button>
              {templateError && <p className="form-error" role="alert">{templateError}</p>}
            </fieldset>
          </>
        )}
        {endNode && (
          <fieldset className="field-group"><legend>回傳 JSON 欄位</legend>
            {endNode.data.fields.map((field, index) => (
              <div className="output-field" key={field.id}>
                <div className="output-field__heading"><strong>欄位 {index + 1}</strong><button type="button" className="icon-button danger" aria-label={`刪除欄位 ${field.key}`} onClick={() => {
                  setJsonErrors((current) => ({ ...current, [field.id]: "" }));
                  setJsonDrafts((current) => ({ ...current, [field.id]: "" }));
                  commitNode({ ...endNode, data: { ...endNode.data, fields: endNode.data.fields.filter((candidate) => candidate.id !== field.id) } });
                }}>×</button></div>
                <label className="field"><span>JSON key</span><input value={field.key} onChange={(event) => updateEndField(endNode, field.id, { ...field, key: event.target.value }, flow, onChangeFlow)} /></label>
                <label className="field"><span>值來源</span><select value={field.value.kind === "literal" ? "literal" : `decision:${field.value.nodeId}`} onChange={(event) => {
                  const value: OutputValue = event.target.value === "literal" ? { kind: "literal", value: null } : { kind: "decision", nodeId: event.target.value.slice("decision:".length) };
                  setJsonErrors((current) => ({ ...current, [field.id]: "" }));
                  setJsonDrafts((current) => ({ ...current, [field.id]: value.kind === "literal" ? JSON.stringify(value.value, null, 2) : "" }));
                  updateEndField(endNode, field.id, { ...field, value }, flow, onChangeFlow);
                }}><option value="literal">固定 JSON 值</option>{field.value.kind === "decision" && referenceProblem(flow, field.value.nodeId, canReference) && <option value={`decision:${field.value.nodeId}`}>無效引用（{referenceProblem(flow, field.value.nodeId, canReference)}）</option>}{canReference.map((ancestor) => <option value={`decision:${ancestor.id}`} key={ancestor.id}>決策結果：{ancestor.data.label}</option>)}</select></label>
                {field.value.kind === "literal" ? <label className="field"><span>JSON 值</span><textarea aria-label={`欄位 ${field.key} JSON 值`} rows={3} value={jsonDrafts[field.id] ?? JSON.stringify(field.value.value, null, 2)} onChange={(event) => {
                  setJsonDrafts((current) => ({ ...current, [field.id]: event.target.value }));
                  try {
                    const value: unknown = JSON.parse(event.target.value);
                    if (!isJsonValue(value)) throw new Error("值必須是 JSON。");
                    setJsonErrors((current) => ({ ...current, [field.id]: "" }));
                    updateEndField(endNode, field.id, { ...field, value: { kind: "literal", value } }, flow, onChangeFlow);
                  } catch (error) {
                    setJsonErrors((current) => ({ ...current, [field.id]: error instanceof Error ? error.message : "JSON 格式錯誤。" }));
                  }
                }} /></label> : referenceProblem(flow, field.value.nodeId, canReference) ? <p className="form-error" role="alert">無效引用（{referenceProblem(flow, field.value.nodeId, canReference)}）。請選擇固定 JSON 值或有效的上游決策。</p> : <p className="helper-copy">執行時會填入「{canReference.find((ancestor) => field.value.kind === "decision" && ancestor.id === field.value.nodeId)?.data.label || field.value.nodeId}」的選擇／分數／是非結果。</p>}
                {jsonErrors[field.id] && <p className="form-error" role="alert">{jsonErrors[field.id]}</p>}
              </div>
            ))}
            <div className="output-field-actions">
              <button type="button" className="button button--subtle button--small" onClick={() => {
                const usedKeys = new Set(endNode.data.fields.map((field) => field.key));
                const key = uniqueOutputKey("result", usedKeys);
                commitNode({ ...endNode, data: { ...endNode.data, fields: [...endNode.data.fields, { id: createId(), key, value: { kind: "literal", value: null } }] } });
              }}>＋ 新增 JSON 欄位</button>
              {canReference.length > 0 && (
                <button
                  type="button"
                  className="button button--subtle button--small"
                  disabled={canReference.every((ancestor) => endNode.data.fields.some((f) => f.value.kind === "decision" && f.value.nodeId === ancestor.id))}
                  onClick={() => {
                    const missing = canReference.filter((ancestor) => !endNode.data.fields.some((f) => f.value.kind === "decision" && f.value.nodeId === ancestor.id));
                    const usedKeys = new Set(endNode.data.fields.map((field) => field.key));
                    const newFields = missing.map((ancestor) => {
                      const baseKey = ancestor.data.label.replace(/^#[\d.]+\s*\|\s*/, "").replace(/[^\w\u4e00-\u9fa5]/g, "") || "field";
                      const key = uniqueOutputKey(baseKey, usedKeys);
                      return { id: createId(), key, value: { kind: "decision" as const, nodeId: ancestor.id } };
                    });
                    commitNode({ ...endNode, data: { ...endNode.data, fields: [...endNode.data.fields, ...newFields] } });
                  }}
                >
                  帶入上游決策結果
                </button>
              )}
            </div>
          </fieldset>
        )}
        {node.type !== "start" && <button type="button" className="button button--danger" onClick={() => onDeleteNode(node.id)}>刪除此積木</button>}
      </div>
    </aside>
  );
}

function updateEndField(node: EndFlowNode, fieldId: string, updated: EndFlowNode["data"]["fields"][number], flow: DecisionFlow, onChangeFlow: (flow: DecisionFlow) => void): void {
  onChangeFlow({ ...flow, nodes: flow.nodes.map((candidate) => candidate.id === node.id && candidate.type === "end"
    ? { ...candidate, data: { ...candidate.data, fields: candidate.data.fields.map((field) => field.id === fieldId ? updated : field) } }
    : candidate) });
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    return items.every(isJsonValue);
  }
  return typeof value === "object" && value !== null && Object.values(value).every(isJsonValue);
}
