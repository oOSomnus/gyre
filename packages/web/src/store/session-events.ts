/**
 * Folding omp session events (messages and tool executions) into a transcript.
 * Shared by a chat and by its sub-agents, so a sub-agent's live view renders
 * exactly like the main chat. Pure: no store, no gateway.
 */
import type { AgentMessage } from "../lib/omp";

export type TranscriptItem =
	| { kind: "message"; key: string; message: AgentMessage; streaming?: boolean }
	| { kind: "command_output"; key: string; text: string; ts: number }
	| { kind: "notice"; key: string; level: "info" | "warning" | "error"; message: string; ts: number; url?: string }
	| { kind: "event"; key: string; label: string; detail?: string; ts: number };

export interface ToolExecution {
	status: "running" | "done" | "error";
	args?: unknown;
	intent?: string;
	partial?: unknown;
	result?: unknown;
	startedAt: number;
	endedAt?: number;
}

/** The part of a transcript that session events change. */
export interface SessionView {
	items: TranscriptItem[];
	toolExec: Record<string, ToolExecution>;
	toolResults: Record<string, AgentMessage>;
}

export type SessionEvent = { type: string; [key: string]: unknown };

function upsertMessage(items: TranscriptItem[], key: string, message: AgentMessage, streaming: boolean): TranscriptItem[] {
	const index = items.findIndex(item => item.kind === "message" && item.key === key);
	const item: TranscriptItem = { kind: "message", key, message, streaming };
	if (index === -1) return [...items, item];
	const next = items.slice();
	next[index] = item;
	return next;
}

/**
 * Apply one `message_*` or `tool_execution_*` event. `messageKey` names the
 * transcript item a message event updates. Other events return `view` unchanged.
 */
export function foldSessionEvent<T extends SessionView>(view: T, event: SessionEvent, messageKey: string, now = Date.now()): T {
	switch (event.type) {
		case "message_start":
		case "message_update":
		case "message_end": {
			const message = event.message as AgentMessage | undefined;
			if (!message) return view;
			const final = event.type === "message_end";
			const next = { ...view, items: upsertMessage(view.items, messageKey, message, !final && message.role === "assistant") };
			if (final && message.role === "toolResult" && message.toolCallId) next.toolResults = { ...view.toolResults, [message.toolCallId]: message };
			return next;
		}
		case "tool_execution_start": {
			const id = String(event.toolCallId);
			return { ...view, toolExec: { ...view.toolExec, [id]: { status: "running", args: event.args, intent: event.intent as string | undefined, startedAt: now } } };
		}
		case "tool_execution_update": {
			const id = String(event.toolCallId);
			const prev = view.toolExec[id] ?? { status: "running" as const, startedAt: now };
			return { ...view, toolExec: { ...view.toolExec, [id]: { ...prev, partial: event.partialResult } } };
		}
		case "tool_execution_end": {
			const id = String(event.toolCallId);
			const prev = view.toolExec[id] ?? { startedAt: now };
			return { ...view, toolExec: { ...view.toolExec, [id]: { ...prev, status: event.isError ? "error" : "done", result: event.result, endedAt: now } } };
		}
		default:
			return view;
	}
}

/** Mark every streaming message finished (the turn ended). */
export function settleStreaming(items: TranscriptItem[]): TranscriptItem[] {
	return items.some(item => item.kind === "message" && item.streaming)
		? items.map(item => (item.kind === "message" && item.streaming ? { ...item, streaming: false } : item))
		: items;
}

/** Transcript items and tool results for messages read from a session file. */
export function messagesToView(messages: AgentMessage[], key: (index: number) => string): Pick<SessionView, "items" | "toolResults"> {
	const toolResults: Record<string, AgentMessage> = {};
	const items: TranscriptItem[] = [];
	messages.forEach((message, index) => {
		if (message.role === "toolResult" && message.toolCallId) toolResults[message.toolCallId] = message;
		items.push({ kind: "message", key: key(index), message });
	});
	return { items, toolResults };
}

// ---------------------------------------------------------------------------
// Sub-agent transcripts
// ---------------------------------------------------------------------------

export interface SubagentTranscript extends SessionView {
	/** A turn is running (between agent_start and agent_end). */
	busy: boolean;
	/** Keys of messages started but not ended, innermost last (omp's own keying rule). */
	openKeys: string[];
	/** A live event arrived since the view opened, so polling the transcript is not needed. */
	live: boolean;
	/** Messages read from the session file have been merged in. */
	seeded: boolean;
	/** Counter for item keys, so keys stay unique within this transcript. */
	seq: number;
}

export function emptySubagentTranscript(): SubagentTranscript {
	return { items: [], toolExec: {}, toolResults: {}, busy: false, openKeys: [], live: false, seeded: false, seq: 0 };
}

/**
 * Apply one sub-agent session event. omp does not stamp sub-agent message
 * frames with a `messageId`, so keys follow the rule omp uses for its own
 * frames: `message_start` opens a key, `message_update` uses the innermost
 * open key, `message_end` closes it.
 */
export function foldSubagentEvent(transcript: SubagentTranscript, event: SessionEvent, now = Date.now()): SubagentTranscript {
	let t: SubagentTranscript = transcript.live ? transcript : { ...transcript, live: true };
	switch (event.type) {
		case "agent_start":
			return { ...t, busy: true };
		case "agent_end":
			return { ...t, busy: false, openKeys: [], items: settleStreaming(t.items) };
		case "message_start":
		case "message_update":
		case "message_end": {
			if (!event.message) return t;
			const openKeys = t.openKeys.slice();
			let key: string | undefined;
			if (event.type === "message_start") key = undefined;
			else if (event.type === "message_update") key = openKeys.at(-1);
			else key = openKeys.pop();
			if (!key) {
				t = { ...t, seq: t.seq + 1 };
				key = `s${t.seq}`;
				if (event.type !== "message_end") openKeys.push(key);
			}
			return { ...foldSessionEvent(t, event, key, now), openKeys };
		}
		default:
			return foldSessionEvent(t, event, "", now);
	}
}

const identity = (message: AgentMessage) => (typeof message.timestamp === "number" ? `${message.role}:${message.timestamp}` : undefined);

/**
 * Merge messages read from the sub-agent's session file. A message already in
 * the transcript (same role and timestamp, e.g. received live) is not added
 * twice. New messages go before the first message still streaming, which is
 * newer than anything on disk. `reset` means the file was read from the start
 * again: finished messages are replaced by what was read.
 */
export function mergeSubagentMessages(transcript: SubagentTranscript, messages: AgentMessage[], reset = false): SubagentTranscript {
	const kept = reset ? transcript.items.filter(item => item.kind === "message" && item.streaming) : transcript.items;
	const seen = new Set(kept.flatMap(item => (item.kind === "message" ? [identity(item.message)] : [])).filter(Boolean));
	const fresh = messages.filter(message => {
		const id = identity(message);
		if (!id) return true;
		if (seen.has(id)) return false;
		seen.add(id);
		return true;
	});
	const added = messagesToView(fresh, index => `h${transcript.seq + index + 1}`);
	const at = kept.findIndex(item => item.kind === "message" && item.streaming);
	const items = at === -1 ? [...kept, ...added.items] : [...kept.slice(0, at), ...added.items, ...kept.slice(at)];
	return {
		...transcript,
		items,
		// Results are keyed by tool call, so ones kept from before a reset are harmless.
		toolResults: { ...transcript.toolResults, ...added.toolResults },
		seeded: true,
		seq: transcript.seq + fresh.length,
	};
}

/**
 * Reference counts for open sub-agent views, per chat. `onChange` runs when a
 * chat's first view opens or its last one closes, with the level to ask omp for.
 */
export function createSubagentWatchers(onChange: (chatId: string, level: "events" | "progress") => void) {
	const counts = new Map<string, number>();
	return {
		level(chatId: string): "events" | "progress" {
			return (counts.get(chatId) ?? 0) > 0 ? "events" : "progress";
		},
		watch(chatId: string): () => void {
			const count = (counts.get(chatId) ?? 0) + 1;
			counts.set(chatId, count);
			if (count === 1) onChange(chatId, "events");
			let released = false;
			return () => {
				if (released) return;
				released = true;
				const left = (counts.get(chatId) ?? 1) - 1;
				if (left > 0) counts.set(chatId, left);
				else {
					counts.delete(chatId);
					onChange(chatId, "progress");
				}
			};
		},
	};
}
