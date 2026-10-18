import type { Question } from "../../../laya/src/types.js";
import type { DecisionFlow, DecisionTemplate, FlowTestCase, FlowTestResult, FlowTestSuite } from "../../decision-types";
import { isRecord } from "../../decision-guards";
import { parseDecisionFlow, parseDecisionStoreData, parseFlowTestResult, parseFlowTestSuite, parseJsonObject } from "../../decision-schema";

async function request(pathname: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(pathname, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (response.status === 204) return undefined;
  const data: unknown = await response.json();
  if (!response.ok) {
    const message = isRecord(data) && typeof data.error === "string" ? data.error : `HTTP ${response.status}`;
    const rawIssues: unknown[] = isRecord(data) && Array.isArray(data.issues) ? data.issues : [];
    const issues = rawIssues.filter((issue): issue is string => typeof issue === "string");
    throw new Error([message, ...issues].join(" "));
  }
  return data;
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
