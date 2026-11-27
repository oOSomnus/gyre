/**
 * One sub-agent's conversation, rendered like a chat: the session file is read
 * once, then its session events stream in live (omp's `events` subscription)
 * with streaming text and running tool cards. Falls back to polling the
 * session file when no live events arrive. Steer and cancel included.
 */
import type { PaneSpec } from "@gyre/protocol";
import { Loader2, Send, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { modelName, progressOf, subStatus } from "../chat/SubagentCard";
import { LatestButton, TranscriptItems, useStickToBottom, visibleTranscriptItems } from "../chat/Transcript";
import { gateway } from "../lib/gateway";
import { formatTokens, type AgentMessage } from "../lib/omp";
import { useChats } from "../store/chats";
import { mergeSubagentTranscript, useSubagentTranscript, watchSubagent } from "../store/subagent-transcripts";

/** Poll the session file this often while running and nothing streams live. */
const POLL_RUNNING_MS = 1500;
/** And this often once the sub-agent is done (or between live updates), to catch anything missed. */
const POLL_IDLE_MS = 6000;

export function SubagentPane({ pane }: { pane: PaneSpec }) {
	const chatId = pane.chatId ?? "";
	const sub = useChats(s => (pane.ref ? s.chats[chatId]?.subagents[pane.ref] : undefined));
	const subagentId = sub?.subagentId ?? pane.subagentId;
	const sessionFile = sub?.sessionFile;
	// Live events are keyed by sub-agent id; with only a session file the view polls it.
	const viewKey = subagentId ?? (sessionFile ? `file:${sessionFile}` : undefined);
	const transcript = useSubagentTranscript(chatId, viewKey);
	const live = transcript?.live ?? false;
	const [error, setError] = useState<string | null>(null);
	const [commandError, setCommandError] = useState<string | null>(null);
	const [steer, setSteer] = useState("");
	const cursor = useRef(0);
	const { scroller, onScroll, stick, toLatest } = useStickToBottom();
	const status = sub ? subStatus(sub) : "unknown";
	const active = status === "running" || status === "pending" || status === "started";

	// Stream this sub-agent's events while the pane is open.
	useEffect(() => {
		if (!chatId || !viewKey) return;
		cursor.current = 0;
		return watchSubagent(chatId, viewKey);
	}, [chatId, viewKey]);

	// Read the session file: all of it first, then only what was appended.
	useEffect(() => {
		if (!chatId || !viewKey) return;
		let current = true;
		let pending = false;
		const poll = async () => {
			if (pending) return;
			pending = true;
			try {
				const data = await gateway.rpc<{ messages?: AgentMessage[]; nextByte?: number; reset?: boolean }>(chatId, {
					type: "get_subagent_messages",
					...(subagentId ? { subagentId } : { sessionFile }),
					fromByte: cursor.current,
				});
				if (!current) return;
				mergeSubagentTranscript(chatId, viewKey, data.messages ?? [], !!data.reset);
				cursor.current = data.nextByte ?? cursor.current;
				setError(null);
			} catch (e) {
				if (current) setError(String((e as Error).message));
			} finally {
				pending = false;
			}
		};
		void poll();
		const timer = setInterval(poll, active && !live ? POLL_RUNNING_MS : POLL_IDLE_MS);
		return () => {
			current = false;
			clearInterval(timer);
		};
	}, [chatId, viewKey, subagentId, sessionFile, active, live]);

	const p = sub ? progressOf(sub) : {};
	const tokens = typeof p.tokens === "number" ? p.tokens : p.tokens?.total;
	const items = transcript ? visibleTranscriptItems(transcript.items, transcript.toolResults) : [];

	return (
		<div className="flex h-full min-h-0 flex-col" style={{ background: "var(--panel)" }}>
			<div
				className="flex flex-wrap items-center gap-2 border-b px-2 py-1.5"
				style={{ borderColor: "var(--border-strong)", background: "var(--tint-subagent)" }}
			>
				<span className="font-mono text-[11.5px] font-semibold tracking-widest uppercase">{String(sub?.agent ?? "sub-agent")}</span>
				<span className={`gy-chip ${status === "completed" ? "ok" : active ? "info" : "err"}`}>{status}</span>
				{active && live && (
					<span className="gy-label" title="Streaming this sub-agent's events live">
						live
					</span>
				)}
				{modelName(p.resolvedModel) && <span className="font-mono text-[11px]">{modelName(p.resolvedModel)}</span>}
				{tokens ? <span className="gy-label">{formatTokens(tokens)} tok</span> : null}
				<span className="min-w-0 flex-1 truncate text-[12px]">{String(sub?.description ?? "")}</span>
				{active && subagentId && (
					<button type="button" className="gy-btn danger" onClick={() => void gateway.rpc(chatId, { type: "cancel_subagent", subagentId }).catch(e => setCommandError((e as Error).message))}>
						<Square size={10} /> Cancel
					</button>
				)}
			</div>
			<div ref={scroller} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto px-2 py-2">
				<div className="mx-auto flex max-w-[1080px] flex-col gap-2.5">
					{(commandError || error) && (
						<div className="text-[12px]" style={{ color: "var(--err)" }}>
							{commandError || error}
						</div>
					)}
					{items.length === 0 && !error && (
						<div className="flex items-center gap-2 p-3 text-[12.5px]" style={{ color: "var(--muted)" }}>
							<Loader2 size={13} className="animate-spin" /> Waiting for the transcript…
						</div>
					)}
					{transcript && <TranscriptItems items={items} toolExec={transcript.toolExec} toolResults={transcript.toolResults} chatId={chatId} readOnly />}
					{transcript?.busy && !items.some(item => item.kind === "message" && item.streaming) && (
						<div className="flex items-center gap-2 px-1 text-[12px]" style={{ color: "var(--muted)" }}>
							<Loader2 size={13} className="animate-spin" /> Working…
						</div>
					)}
				</div>
				{!stick && <LatestButton onClick={toLatest} />}
			</div>
			{active && subagentId && (
				<form
					className="gy-composer"
					onSubmit={e => {
						e.preventDefault();
						if (!steer.trim()) return;
						const sent = steer;
						setCommandError(null);
						void gateway
							.rpc(chatId, { type: "steer_subagent", subagentId, message: sent.trim() })
							.then(() => setSteer(current => (current === sent ? "" : current)))
							.catch(e => setCommandError((e as Error).message));
					}}
				>
					<input
						className="flex-1 bg-transparent py-1 font-mono text-[13px] outline-none"
						placeholder="Steer this sub-agent…"
						value={steer}
						onChange={e => setSteer(e.target.value)}
					/>
					<button type="submit" className="gy-btn" disabled={!steer.trim()}>
						<Send size={12} /> Steer
					</button>
				</form>
			)}
		</div>
	);
}
