/** Background jobs: the `gyre.jobs` widget in the chat store, cross-chat listing and the pane's status light. */
import { expect, test } from "bun:test";
import type { ChatInfo, PaneSpec } from "@gyre/protocol";

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

const { parseJobs, useChats } = await import("../src/store/chats");
const { allJobs, duration, jobResult, runningJobCount } = await import("../src/lib/jobs");
const { paneStatus } = await import("../src/lib/status");

const info = (chatId: string): ChatInfo => ({ chatId, projectId: "p", cwd: "/p", status: "ready" });
const widget = (chatId: string, jobs: unknown[] | undefined) =>
	useChats.getState().apply(chatId, {
		type: "extension_ui_request",
		id: `w${Math.random()}`,
		method: "setWidget",
		widgetKey: "gyre.jobs",
		widgetLines: jobs ? [JSON.stringify({ jobs })] : undefined,
	});

test("the gyre.jobs widget fills chat.jobs and clearing it empties them", () => {
	useChats.getState().setInfo(info("c1"));
	widget("c1", [{ id: "j1", type: "bash", status: "running", label: "sleep", startTime: 1 }]);
	expect(useChats.getState().chats.c1!.jobs.map(j => j.id)).toEqual(["j1"]);
	expect(useChats.getState().chats.c1!.widgets["gyre.jobs"]).toBeUndefined();
	widget("c1", undefined);
	expect(useChats.getState().chats.c1!.jobs).toEqual([]);
	expect(parseJobs("{not json")).toEqual([]);
	expect(parseJobs(JSON.stringify({ jobs: [{ id: 1 }, null] }))).toEqual([]);
});

test("jobs from every chat are listed running first and drive the jobs pane light", () => {
	useChats.getState().setInfo(info("c2"));
	widget("c1", [{ id: "old", type: "bash", status: "completed", label: "done", startTime: 5, endTime: 70_000 }]);
	widget("c2", [{ id: "live", type: "task", status: "running", label: "task", startTime: 2 }]);
	const chats = useChats.getState().chats;
	expect(allJobs(chats).map(j => `${j.chatId}:${j.id}`)).toEqual(["c2:live", "c1:old"]);
	expect(runningJobCount(chats)).toBe(1);
	const pane: PaneSpec = { id: "jp", kind: "jobs" };
	expect(paneStatus(pane, chats)).toBe("running");
	widget("c2", undefined);
	expect(paneStatus(pane, useChats.getState().chats)).toBe("none");
	expect(duration({ id: "x", type: "bash", status: "completed", label: "", startTime: 0, endTime: 125_000 })).toBe("2m 5s");
});

test("a settled job's result comes from the transcript's async-result message", () => {
	const chat = useChats.getState().chats.c1!;
	const withResult = {
		...chat,
		items: [
			...chat.items,
			{ kind: "message" as const, id: "m1", message: { role: "custom", customType: "async-result", content: "exit 0: built", details: { jobId: "old" } } },
		],
	};
	expect(jobResult(withResult as never, "old")).toBe("exit 0: built");
	expect(jobResult(withResult as never, "other")).toBeUndefined();
});
