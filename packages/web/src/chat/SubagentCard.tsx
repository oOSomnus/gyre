/** Live sub-agent cards inside a `task` tool card (matched by parent tool call). */
import { Bot, ExternalLink, Loader2, Square } from "lucide-react";
import { gateway } from "../lib/gateway";
import { formatTokens } from "../lib/omp";
import { openChatPane } from "../store/app";
import { type SubagentInfo, useChats } from "../store/chats";

export interface Progress {
	status?: string;
	currentTool?: string;
	currentToolIntent?: string;
	lastIntent?: string;
	recentOutput?: string[];
	toolCount?: number;
	tokens?: number | { total?: number };
	cost?: number;
	durationMs?: number;
	resolvedModel?: string | { provider?: string; id?: string };
	resolvedThinkingLevel?: string;
	contextTokens?: number;
	contextWindow?: number;
}

export function progressOf(sub: SubagentInfo): Progress {
	return (sub.progress ?? {}) as Progress;
}

export function subStatus(sub: SubagentInfo): string {
	return String(progressOf(sub).status ?? sub.status ?? "pending");
}

export function modelName(model: Progress["resolvedModel"]): string | undefined {
	if (!model) return undefined;
	if (typeof model === "string") return model;
	return model.provider && model.id ? `${model.provider}/${model.id}` : model.id;
}

const ACTIVE = new Set(["pending", "running", "started"]);

export function SubagentCard({ chatId, sub }: { chatId: string; sub: SubagentInfo }) {
	const p = progressOf(sub);
	const status = subStatus(sub);
	const active = ACTIVE.has(status);
	const tokens = typeof p.tokens === "number" ? p.tokens : p.tokens?.total;
	const chip = status === "completed" ? "ok" : status === "failed" || status === "aborted" ? "err" : "info";
	const lines = (p.recentOutput ?? []).slice(0, 3).reverse();
	return (
		<div className="gy-card subagent" data-subagent={sub.id}>
			<div className="gy-card-head">
				<div className="gy-card-label">
					<Bot size={13} />
					{String(sub.agent ?? "agent")}
					<span className={`gy-chip ${chip}`}>{status}</span>
					<span className="min-w-0 flex-1 truncate font-sans text-[12px] font-normal tracking-normal normal-case" style={{ color: "var(--text-dim)" }}>
						{String(sub.description ?? sub.task ?? "")}
					</span>
				</div>
				<div className="gy-card-meta">
					{modelName(p.resolvedModel) && <span title="model">{modelName(p.resolvedModel)}</span>}
					{tokens ? <span>{formatTokens(tokens)} tok</span> : null}
					{typeof p.cost === "number" && p.cost > 0 ? <span>${p.cost.toFixed(4)}</span> : null}
					<button
						type="button"
						title="Open in a pane"
						data-jump="open-subagent"
						onClick={() => openChatPane("subagent", chatId, { ref: sub.id, subagentId: sub.subagentId })}
					>
						<ExternalLink size={12} />
					</button>
					{active && sub.subagentId && (
						<button
							type="button"
							title="Cancel"
							onClick={() => void gateway.rpc(chatId, { type: "cancel_subagent", subagentId: sub.subagentId }).catch(e => useChats.getState().apply(chatId, { type: "notice", level: "error", message: (e as Error).message }))}
						>
							<Square size={11} />
						</button>
					)}
				</div>
			</div>
			{(active || lines.length > 0) && (
				<div className="gy-card-body space-y-1 py-2 text-[12px]">
					{active && (
						<div className="flex items-center gap-2" style={{ color: "var(--text-dim)" }}>
							<Loader2 size={12} className="animate-spin" />
							<span className="truncate">
								{p.currentTool ? <span className="font-mono">{p.currentTool}</span> : "thinking"}
								{p.currentToolIntent || p.lastIntent ? ` · ${p.currentToolIntent ?? p.lastIntent}` : ""}
							</span>
							{p.toolCount ? <span className="gy-label ml-auto">{p.toolCount} tools</span> : null}
						</div>
					)}
					{lines.length > 0 && (
						<pre className="gy-pre" style={{ maxHeight: 90 }}>
							{lines.join("\n")}
						</pre>
					)}
				</div>
			)}
		</div>
	);
}

export function SubagentCards({ chatId, toolCallId, fallback }: { chatId: string; toolCallId: string; fallback?: React.ReactNode }) {
	const map = useChats(s => s.chats[chatId]?.subagents);
	const subs = Object.values(map ?? {}).filter(sub => sub.parentToolCallId === toolCallId);
	if (subs.length === 0) return fallback ?? null;
	return (
		<div className="space-y-2">
			{subs
				.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
				.map(sub => (
					<SubagentCard key={sub.id} chatId={chatId} sub={sub} />
				))}
		</div>
	);
}
