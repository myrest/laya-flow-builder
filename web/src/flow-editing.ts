import type { DecisionFlow } from "../../decision-types";

export function removeFlowNodes(flow: DecisionFlow, nodeIds: ReadonlySet<string>): DecisionFlow {
  return {
    ...flow,
    nodes: flow.nodes.filter((node) => !nodeIds.has(node.id)).map((node) => {
      if (node.type !== "decision" || !node.data.inputNodeIds.some((id) => nodeIds.has(id))) return node;
      return { ...node, data: { ...node.data, inputNodeIds: node.data.inputNodeIds.filter((id) => !nodeIds.has(id)) } };
    }),
    edges: flow.edges.filter((edge) => !nodeIds.has(edge.source) && !nodeIds.has(edge.target)),
  };
}
