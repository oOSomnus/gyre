/** WebSocket + HTTP client for the Gyre gateway. */
import type { ClientMessage, OmpCommand, OmpUiResponse, ServerMessage } from "@gyre/protocol";
import { useSyncExternalStore } from "react";

declare global {
	interface Window {
		__GYRE__?: { token?: string; gateway?: string; remote?: boolean };
	}
}

function resolveToken(): string {
	const fromHash = new URLSearchParams(location.hash.slice(1)).get("token");
	if (fromHash) {
		sessionStorage.setItem("gyre.token", fromHash);
		history.replaceState(null, "", location.pathname + location.search);
		// Remote browsers: trade the link's token for a session cookie so later visits need no link.
		if (window.__GYRE__?.remote) {
			void fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: fromHash }) }).catch(
				() => undefined,
			);
		}
	}
	return window.__GYRE__?.token ?? fromHash ?? sessionStorage.getItem("gyre.token") ?? (import.meta.env.VITE_GYRE_TOKEN as string | undefined) ?? "";
}

export const token = resolveToken();
const base = window.__GYRE__?.gateway ?? "";

function debugLog(message: string) {
	if (!import.meta.env.DEV && !localStorage.getItem("gyre.debug")) return;
	void fetch(`${base}/api/client-log`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-gyre-token": token },
		body: JSON.stringify({ level: "debug", message }),
	}).catch(() => undefined);
}

export class GatewayError extends Error {
	constructor(
		message: string,
		readonly code?: string,
		readonly status?: number,
	) {
		super(message);
	}
}

/** Like `api`, but also returns the response's ETag (for conditional writes with `If-Match`). */
export async function apiWithEtag<T>(path: string, init: RequestInit = {}): Promise<{ body: T; etag: string | null }> {
	const response = await fetch(`${base}${path}`, {
		...init,
		headers: { "content-type": "application/json", "x-gyre-token": token, ...(init.headers ?? {}) },
	});
	const body = (await response.json().catch(error => {
		// An aborted body read is a failure, not an empty response.
		if (init.signal?.aborted) throw error;
		return {};
	})) as { error?: string };
	if (!response.ok) throw new GatewayError(body.error ?? `HTTP ${response.status}`, undefined, response.status);
	return { body: body as T, etag: response.headers.get("etag") };
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
	return (await apiWithEtag<T>(path, init)).body;
}

type Listener = (message: ServerMessage) => void;
export type ConnectionState = "connecting" | "open" | "closed" | "unauthorized";

class GatewayClient {
	#ws: WebSocket | null = null;
	#listeners = new Set<Listener>();
	#stateListeners = new Set<(state: ConnectionState) => void>();
	#pending = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void }>();
	#queue: ClientMessage[] = [];
	#nextId = 0;
	#retry = 0;
	#welcomeListeners = new Set<() => void>();
	state: ConnectionState = "connecting";
	ompVersion: string | null = null;

	connect(): void {
		const url = base ? base.replace(/^http/, "ws") : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
		debugLog(`ws connect ${url}/ws`);
		const ws = new WebSocket(`${url}/ws`);
		this.#ws = ws;
		this.#setState("connecting");
		ws.onopen = () => {
			debugLog(`ws onopen readyState=${ws.readyState}`);
			ws.send(JSON.stringify({ t: "hello", token } satisfies ClientMessage));
		};
		ws.onmessage = event => {
			const message = JSON.parse(String(event.data)) as ServerMessage;
			if (message.t !== "frame") debugLog(`ws recv ${message.t}`);
			if (message.t === "welcome") {
				this.#retry = 0;
				this.ompVersion = message.ompVersion;
				this.#setState("open");
				// Re-attach to chats after a reconnect (gateway keeps the omp processes alive).
				for (const listener of this.#welcomeListeners) listener();
				for (const queued of this.#queue.splice(0)) this.#sendRaw(queued);
			} else if (message.t === "error" && message.message === "unauthorized") {
				this.#setState("unauthorized");
			} else if (message.t === "result") {
				const pending = this.#pending.get(message.reqId);
				if (pending) {
					this.#pending.delete(message.reqId);
					if (message.ok) pending.resolve(message.data);
					else pending.reject(new GatewayError(message.error, message.code));
				}
			}
			for (const listener of this.#listeners) listener(message);
		};
		ws.onerror = () => {
			void fetch(`${base}/api/client-log`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-gyre-token": token },
				body: JSON.stringify({ level: "ws", message: `websocket error connecting to ${url}/ws` }),
			}).catch(() => undefined);
		};
		ws.onclose = () => {
			if (this.state === "unauthorized") return;
			this.#setState("closed");
			for (const pending of this.#pending.values()) pending.reject(new GatewayError("connection lost"));
			const rejected = new Set(this.#pending.keys());
			this.#queue = this.#queue.filter(message => !("reqId" in message && rejected.has(message.reqId)));
			this.#pending.clear();
			const delay = Math.min(10_000, 500 * 2 ** this.#retry++);
			setTimeout(() => this.connect(), delay);
		};
	}

	on(listener: Listener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Called on every (re)connect, before queued messages are flushed. */
	onWelcome(listener: () => void): () => void {
		this.#welcomeListeners.add(listener);
		return () => this.#welcomeListeners.delete(listener);
	}

	onState(listener: (state: ConnectionState) => void): () => void {
		this.#stateListeners.add(listener);
		return () => this.#stateListeners.delete(listener);
	}

	#setState(state: ConnectionState): void {
		this.state = state;
		for (const listener of this.#stateListeners) listener(state);
	}

	#sendRaw(message: ClientMessage): void {
		this.#ws?.send(JSON.stringify(message));
	}

	send(message: ClientMessage): void {
		if (this.state === "open") this.#sendRaw(message);
		else this.#queue.push(message);
	}

	request<T>(build: (reqId: string) => ClientMessage): Promise<T> {
		const reqId = `r${++this.#nextId}`;
		return new Promise<T>((resolve, reject) => {
			this.#pending.set(reqId, { resolve: resolve as (data: unknown) => void, reject });
			this.send(build(reqId));
		});
	}

	openChat(projectId: string, opts: { chatId?: string; sessionPath?: string } = {}) {
		return this.request<import("@gyre/protocol").ChatInfo>(reqId => ({ t: "open_chat", reqId, projectId, ...opts }));
	}

	closeChat(chatId: string): void {
		this.send({ t: "close_chat", chatId });
	}

	/** Re-attach this connection to a running chat (the gateway replays its pending state). */
	subscribeChat(chatId: string): void {
		this.send({ t: "subscribe", chatId });
	}

	rpc<T = unknown>(chatId: string, command: OmpCommand, timeoutMs?: number): Promise<T> {
		return this.request<T>(reqId => ({ t: "rpc", reqId, chatId, command, timeoutMs }));
	}

	respondUi(chatId: string, response: OmpUiResponse): void {
		this.send({ t: "ui_response", chatId, response });
	}

	openPty(projectId: string, cols: number, rows: number, key?: string) {
		return this.request<{ ptyId: string; attachmentId: string; reused?: boolean; cols?: number; rows?: number }>(reqId => ({ t: "pty_open", reqId, projectId, cols, rows, key }));
	}
}

export const gateway = new GatewayClient();

/**
 * Connection state as a React external store, so a transition that happens
 * before a component subscribes (e.g. a fast local `welcome`) is never missed.
 */
export function useConnectionState(): ConnectionState {
	return useSyncExternalStore(
		listener => gateway.onState(listener),
		() => gateway.state,
	);
}
