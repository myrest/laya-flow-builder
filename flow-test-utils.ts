import type { DecisionFlow, JsonValue } from "./decision-types.js";

export function flowRevision(flow: DecisionFlow): string {
  // Ignore canvas positions and edge IDs; they do not change flow execution.
  return JSON.stringify({
    nodes: flow.nodes.map(({ id, type, data }) => ({ id, type, data })),
    edges: flow.edges.map(({ source, target, sourceHandle }) => ({ source, target, sourceHandle })),
  });
}

function jsonValuesEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => jsonValuesEqual(item, right[index] as JsonValue));
  }
  if (Object.keys(left).length !== Object.keys(right).length) return false;
  return Object.entries(left).every(([key, value]) => Object.hasOwn(right, key) && jsonValuesEqual(value, right[key] as JsonValue));
}

export function outputsEqual(actual: Record<string, JsonValue>, expected: Record<string, JsonValue>): boolean {
  return jsonValuesEqual(actual, expected);
}
