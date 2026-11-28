/** Notification detection from chat-store transitions, and the notification store. */
import { expect, test } from "bun:test";
import type { ChatInfo } from "@gyre/protocol";

const g = globalThis as Record<string, unknown>;
const memoryStorage = () => {
	const m = new Map<string, string>();
	return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};
g.location ??= new URL("http://localhost/");
g.history ??= { replaceState() {} };
g.localStorage ??= memoryStorage();
g.sessionStorage ??= memoryStorage();
g.window ??= globalThis;
g.fetch = async () => new Response("{}", { headers: { "content-type": "application/json" } });

const { detectNotifications, hookTarget } = await import("../src/lib/notifications");
const { useNotifications, MAX_NOTIFICATIONS } = await import("../src/store/notifications");
type ChatState = import("../src/store/chats").ChatState;

const info: ChatInfo = { chatId: "c", projectId: "p", cwd: "/p", status: "ready" };
const chat = (patch: Partial<ChatState> = {}): ChatState =>
	({
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
		historyLoaded: true,
		plan: null,
		jobs: [],
		turns: null,
		todoPhases: [],
		tpsHistory: [],
		...patch,
	}) as ChatState;
const detect = (a: ChatState, b: ChatState, now = 1000) => detectNotifications({ c: a }, { c: b }, () => "Chat", now);

test("a new dialog needs the user once; a replay of the same one is not new", () => {
	const ui = { type: "extension_ui_request" as const, id: "q1", method: "confirm", title: "Allow rm?" };
	const [n] = detect(chat(), chat({ pendingUi: [ui] }));
	expect(n).toMatchObject({ kind: "needs-you", title: "Chat needs you", body: "Allow rm?", key: "ui:c:q1" });
	expect(detect(chat({ pendingUi: [ui] }), chat({ pendingUi: [ui] }))).toEqual([]);
});

test("a run ending is done, or an error when the last reply failed", () => {
	const reply = (stopReason?: string) => ({ kind: "message" as const, id: "m", message: { role: "assistant", content: [{ type: "text", text: "All tests pass." }], stopReason, errorMessage: "rate limited" } });
	expect(detect(chat({ busy: true }), chat({ busy: false, items: [reply()] as never }))[0]).toMatchObject({ kind: "done", body: "All tests pass." });
	expect(detect(chat({ busy: true }), chat({ busy: false, items: [reply("error")] as never }))[0]).toMatchObject({ kind: "error", body: "rate limited" });
	expect(detect(chat({ busy: false }), chat({ busy: true }))).toEqual([]);
	// A fresh session restarts the transcript; its first run is not the old run's duplicate.
	const first = detect(chat({ busy: true }), chat({ busy: false, items: [reply()] as never }))[0]!;
	const afterReset = detect(chat({ busy: true, transcriptEpoch: 1 }), chat({ busy: false, transcriptEpoch: 1, items: [reply()] as never }))[0]!;
	expect(afterReset.key).not.toBe(first.key);
});

test("plans entering review, settled jobs and fresh warnings are reported; stale notices are not", () => {
	const plan = { phase: "reviewing" as const, revision: 2, title: "Refactor", updatedAt: 0 };
	expect(detect(chat(), chat({ plan }))[0]).toMatchObject({ kind: "plan", key: "plan:c:2" });
	const job = (status: "running" | "completed" | "failed") => ({ id: "j", type: "bash", status, label: "build", startTime: 0 });
	expect(detect(chat({ jobs: [job("running")] }), chat({ jobs: [job("failed")] }))[0]).toMatchObject({ kind: "error", title: "Background job failed" });
	expect(detect(chat({ jobs: [job("running")] }), chat({ jobs: [job("completed")] }))[0]).toMatchObject({ kind: "job" });
	const notice = (ts: number, extensionPath?: string) => ({ kind: "notice" as const, key: `n${ts}`, level: "error" as const, message: "boom", ts, extensionPath });
	const fresh = detect(chat(), chat({ items: [notice(990, "/p/.omp/hooks/pre/bash.ts")] }));
	expect(fresh[0]).toMatchObject({ kind: "error", extensionPath: "/p/.omp/hooks/pre/bash.ts" });
	expect(detect(chat(), chat({ items: [notice(-60_000)] }))).toEqual([]);
});

test("hook files map to a Hook Studio target", () => {
	expect(hookTarget("/p/.omp/hooks/pre/bash.ts", "/p")).toBe("project:pre:bash.ts");
	expect(hookTarget("/home/u/.omp/agent/hooks/post/*.ts", "/p")).toBe("user:post:*.ts");
	expect(hookTarget("/home/u/.omp/agent/extensions/x.ts", "/p")).toBeUndefined();
});

test("the store dedupes by key, keeps newest first, caps the list and tracks read state", () => {
	const store = useNotifications.getState();
	store.clear();
	store.push([{ kind: "done", chatId: "c", title: "a", key: "k1" }]);
	store.push([
		{ kind: "done", chatId: "c", title: "a again", key: "k1" },
		{ kind: "error", chatId: "c", title: "b", key: "k2" },
		{ kind: "error", chatId: "c", title: "b twice in one batch", key: "k2" },
	]);
	expect(useNotifications.getState().items.map(n => n.title)).toEqual(["b", "a"]);
	useNotifications.getState().markAllRead();
	expect(useNotifications.getState().items.every(n => n.read)).toBe(true);
	useNotifications.getState().push(Array.from({ length: MAX_NOTIFICATIONS + 5 }, (_, i) => ({ kind: "done" as const, chatId: "c", title: `t${i}`, key: `bulk${i}` })));
	expect(useNotifications.getState().items).toHaveLength(MAX_NOTIFICATIONS);
	expect(JSON.parse(localStorage.getItem("gyre.notifications")!)).toHaveLength(MAX_NOTIFICATIONS);
});
