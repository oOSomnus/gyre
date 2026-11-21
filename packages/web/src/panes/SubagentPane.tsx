/** One sub-agent's live card plus its transcript (incremental get_subagent_messages), with steer and cancel. */
import type { PaneSpec } from "@gyre/protocol";
import { Loader2, Send, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AssistantMessage, GenericMessage, UserCard } from "../chat/Cards";
import { modelName, progressOf, subStatus } from "../chat/SubagentCard";
import { gateway } from "../lib/gateway";
import { formatTokens, type AgentMessage } from "../lib/omp";
import { useChats } from "../store/chats";

export function SubagentPane({ pane }: { pane: PaneSpec }) {
	const chatId = pane.chatId ?? "";
	const sub = useChats(s => (pane.ref ? s.chats[chatId]?.subagents[pane.ref] : undefined));
	const subagentId = sub?.subagentId ?? pane.subagentId;
	const sessionFile = sub?.sessionFile;
	const [messages, setMessages] = useState<AgentMessage[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [steer, setSteer] = useState("");
	const cursor = useRef(0);
	const status = sub ? subStatus(sub) : "unknown";
	const active = status === "running" || status === "pending" || status === "started";

	useEffect(() => {
		if (!chatId || (!subagentId && !sessionFile)) return;
		let live = true;
		const poll = async () => {
			try {
				const data = await gateway.rpc<{ messages?: AgentMessage[]; nextByte?: number; reset?: boolean }>(chatId, {
					type: "get_subagent_messages",
					...(subagentId ? { subagentId } : { sessionFile }),
					fromByte: cursor.current,
				});
				if (!live) return;
				if (data.reset) setMessages(data.messages ?? []);
				else if (data.messages?.length) setMessages(m => [...m, ...(data.messages ?? [])]);
				cursor.current = data.nextByte ?? cursor.current;
				setError(null);
			} catch (e) {
				if (live) setError(String((e as Error).message));
			}
		};
		void poll();
		const timer = setInterval(poll, active ? 1500 : 6000);
		return () => {
			live = false;
			clearInterval(timer);
		};
	}, [chatId, subagentId, sessionFile, active]);

	const p = sub ? progressOf(sub) : {};
	const tokens = typeof p.tokens === "number" ? p.tokens : p.tokens?.total;
	const toolResults = Object.fromEntries(messages.filter(m => m.role === "toolResult" && m.toolCallId).map(m => [m.toolCallId as string, m]));

	return (
		<div className="flex h-full min-h-0 flex-col" style={{ background: "var(--panel)" }}>
			<div className="flex flex-wrap items-center gap-2 border-b px-2 py-1.5" style={{ borderColor: "var(--border-strong)", background: "var(--tint-subagent)" }}>
				<span className="font-mono text-[11.5px] font-semibold tracking-widest uppercase">{String(sub?.agent ?? "sub-agent")}</span>
				<span className={`gy-chip ${status === "completed" ? "ok" : active ? "info" : "err"}`}>{status}</span>
				{modelName(p.resolvedModel) && <span className="font-mono text-[11px]">{modelName(p.resolvedModel)}</span>}
				{tokens ? <span className="gy-label">{formatTokens(tokens)} tok</span> : null}
				<span className="min-w-0 flex-1 truncate text-[12px]">{String(sub?.description ?? "")}</span>
				{active && subagentId && (
					<button type="button" className="gy-btn danger" onClick={() => void gateway.rpc(chatId, { type: "cancel_subagent", subagentId })}>
						<Square size={10} /> Cancel
					</button>
				)}
			</div>
			<div className="min-h-0 flex-1 space-y-2 overflow-auto p-2">
				{error && <div className="text-[12px]" style={{ color: "var(--err)" }}>{error}</div>}
				{messages.length === 0 && !error && (
					<div className="flex items-center gap-2 p-3 text-[12.5px]" style={{ color: "var(--muted)" }}>
						<Loader2 size={13} className="animate-spin" /> Waiting for the transcript…
					</div>
				)}
				{messages.map((m, i) =>
					m.role === "user" ? (
						// biome-ignore lint/suspicious/noArrayIndexKey: transcript order
						<UserCard key={i} message={m} />
					) : m.role === "assistant" ? (
						// biome-ignore lint/suspicious/noArrayIndexKey: transcript order
						<AssistantMessage key={i} message={m} streaming={false} toolExec={{}} toolResults={toolResults} />
					) : m.role === "toolResult" ? null : (
						// biome-ignore lint/suspicious/noArrayIndexKey: transcript order
						<GenericMessage key={i} message={m} />
					),
				)}
			</div>
			{active && subagentId && (
				<form
					className="gy-composer"
					onSubmit={e => {
						e.preventDefault();
						if (!steer.trim()) return;
						void gateway.rpc(chatId, { type: "steer_subagent", subagentId, message: steer.trim() }).then(() => setSteer(""));
					}}
				>
					<input className="flex-1 bg-transparent py-1 font-mono text-[13px] outline-none" placeholder="Steer this sub-agent…" value={steer} onChange={e => setSteer(e.target.value)} />
					<button type="submit" className="gy-btn" disabled={!steer.trim()}>
						<Send size={12} /> Steer
					</button>
				</form>
			)}
		</div>
	);
}
