/** Objectives: omp goal mode plus the todo phases the agent tracks, with a completion timeline. */
import type { PaneSpec } from "@gyre/protocol";
import { CheckCircle2, Circle, CircleDashed, CircleSlash, ClipboardList, Pause, Play, Target, Trash2 } from "lucide-react";
import { useState } from "react";
import { time } from "../chat/Cards";
import { gateway } from "../lib/gateway";
import { openChatPane } from "../store/app";
import { refreshState, type TodoTask, useChats } from "../store/chats";

interface Goal {
	id: string;
	objective: string;
	status: "active" | "paused" | "budget-limited" | "complete" | "dropped";
	tokenBudget?: number;
	tokensUsed?: number;
	timeUsedSeconds?: number;
}

const ICON: Record<TodoTask["status"], typeof Circle> = {
	pending: Circle,
	in_progress: CircleDashed,
	completed: CheckCircle2,
	abandoned: CircleSlash,
};
const COLOR: Record<TodoTask["status"], string> = {
	pending: "var(--muted)",
	in_progress: "var(--warn)",
	completed: "var(--ok)",
	abandoned: "var(--err)",
};

export function ObjectivesPane({ pane }: { pane: PaneSpec }) {
	const chatId = pane.chatId ?? "";
	const chat = useChats(s => s.chats[chatId]);
	const [objective, setObjective] = useState("");
	const [error, setError] = useState<string | null>(null);
	if (!chat) return <div className="p-4 text-[12.5px]">This pane is not attached to a running chat.</div>;
	const goal = (chat.state as { goal?: { goal?: Goal } | Goal | null } | null)?.goal;
	const g: Goal | undefined = goal && "objective" in goal ? goal : (goal as { goal?: Goal } | undefined)?.goal;
	const phases = chat.todoPhases;
	const all = phases.flatMap(p => p.tasks);
	const done = all.filter(t => t.status === "completed").length;
	// Timeline: completed todo updates, newest first.
	const timeline = Object.entries(chat.toolExec)
		.filter(([, exec]) => exec.status === "done" && (exec.args as { op?: string } | undefined)?.op && ["done", "start"].includes(String((exec.args as { op?: string }).op)))
		.map(([id, exec]) => ({ id, ts: exec.endedAt ?? exec.startedAt, op: String((exec.args as { op?: string }).op), task: (exec.args as { task?: unknown }).task }))
		.sort((a, b) => b.ts - a.ts)
		.slice(0, 30);

	const goalCmd = async (body: Record<string, unknown>) => {
		setError(null);
		try {
			await gateway.rpc(chatId, { type: "goal", ...body }, 60_000);
			refreshState(chatId, 0);
		} catch (e) {
			setError(String((e as Error).message));
		}
	};

	return (
		<div className="h-full overflow-auto" style={{ background: "var(--panel)" }}>
			<div className="gy-section">
				<Target size={13} /> Goal
			</div>
			{g ? (
				<div className="gy-row flex-wrap">
					<span className={`gy-chip ${g.status === "active" ? "info" : g.status === "complete" ? "ok" : "warn"}`}>{g.status}</span>
					<span className="min-w-0 flex-1 text-[13px]">{g.objective}</span>
					{g.tokenBudget ? (
						<span className="gy-label">
							{g.tokensUsed ?? 0}/{g.tokenBudget} tok
						</span>
					) : null}
					{g.status === "active" && (
						<button type="button" className="gy-btn" onClick={() => void goalCmd({ op: "pause" })}>
							<Pause size={11} /> Pause
						</button>
					)}
					{g.status === "paused" && (
						<button type="button" className="gy-btn" onClick={() => void goalCmd({ op: "resume" })}>
							<Play size={11} /> Resume
						</button>
					)}
					{g.status !== "dropped" && g.status !== "complete" && (
						<button type="button" className="gy-btn danger" onClick={() => void goalCmd({ op: "drop" })}>
							<Trash2 size={11} /> Drop
						</button>
					)}
				</div>
			) : (
				<form
					className="gy-row"
					onSubmit={e => {
						e.preventDefault();
						if (objective.trim()) void goalCmd({ op: "create", objective: objective.trim() }).then(() => setObjective(""));
					}}
				>
					<input className="gy-input flex-1" placeholder="Track an objective: the agent keeps working until it is met" value={objective} onChange={e => setObjective(e.target.value)} />
					<button type="submit" className="gy-btn primary" disabled={!objective.trim()}>
						Track objective
					</button>
				</form>
			)}
			{error && <div className="gy-row text-[12px]" style={{ color: "var(--err)" }}>{error}</div>}

			<div className="gy-section">
				<ClipboardList size={13} /> Checklist
				<span className="ml-auto font-normal tracking-normal normal-case">
					{done}/{all.length} done
				</span>
			</div>
			{chat.plan?.planFilePath && (
				<button type="button" className="gy-row w-full text-left text-[12.5px]" onClick={() => openChatPane("plan", chatId)}>
					<span className="gy-chip warn">plan</span> {chat.plan.title ?? chat.plan.planFilePath}
				</button>
			)}
			{phases.length === 0 && (
				<div className="gy-row text-[12.5px]" style={{ color: "var(--muted)" }}>
					No todo list yet. The agent creates one with its todo tool for multi-step work.
				</div>
			)}
			{phases.map(phase => (
				<div key={phase.name}>
					<div className="px-3 pt-2 pb-1 font-mono text-[11px] font-semibold tracking-wider uppercase" style={{ color: "var(--text-dim)" }}>
						{phase.name}
					</div>
					{phase.tasks.map((task, i) => {
						const Icon = ICON[task.status] ?? Circle;
						return (
							// biome-ignore lint/suspicious/noArrayIndexKey: tasks have no ids
							<div key={i} className="gy-row items-start py-1.5">
								<Icon size={15} style={{ color: COLOR[task.status] }} className="mt-0.5 shrink-0" />
								<div className="min-w-0 flex-1">
									<div className="text-[13px]" style={task.status === "completed" || task.status === "abandoned" ? { textDecoration: "line-through", color: "var(--muted)" } : undefined}>
										{task.content}
									</div>
									{(task.notes || task.details) && (
										<div className="text-[12px]" style={{ color: "var(--text-dim)" }}>
											{task.notes ?? task.details}
										</div>
									)}
								</div>
								<span className="gy-label">{task.status.replace("_", " ")}</span>
							</div>
						);
					})}
				</div>
			))}

			{timeline.length > 0 && (
				<>
					<div className="gy-section">Timeline</div>
					{timeline.map(entry => (
						<div key={entry.id} className="gy-row py-1 text-[12px]">
							<span className="gy-label w-16">{time(entry.ts)}</span>
							<span className={`gy-chip ${entry.op === "done" ? "ok" : "info"}`}>{entry.op === "done" ? "done" : "started"}</span>
							<span className="truncate">{Array.isArray(entry.task) ? entry.task.join(", ") : String(entry.task ?? "")}</span>
						</div>
					))}
				</>
			)}
		</div>
	);
}
