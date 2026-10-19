import type { Question } from "../../../laya/src/types.js";
import type { DecisionFlow, DecisionTemplate, FlowDraft, FlowDraftPreview, FlowHistoryEntry, FlowTestCase, FlowTestResult, FlowTestSuite } from "../../decision-types";
import { isRecord } from "../../decision-guards";
import { parseDecisionFlow, parseDecisionStoreData, parseFlowDraft, parseFlowHistoryEntry, parseFlowTestResult, parseFlowTestSuite, parseJsonObject } from "../../decision-schema";

const ADMIN_TOKEN_KEY = "laya-admin-token";

async function request(pathname: string, init?: RequestInit): Promise<unknown> {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  const method = (init?.method ?? "GET").toUpperCase();
  const isPublicMutation = method === "POST" && /\/(?:run|test|validate)$/.test(pathname) && !/\/test-cases\/run$/.test(pathname);
  const isAdminOnlyRead = method === "GET" && /\/api\/flows\/[^/]+\/history$/.test(pathname);
  const token = sessionStorage.getItem(ADMIN_TOKEN_KEY);
  if (((method !== "GET" && method !== "HEAD" && !isPublicMutation) || isAdminOnlyRead) && token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(pathname, { ...init, headers });
  if (response.status === 204) return undefined;
  const data: unknown = await response.json();
  if (!response.ok) {
    const message = isRecord(data) && typeof data.error === "string" ? data.error : `HTTP ${response.status}`;
    const rawIssues: unknown[] = isRecord(data) && Array.isArray(data.issues) ? data.issues : [];
    const issues = rawIssues.filter((issue): issue is string => typeof issue === "string");
    const prefix = response.status === 409 ? "衝突（HTTP 409）：" : response.status === 401 ? "管理員驗證失敗（HTTP 401）：" : "";
    const error = new Error(`${prefix}${[message, ...issues].join(" ")}`);
    Object.assign(error, { status: response.status });
    throw error;
  }
  return data;
}

export async function checkAdminToken(token: string): Promise<void> {
  await request("/api/admin/check", { headers: { Authorization: `Bearer ${token}` } });
}

export function getAdminToken(): string | null {
  return sessionStorage.getItem(ADMIN_TOKEN_KEY);
}

export function setAdminToken(token: string): void {
  sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
}

export function clearAdminToken(): void {
  sessionStorage.removeItem(ADMIN_TOKEN_KEY);
}

export async function listFlowDrafts(flowId?: string): Promise<FlowDraft[]> {
  const query = flowId ? `?flowId=${encodeURIComponent(flowId)}` : "";
  const value = await request(`/api/flow-drafts${query}`);
  if (!Array.isArray(value)) throw new Error("Invalid flow draft list.");
  return value.map(parseFlowDraft);
}

export async function createFlowDraft(sourceFlowId?: string, name?: string): Promise<FlowDraft> {
  const body: { sourceFlowId?: string; name?: string } = {};
  if (sourceFlowId) body.sourceFlowId = sourceFlowId;
  if (name) body.name = name;
  return parseFlowDraft(await request("/api/flow-drafts", { method: "POST", body: JSON.stringify(body) }));
}

export async function getFlowDraft(id: string): Promise<FlowDraft> {
  return parseFlowDraft(await request(`/api/flow-drafts/${encodeURIComponent(id)}`));
}

export async function updateFlowDraft(id: string, revision: string, value: { flow?: DecisionFlow; cases?: FlowTestCase[] }): Promise<FlowDraft> {
  return parseFlowDraft(await request(`/api/flow-drafts/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ revision, ...value }) }));
}

export async function validateFlowDraft(id: string, revision: string): Promise<{ issues: string[] }> {
  const value = await request(`/api/flow-drafts/${encodeURIComponent(id)}/validate`, { method: "POST", body: JSON.stringify({ revision }) });
  if (!isRecord(value) || !Array.isArray(value.issues) || !value.issues.every((item) => typeof item === "string")) throw new Error("Invalid draft validation response.");
  return { issues: value.issues };
}

export async function testFlowDraft(id: string, revision: string, input: unknown): Promise<FlowTestResult> {
  return parseFlowTestResult(await request(`/api/flow-drafts/${encodeURIComponent(id)}/test`, { method: "POST", body: JSON.stringify({ revision, input }) }));
}

export async function runFlowDraftBatch(id: string, revision: string): Promise<FlowDraft> {
  return parseFlowDraft(await request(`/api/flow-drafts/${encodeURIComponent(id)}/test-batch`, { method: "POST", body: JSON.stringify({ revision }) }));
}

export async function submitFlowDraft(id: string, revision: string): Promise<FlowDraft> {
  return parseFlowDraft(await request(`/api/flow-drafts/${encodeURIComponent(id)}/submit`, { method: "POST", body: JSON.stringify({ revision }) }));
}

export async function discardFlowDraft(id: string, revision: string): Promise<FlowDraft> {
  return parseFlowDraft(await request(`/api/flow-drafts/${encodeURIComponent(id)}/discard`, { method: "POST", body: JSON.stringify({ revision }) }));
}


export async function applyFlowDraft(id: string, revision: string, acknowledgeWarnings: boolean): Promise<{ flow: DecisionFlow; suite: FlowTestSuite; draft: FlowDraft }> {
  const value: unknown = await request(`/api/flow-drafts/${encodeURIComponent(id)}/apply`, { method: "POST", body: JSON.stringify({ revision, acknowledgeWarnings }) });
  if (!isRecord(value)) throw new Error("Invalid draft apply response.");
  return { flow: parseDecisionFlow(value.flow), suite: parseFlowTestSuite(value.suite), draft: parseFlowDraft(value.draft) };
}

export async function listFlowHistory(flowId: string): Promise<FlowHistoryEntry[]> {
  const value = await request(`/api/flows/${encodeURIComponent(flowId)}/history`);
  if (!Array.isArray(value)) throw new Error("Invalid flow history response.");
  return value.map(parseFlowHistoryEntry);
}

export async function restoreFlowHistory(flowId: string, entryId: string, flowVersion: string, suiteRevision: string): Promise<{ flow: DecisionFlow; suite: FlowTestSuite }> {
  const value: unknown = await request(`/api/flows/${encodeURIComponent(flowId)}/history/${encodeURIComponent(entryId)}/restore`, { method: "POST", body: JSON.stringify({ flowVersion, suiteRevision }) });
  if (!isRecord(value)) throw new Error("Invalid history restore response.");
  return { flow: parseDecisionFlow(value.flow), suite: parseFlowTestSuite(value.suite) };
}

export async function previewFlowDraft(id: string): Promise<FlowDraftPreview> {
  const value: unknown = await request(`/api/flow-drafts/${encodeURIComponent(id)}/preview`);
  if (!isRecord(value) || !Array.isArray(value.issues) || !value.issues.every((item) => typeof item === "string") ||
    !Array.isArray(value.changes) || !Array.isArray(value.caseChanges) || !Array.isArray(value.warnings) ||
    !value.warnings.every((item) => typeof item === "string") || typeof value.conflict !== "boolean" ||
    (value.currentFlowVersion !== null && typeof value.currentFlowVersion !== "string")) throw new Error("Invalid draft preview response.");
  const parseChanges = (raw: unknown[]): FlowDraftPreview["changes"] => raw.map((item) => {
    if (!isRecord(item) || typeof item.path !== "string") throw new Error("Invalid draft change response.");
    return { path: item.path, before: item.before, after: item.after };
  });
  return {
    draft: parseFlowDraft(value.draft),
    currentFlow: value.currentFlow === null ? null : parseDecisionFlow(value.currentFlow),
    currentSuite: value.currentSuite === null ? null : parseFlowTestSuite(value.currentSuite),
    currentFlowVersion: value.currentFlowVersion,
    conflict: value.conflict,
    issues: value.issues,
    changes: parseChanges(value.changes),
    caseChanges: parseChanges(value.caseChanges),
    warnings: value.warnings,
  };
}

export async function listFlows(): Promise<DecisionFlow[]> {
  const value = await request("/api/flows");
  if (!Array.isArray(value)) throw new Error("Invalid flow list response.");
  return parseDecisionStoreData({ flows: value, templates: [] }).flows;
}

export async function getFlow(id: string): Promise<DecisionFlow> {
  return parseDecisionFlow(await request(`/api/flows/${encodeURIComponent(id)}`));
}

export async function createFlow(name: string): Promise<DecisionFlow> {
  return parseDecisionFlow(await request("/api/flows", { method: "POST", body: JSON.stringify({ name }) }));
}

export async function saveFlow(flow: DecisionFlow): Promise<DecisionFlow> {
  return parseDecisionFlow(await request(`/api/flows/${encodeURIComponent(flow.id)}`, { method: "PUT", body: JSON.stringify(flow) }));
}

export async function deleteFlow(id: string): Promise<void> {
  await request(`/api/flows/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function listTemplates(): Promise<DecisionTemplate[]> {
  const value = await request("/api/templates");
  if (!Array.isArray(value)) throw new Error("Invalid template list response.");
  return parseDecisionStoreData({ flows: [], templates: value }).templates;
}

export async function createTemplate(template: DecisionTemplate): Promise<DecisionTemplate> {
  const value = await request("/api/templates", { method: "POST", body: JSON.stringify(template) });
  const templates = parseDecisionStoreData({ flows: [], templates: [value] }).templates;
  const created = templates[0];
  if (!created) throw new Error("Invalid template response.");
  return created;
}

export async function deleteTemplate(id: string): Promise<void> {
  await request(`/api/templates/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function validateFlow(id: string): Promise<{ issues: string[] }> {
  const value = await request(`/api/flows/${encodeURIComponent(id)}/validate`, { method: "POST", body: "{}" });
  if (!isRecord(value) || !Array.isArray(value.issues)) throw new Error("Invalid validation response.");
  const rawIssues: unknown[] = value.issues;
  const issues: string[] = [];
  for (const issue of rawIssues) {
    if (typeof issue !== "string") throw new Error("Invalid validation issue.");
    issues.push(issue);
  }
  return { issues };
}

export async function testFlow(flow: DecisionFlow, input: unknown): Promise<FlowTestResult> {
  const value = await request(`/api/flows/${encodeURIComponent(flow.id)}/test`, { method: "POST", body: JSON.stringify({ input, flow }) });
  return parseFlowTestResult(value);
}

export async function getFlowTestSuite(flowId: string): Promise<FlowTestSuite> {
  return parseFlowTestSuite(await request(`/api/flows/${encodeURIComponent(flowId)}/test-cases`));
}

export async function saveFlowTestCases(flowId: string, revision: string, cases: FlowTestCase[]): Promise<FlowTestSuite> {
  return parseFlowTestSuite(await request(`/api/flows/${encodeURIComponent(flowId)}/test-cases`, { method: "PUT", body: JSON.stringify({ revision, cases }) }));
}

export async function runFlowTestBatch(flow: DecisionFlow, caseIds?: string[]): Promise<FlowTestSuite> {
  return parseFlowTestSuite(await request(`/api/flows/${encodeURIComponent(flow.id)}/test-cases/run`, {
    method: "POST",
    body: JSON.stringify({ flow, ...(caseIds ? { caseIds } : {}) }),
  }));
}

export async function runFlow(id: string, input: unknown): Promise<Record<string, unknown>> {
  return parseJsonObject(await request(`/api/flows/${encodeURIComponent(id)}/run`, { method: "POST", body: JSON.stringify({ input }) }));
}

export function choiceQuestion(): Question {
  return { type: "choice", instructions: "要判斷什麼？", criteria: { yes: "符合", no: "不符合", other: "其他／無法判斷" } };
}
