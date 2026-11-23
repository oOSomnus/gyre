/**
 * Agent Studio drafts: one shared `ui.agentDrafts` record, keyed by agent.
 *
 * Every mutation reads the latest record with its ETag, changes only its own
 * key, and writes with `If-Match`; when another pane or tab wrote in between
 * (412) it re-reads and re-applies, so unrelated drafts are never lost. A save
 * never silently replaces a newer draft of the same key: it raises
 * `DraftConflictError` instead.
 *
 * Pure: the HTTP transport is injected (see StudioPane).
 */

export interface Draft {
	name: string;
	description: string;
	scope: "user" | "project";
	model: string;
	thinking: string;
	tools: string[] | null;
	spawns: string;
	instructions: string;
	previousName?: string;
	savedAt?: number;
}

export type Drafts = Record<string, Draft>;

export interface DraftTransport {
	read(): Promise<{ body: Drafts | null; etag: string }>;
	/** Write only if the record still has `etag`; false when it changed since (HTTP 412). */
	write(body: Drafts, etag: string): Promise<boolean>;
}

/** The stored draft for this key changed since the editor last saw it. */
export class DraftConflictError extends Error {
	constructor(readonly drafts: Drafts) {
		super("This draft was changed in another pane or tab. Save again to replace it.");
	}
}

/**
 * Older builds stored the user-scope new-agent draft under `new`. Move it to `new:user`
 * (keeping an existing `new:user`) and drop the alias, so the next write migrates the
 * record and a published draft cannot come back from the alias on reload.
 */
function normalize(body: Drafts | null | undefined): Drafts {
	const drafts = { ...body };
	if (drafts.new?.scope === "user") {
		drafts["new:user"] ??= drafts.new;
		delete drafts.new;
	}
	return drafts;
}

export function createDraftStore(transport: DraftTransport, { attempts = 5 }: { attempts?: number } = {}) {
	/** Apply `change` to the latest record with a conditional write, retrying when someone else wrote first. */
	async function mutate<T>(change: (latest: Drafts) => { next: Drafts | null; result: T }): Promise<{ result: T; drafts: Drafts }> {
		for (let attempt = 0; attempt < attempts; attempt++) {
			const { body, etag } = await transport.read();
			const latest = normalize(body);
			const { next, result } = change(latest);
			if (next === null) return { result, drafts: latest };
			if (await transport.write(next, etag)) return { result, drafts: next };
		}
		throw new Error("Drafts kept changing in another pane or tab; try again.");
	}

	return {
		async load(): Promise<Drafts> {
			return normalize((await transport.read()).body);
		},

		/**
		 * Save `draft` under `key`. `baseSavedAt` is the `savedAt` of the stored draft this
		 * editor last saw (undefined if none); a different stored version is a conflict.
		 */
		async save(key: string, draft: Draft, baseSavedAt: number | undefined): Promise<{ saved: Draft; drafts: Drafts }> {
			const { result, drafts } = await mutate(latest => {
				if (latest[key]?.savedAt !== baseSavedAt) throw new DraftConflictError(latest);
				// Strictly newer than the stored version, so two saves in one millisecond still differ.
				const saved = { ...draft, savedAt: Math.max(Date.now(), (latest[key]?.savedAt ?? 0) + 1) };
				return { next: { ...latest, [key]: saved }, result: saved };
			});
			return { saved: result, drafts };
		},

		/**
		 * Remove the draft that was published, unless a newer one was saved meanwhile.
		 * `removed: false` means the stored draft was newer and was kept.
		 */
		async removePublished(key: string, publishedSavedAt: number | undefined): Promise<{ removed: boolean; drafts: Drafts }> {
			const { result, drafts } = await mutate(latest => {
				if (!latest[key]) return { next: null, result: true };
				if (latest[key].savedAt !== publishedSavedAt) return { next: null, result: false };
				const next = { ...latest };
				delete next[key];
				return { next, result: true };
			});
			return { removed: result, drafts };
		},
	};
}

export type DraftStore = ReturnType<typeof createDraftStore>;
