import { expect, test } from "bun:test";
import type { ChatInfo, PaneSpec } from "@gyre/protocol";
import { createChatLifecycle } from "../src/store/chat-lifecycle-core";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const info = (chatId: string, status: ChatInfo["status"] = "ready"): ChatInfo => ({ chatId, projectId: "p", cwd: "/p", status });

/** A fake gateway + store. `opens` holds one deferred per open request, resolved by the test. */
function harness() {
	const opens: Array<{ chatId: string; result: ReturnType<typeof deferred<ChatInfo>> }> = [];
	const closes: string[] = [];
	const subscribes: string[] = [];
	const welcome = new Set<() => void>();
	const store = new Map<string, ChatInfo>();
	const lifecycle = createChatLifecycle(
		{
			open(_projectId, { chatId }) {
				const result = deferred<ChatInfo>();
				opens.push({ chatId, result });
				return result.promise;
			},
			close: chatId => closes.push(chatId),
			subscribe: chatId => subscribes.push(chatId),
			onWelcome(listener) {
				welcome.add(listener);
				return () => welcome.delete(listener);
			},
		},
		{
			current: chatId => store.get(chatId),
			setInfo: chatInfo => store.set(chatInfo.chatId, chatInfo),
			forget: chatId => store.delete(chatId),
		},
	);
	/** What the gateway would broadcast; routed only when the lifecycle accepts it (as wireChatStore does). */
	const broadcast = (chatInfo: ChatInfo) => {
		if (lifecycle.accepts(chatInfo.chatId)) store.set(chatInfo.chatId, chatInfo);
	};
	const reconnect = () => {
		for (const listener of welcome) listener();
	};
	return { lifecycle, opens, closes, subscribes, store, broadcast, reconnect };
}

const target = (chatId: string) => ({ chatId, projectId: "p" });

test("concurrent attaches for one chat share a single open", async () => {
	const h = harness();
	const a = h.lifecycle.attach(target("c1"));
	const b = h.lifecycle.attach(target("c1"), { force: true });
	expect(h.opens).toHaveLength(1);
	h.opens[0]!.result.resolve(info("c1"));
	expect(await a).toEqual(info("c1"));
	expect(await b).toEqual(info("c1"));
	// Attached and running: a remount does not reopen.
	await h.lifecycle.attach(target("c1"));
	expect(h.opens).toHaveLength(1);
});

test("a failed open records an exited chat, and a forced attach recovers it", async () => {
	const h = harness();
	const first = h.lifecycle.attach(target("c1"));
	h.opens[0]!.result.reject(new Error("omp is not installed"));
	await expect(first).rejects.toThrow("omp is not installed");
	expect(h.store.get("c1")).toMatchObject({ status: "exited", error: "omp is not installed" });

	const retry = h.lifecycle.attach(target("c1"), { force: true });
	h.opens[1]!.result.resolve(info("c1"));
	await retry;
	expect(h.store.get("c1")?.status).toBe("ready");
});

test("a reconnect re-subscribes attached chats only", async () => {
	const h = harness();
	const ready = h.lifecycle.attach(target("ready"));
	h.opens[0]!.result.resolve(info("ready"));
	await ready;
	void h.lifecycle.attach(target("opening"));
	const failed = h.lifecycle.attach(target("failed"));
	h.opens[2]!.result.reject(new Error("boom"));
	await failed.catch(() => undefined);
	const closed = h.lifecycle.attach(target("closed"));
	h.opens[3]!.result.resolve(info("closed"));
	await closed;
	h.lifecycle.close("closed");

	h.reconnect();
	expect(h.subscribes).toEqual(["ready"]);
});

test("closing forgets the chat and ignores its late exit broadcast", async () => {
	const h = harness();
	const open = h.lifecycle.attach(target("c1"));
	h.opens[0]!.result.resolve(info("c1"));
	await open;
	h.broadcast({ ...info("c1"), busy: true });
	expect(h.store.get("c1")?.busy).toBe(true);

	h.lifecycle.close("c1");
	expect(h.closes).toEqual(["c1"]);
	expect(h.store.has("c1")).toBe(false);
	expect(h.lifecycle.accepts("c1")).toBe(false);
	// The gateway's onExit broadcast arrives after the close: the chat must stay gone,
	// so it no longer feeds "needs you" counts (pending dialogs, plan reviews).
	h.broadcast(info("c1", "exited"));
	expect(h.store.has("c1")).toBe(false);
});

test("an open that resolves after close does not resurrect the chat and is closed again", async () => {
	const h = harness();
	const open = h.lifecycle.attach(target("c1"));
	h.lifecycle.close("c1");
	h.opens[0]!.result.resolve(info("c1"));
	await expect(open).rejects.toThrow("closed");
	expect(h.store.has("c1")).toBe(false);
	// Once for the explicit close, once more for the process the late open started.
	expect(h.closes).toEqual(["c1", "c1"]);
});

test("a stale open does not close a newer attachment of the same chat", async () => {
	const h = harness();
	const stale = h.lifecycle.attach(target("c1"));
	h.lifecycle.close("c1");
	const fresh = h.lifecycle.attach(target("c1"));
	h.opens[0]!.result.resolve(info("c1"));
	await stale.catch(() => undefined);
	h.opens[1]!.result.resolve(info("c1"));
	await fresh;
	expect(h.closes).toEqual(["c1"]);
	expect(h.store.get("c1")?.status).toBe("ready");
});

test("restartExited restarts only exited or never-started chat panes", async () => {
	const h = harness();
	const running = h.lifecycle.attach(target("running"));
	h.opens[0]!.result.resolve(info("running"));
	await running;
	h.store.set("dead", info("dead", "exited"));
	const panes: PaneSpec[] = [
		{ id: "running", kind: "chat", projectId: "p" },
		{ id: "dead", kind: "chat", projectId: "p" },
		{ id: "missing", kind: "chat", projectId: "p" },
		{ id: "unbound", kind: "chat" },
		{ id: "term", kind: "terminal", projectId: "p" },
	];
	h.lifecycle.restartExited(panes);
	expect(h.opens.map(o => o.chatId)).toEqual(["running", "dead", "missing"]);
});
