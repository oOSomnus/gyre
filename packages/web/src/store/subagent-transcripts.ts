/**
 * Live transcripts of the sub-agents someone is looking at. While a view is
 * open its chat is subscribed at omp's `events` level, so each sub-agent
 * session event (`subagent_event`) streams in and is folded like the main chat.
 */
import { create } from "zustand";
import { gateway } from "../lib/gateway";
import type { AgentMessage } from "../lib/omp";
import { createSubagentWatchers, emptySubagentTranscript, foldSubagentEvent, mergeSubagentMessages, type SessionEvent, type SubagentTranscript } from "./session-events";

const keyOf = (chatId: string, subagentId: string) => `${chatId}\u0000${subagentId}`;

interface SubagentTranscriptStore {
	transcripts: Record<string, SubagentTranscript>;
}

export const useSubagentTranscripts = create<SubagentTranscriptStore>(() => ({ transcripts: {} }));

function update(chatId: string, subagentId: string, change: (transcript: SubagentTranscript) => SubagentTranscript): void {
	useSubagentTranscripts.setState(store => {
		const key = keyOf(chatId, subagentId);
		const current = store.transcripts[key];
		// Only sub-agents with an open view are tracked.
		if (!current) return store;
		return { transcripts: { ...store.transcripts, [key]: change(current) } };
	});
}

export function useSubagentTranscript(chatId: string, subagentId: string | undefined): SubagentTranscript | undefined {
	return useSubagentTranscripts(store => (subagentId ? store.transcripts[keyOf(chatId, subagentId)] : undefined));
}

// A chat that is not running refuses this; the chat store sends the current level once it is ready.
const watchers = createSubagentWatchers((chatId, level) => void gateway.rpc(chatId, { type: "set_subagent_subscription", level }).catch(() => undefined));

/** The sub-agent level a chat should be subscribed at right now. */
export function subagentLevel(chatId: string): "events" | "progress" {
	return watchers.level(chatId);
}

const viewCounts = new Map<string, number>();

/**
 * Track one sub-agent's transcript while a view of it is open. Returns the
 * release function; the transcript is dropped when its last view closes.
 */
export function watchSubagent(chatId: string, subagentId: string): () => void {
	const key = keyOf(chatId, subagentId);
	const count = (viewCounts.get(key) ?? 0) + 1;
	viewCounts.set(key, count);
	if (count === 1) useSubagentTranscripts.setState(store => ({ transcripts: { ...store.transcripts, [key]: store.transcripts[key] ?? emptySubagentTranscript() } }));
	const releaseLevel = watchers.watch(chatId);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		releaseLevel();
		const left = (viewCounts.get(key) ?? 1) - 1;
		if (left > 0) {
			viewCounts.set(key, left);
			return;
		}
		viewCounts.delete(key);
		useSubagentTranscripts.setState(store => {
			const transcripts = { ...store.transcripts };
			delete transcripts[key];
			return { transcripts };
		});
	};
}

/** Fold a `subagent_event` frame's payload (`{id, event}`) into its transcript, if one is open. */
export function applySubagentEvent(chatId: string, payload: unknown): void {
	const { id, event } = (payload ?? {}) as { id?: unknown; event?: SessionEvent };
	if (typeof id !== "string" || !event || typeof event.type !== "string") return;
	update(chatId, id, transcript => foldSubagentEvent(transcript, event));
}

/** Merge messages read with `get_subagent_messages`. */
export function mergeSubagentTranscript(chatId: string, subagentId: string, messages: AgentMessage[], reset: boolean): void {
	update(chatId, subagentId, transcript => mergeSubagentMessages(transcript, messages, reset));
}
