/**
 * Chat registry: one omp process per open chat, fan-out of its frames to
 * subscribed UI connections, and replay of state a reconnecting UI needs.
 */
import type { ChatInfo, OmpFrame, ServerMessage } from "@gyre/protocol";
import { OmpProcess, type OmpProcessOptions } from "./omp-process";

export interface Subscriber {
	send(message: ServerMessage): void;
	connected?: boolean;
}

export interface ChatManagerOptions {
	ompPath?: string;
	/** Extra omp CLI args for every chat (e.g. `--no-session` in tests). */
	ompArgs?: string[];
	/** Stop a chat this long after its last subscriber leaves, unless the agent is busy. */
	idleReapMs?: number;
	createProcess?: (options: OmpProcessOptions) => OmpProcess;
	/** omp extensions loaded into every chat (`-e <path>`), e.g. Gyre's plan-mode extension. */
	extensions?: string[];
	/** Extra environment for a chat's omp process. */
	envFor?: (chatId: string) => Record<string, string | undefined>;
	/** Called when a chat's omp process exits, with its stderr tail. */
	onExit?: (code: number | null, stderrTail: string) => void;
}

/** Frames whose latest value a late subscriber should receive. */
const STICKY_FRAME_TYPES = new Set(["available_commands_update", "session_info_update", "config_update"]);
/** UI request methods that are fire-and-forget presentation updates (no response expected). */
const PRESENTATION_METHODS = new Set(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text", "open_url"]);

export class Chat {
	readonly subscribers = new Set<Subscriber>();
	/** Unanswered dialog requests, replayed to new subscribers. */
	readonly pendingUi = new Map<string, OmpFrame>();
	/** Latest value of sticky frames and presentation state (status/widgets/title). */
	readonly sticky = new Map<string, OmpFrame>();
	busy = false;
	reapTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		public info: ChatInfo,
		readonly process: OmpProcess,
	) {}

	broadcast(message: ServerMessage): void {
		for (const subscriber of this.subscribers) {
			try {
				subscriber.send(message);
			} catch {
				this.subscribers.delete(subscriber);
			}
		}
	}

	setInfo(patch: Partial<ChatInfo>): void {
		this.info = { ...this.info, ...patch };
		this.broadcast({ t: "chat", chat: this.info });
	}

	trackFrame(frame: OmpFrame): void {
		switch (frame.type) {
			case "agent_start":
				if (!this.busy) {
					this.busy = true;
					this.setInfo({ busy: true });
				}
				break;
			case "session_settled":
				if (this.busy) {
					this.busy = false;
					this.setInfo({ busy: false });
				}
				break;
			case "extension_ui_request": {
				const method = String(frame.method);
				const id = String(frame.id);
				if (method === "cancel") {
					this.pendingUi.delete(String(frame.targetId));
				} else if (method === "setStatus") {
					this.sticky.set(`status:${String(frame.statusKey)}`, frame);
				} else if (method === "setWidget") {
					this.sticky.set(`widget:${String(frame.widgetKey)}`, frame);
				} else if (method === "setTitle") {
					this.sticky.set("title", frame);
				} else if (!PRESENTATION_METHODS.has(method)) {
					this.pendingUi.set(id, frame);
				}
				break;
			}
			default:
				if (STICKY_FRAME_TYPES.has(frame.type)) this.sticky.set(frame.type, frame);
		}
	}

	replayTo(subscriber: Subscriber): void {
		subscriber.send({ t: "chat_replay", chat: this.info });
		for (const frame of this.sticky.values()) subscriber.send({ t: "frame", chatId: this.info.chatId, frame });
		for (const frame of this.pendingUi.values()) subscriber.send({ t: "frame", chatId: this.info.chatId, frame });
	}
}

export class ChatManager {
	readonly chats = new Map<string, Chat>();
	stopping = false;

	constructor(private readonly options: ChatManagerOptions = {}) {}

	get(chatId: string): Chat | undefined {
		return this.chats.get(chatId);
	}

	/**
	 * Open (or reattach to) a chat. A new chat spawns omp in `cwd`; when
	 * `sessionPath` is given it switches to that persisted session.
	 */
	async open(params: { projectId: string; cwd: string; chatId?: string; sessionPath?: string; subscriber?: Subscriber }): Promise<Chat> {
		if (this.stopping) throw new Error("gateway is shutting down");
		const existing = params.chatId ? this.chats.get(params.chatId) : undefined;
		if (existing && existing.info.status !== "exited") {
			if (params.subscriber) this.subscribe(existing, params.subscriber);
			return existing;
		}

		const chatId = params.chatId ?? crypto.randomUUID();
		let chat!: Chat;
		const extensionArgs = (this.options.extensions ?? []).flatMap(path => ["-e", path]);
		const processOptions: OmpProcessOptions = {
			cwd: params.cwd,
			ompPath: this.options.ompPath,
			args: [...extensionArgs, ...(this.options.ompArgs ?? [])],
			env: this.options.envFor?.(chatId),
			onFrame: frame => {
				chat.trackFrame(frame);
				chat.broadcast({ t: "frame", chatId, frame });
			},
			onExit: (code, stderrTail) => {
				this.options.onExit?.(code, stderrTail);
				chat.busy = false;
				chat.pendingUi.clear();
				chat.setInfo({
					status: "exited",
					busy: false,
					error: code === 0 ? undefined : `omp exited with code ${code}\n${stderrTail.slice(-4000)}`,
				});
			},
		};
		const process = this.options.createProcess?.(processOptions) ?? new OmpProcess(processOptions);
		chat = new Chat(
			{
				chatId,
				projectId: params.projectId,
				cwd: params.cwd,
				status: "starting",
				sessionPath: params.sessionPath,
				startedAt: Date.now(),
				generation: crypto.randomUUID(),
				busy: false,
			},
			process,
		);
		this.chats.set(chatId, chat);
		if (params.subscriber) this.subscribe(chat, params.subscriber);
		chat.broadcast({ t: "chat", chat: chat.info });

		try {
			await process.start();
			// Let the `ask` tool surface structured questions instead of degrading to plain selects.
			await process.send({ type: "set_ask_dialog", enabled: true }).catch(() => undefined);
			if (params.sessionPath) {
				await process.call({ type: "switch_session", sessionPath: params.sessionPath }, 120_000);
			}
			const state = await process.call<{ sessionFile?: string }>({ type: "get_state" }).catch(() => undefined);
			if (!process.running || this.stopping) throw new Error("omp exited during initialization");
			chat.setInfo({ status: "ready", sessionPath: state?.sessionFile ?? params.sessionPath, error: undefined });
		} catch (error) {
			chat.setInfo({ status: "exited", error: error instanceof Error ? error.message : String(error) });
			await process.stop().catch(() => undefined);
		}
		return chat;
	}

	subscribe(chat: Chat, subscriber: Subscriber): void {
		if (chat.reapTimer) {
			clearTimeout(chat.reapTimer);
			chat.reapTimer = null;
		}
		if (subscriber.connected === false) return;
		chat.subscribers.add(subscriber);
		chat.info = { ...chat.info, subscribers: chat.subscribers.size };
		chat.replayTo(subscriber);
	}

	unsubscribeAll(subscriber: Subscriber): void {
		subscriber.connected = false;
		for (const chat of this.chats.values()) {
			if (!chat.subscribers.delete(subscriber)) continue;
			chat.info = { ...chat.info, subscribers: chat.subscribers.size };
			if (chat.subscribers.size === 0) this.#scheduleReap(chat);
		}
	}

	/**
	 * Restart a chat's omp process on the same session file (e.g. after MCP or
	 * extension config changes, which omp does not hot-reload). Subscribers stay attached.
	 */
	async restart(chatId: string): Promise<Chat | undefined> {
		const chat = this.chats.get(chatId);
		if (!chat) return undefined;
		const state = await chat.process.call<{ sessionFile?: string }>({ type: "get_state" }).catch(() => undefined);
		// Closed or replaced while reading state: never reopen or touch the replacement.
		if (this.chats.get(chatId) !== chat) return this.chats.get(chatId);
		if (state) chat.info.sessionPath = state.sessionFile;
		const { projectId, cwd, sessionPath } = chat.info;
		await this.close(chatId);
		const subscribers = [...chat.subscribers];
		chat.subscribers.clear();
		const next = await this.open({ projectId, cwd, chatId, sessionPath });
		for (const subscriber of subscribers) if (subscriber.connected !== false) this.subscribe(next, subscriber);
		if (next.subscribers.size === 0) this.#scheduleReap(next);
		return next;
	}

	async close(chatId: string): Promise<void> {
		const chat = this.chats.get(chatId);
		if (!chat) return;
		this.chats.delete(chatId);
		if (chat.reapTimer) clearTimeout(chat.reapTimer);
		await chat.process.stop();
	}

	async closeAll(): Promise<void> {
		this.stopping = true;
		await Promise.allSettled([...this.chats.keys()].map(id => this.close(id)));
	}

	/** Called after a UI answers a dialog so it is not replayed again. */
	resolveUi(chat: Chat, requestId: string): void {
		chat.pendingUi.delete(requestId);
	}

	#scheduleReap(chat: Chat): void {
		const delay = this.options.idleReapMs ?? 10 * 60_000;
		if (delay <= 0) return;
		chat.reapTimer = setTimeout(() => {
			chat.reapTimer = null;
			if (this.chats.get(chat.info.chatId) !== chat || chat.subscribers.size > 0) return;
			if (chat.busy) {
				this.#scheduleReap(chat);
				return;
			}
			void this.close(chat.info.chatId);
		}, delay);
	}
}
