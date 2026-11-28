import { expect, test } from "bun:test";
import { JOBS_WIDGET_KEY } from "@gyre/protocol";
import { jobsFromSnapshot, registerJobs } from "../src/jobs";

type Handler = (event: unknown, ctx: unknown) => void;

function harness() {
	const handlers = new Map<string, Handler[]>();
	const widgets: Array<string[] | undefined> = [];
	let snapshot: unknown = { running: [], recent: [], delivery: {} };
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		logger: { warn() {} },
	};
	const ctx = {
		hasUI: true,
		agent: { kind: "main" },
		getAsyncJobSnapshot: () => snapshot,
		ui: { setWidget: (key: string, lines: string[] | undefined) => key === JOBS_WIDGET_KEY && widgets.push(lines) },
	};
	registerJobs(pi as never, { intervalMs: 10 });
	const emit = (name: string, c: unknown = ctx) => {
		for (const h of handlers.get(name) ?? []) h({}, c);
	};
	return { emit, widgets, setSnapshot: (s: unknown) => (snapshot = s), ctx };
}

const job = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ id, type: "bash", status, label: `job ${id}`, startTime: 1, ...extra });

test("snapshot jobs are listed running first, deduplicated, and malformed rows dropped", () => {
	const jobs = jobsFromSnapshot({
		running: [job("a", "running", { command: "sleep 60", caption: "sleeps" })],
		recent: [job("b", "completed", { endTime: 5 }), job("a", "running"), { id: "c" }, null],
	});
	expect(jobs.map(j => `${j.id}:${j.status}`)).toEqual(["a:running", "b:completed"]);
	expect(jobs[0]).toMatchObject({ command: "sleep 60", caption: "sleeps" });
	expect(jobsFromSnapshot(null)).toEqual([]);
});

test("the widget is published when jobs appear, only on change, and cleared when they are gone", async () => {
	const h = harness();
	h.emit("session_start");
	expect(h.widgets).toEqual([]);
	h.setSnapshot({ running: [job("a", "running")], recent: [] });
	await Bun.sleep(40);
	expect(h.widgets).toHaveLength(1);
	expect(JSON.parse(h.widgets[0]![0]!).jobs[0].id).toBe("a");
	await Bun.sleep(40);
	expect(h.widgets).toHaveLength(1);
	h.setSnapshot({ running: [], recent: [] });
	h.emit("agent_end");
	expect(h.widgets.at(-1)).toBeUndefined();
	h.emit("session_shutdown");
});

test("sub-agent sessions and failing snapshots publish nothing", () => {
	const h = harness();
	h.setSnapshot({ running: [job("a", "running")] });
	h.emit("session_start", { ...h.ctx, agent: { kind: "sub" } });
	expect(h.widgets).toEqual([]);
	h.emit("session_start", {
		...h.ctx,
		getAsyncJobSnapshot: () => {
			throw new Error("gone");
		},
	});
	expect(h.widgets).toEqual([]);
	h.emit("session_shutdown");
});
