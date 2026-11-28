/** Review pane helpers, the `gyre.turns` widget in the chat store, and the `/review` command. */
import { expect, test } from "bun:test";
import type { TurnRecord, TurnsState } from "@gyre/protocol";

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

const { commentsMessage, latestChangedTurn, rangeFor, reviewableTurns, turnChanged } = await import("../src/lib/review");
const { parseTurns, useChats } = await import("../src/store/chats");
const { useApp } = await import("../src/store/app");
const { findLocalCommand } = await import("../src/chat/localCommands");

const t = (n: number, extra: Partial<TurnRecord> = {}): TurnRecord => ({ n, prompt: `p${n}`, startedAt: n, before: `b${n}`, after: `a${n}`, endedAt: n + 1, ...extra });

test("reviewable turns are newest first and need a before snapshot", () => {
	const state: TurnsState = { sessionId: "s", turns: [t(1), t(2, { before: undefined, error: "timeout" }), t(3)] };
	expect(reviewableTurns(state).map(x => x.n)).toEqual([3, 1]);
	expect(reviewableTurns(null)).toEqual([]);
});

test("the latest finished turn counts as changed only when its trees differ", () => {
	expect(latestChangedTurn({ sessionId: "s", turns: [t(1), t(2, { after: "b2" })] })).toBeUndefined();
	expect(latestChangedTurn({ sessionId: "s", turns: [t(1), t(2, { endedAt: undefined, after: undefined })] })?.n).toBe(1);
	expect(turnChanged(t(4))).toBe(true);
});

test("modes map to tree ranges; a running turn has only the work-tree range", () => {
	expect(rangeFor(t(1), "turn")).toEqual({ from: "b1", to: "a1" });
	expect(rangeFor(t(1), "since")).toEqual({ from: "b1", to: "worktree" });
	expect(rangeFor(t(2, { after: undefined }), "turn")).toBeNull();
	expect(rangeFor(t(3, { before: undefined }), "since")).toBeNull();
});

test("comments become one message grouped by file in line order", () => {
	const message = commentsMessage([
		{ id: "1", turn: 2, path: "b.ts", line: 9, text: "rename this " },
		{ id: "2", turn: 2, path: "a.ts", line: 30, text: "off by one" },
		{ id: "3", turn: 3, path: "b.ts", line: 2, text: "unused" },
	]);
	expect(message).toBe(
		["Review of your changes (turns 2, 3):", "", "- b.ts:2 — unused", "- b.ts:9 — rename this", "- a.ts:30 — off by one", "", "Please address these comments."].join("\n"),
	);
	expect(commentsMessage([])).toBe("");
});

test("the gyre.turns widget fills chat.turns", () => {
	useChats.getState().setInfo({ chatId: "c1", projectId: "p", cwd: "/p", status: "ready" });
	useChats.getState().apply("c1", {
		type: "extension_ui_request",
		id: "w1",
		method: "setWidget",
		widgetKey: "gyre.turns",
		widgetLines: [JSON.stringify({ sessionId: "s", turns: [t(1)] })],
	});
	expect(useChats.getState().chats.c1!.turns?.turns[0]?.n).toBe(1);
	expect(parseTurns("nope")).toBeNull();
	expect(parseTurns(JSON.stringify({ turns: "x" }))).toBeNull();
});

test("/review opens the chat's review pane", () => {
	useApp.setState({
		workspaces: [{ id: "w", name: "W", panes: { c1: { id: "c1", kind: "chat", projectId: "p" } }, layout: { type: "pane", paneId: "c1" }, updatedAt: 0 }],
		activeWorkspaceId: "w",
	});
	findLocalCommand("c1", "/review")!();
	const panes = Object.values(useApp.getState().activeWorkspace()!.panes);
	expect(panes.some(p => p.kind === "review" && p.chatId === "c1")).toBe(true);
});
