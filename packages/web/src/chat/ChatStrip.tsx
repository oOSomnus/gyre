/** Per-chat status strip above the composer (cache, state, modes, thinking, speed, context). */
import { Bot, ClipboardList, Crosshair, ListChecks, Workflow } from "lucide-react";
import { gateway } from "../lib/gateway";
import { contextPercent, formatTokens } from "../lib/omp";
import { chatStatus, STATUS_LABEL } from "../lib/status";
import { openChatPane, useApp } from "../store/app";
import { useChats } from "../store/chats";

function Sparkline({ values }: { values: number[] }) {
	if (values.length < 2) return null;
	const max = Math.max(...values, 1);
	const pts = values.map((v, i) => `${(i / (values.length - 1)) * 44},${14 - (v / max) * 12}`).join(" ");
	return (
		<svg width="46" height="16" className="ml-1 inline-block align-middle" aria-hidden>
			<polyline points={pts} fill="none" stroke="var(--spark)" strokeWidth="1.3" />
		</svg>
	);
}

function Ring({ percent }: { percent: number | null }) {
	const p = Math.max(0, Math.min(100, percent ?? 0));
	const r = 9;
	const c = 2 * Math.PI * r;
	const color = p > 85 ? "var(--st-error)" : p > 65 ? "var(--st-waiting)" : "var(--led-on)";
	return (
		<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden>
			<circle cx="12" cy="12" r={r} fill="none" stroke="var(--ring-track)" strokeWidth="3.5" />
			<circle cx="12" cy="12" r={r} fill="none" stroke={color} strokeWidth="3.5" strokeDasharray={`${(p / 100) * c} ${c}`} transform="rotate(-90 12 12)" />
		</svg>
	);
}

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function ChatStrip({ chatId }: { chatId: string }) {
	const chat = useChats(s => s.chats[chatId]);
	const setJumpMode = useApp(s => s.setJumpMode);
	const jumpMode = useApp(s => s.jumpMode);
	const openModelPicker = useApp(s => s.openModelPicker);
	if (!chat) return null;
	const state = chat.state;
	const stats = chat.stats;
	const status = chatStatus(chat);
	const ctx = contextPercent(stats?.contextUsage ?? state?.contextUsage);
	const remaining = chat.todoPhases.flatMap(p => p.tasks).filter(t => t.status === "pending" || t.status === "in_progress").length;
	const runningSubagents = Object.values(chat.subagents).filter(s => {
		const st = String(s.status ?? (s.progress as { status?: string } | undefined)?.status ?? "");
		return st === "running" || st === "started" || st === "pending";
	}).length;
	const plan = chat.plan;
	const planOn = plan && plan.phase !== "idle";
	const dot = { running: "var(--st-running)", waiting: "var(--st-waiting)", error: "var(--st-error)", idle: "var(--st-idle)", none: "var(--st-none)" }[status];
	const tps = state?.tokensPerSecond;
	const levels = (state?.thinkingLevels as string[] | undefined) ?? LEVELS;
	const level = state?.thinkingLevel ?? "off";
	const cost = typeof stats?.cost === "number" ? stats.cost : undefined;

	const cycleThinking = () => {
		const next = levels[(levels.indexOf(level) + 1) % levels.length] ?? "off";
		void gateway.rpc(chatId, { type: "set_thinking_level", level: next }).catch(() => undefined);
	};
	const togglePlan = () => {
		const command = planOn ? { action: "cancel" } : { action: "enter" };
		void gateway.rpc(chatId, { type: "prompt", message: `/gyre-plan ${JSON.stringify(command)}` }).catch(() => undefined);
	};
	const hasPlanMode = chat.commands.some(c => c.name === "gyre-plan");

	return (
		<div className="@container">
		<div className="gy-strip" data-testid="chat-strip">
			<div className="gy-strip-cell w-[78px] @max-[620px]:hidden" title={`cache read ${stats?.tokens?.cacheRead ?? 0} tokens`}>
				<span className="k">C. Read</span>
				<span className="v">{formatTokens(stats?.tokens?.cacheRead)}</span>
			</div>
			<div className="gy-strip-cell w-[104px] shrink-0">
				<span className="k">chat</span>
				<span className="v flex items-center gap-1.5">
					<span className={`inline-block h-2 w-2 rounded-full ${status === "running" ? "gy-pulse" : ""}`} style={{ background: dot }} />
					{state?.isCompacting ? "compacting" : status === "none" ? chat.info.status : STATUS_LABEL[status] === "done" ? "idle" : STATUS_LABEL[status]}
				</span>
			</div>
			<button
				type="button"
				className="gy-strip-cell min-w-[90px] flex-1 text-left"
				onClick={() => openModelPicker(chatId)}
				data-jump="model"
				title={`Model (Ctrl+M)${cost !== undefined ? ` · session cost $${cost.toFixed(4)}` : ""}`}
			>
				<span className="k">model</span>
				<span className="v">{state?.model ? `${state.model.provider}/${state.model.id}` : "–"}</span>
			</button>
			<button type="button" className="gy-strip-icon" title="Marks: label everything (Alt+W)" data-on={jumpMode} onClick={() => setJumpMode(!jumpMode)}>
				<Crosshair size={15} />
			</button>
			{hasPlanMode && (
				<button
					type="button"
					className="gy-strip-icon"
					title={planOn ? `Plan mode: ${plan?.phase} (click to leave)` : "Enter plan mode"}
					data-on={Boolean(planOn)}
					onClick={togglePlan}
					data-jump="plan-mode"
				>
					<ClipboardList size={15} />
					{planOn && <span className="gy-badge">{plan?.phase === "reviewing" ? "!" : "P"}</span>}
				</button>
			)}
			<button type="button" className="gy-strip-icon" title="Objectives" onClick={() => openChatPane("objectives", chatId)} data-jump="objectives">
				<ListChecks size={15} />
				{remaining > 0 && <span className="gy-badge">{remaining}</span>}
			</button>
			<button type="button" className="gy-strip-icon" title="Sub-agents" onClick={() => openChatPane("subagents", chatId)} data-jump="subagents">
				<Bot size={15} />
				<span className="gy-badge">{runningSubagents}</span>
			</button>
			<button type="button" className="gy-strip-icon @max-[700px]:hidden" title="Event graph" onClick={() => openChatPane("graph", chatId)} data-jump="graph">
				<Workflow size={15} />
			</button>
			<button type="button" className="gy-strip-cell w-[70px] shrink-0 text-left" onClick={cycleThinking} title="Thinking level (click to cycle)" data-jump="thinking">
				<span className="k">think</span>
				<span className="v">{level}</span>
			</button>
			<div className="gy-strip-cell w-[100px] @max-[560px]:hidden">
				<span className="k">t/s</span>
				<span className="v">
					{tps ? tps.toFixed(1) : "–"}
					<Sparkline values={chat.tpsHistory} />
				</span>
			</div>
			<div className="gy-strip-icon w-[36px]" title={ctx == null ? "context" : `context ${ctx.toFixed(0)}%`}>
				<Ring percent={ctx} />
			</div>
		</div>
		</div>
	);
}
