import { create } from "zustand";

export function createConfigMap(transport: { read(): Promise<Record<string, string>>; write(value: Record<string, string>): Promise<void> }) {
	let loading: Promise<void> | undefined;
	let writes: Promise<void> = Promise.resolve();
	const store = create<{
		assignments: Record<string, string>;
		loaded: boolean;
		error: string | null;
		load(): Promise<void>;
		assign(name: string, value: string | null): Promise<void>;
	}>((set, get) => ({
		assignments: {},
		loaded: false,
		error: null,
		load() {
			if (loading) return loading;
			loading = writes
				.catch(() => {})
				.then(async () => {
					try {
						const value = await transport.read();
						set({ assignments: value ?? {}, loaded: true, error: null });
					} catch (error) {
						set({ loaded: false, error: (error as Error).message });
						throw error;
					}
				})
				.finally(() => {
					loading = undefined;
				});
			return loading;
		},
		assign(name, value) {
			const initialLoad = loading;
			const next = writes
				.catch(() => {})
				.then(async () => {
					if (initialLoad) await initialLoad;
					if (!get().loaded || get().error) throw new Error(get().error ?? "Load saved assignments before editing.");
					const assignments = { ...get().assignments };
					if (value) assignments[name] = value;
					else delete assignments[name];
					await transport.write(assignments);
					set({ assignments, error: null });
				});
			writes = next;
			return next;
		},
	}));
	return store;
}
