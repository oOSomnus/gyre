/**
 * Chat lifecycle: the one owner of which chats this client is attached to.
 *
 * Attaching opens (or re-attaches to) a chat's omp process and records its
 * state; reconnects re-subscribe every attached chat; an explicit close stops
 * the process and forgets the chat. Gateway messages for a chat that is not
 * attached are ignored, so a late exit broadcast or open result can never bring
 * a closed chat back. Hiding or unmounting a pane does not detach its chat.
 *
 * Pure: the transport and the state sink are injected (see `chat-lifecycle.ts`).
 */
import type { ChatInfo, PaneSpec } from "@gyre/protocol";

/** Rejection of an open whose connection dropped before the gateway answered. */
export class ChatDisconnectedError extends Error {
	constructor() {
		super("connection lost");
	}
}

export interface ChatTransport {
	/** Rejects with `ChatDisconnectedError` when the connection drops before the answer. */
	open(projectId: string, opts: { chatId: string; sessionPath?: string }): Promise<ChatInfo>;
	close(chatId: string): void;
	subscribe(chatId: string): void;
	/** Called on every (re)connect, before queued messages are sent. */
	onWelcome(listener: () => void): () => void;
}

export interface ChatSink {
	current(chatId: string): ChatInfo | undefined;
	setInfo(info: ChatInfo): void;
	/** Drop all client state for a chat. */
	forget(chatId: string): void;
}

export interface ChatTarget {
	chatId: string;
	projectId: string;
	sessionPath?: string;
}

interface Attachment {
	/** `interrupted`: the open lost its connection, so it is retried on the next welcome. */
	phase: "opening" | "attached" | "failed" | "interrupted";
	target: ChatTarget;
	opening?: Promise<ChatInfo>;
}

export function createChatLifecycle(transport: ChatTransport, sink: ChatSink) {
	const attachments = new Map<string, Attachment>();

	transport.onWelcome(() => {
		// Re-attach after a reconnect; the gateway keeps omp processes alive.
		// Chats still opening are subscribed by their open request; chats that failed in
		// the gateway (e.g. omp not set up) stay failed until restarted explicitly.
		for (const [chatId, attachment] of attachments) {
			if (attachment.phase === "attached") transport.subscribe(chatId);
			// The open never got an answer: send it again (it attaches to the process if one started).
			else if (attachment.phase === "interrupted") void attach(attachment.target, { force: true }).catch(() => undefined);
		}
	});

	function attach(target: ChatTarget, opts: { force?: boolean } = {}): Promise<ChatInfo> {
		const { chatId } = target;
		const existing = attachments.get(chatId);
		if (existing?.opening) return existing.opening;
		const status = sink.current(chatId)?.status;
		if (!opts.force && existing && (status === "ready" || status === "starting")) return Promise.resolve(sink.current(chatId)!);

		const attachment: Attachment = existing ?? { phase: "opening", target };
		attachment.phase = "opening";
		attachment.target = target;
		attachments.set(chatId, attachment);
		const owns = () => attachments.get(chatId) === attachment;
		const opening = transport.open(target.projectId, { chatId, sessionPath: target.sessionPath }).then(
			info => {
				attachment.opening = undefined;
				if (!owns()) {
					// Closed while opening: the close may have reached the gateway before the process existed.
					// (Unless a newer attach for the same id now owns it.)
					if (!attachments.has(chatId)) transport.close(chatId);
					throw new Error("chat was closed");
				}
				attachment.phase = "attached";
				sink.setInfo(info);
				return info;
			},
			(error: unknown) => {
				attachment.opening = undefined;
				if (owns() && error instanceof ChatDisconnectedError) {
					// Keep what the store shows; the next welcome retries this open.
					attachment.phase = "interrupted";
				} else if (owns()) {
					attachment.phase = "failed";
					sink.setInfo({
						chatId,
						projectId: target.projectId,
						cwd: "",
						status: "exited",
						error: error instanceof Error ? error.message : String(error),
					});
				}
				throw error;
			},
		);
		attachment.opening = opening;
		return opening;
	}

	return {
		attach,

		/** Explicit teardown: stop the chat's omp process and drop its client state. */
		close(chatId: string): void {
			attachments.delete(chatId);
			transport.close(chatId);
			sink.forget(chatId);
		},

		/** Whether gateway messages for this chat should reach the store. */
		accepts(chatId: string): boolean {
			return attachments.has(chatId);
		},

		/** Restart chat panes that died (or never started), e.g. after omp setup is fixed. */
		restartExited(panes: Iterable<PaneSpec>): void {
			for (const pane of panes) {
				if (pane.kind !== "chat" || !pane.projectId) continue;
				const status = sink.current(pane.id)?.status;
				if (status === undefined || status === "exited")
					void attach({ chatId: pane.id, projectId: pane.projectId, sessionPath: pane.sessionPath }, { force: true }).catch(() => undefined);
			}
		},
	};
}

export type ChatLifecycle = ReturnType<typeof createChatLifecycle>;
