import { expect, test } from "bun:test";
import { createConfigMap } from "../src/lib/config-map-store";
import { stripAnsi } from "../src/lib/omp";

function deferred() {
	let release!: () => void;
	const promise = new Promise<void>(resolve => {
		release = resolve;
	});
	return { promise, release };
}

test("assignments cannot replace saved roles before a successful load", async () => {
	let writes = 0;
	const store = createConfigMap({
		async read() {
			throw new Error("offline");
		},
		async write() {
			writes++;
		},
	});
	await expect(store.getState().assign("plan", "p/m")).rejects.toThrow("Load saved assignments");
	await expect(store.getState().load()).rejects.toThrow("offline");
	await expect(store.getState().assign("plan", "p/m")).rejects.toThrow("offline");
	expect(writes).toBe(0);
});

test("overlapping role and routing edits retain every confirmed assignment", async () => {
	let saved = { existing: "p/original" } as Record<string, string>;
	const first = deferred();
	let calls = 0;
	const store = createConfigMap({
		async read() {
			return { ...saved };
		},
		async write(value) {
			if (++calls === 1) await first.promise;
			saved = value;
		},
	});
	await store.getState().load();
	const a = store.getState().assign("plan", "p/planner");
	const b = store.getState().assign("task", "p/worker");
	await Bun.sleep(0);
	expect(calls).toBe(1);
	first.release();
	await Promise.all([a, b]);
	expect(saved).toEqual({ existing: "p/original", plan: "p/planner", task: "p/worker" });
	expect(store.getState().assignments).toEqual(saved);
});

test("a reload between queued writes does not deadlock or restore stale assignments", async () => {
	let saved: Record<string, string> = { old: "p/old" };
	const gate = deferred();
	let calls = 0;
	const store = createConfigMap({
		async read() {
			return { ...saved };
		},
		async write(value) {
			if (++calls === 1) await gate.promise;
			saved = value;
		},
	});
	await store.getState().load();
	const a = store.getState().assign("one", "p/one");
	const reload = store.getState().load();
	const b = store.getState().assign("two", "p/two");
	gate.release();
	await Promise.all([a, reload, b]);
	expect(saved).toEqual({ old: "p/old", one: "p/one", two: "p/two" });
});

test("a failed write does not poison the queue or appear in the next saved map", async () => {
	let saved: Record<string, string> = { old: "p/old" };
	let fail = true;
	const store = createConfigMap({
		async read() {
			return saved;
		},
		async write(value) {
			if (fail) {
				fail = false;
				throw new Error("write failed");
			}
			saved = value;
		},
	});
	await store.getState().load();
	const a = store.getState().assign("failed", "p/no");
	const b = store.getState().assign("valid", "p/yes");
	await expect(a).rejects.toThrow("write failed");
	await b;
	expect(saved).toEqual({ old: "p/old", valid: "p/yes" });
});

test("OSC hyperlinks preserve visible tool output across both terminator forms", () => {
	expect(stripAnsi("\x1b]8;;https://example.test\x1b\\visible\x1b]8;;\x1b\\")).toBe("visible");
	expect(stripAnsi("\x1b]8;;https://example.test\x07visible\x1b]8;;\x07")).toBe("visible");
});
