import { useCallback, useEffect, useRef, useState } from "react";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import { getBranchPorts } from "../../decision-engine";
import type { DecisionFlow, FlowEdge, FlowNode } from "../../decision-types";
import { isRecord } from "../../decision-guards";
import { createId } from "./id";
import { removeFlowNodes } from "./flow-editing";

const BLOCK_TRANSFER_KEY = "application/laya-decision-block";
type CanvasNodeData = { flowNode: FlowNode };
type CanvasNode = Node<CanvasNodeData, "flowNode">;
type CanvasEdge = Edge;
type NodeDragType = "choice" | "noul" | "score" | "end" | `template:${string}`;

interface FlowCanvasProps {
  flow: DecisionFlow;
  selectedNodeId: string | null;
  active: boolean;
  onSelectNode: (nodeId: string | null) => void;
  onChange: (flow: DecisionFlow) => void;
  onAddAt: (type: NodeDragType, position: { x: number; y: number }) => void;
  onNodeDrop: (nodeId: string) => void;
}

function estimateNodeDimensions(node: FlowNode): { initialWidth: number; initialHeight: number } {
  if (node.type === "start") return { initialWidth: 220, initialHeight: 70 };
  if (node.type === "end") return { initialWidth: 230, initialHeight: Math.max(75, 55 + node.data.fields.length * 22) };
  return { initialWidth: 240, initialHeight: Math.max(90, 75 + getBranchPorts(node).length * 28) };
}

function toCanvasNodes(
  nodes: FlowNode[],
  selectedNodeId: string | null,
  dimensionsMap?: Map<string, { width: number; height: number }>,
): CanvasNode[] {
  return nodes.map((flowNode) => {
    const estimated = estimateNodeDimensions(flowNode);
    const measured = dimensionsMap?.get(flowNode.id);
    return {
      id: flowNode.id,
      type: "flowNode",
      position: flowNode.position,
      data: { flowNode },
      selected: flowNode.id === selectedNodeId,
      deletable: flowNode.type !== "start",
      initialWidth: estimated.initialWidth,
      initialHeight: estimated.initialHeight,
      ...(measured ? { measured } : {}),
    };
  });
}

function fromCanvasNodes(nodes: CanvasNode[]): FlowNode[] {
  return nodes.map((node) => ({ ...node.data.flowNode, position: { x: node.position.x, y: node.position.y } }));
}

const EDGE_PALETTE = [
  "#0d9488", // Teal
  "#ea580c", // Orange
  "#7c3aed", // Violet
  "#16a34a", // Green
  "#e11d48", // Rose / Red
  "#d97706", // Amber
  "#0891b2", // Cyan
  "#9333ea", // Purple
  "#059669", // Emerald
  "#c026d3", // Magenta
  "#ca8a04", // Gold
  "#be123c", // Crimson
];

export function getEdgeColorMap(edges: FlowEdge[]): Map<string, string> {
  const map = new Map<string, string>();
  const usedByTarget = new Map<string, Set<number>>();
  const usedBySource = new Map<string, Set<number>>();

  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i]!;
    const targetUsed = usedByTarget.get(edge.target) ?? new Set<number>();
    const sourceUsed = usedBySource.get(edge.source) ?? new Set<number>();

    let chosenIndex = i % EDGE_PALETTE.length;
    for (let offset = 0; offset < EDGE_PALETTE.length; offset++) {
      const candidate = (i + offset) % EDGE_PALETTE.length;
      if (!targetUsed.has(candidate) && !sourceUsed.has(candidate)) {
        chosenIndex = candidate;
        break;
      }
    }

    targetUsed.add(chosenIndex);
    sourceUsed.add(chosenIndex);
    usedByTarget.set(edge.target, targetUsed);
    usedBySource.set(edge.source, sourceUsed);
    map.set(edge.id, EDGE_PALETTE[chosenIndex]!);
  }

  return map;
}

function toCanvasEdges(edges: FlowEdge[], selectedEdgeIds: ReadonlySet<string>): CanvasEdge[] {
  const colorMap = getEdgeColorMap(edges);
  return edges.map((edge) => {
    const isSelected = selectedEdgeIds.has(edge.id);
    const color = colorMap.get(edge.id) ?? "#8799b0";
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle,
      ...(edge.targetHandle !== undefined ? { targetHandle: edge.targetHandle } : {}),
      selected: isSelected,
      type: "smoothstep",
      style: {
        stroke: isSelected ? "var(--accent)" : color,
        strokeWidth: isSelected ? 2.8 : 2.0,
      },
    };
  });
}

function fromCanvasEdges(edges: CanvasEdge[]): FlowEdge[] {
  return edges.flatMap((edge) => edge.sourceHandle ? [{
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    ...(edge.targetHandle !== undefined ? { targetHandle: edge.targetHandle } : {}),
  }] : []);
}

function FlowNodeCard({ data, selected }: NodeProps<CanvasNode>) {
  const node = data.flowNode;
  const ports = node.type === "start" ? [{ id: "next", label: "下一步" }]
    : node.type === "decision" ? getBranchPorts(node)
    : [];
  const typeLabel = node.type === "start" ? "起點"
    : node.type === "end" ? "輸出"
    : node.data.question.type === "choice" ? "單選判斷"
    : node.data.question.type === "noul" ? "是非判斷"
    : "程度評分";
  return (
    <article className={`flow-node flow-node--${node.type}${selected ? " is-selected" : ""}`}>
      {node.type !== "start" && <Handle type="target" position={Position.Left} id="target" aria-label="輸入連線" />}
      <div className="flow-node__eyebrow">{typeLabel}</div>
      <strong className="flow-node__title">{node.data.label || "未命名節點"}</strong>
      {node.type === "decision" && (
        <p className="flow-node__prompt">{typeof node.data.question.instructions === "string" ? node.data.question.instructions : JSON.stringify(node.data.question.instructions)}</p>
      )}
      {node.type === "end" && <p className="flow-node__prompt">{node.data.fields.length} 個 JSON 欄位</p>}
      {ports.length > 0 && (
        <div className="flow-node__ports">
          {ports.map((port) => (
            <div className="flow-node__port" key={port.id}>
              <span>{port.label}</span>
              <Handle type="source" position={Position.Right} id={port.id} aria-label={`出口 ${port.label}`} />
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

const nodeTypes = { flowNode: FlowNodeCard };

function isConnectionAllowed(flow: DecisionFlow, connection: Connection | Edge): boolean {
  const { source, target, sourceHandle } = connection;
  if (!source || !target || !sourceHandle || source === target) return false;
  const sourceNode = flow.nodes.find((node) => node.id === source);
  const targetNode = flow.nodes.find((node) => node.id === target);
  if (!sourceNode || !targetNode || targetNode.type === "start" || sourceNode.type === "end") return false;
  const existingPortEdge = flow.edges.some((edge) => edge.source === source && edge.sourceHandle === sourceHandle);
  if (existingPortEdge) return false;
  if (targetNode.type === "decision" && flow.edges.some((edge) => edge.target === target)) return false;
  if (sourceNode.type === "start" && sourceHandle !== "next") return false;
  if (sourceNode.type === "decision" && !getBranchPorts(sourceNode).some((port) => port.id === sourceHandle)) return false;
  const descendants = new Set<string>();
  const visit = (id: string): void => {
    if (descendants.has(id)) return;
    descendants.add(id);
    for (const edge of flow.edges) if (edge.source === id) visit(edge.target);
  };
  visit(target);
  return !descendants.has(source);
}

export function beginBlockDrag(event: React.DragEvent, type: NodeDragType): void {
  event.dataTransfer.setData(BLOCK_TRANSFER_KEY, type);
  event.dataTransfer.effectAllowed = "copy";
}

export function FlowCanvas({ flow, selectedNodeId, active, onSelectNode, onChange, onAddAt, onNodeDrop }: FlowCanvasProps) {
  const { screenToFlowPosition, fitView } = useReactFlow();
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<Set<string>>(() => new Set());
  const [, setDimensionsRevision] = useState(0);
  const nodeDimensionsRef = useRef<Map<string, { width: number; height: number }>>(new Map());
  const flowRef = useRef(flow);
  const canvasElementRef = useRef<HTMLDivElement | null>(null);
  const canvasSizeRef = useRef({ width: 0, height: 0 });
  const activeRef = useRef(active);
  flowRef.current = flow;
  activeRef.current = active;
  useEffect(() => {
    const element = canvasElementRef.current;
    if (!element) return;
    let frame = 0;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const next = { width: Math.round(entry.contentRect.width), height: Math.round(entry.contentRect.height) };
      const previous = canvasSizeRef.current;
      canvasSizeRef.current = next;
      if (!activeRef.current || next.width === 0 || next.height === 0 || (next.width === previous.width && next.height === previous.height)) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          if (activeRef.current) void fitView({ padding: 0.2, maxZoom: 1 });
        });
      });
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [fitView]);
  const commitFlow = useCallback((next: DecisionFlow) => {
    flowRef.current = next;
    onChange(next);
  }, [onChange]);
  const nodes = toCanvasNodes(flow.nodes, selectedNodeId, nodeDimensionsRef.current);
  const edges = toCanvasEdges(flow.edges, selectedEdgeIds);

  const handleNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    let hasDimChange = false;
    for (const change of changes) {
      if (change.type === "dimensions" && change.dimensions) {
        nodeDimensionsRef.current.set(change.id, change.dimensions);
        hasDimChange = true;
      }
    }
    if (hasDimChange) {
      setDimensionsRevision((rev) => rev + 1);
    }

    if (!activeRef.current) return;
    const contentChanges = changes.filter((change) => change.type !== "select" && change.type !== "dimensions");
    if (contentChanges.length === 0) return;
    const current = flowRef.current;
    const updated = applyNodeChanges<CanvasNode>(contentChanges, toCanvasNodes(current.nodes, selectedNodeId, nodeDimensionsRef.current));
    const removedNodeIds = new Set<string>();
    for (const change of contentChanges) {
      if (change.type === "remove") {
        removedNodeIds.add(change.id);
        nodeDimensionsRef.current.delete(change.id);
      }
    }
    const next = removeFlowNodes({ ...current, nodes: fromCanvasNodes(updated) }, removedNodeIds);
    if (removedNodeIds.size > 0) {
      const remainingIds = new Set(next.edges.map((edge) => edge.id));
      setSelectedEdgeIds((currentIds) => new Set([...currentIds].filter((id) => remainingIds.has(id))));
    }
    commitFlow(next);
  }, [commitFlow, selectedNodeId]);

  const handleEdgesChange = useCallback((changes: EdgeChange<CanvasEdge>[]) => {
    if (!activeRef.current) return;
    if (changes.some((change) => change.type === "select")) {
      if (changes.some((change) => change.type === "select" && change.selected)) onSelectNode(null);
      setSelectedEdgeIds((current) => {
        const next = new Set(current);
        for (const change of changes) {
          if (change.type !== "select") continue;
          if (change.selected) next.add(change.id);
          else next.delete(change.id);
        }
        return next;
      });
    }
    const contentChanges = changes.filter((change) => change.type !== "select");
    if (contentChanges.length === 0) return;
    const current = flowRef.current;
    const updated = applyEdgeChanges<CanvasEdge>(contentChanges, toCanvasEdges(current.edges, selectedEdgeIds));
    const nextEdges = fromCanvasEdges(updated);
    const remainingIds = new Set(nextEdges.map((edge) => edge.id));
    setSelectedEdgeIds((currentIds) => {
      const next = new Set([...currentIds].filter((id) => remainingIds.has(id)));
      return next.size === currentIds.size ? currentIds : next;
    });
    if (JSON.stringify(nextEdges) !== JSON.stringify(current.edges)) commitFlow({ ...current, edges: nextEdges });
  }, [commitFlow, onSelectNode, selectedEdgeIds]);

  const handleConnect = useCallback((connection: Connection) => {
    const current = flowRef.current;
    if (!isConnectionAllowed(current, connection)) return;
    const updated = addEdge({ ...connection, id: createId(), type: "smoothstep" }, toCanvasEdges(current.edges, selectedEdgeIds));
    commitFlow({ ...current, edges: fromCanvasEdges(updated) });
  }, [commitFlow, selectedEdgeIds]);

  const handleDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const type = event.dataTransfer.getData(BLOCK_TRANSFER_KEY);
    if (!isNodeDragType(type)) return;
    onAddAt(type, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  }, [onAddAt, screenToFlowPosition]);

  const handleNodeClick = useCallback((_event: React.MouseEvent, node: CanvasNode) => {
    setSelectedEdgeIds(new Set());
    onSelectNode(node.id);
  }, [onSelectNode]);

  return (
    <div ref={canvasElementRef} className="canvas-wrap" onDrop={handleDrop} onDragOver={(event) => event.preventDefault()}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        isValidConnection={(connection) => isConnectionAllowed(flowRef.current, connection)}
        onNodeClick={handleNodeClick}
        onPaneClick={() => {
          setSelectedEdgeIds(new Set());
          onSelectNode(null);
        }}
        onNodeDragStop={(_event, node) => onNodeDrop(node.id)}
        deleteKeyCode={active ? ["Backspace", "Delete"] : null}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.2}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
        aria-label="決策流程畫布"
      >
        <Background color="var(--border)" gap={20} size={1} />
        <Controls showInteractive={false} />
        <MiniMap
          nodeColor={(node) => {
            const data: unknown = node.data;
            if (isRecord(data) && isRecord(data.flowNode)) {
              const flowNode = data.flowNode as unknown as FlowNode;
              if (flowNode.type === "start") return "#15805d";
              if (flowNode.type === "end") return "#208360";
              return "#426bc9";
            }
            return "#426bc9";
          }}
          nodeStrokeColor="#94a3b8"
          nodeStrokeWidth={1}
          nodeBorderRadius={4}
          maskColor="rgba(23, 38, 58, 0.08)"
          maskStrokeColor="#94a3b8"
          maskStrokeWidth={1}
          pannable
          zoomable
        />
      </ReactFlow>
    </div>
  );
}

function isNodeDragType(value: string): value is NodeDragType {
  return value === "choice" || value === "noul" || value === "score" || value === "end" || value.startsWith("template:");
}
