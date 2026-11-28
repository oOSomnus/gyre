/** Task Manager: omp chat processes, terminals and running sub-agents, with open/restart/kill. */
import type { ChatInfo, PaneSpec, PtyInfo } from "@gyre/protocol";
import { Activity, Bot, Cpu, MessagesSquare, SquareTerminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { progressOf, subStatus } from "../chat/SubagentCard";
import { api, gateway } from "../lib/gateway";
import { runningJobCount } from "../lib/jobs";
import { openChatPane, openJobsPane, useApp } from "../store/app";
import { useChats } from "../store/chats";

const POLL_TIMEOUT_MS = 10_000;

function uptime(since?: number): string {
	if (!since) return "";
	const s = Math.floor((Date.now() - since) / 1000);
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function TasksPane(_props: { pane: PaneSpec }) {
	const [chats, setChats] = useState<ChatInfo[]>([]);
	const [ptys, setPtys] = useState<PtyInfo[]>([]);
	const [loaded, setLoaded] = useState(false);
	const pollGeneration = useRef(0);
	const polling = useRef(false);
	const rerun = useRef(false);
	const reload = useRef<() => void>(() => {});
	const [error, setError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const action = (work: Promise<unknown>) => {
		setActionError(null);
		void work.then(() => {
			pollGeneration.current++;
			reload.current();
		}).catch(e => setActionError((e as Error).message));
	};
	const projects = useApp(s => s.projects);
	const workspaces = useApp(s => s.workspaces);
	const revealPane = useApp(s => s.revealPane);
	const chatStore = useChats(s => s.chats);
	const runningJobs = runningJobCount(chatStore);

	useEffect(() => {
		let live = true;
		/** Aborts the in-flight poll when the pane unmounts. */
		let inflight: AbortController | null = null;
		const load = async () => {
			// One poll at a time: an action that lands mid-poll queues a fresh read instead.
			if (polling.current) {
				rerun.current = true;
				return;
			}
			polling.current = true;
			const request = ++pollGeneration.current;
			const controller = new AbortController();
			inflight = controller;
			// Both requests share one deadline and one cancellation, so a hung gateway cannot wedge polling.
			const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(POLL_TIMEOUT_MS)]);
			try {
				const [c, p] = await Promise.all([api<ChatInfo[]>("/api/chats", { signal }), api<PtyInfo[]>("/api/ptys", { signal })]);
				if (live && request === pollGeneration.current) {
					setLoaded(true);
					setChats(c);
					setPtys(p);
					setError(null);
				}
			} catch (e) {
				if (live && request === pollGeneration.current) {
					setError(signal.reason instanceof DOMException && signal.reason.name === "TimeoutError" ? "Task list request timed out." : String((e as Error).message));
				}
			} finally {
				if (inflight === controller) inflight = null;
				polling.current = false;
				if (live && rerun.current) {
					rerun.current = false;
					void load();
				}
			}
		};
		reload.current = () => void load();
		void load();
		// Interval ticks skip while a poll is pending, so a slow poll can still land.
		const timer = setInterval(() => {
			if (!polling.current) void load();
		}, 2000);
		return () => {
			live = false;
			clearInterval(timer);
			inflight?.abort();
		};
	}, []);

	const projectName = (id: string) => projects.find(p => p.id === id)?.name ?? "project";
	const paneExists = (id: string) => workspaces.some(ws => ws.panes[id]);
	const title = (chat: ChatInfo) => {
		const state = chatStore[chat.chatId]?.state;
		return String(state?.sessionName ?? chat.sessionPath?.split("/").pop() ?? chat.chatId.slice(0, 8));
	};
	const subagents = Object.entries(chatStore).flatMap(([chatId, chat]) =>
		Object.values(chat.subagents)
			.filter(s => ["running", "pending", "started"].includes(subStatus(s)))
			.map(s => ({ chatId, sub: s })),
	);

	return (
		<div className="h-full overflow-auto" style={{ background: "var(--panel)" }}>
			{(error || actionError) && (
				<div className="gy-row text-[12px]" style={{ color: "var(--err)" }}>
					{actionError || error}
				</div>
			)}
			<div className="gy-section">
				<MessagesSquare size={13} /> omp chats <span className="ml-auto font-normal tracking-normal normal-case">{loaded ? `${chats.length} running` : "Loading…"}</span>
			</div>
			{loaded && chats.length === 0 && (
				<div className="gy-row text-[12.5px]" style={{ color: "var(--muted)" }}>
					No omp processes.
				</div>
			)}
			{chats.map(chat => (
				<div key={chat.chatId} className="gy-row flex-wrap">
					<span className="gy-chip">chat</span>
					<span className={`gy-chip ${chat.status === "exited" ? "err" : chat.busy ? "info" : "ok"}`}>
						{chat.status === "ready" ? (chat.busy ? "running" : "idle") : chat.status}
					</span>
					<div className="min-w-0 flex-1">
						<div className="truncate text-[13px] font-medium">{title(chat)}</div>
						<div className="truncate font-mono text-[11px]" style={{ color: "var(--muted)" }}>
							{projectName(chat.projectId)} · {chat.cwd} · up {uptime(chat.startedAt)} · {chat.subscribers ?? 0} viewer(s)
						</div>
					</div>
					{paneExists(chat.chatId) && (
						<button type="button" className="gy-btn" onClick={() => revealPane(chat.chatId)}>
							Open
						</button>
					)}
					<button type="button" className="gy-btn" onClick={() => action(api(`/api/chats/${encodeURIComponent(chat.chatId)}/restart`, { method: "POST" }))}>
						Restart
					</button>
					<button type="button" className="gy-btn danger" onClick={() => action(api(`/api/chats/${encodeURIComponent(chat.chatId)}/kill`, { method: "POST" }))}>
						Kill
					</button>
				</div>
			))}

			<div className="gy-section">
				<SquareTerminal size={13} /> Terminals <span className="ml-auto font-normal tracking-normal normal-case">{loaded ? `${ptys.length} running` : "Loading…"}</span>
			</div>
			{loaded && ptys.length === 0 && (
				<div className="gy-row text-[12.5px]" style={{ color: "var(--muted)" }}>
					No terminals.
				</div>
			)}
			{ptys.map(pty => (
				<div key={pty.ptyId} className="gy-row">
					<span className="gy-chip">terminal</span>
					<span className={`gy-chip ${pty.attached > 0 ? "ok" : ""}`}>{pty.attached > 0 ? "attached" : "detached"}</span>
					<div className="min-w-0 flex-1">
						<div className="truncate text-[13px]">{projectName(pty.projectId)}</div>
						<div className="truncate font-mono text-[11px]" style={{ color: "var(--muted)" }}>
							pid {pty.pid} · {pty.cwd} · up {uptime(pty.startedAt)}
						</div>
					</div>
					{pty.key && paneExists(pty.key) && (
						<button type="button" className="gy-btn" onClick={() => pty.key && revealPane(pty.key)}>
							Open
						</button>
					)}
					<button type="button" className="gy-btn danger" onClick={() => action(api(`/api/ptys/${pty.ptyId}`, { method: "DELETE" }))}>
						Kill
					</button>
				</div>
			))}

			<div className="gy-section">
				<Bot size={13} /> Sub-agents <span className="ml-auto font-normal tracking-normal normal-case">{subagents.length} active</span>
			</div>
			{subagents.length === 0 && (
				<div className="gy-row text-[12.5px]" style={{ color: "var(--muted)" }}>
					No running sub-agents.
				</div>
			)}
			{subagents.map(({ chatId, sub }) => {
				const p = progressOf(sub);
				return (
					<div key={`${chatId}:${sub.id}`} className="gy-row">
						<span className="gy-chip info">{subStatus(sub)}</span>
						<button
							type="button"
							className="min-w-0 flex-1 text-left"
							title="Open its conversation"
							data-jump="open-subagent"
							onClick={() => openChatPane("subagent", chatId, { ref: sub.id, subagentId: sub.subagentId })}
						>
							<div className="truncate text-[13px]">
								{String(sub.agent ?? "agent")} · {String(sub.description ?? "")}
							</div>
							<div className="truncate font-mono text-[11px]" style={{ color: "var(--muted)" }}>
								{p.currentTool ?? "thinking"} {p.toolCount ? `· ${p.toolCount} tools` : ""}
							</div>
						</button>
						{sub.subagentId && (
							<button
								type="button"
								className="gy-btn danger"
								onClick={() => action(gateway.rpc(chatId, { type: "cancel_subagent", subagentId: sub.subagentId }))}
							>
								Cancel
							</button>
						)}
					</div>
				);
			})}
			<button type="button" className="gy-row w-full text-left text-[12px]" onClick={() => openJobsPane()} data-testid="tasks-jobs">
				<Cpu size={13} />
				<span className="flex-1">
					Background jobs: {runningJobs ? `${runningJobs} running` : "none running"}
				</span>
				<span style={{ color: "var(--muted)" }}>Open</span>
			</button>
		</div>
	);
}
