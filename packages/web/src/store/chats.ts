/**
 * Per-chat state, built by folding omp frames. Unknown frames are kept in the
 * raw log (Events pane) so new upstream events are visible without code changes.
 */
import { type ChatInfo, type JobInfo, JOBS_WIDGET_KEY, type OmpFrame, PLAN_WIDGET_KEY, type PlanState, TURNS_WIDGET_KEY, type TurnsState, uiRequestKind } from "@gyre/protocol";
import { create } from "zustand";
import { gateway } from "../lib/gateway";
import { openChatPane } from "./app";
import type { AgentMessage, SessionState, SessionStats, SlashCommand, UiRequest } from "../lib/omp";
import { foldSessionEvent, messagesToView, settleStreaming, type ToolExecution, type TranscriptItem } from "./session-events";
import { applySubagentEvent, subagentLevel } from "./subagent-transcripts";

export type { ToolExecution, TranscriptItem } from "./session-events";

export interface TodoTask {
	content: string;
	status: "pending" | "in_progress" | "completed" | "abandoned";
	details?: string;
	notes?: string;
}
export interface TodoPhase {
	name: string;
	tasks: TodoTask[];
}

export interface SubagentInfo {
	id: string;
	/** omp subagent id (for transcripts, steer, cancel), from lifecycle frames. */
	subagentId?: string;
	parentToolCallId?: string;
	index?: number;
	sessionFile?: string;
	agent?: string;
	description?: string;
	status?: string;
	task?: string;
	lastUpdate?: number;
	progress?: unknown;
	[key: string]: unknown;
}

export interface ChatState {
	info: ChatInfo;
	items: TranscriptItem[];
	toolExec: Record<string, ToolExecution>;
	toolResults: Record<string, AgentMessage>;
	pendingUi: UiRequest[];
	statuses: Record<string, string>;
	widgets: Record<string, { lines: string[]; placement?: string }>;
	title?: string;
	commands: SlashCommand[];
	state: SessionState | null;
	stats: SessionStats | null;
	queue: { steering: string[]; followUp: string[] };
	subagents: Record<string, SubagentInfo>;
	busy: boolean;
	editorInject?: { text: string; nonce: number; append?: boolean };
	frames: Array<{ ts: number; frame: OmpFrame }>;
	historyLoaded: boolean;
	/** Gyre plan mode, from the extension's `gyre.plan` widget. */
	plan: PlanState | null;
	/** The agent's background jobs, from the extension's `gyre.jobs` widget. */
	jobs: JobInfo[];
	/** Counts transcript resets (a fresh session), so per-transcript positions stay unique. */
	transcriptEpoch?: number;
	/** Per-turn work-tree snapshots, from the extension's `gyre.turns` widget. */
	turns: TurnsState | null;
	/** Todo phases: from get_state and live todo tool results. */
	todoPhases: TodoPhase[];
	/** Recent tokens/s samples for the sparkline. */
	tpsHistory: number[];
}

const MAX_FRAMES = 600;
const REFRESH_ON = new Set([
	"agent_end",
	"session_settled",
	"prompt_result",
	"model_changed",
	"thinking_level_changed",
	"session_info_update",
	"goal_updated",
	"auto_compaction_end",
	"manual_compaction_end",
	"config_update",
]);
const EVENT_LABELS: Record<string, string> = {
	auto_compaction_start: "Compacting context…",
	auto_compaction_end: "Context compacted",
	manual_compaction_start: "Compacting context…",
	manual_compaction_end: "Context compacted",
	auto_retry_start: "Retrying request…",
	auto_retry_end: "Retry finished",
	retry_fallback_applied: "Switched to fallback model",
	model_changed: "Model changed",
	thinking_level_changed: "Thinking level changed",
	ttsr_triggered: "Rule triggered",
	todo_reminder: "Todo reminder",
	agent_pause: "Agent paused",
	irc_message: "Message from another agent",
};

let keySeq = 0;
const nextKey = (prefix: string) => `${prefix}${++keySeq}`;

/** The `gyre.jobs` widget line; anything unreadable is no jobs. */
export function parseJobs(line: string | undefined): JobInfo[] {
	if (!line) return [];
	try {
		const jobs = (JSON.parse(line) as { jobs?: unknown }).jobs;
		return Array.isArray(jobs) ? jobs.filter((j): j is JobInfo => !!j && typeof (j as JobInfo).id === "string" && typeof (j as JobInfo).status === "string") : [];
	} catch {
		return [];
	}
}

/** The `gyre.turns` widget line, or null when absent or unreadable. */
export function parseTurns(line: string | undefined): TurnsState | null {
	if (!line) return null;
	try {
		const state = JSON.parse(line) as TurnsState;
		return state && Array.isArray(state.turns) ? state : null;
	} catch {
		return null;
	}
}

function emptyChat(info: ChatInfo): ChatState {
	return {
		info,
		items: [],
		toolExec: {},
		toolResults: {},
		pendingUi: [],
		statuses: {},
		widgets: {},
		commands: [],
		state: null,
		stats: null,
		queue: { steering: [], followUp: [] },
		subagents: {},
		busy: false,
		frames: [],
		historyLoaded: false,
		plan: null,
		jobs: [],
		turns: null,
		todoPhases: [],
		tpsHistory: [],
	};
}

/** Prefer omp identity (including progress.id), falling back to the parent/index until known. */
export function subagentKey(payload: { subagentId?: unknown; id?: unknown; progress?: unknown; parentToolCallId?: unknown; index?: unknown }): string {
	const id = payload.subagentId ?? payload.id ?? (payload.progress as { id?: unknown } | undefined)?.id;
	if (id) return String(id);
	if (payload.parentToolCallId !== undefined && payload.index !== undefined) return `${String(payload.parentToolCallId)}:${String(payload.index)}`;
	return String(payload.id ?? "");
}

export function applyFrame(chat: ChatState, frame: OmpFrame): ChatState {
	const now = Date.now();
	const frames = chat.frames.length >= MAX_FRAMES ? chat.frames.slice(-MAX_FRAMES + 1) : chat.frames.slice();
	frames.push({ ts: now, frame });
	let next: ChatState = { ...chat, frames };
	const f = frame as Record<string, unknown>;

	switch (frame.type) {
		case "agent_start":
			turnRevisions.set(chat.info.chatId, (turnRevisions.get(chat.info.chatId) ?? 0) + 1);
			next.busy = true;
			break;
		case "agent_end":
			turnRevisions.set(chat.info.chatId, (turnRevisions.get(chat.info.chatId) ?? 0) + 1);
			next.items = settleStreaming(next.items);
			break;
		case "session_settled":
			turnRevisions.set(chat.info.chatId, (turnRevisions.get(chat.info.chatId) ?? 0) + 1);
			next.busy = false;
			break;
		case "message_start":
		case "message_update":
		case "message_end":
		case "tool_execution_start":
		case "tool_execution_update":
			next = foldSessionEvent(next, frame, typeof f.messageId === "string" ? `m${f.messageId}` : nextKey("m"), now);
			break;
		case "tool_execution_end": {
			next = foldSessionEvent(next, frame, "", now);
			const phases = (f.result as { details?: { phases?: TodoPhase[] } } | undefined)?.details?.phases;
			if (f.toolName === "todo" && !f.isError && Array.isArray(phases)) next.todoPhases = phases;
			break;
		}
		case "extension_ui_request": {
			const request = frame as unknown as UiRequest;
			const method = request.method;
			const kind = uiRequestKind(method);
			if (kind === "dialog") {
				if (!next.pendingUi.some(existing => existing.id === request.id)) next.pendingUi = [...next.pendingUi, request];
			} else if (kind === "cancel") {
				next.pendingUi = next.pendingUi.filter(existing => existing.id !== f.targetId);
			} else if (method === "notify") {
				next.items = [
					...next.items,
					{
						kind: "notice",
						key: nextKey("n"),
						level: (f.notifyType as "info" | "warning" | "error") ?? "info",
						message: String(f.message ?? ""),
						ts: now,
					},
				];
			} else if (method === "setStatus") {
				const statuses = { ...next.statuses };
				if (f.statusText == null || f.statusText === "") delete statuses[String(f.statusKey)];
				else statuses[String(f.statusKey)] = String(f.statusText);
				next.statuses = statuses;
			} else if (method === "setWidget") {
				if (f.widgetKey === PLAN_WIDGET_KEY) {
					const line = (f.widgetLines as string[] | undefined)?.[0];
					try {
						next.plan = line ? (JSON.parse(line) as PlanState) : null;
					} catch {
						next.plan = null;
					}
					break;
				}
				if (f.widgetKey === TURNS_WIDGET_KEY) {
					next.turns = parseTurns((f.widgetLines as string[] | undefined)?.[0]);
					break;
				}
				if (f.widgetKey === JOBS_WIDGET_KEY) {
					next.jobs = parseJobs((f.widgetLines as string[] | undefined)?.[0]);
					break;
				}
				const widgets = { ...next.widgets };
				if (!f.widgetLines) delete widgets[String(f.widgetKey)];
				else widgets[String(f.widgetKey)] = { lines: f.widgetLines as string[], placement: f.widgetPlacement as string };
				next.widgets = widgets;
			} else if (method === "setTitle") {
				next.title = String(f.title ?? "");
			} else if (method === "set_editor_text") {
				next.editorInject = { text: String(f.text ?? ""), nonce: now };
			} else if (method === "open_url") {
				next.items = [
					...next.items,
					{
						kind: "notice",
						key: nextKey("n"),
						level: "info",
						message: String(f.instructions ?? "Open this link to continue"),
						url: String(f.launchUrl ?? f.url),
						ts: now,
					},
				];
			}
			break;
		}
		case "available_commands_update":
			next.commands = (f.commands as SlashCommand[]) ?? [];
			break;
		case "command_output":
			next.items = [...next.items, { kind: "command_output", key: nextKey("c"), text: String(f.text ?? ""), ts: now }];
			break;
		case "notice":
			next.items = [
				...next.items,
				{
					kind: "notice",
					key: nextKey("n"),
					level: (f.level as "info" | "warning" | "error") ?? "info",
					message: String(f.message ?? ""),
					ts: now,
				},
			];
			break;
		case "extension_error":
			// A hook or extension handler threw; Hook Studio can open it when it is a hook file.
			next.items = [
				...next.items,
				{
					kind: "notice",
					key: nextKey("n"),
					level: "error",
					message: `${String(f.extensionPath ?? "extension")} failed in ${String(f.event ?? "a handler")}: ${String(f.error ?? "")}`,
					ts: now,
					extensionPath: typeof f.extensionPath === "string" ? f.extensionPath : undefined,
				},
			];
			break;
		case "queue_update":
			next.queue = { steering: (f.steering as string[]) ?? [], followUp: (f.followUp as string[]) ?? [] };
			break;
		case "prompt_result":
			if (f.status === "error") {
				const error = f.error as { message?: string } | undefined;
				next.items = [...next.items, { kind: "notice", key: nextKey("n"), level: "error", message: error?.message ?? "The request failed", ts: now }];
			}
			break;
		case "subagent_lifecycle":
		case "subagent_progress": {
			const payload = (f.payload ?? f) as SubagentInfo;
			const key = subagentKey(payload);
			if (!key) break;
			const previousKey = Object.keys(next.subagents).find(
				key =>
					key !== subagentKey(payload) &&
					payload.parentToolCallId !== undefined &&
					payload.index !== undefined &&
					next.subagents[key]?.parentToolCallId === payload.parentToolCallId &&
					next.subagents[key]?.index === payload.index,
			);
			const previous = next.subagents[previousKey ?? key];
			const subagentId = payload.subagentId ?? payload.id ?? (payload.progress as { id?: string } | undefined)?.id ?? previous?.subagentId;
			const id = String(subagentId ?? key);
			const merged: SubagentInfo = {
				...previous,
				...payload,
				id,
				subagentId,
				lastUpdate: now,
			};
			if (previousKey && previousKey !== id) {
				next.subagents = { ...next.subagents };
				delete next.subagents[previousKey];
			}
			if (frame.type === "subagent_lifecycle" && payload.id) merged.subagentId = String(payload.id);
			next.subagents = { ...next.subagents, [id]: merged };
			break;
		}
		case "response":
			if (f.success === false) {
				next.items = [...next.items, { kind: "notice", key: nextKey("n"), level: "error", message: `${String(f.command)}: ${String(f.error)}`, ts: now }];
			}
			break;
		default: {
			const label = EVENT_LABELS[frame.type];
			if (label) {
				const detail =
					frame.type === "model_changed"
						? String((f.model as { id?: string } | undefined)?.id ?? "")
						: frame.type === "thinking_level_changed"
							? String(f.level ?? "")
							: undefined;
				next.items = [...next.items, { kind: "event", key: nextKey("e"), label, detail, ts: now }];
			}
		}
	}
	return next;
}

interface ChatStore {
	chats: Record<string, ChatState>;
	setInfo(info: ChatInfo): void;
	apply(chatId: string, frame: OmpFrame): void;
	patch(chatId: string, patch: Partial<ChatState>): void;
	remove(chatId: string): void;
}

export const useChats = create<ChatStore>(set => ({
	chats: {},
	setInfo: info =>
		set(store => ({
			chats: { ...store.chats, [info.chatId]: { ...(store.chats[info.chatId] ?? emptyChat(info)), info } },
		})),
	apply: (chatId, frame) =>
		set(store => {
			const chat = store.chats[chatId];
			if (!chat) return store;
			return { chats: { ...store.chats, [chatId]: applyFrame(chat, frame) } };
		}),
	patch: (chatId, patch) =>
		set(store => {
			const chat = store.chats[chatId];
			if (!chat) return store;
			return { chats: { ...store.chats, [chatId]: { ...chat, ...patch } } };
		}),
	remove: chatId =>
		set(store => {
			const chats = { ...store.chats };
			delete chats[chatId];
			return { chats };
		}),
}));

// ---------------------------------------------------------------------------
// Side effects: state refresh and history loading
// ---------------------------------------------------------------------------

const turnRevisions = new Map<string, number>();
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function refreshState(chatId: string, delay = 150): void {
	clearTimeout(refreshTimers.get(chatId));
	refreshTimers.set(
		chatId,
		setTimeout(async () => {
			refreshTimers.delete(chatId);
			const chat = useChats.getState().chats[chatId];
			if (!chat || chat.info.status !== "ready") return;
			const revision = turnRevisions.get(chatId) ?? 0;
			const [state, stats] = await Promise.all([
				gateway.rpc<SessionState>(chatId, { type: "get_state" }).catch(() => null),
				gateway.rpc<SessionStats>(chatId, { type: "get_session_stats" }).catch(() => null),
			]);
			const patch: Partial<ChatState> = {};
			if (state) {
				// The system prompt and tool dump are large and unused by the UI.
				delete state.systemPrompt;
				delete state.dumpTools;
				patch.state = state;
				if ((turnRevisions.get(chatId) ?? 0) === revision) patch.busy = state.isSettled === false || state.isStreaming === true;
				const phases = (state as { todoPhases?: TodoPhase[] }).todoPhases;
				if (Array.isArray(phases)) patch.todoPhases = phases;
				const tps = state.tokensPerSecond;
				if (typeof tps === "number" && tps > 0) patch.tpsHistory = [...chat.tpsHistory.slice(-23), tps];
			}
			if (stats) patch.stats = stats;
			useChats.getState().patch(chatId, patch);
		}, delay),
	);
}

const sessionTransitions = new Map<string, OmpFrame[]>();
export async function startFreshSession(chatId: string, parentSession?: string): Promise<boolean> {
	if (sessionTransitions.has(chatId)) throw new Error("A session change is already pending.");
	const frames: OmpFrame[] = [];
	sessionTransitions.set(chatId, frames);
	try {
		const result = await gateway.rpc<{ cancelled?: boolean }>(chatId, { type: "new_session", ...(parentSession ? { parentSession } : {}) });
		if (result?.cancelled) return false;
		resetTranscript(chatId);
		return true;
	} finally {
		sessionTransitions.delete(chatId);
		for (const frame of frames) useChats.getState().apply(chatId, frame);
		refreshState(chatId, 0);
	}
}
const historyEpochs = new Map<string, number>();
const historyLoads = new Map<string, Promise<void>>();
export function loadHistory(chatId: string): Promise<void> {
	const generation = useChats.getState().chats[chatId]?.info.generation;
	const epoch = historyEpochs.get(chatId) ?? 0;
	const key = `${chatId}:${generation}:${epoch}`;
	if (historyLoads.has(key)) return historyLoads.get(key)!;
	const pending = readHistory(chatId, generation, epoch).finally(() => historyLoads.delete(key));
	historyLoads.set(key, pending);
	return pending;
}
async function readHistory(chatId: string, generation: string | undefined, epoch: number): Promise<void> {
	const data = await gateway.rpc<{ messages?: AgentMessage[] } | AgentMessage[]>(chatId, { type: "get_messages" }, 60_000);
	const messages = Array.isArray(data) ? data : (data?.messages ?? []);
	const { items, toolResults } = messagesToView(messages, () => nextKey("h"));
	const chat = useChats.getState().chats[chatId];
	if (!chat) return;
	if (chat.info.generation !== generation || (historyEpochs.get(chatId) ?? 0) !== epoch) return;
	// Keep live items that arrived while history was loading.
	useChats.getState().patch(chatId, {
		items: [...items, ...chat.items.filter(item => item.kind !== "message")],
		toolResults: { ...toolResults, ...chat.toolResults },
		historyLoaded: true,
	});
}

export async function loadCommands(chatId: string): Promise<void> {
	const data = await gateway.rpc<{ commands?: SlashCommand[] } | SlashCommand[]>(chatId, { type: "get_available_commands" });
	const commands = Array.isArray(data) ? data : (data?.commands ?? []);
	useChats.getState().patch(chatId, { commands });
}

/** Drop every piece of client state for a chat (after an explicit close). */
export function forgetChat(chatId: string): void {
	clearTimeout(refreshTimers.get(chatId));
	refreshTimers.delete(chatId);
	turnRevisions.delete(chatId);
	historyEpochs.delete(chatId);
	sessionTransitions.delete(chatId);
	useChats.getState().remove(chatId);
}

/**
 * Called once at startup: route gateway messages into the store. `accepts`
 * (the chat lifecycle) drops messages for chats this client is not attached to,
 * so a closed chat's exit broadcast cannot bring it back.
 */
export function wireChatStore({ accepts }: { accepts(chatId: string): boolean }): void {
	// A newly submitted plan (or a new revision) opens the review pane next to its chat.
	useChats.subscribe((state, prev) => {
		for (const [chatId, chat] of Object.entries(state.chats)) {
			const after = chat.plan;
			const before = prev.chats[chatId]?.plan;
			if (after === before || after?.phase !== "reviewing") continue;
			if (before?.phase !== "reviewing" || before.revision !== after.revision) queueMicrotask(() => openChatPane("plan", chatId));
		}
	});
	gateway.on(message => {
		const store = useChats.getState();
		if (message.t === "chat" || message.t === "chat_replay") {
			if (!accepts(message.chat.chatId)) return;
			const old = store.chats[message.chat.chatId];
			const replaced = old?.info.generation !== message.chat.generation;
			const previous = store.chats[message.chat.chatId]?.info.status;
			store.setInfo(message.chat);
			if (message.t === "chat_replay") store.patch(message.chat.chatId, { pendingUi: [] });
			// Jobs belonged to the old process: the new one cannot list or kill them. Its turn list
			// arrives once its session attaches; until then Review has none to offer.
			if (replaced) store.patch(message.chat.chatId, { historyLoaded: false, jobs: [], turns: null });
			if (message.chat.status === "ready" && (previous !== "ready" || replaced || message.t === "chat_replay")) {
				void loadHistory(message.chat.chatId).catch(() => undefined);
				void loadCommands(message.chat.chatId).catch(() => undefined);
				// `events` while a sub-agent view of this chat is open, so a restart or reconnect keeps it live.
				void gateway.rpc(message.chat.chatId, { type: "set_subagent_subscription", level: subagentLevel(message.chat.chatId) }).catch(() => undefined);
				refreshState(message.chat.chatId, 0);
			}
		} else if (message.t === "frame") {
			if (!accepts(message.chatId)) return;
			// Every token of every sub-agent: kept out of the chat (and its raw frame log).
			if (message.frame.type === "subagent_event") {
				applySubagentEvent(message.chatId, message.frame.payload);
				return;
			}
			const buffered = sessionTransitions.get(message.chatId);
			if (buffered) {
				buffered.push(message.frame);
				return;
			}
			store.apply(message.chatId, message.frame);
			if (REFRESH_ON.has(message.frame.type)) refreshState(message.chatId);
		}
	});
}

export function resetTranscript(chatId: string): void {
	historyEpochs.set(chatId, (historyEpochs.get(chatId) ?? 0) + 1);
	useChats.getState().patch(chatId, {
		transcriptEpoch: (useChats.getState().chats[chatId]?.transcriptEpoch ?? 0) + 1,
		items: [],
		toolExec: {},
		toolResults: {},
		pendingUi: [],
		historyLoaded: false,
	});
}
