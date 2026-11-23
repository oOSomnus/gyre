import { afterEach, beforeEach, expect, test } from "bun:test";
// The gateway's own storage, so ETag / If-Match behave exactly as `/api/kv/ui.*` does.
import { Store } from "../../gateway/src/db";
import { createDraftStore, type Draft, DraftConflictError, type DraftTransport, type Drafts } from "../src/lib/agent-drafts";

const KEY = "ui.agentDrafts";
let store: Store;

beforeEach(() => {
	store = new Store(":memory:");
});
afterEach(() => store.close());

/** One browser pane/tab talking to the gateway; `beforeWrite` lets a test interleave another writer. */
function client(hooks: { beforeWrite?: () => void | Promise<void>; failWrites?: number } = {}): DraftTransport {
	let failures = hooks.failWrites ?? 0;
	return {
		async read() {
			return { body: store.getKv<Drafts>(KEY) ?? null, etag: store.kvEtag(KEY) };
		},
		async write(body, etag) {
			await hooks.beforeWrite?.();
			if (failures > 0) {
				failures--;
				throw new Error("network down");
			}
			return store.setKvIfMatch(KEY, body, etag) !== null;
		},
	};
}

const draft = (name: string, instructions = "do it"): Draft => ({
	name,
	description: `${name} agent`,
	scope: "user",
	model: "",
	thinking: "",
	tools: null,
	spawns: "",
	instructions,
});

test("interleaved saves from two panes keep each other's drafts", async () => {
	const b = createDraftStore(client());
	let interleaved = false;
	const a = createDraftStore(
		client({
			async beforeWrite() {
				// Pane B saves a different agent between pane A's read and write.
				if (interleaved) return;
				interleaved = true;
				await b.save("user:beta", draft("beta"), undefined);
			},
		}),
	);
	await a.save("user:alpha", draft("alpha"), undefined);
	expect(Object.keys(store.getKv<Drafts>(KEY) ?? {}).sort()).toEqual(["user:alpha", "user:beta"]);
});

test("a save from a stale editor does not overwrite a newer draft of the same agent", async () => {
	const a = createDraftStore(client());
	const b = createDraftStore(client());
	const { saved: first } = await a.save("user:alpha", draft("alpha", "v1"), undefined);
	await b.save("user:alpha", draft("alpha", "from B"), first.savedAt);

	const conflict = await a.save("user:alpha", draft("alpha", "from A"), first.savedAt).catch(error => error);
	expect(conflict).toBeInstanceOf(DraftConflictError);
	expect(store.getKv<Drafts>(KEY)?.["user:alpha"]?.instructions).toBe("from B");

	// Saving again against the version the conflict reported replaces it deliberately.
	const latest = (conflict as DraftConflictError).drafts["user:alpha"]?.savedAt;
	await a.save("user:alpha", draft("alpha", "from A"), latest);
	expect(store.getKv<Drafts>(KEY)?.["user:alpha"]?.instructions).toBe("from A");
});

test("publish cleanup keeps a newer draft saved meanwhile", async () => {
	const a = createDraftStore(client());
	const b = createDraftStore(client());
	const { saved } = await a.save("user:alpha", draft("alpha", "published"), undefined);
	await b.save("user:alpha", draft("alpha", "newer"), saved.savedAt);

	const result = await a.removePublished("user:alpha", saved.savedAt);
	expect(result.removed).toBe(false);
	expect(store.getKv<Drafts>(KEY)?.["user:alpha"]?.instructions).toBe("newer");
});

test("publish cleanup still removes its draft when only another agent's draft changed", async () => {
	const b = createDraftStore(client());
	let interleaved = false;
	const a = createDraftStore(
		client({
			async beforeWrite() {
				if (interleaved) return;
				interleaved = true;
				await b.save("user:beta", draft("beta"), undefined);
			},
		}),
	);
	store.setKv(KEY, { "user:alpha": { ...draft("alpha"), savedAt: 1 } });
	const result = await a.removePublished("user:alpha", 1);
	expect(result.removed).toBe(true);
	expect(Object.keys(store.getKv<Drafts>(KEY) ?? {})).toEqual(["user:beta"]);
});

test("a failed cleanup can be retried without publishing again", async () => {
	const drafts = createDraftStore(client({ failWrites: 1 }));
	store.setKv(KEY, { "user:alpha": { ...draft("alpha"), savedAt: 1 } });
	await expect(drafts.removePublished("user:alpha", 1)).rejects.toThrow("network down");
	expect(store.getKv<Drafts>(KEY)?.["user:alpha"]).toBeDefined();
	expect((await drafts.removePublished("user:alpha", 1)).removed).toBe(true);
	expect(store.getKv<Drafts>(KEY)).toEqual({});
});

test("legacy `new` drafts load under `new:user`, and publishing one does not bring it back", async () => {
	store.setKv(KEY, { new: { ...draft("legacy"), savedAt: 5 } });
	const drafts = createDraftStore(client());
	const loaded = await drafts.load();
	expect(loaded["new:user"]?.name).toBe("legacy");
	expect(loaded.new).toBeUndefined();

	expect((await drafts.removePublished("new:user", 5)).removed).toBe(true);
	expect(store.getKv<Drafts>(KEY)).toEqual({});
	expect(await drafts.load()).toEqual({});
});

test("an existing `new:user` draft wins over the legacy alias", async () => {
	store.setKv(KEY, { new: { ...draft("legacy"), savedAt: 5 }, "new:user": { ...draft("current"), savedAt: 9 } });
	const loaded = await createDraftStore(client()).load();
	expect(loaded).toEqual({ "new:user": { ...draft("current"), savedAt: 9 } });
});

test("a record that never stops changing fails instead of looping", async () => {
	let n = 0;
	const drafts = createDraftStore(
		client({
			beforeWrite() {
				store.setKv(KEY, { [`user:other${n++}`]: draft("other") });
			},
		}),
		{ attempts: 3 },
	);
	await expect(drafts.save("user:alpha", draft("alpha"), undefined)).rejects.toThrow("kept changing");
	expect(n).toBe(3);
});
