/**
 * Event graph: every prompt, reply, tool request, tool result, sub-agent and
 * objective as a color-coded node, linked into a tree. Pan, zoom, minimap and
 * filters by node type.
 */
import type { PaneSpec } from "@gyre/protocol";
import { Background, Controls, type Edge, MiniMap, type Node, ReactFlow } from "@xyflow/react";
import { useMemo, useState } from "react";
import { type AgentMessage, type ToolCallBlock, textOf } from "../lib/omp";
import { THEMES } from "../lib/themes";
import { viewMessage } from "../store/actions";
import { useApp } from "../store/app";
import { type ChatState, useChats } from "../store/chats";

type Kind = "prompt" | "assistant" | "tool" | "result" | "subagent" | "objective";

const KINDS: Array<{ kind: Kind; label: string; tint: string }> = [
	{ kind: "prompt", label: "Prompts", tint: "var(--tint-user)" },
	{ kind: "assistant", label: "Assistant", tint: "var(--tint-assistant)" },
	{ kind: "tool", label: "Tool requests", tint: "var(--tint-tool)" },
	{ kind: "result", label: "Results", tint: "var(--tint-command)" },
	{ kind: "subagent", label: "Sub-agents", tint: "var(--tint-subagent)" },
	{ kind: "objective", label: "Objectives", tint: "var(--tint-plan)" },
];
const TINT = Object.fromEntries(KINDS.map(k => [k.kind, k.tint])) as Record<Kind, string>;

const clip = (s: string, n = 70) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

interface Built {
	nodes: Array<Node & { data: { kind: Kind; label: string; detail?: string; message?: AgentMessage } }>;
	edges: Edge[];
}

function build(chat: ChatState, enabled: Set<Kind>): Built {
	const nodes: Built["nodes"] = [];
	const edges: Edge[] = [];
	let row = 0;
	let spine: string | null = null;
	const add = (id: string, kind: Kind, label: string, x: number, y: number, extra: Partial<Built["nodes"][number]["data"]> = {}) => {
		nodes.push({
			id,
			position: { x, y },
			className: "gy-node",
			data: { kind, label, ...extra },
			style: { width: 220, background: TINT[kind] },
		});
	};
	const link = (from: string | null, to: string, dashed = false) => {
		if (from) edges.push({ id: `${from}->${to}`, source: from, target: to, style: dashed ? { strokeDasharray: "4 3" } : undefined });
	};

	chat.items.forEach((item, index) => {
		if (item.kind !== "message") return;
		const m = item.message;
		if (m.role === "user" && enabled.has("prompt")) {
			const id = `u${index}`;
			add(id, "prompt", clip(textOf(m.content) || "(prompt)"), 0, row * 90, { message: m });
			link(spine, id);
			spine = id;
			row++;
		} else if (m.role === "assistant") {
			const blocks = Array.isArray(m.content) ? m.content : [];
			const text = textOf(m.content);
			let anchor = spine;
			if (enabled.has("assistant") && (text.trim() || blocks.length === 0)) {
				const id = `a${index}`;
				add(id, "assistant", clip(text.trim() || "(reply)"), 0, row * 90, { message: m, detail: m.model });
				link(spine, id);
				spine = id;
				anchor = id;
				row++;
			}
			let lane = 0;
			for (const block of blocks) {
				if (block.type !== "toolCall") continue;
				const call = block as ToolCallBlock;
				const y = (row - 1 + lane) * 90;
				if (enabled.has("tool")) {
					add(`t${call.id}`, "tool", `${call.name}${call.intent ? ` · ${clip(call.intent, 40)}` : ""}`, 280, Math.max(0, y));
					link(anchor, `t${call.id}`);
				}
				const result = chat.toolResults[call.id] ?? undefined;
				const exec = chat.toolExec[call.id];
				if (enabled.has("result") && (result || exec?.status !== "running")) {
					const failed = result?.isError || exec?.status === "error";
					add(`r${call.id}`, "result", `${failed ? "error" : "ok"} · ${clip(textOf(result?.content).split("\n")[0] ?? "", 40)}`, 560, Math.max(0, y));
					link(enabled.has("tool") ? `t${call.id}` : anchor, `r${call.id}`);
				}
				if (enabled.has("subagent")) {
					for (const sub of Object.values(chat.subagents).filter(s => s.parentToolCallId === call.id)) {
						lane++;
						const sid = `s${sub.id}`;
						add(sid, "subagent", `${String(sub.agent ?? "agent")} · ${clip(String(sub.description ?? ""), 40)}`, 560, Math.max(0, (row - 1 + lane) * 90));
						link(enabled.has("tool") ? `t${call.id}` : anchor, sid, true);
					}
				}
				lane++;
			}
			if (lane > 1) row += lane - 1;
		}
	});

	if (enabled.has("objective")) {
		chat.todoPhases.forEach((phase, pi) => {
			const pid = `o${pi}`;
			const done = phase.tasks.filter(t => t.status === "completed").length;
			add(pid, "objective", `${phase.name} · ${done}/${phase.tasks.length}`, 860, pi * 90);
			if (pi > 0) link(`o${pi - 1}`, pid);
		});
	}
	return { nodes, edges };
}

export function GraphPane({ pane }: { pane: PaneSpec }) {
	const theme = useApp(s => s.theme);
	const chatId = pane.chatId ?? "";
	const chat = useChats(s => s.chats[chatId]);
	const [enabled, setEnabled] = useState<Set<Kind>>(() => new Set(KINDS.map(k => k.kind)));
	const graph = useMemo(() => (chat ? build(chat, enabled) : { nodes: [], edges: [] }), [chat, enabled]);
	if (!chat) return <div className="p-4 text-[12.5px]">This graph is not attached to a running chat.</div>;
	const toggle = (kind: Kind) =>
		setEnabled(prev => {
			const next = new Set(prev);
			if (next.has(kind)) next.delete(kind);
			else next.add(kind);
			return next;
		});

	return (
		<div className="flex h-full min-h-0 flex-col" style={{ background: "var(--panel)" }}>
			<div className="flex flex-wrap items-center gap-1.5 border-b px-2 py-1.5" style={{ borderColor: "var(--border-strong)", background: "var(--panel-2)" }}>
				{KINDS.map(k => (
					<button
						type="button"
						key={k.kind}
						className="gy-chip"
						style={{ background: enabled.has(k.kind) ? k.tint : "transparent", opacity: enabled.has(k.kind) ? 1 : 0.55 }}
						onClick={() => toggle(k.kind)}
					>
						{k.label}
					</button>
				))}
				<span className="ml-auto gy-label">{graph.nodes.length} nodes</span>
			</div>
			<div className="min-h-0 flex-1">
				<ReactFlow
					nodes={graph.nodes.map(n => ({ ...n, data: { ...n.data, label: n.data.label } }))}
					edges={graph.edges}
					fitView
					minZoom={0.1}
					nodesDraggable={false}
					nodesConnectable={false}
					onNodeDoubleClick={(_e, node) => {
						const message = (node.data as { message?: AgentMessage }).message;
						if (message) viewMessage(chatId, message);
					}}
				>
					<Background gap={20} />
					<MiniMap pannable zoomable nodeColor={n => THEMES[theme].graph[(n.data as { kind: Kind }).kind] ?? THEMES[theme].graph.assistant} />
					<Controls showInteractive={false} />
				</ReactFlow>
			</div>
		</div>
	);
}
