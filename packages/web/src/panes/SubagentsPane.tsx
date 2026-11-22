import type { PaneSpec } from "@gyre/protocol";
import { Bot, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { gateway } from "../lib/gateway";
import { useApp } from "../store/app";
import { type SubagentInfo, useChats } from "../store/chats";

/** Live view of task sub-agents spawned by the focused (or chosen) chat. */
export function SubagentsPane({ pane }: { pane: PaneSpec }) {
	const chats = useApp(s => s.workspaces.find(w => w.id === s.activeWorkspaceId)?.panes ?? {});
	const chatPanes = Object.values(chats).filter(p => p.kind === "chat");
	const [chatId, setChatId] = useState<string | undefined>(pane.chatId ?? chatPanes[0]?.id);
	const chat = useChats(s => (chatId ? s.chats[chatId] : undefined));
	const [actionError, setActionError] = useState<string | null>(null);
	const [snapshot, setSnapshot] = useState<SubagentInfo[]>([]);

	useEffect(() => {
		let current = true;
		setSnapshot([]);
		if (!chatId || chat?.info.status !== "ready") return;
		void gateway.rpc(chatId, { type: "set_subagent_subscription", level: "progress" }).catch(() => undefined);
		const poll = () =>
			void gateway
				.rpc<SubagentInfo[] | { subagents?: SubagentInfo[] }>(chatId, { type: "get_subagents" })
				.then(data => {
					if (current) setSnapshot(Array.isArray(data) ? data : (data?.subagents ?? []));
				})
				.catch(() => undefined);
		poll();
		const timer = setInterval(poll, 3000);
		return () => {
			current = false;
			clearInterval(timer);
		};
	}, [chatId, chat?.info.status]);

	const merged = new Map<string, SubagentInfo>();
	for (const s of snapshot) merged.set(s.id, { ...s, subagentId: s.subagentId ?? s.id });
	for (const s of Object.values(chat?.subagents ?? {})) merged.set(s.id, { ...merged.get(s.id), ...s });
	const list = [...merged.values()].sort((a, b) => (b.lastUpdate ?? 0) - (a.lastUpdate ?? 0));

	return (
		<div className="flex h-full flex-col" data-pane-kind={pane.kind}>
			<div className="flex items-center gap-2 border-b p-2" style={{ borderColor: "var(--border)" }}>
				<span className="gy-label">chat</span>
				<select className="gy-input min-w-0 flex-1" value={chatId} onChange={e => setChatId(e.target.value)}>
					{chatPanes.map(p => (
						<option key={p.id} value={p.id}>
							{useChats.getState().chats[p.id]?.state?.sessionName ?? `Chat ${p.id.slice(0, 6)}`}
						</option>
					))}
				</select>
			</div>
			<div className="min-h-0 flex-1 space-y-2 overflow-auto p-2">
				{actionError && <div role="alert" style={{ color: "var(--err)" }}>{actionError}</div>}
				{list.length === 0 && (
					<div className="p-3 text-[12.5px]" style={{ color: "var(--muted)" }}>
						No sub-agents running. They appear here when the agent delegates with the task tool.
					</div>
				)}
				{list.map(agent => (
					<div key={agent.id} className="gy-card tool">
						<div className="gy-card-head">
							<Bot size={13} style={{ color: "var(--tool)" }} />
							<span className="gy-label" style={{ color: "var(--tool)" }}>
								{String(agent.agent ?? "agent")}
							</span>
							<span className="min-w-0 flex-1 truncate text-[12.5px]">{String(agent.description ?? agent.task ?? "")}</span>
							<span className="gy-chip">{String(agent.status ?? "…")}</span>
							{chatId && (agent.status === "running" || agent.status === "pending") && (
								<button
									type="button"
									className="gy-icon-btn"
									title="Cancel"
									onClick={() => {
									setActionError(null);
									void gateway.rpc(chatId, { type: "cancel_subagent", subagentId: agent.subagentId ?? agent.id }).catch(e => setActionError((e as Error).message));
								}}
								>
									<Square size={12} />
								</button>
							)}
						</div>
						{typeof agent.assignment === "string" && (
							<div className="gy-card-body text-[12px]" style={{ color: "var(--text-dim)" }}>
								{agent.assignment.slice(0, 600)}
							</div>
						)}
					</div>
				))}
			</div>
		</div>
	);
}
