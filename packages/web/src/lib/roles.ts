/** omp model roles (built-ins mirror omp's config/model-roles.ts) plus configured custom roles. */
import { useEffect, useState } from "react";
import { create } from "zustand";
import { api } from "./gateway";

export interface RoleInfo {
	id: string;
	name: string;
	/** Chat roles can run a conversation; kind roles serve one capability (images, speech, …). */
	section: "chat" | "kind";
	builtin: boolean;
}

export const BUILTIN_ROLES: RoleInfo[] = [
	{ id: "default", name: "Default", section: "chat", builtin: true },
	{ id: "smol", name: "Fast", section: "chat", builtin: true },
	{ id: "slow", name: "Thinking", section: "chat", builtin: true },
	{ id: "plan", name: "Architect (plan mode)", section: "chat", builtin: true },
	{ id: "task", name: "Subtask (sub-agents)", section: "chat", builtin: true },
	{ id: "vision", name: "Vision", section: "chat", builtin: true },
	{ id: "commit", name: "Commit", section: "chat", builtin: true },
	{ id: "advisor", name: "Advisor", section: "chat", builtin: true },
	{ id: "tiny", name: "Tiny", section: "chat", builtin: true },
	{ id: "memory", name: "Memory", section: "chat", builtin: true },
	{ id: "widget", name: "Job widgets", section: "chat", builtin: true },
	{ id: "image", name: "Image generation", section: "kind", builtin: true },
	{ id: "web", name: "Web search", section: "kind", builtin: true },
	{ id: "speech", name: "Speech", section: "kind", builtin: true },
	{ id: "dictation", name: "Dictation", section: "kind", builtin: true },
	{ id: "judge", name: "Judge", section: "kind", builtin: true },
];

interface RolesStore {
	assignments: Record<string, string>;
	loaded: boolean;
	error: string | null;
	load(): Promise<void>;
	assign(role: string, selector: string | null): Promise<void>;
}

export const useRolesStore = create<RolesStore>((set, get) => ({
	assignments: {},
	loaded: false,
	error: null,
	async load() {
		try {
			const { value } = await api<{ value: Record<string, string> | null }>("/api/omp/config?key=modelRoles");
			set({ assignments: value ?? {}, loaded: true, error: null });
		} catch (error) {
			set({ loaded: true, error: (error as Error).message });
		}
	},
	async assign(role, selector) {
		const next = { ...get().assignments };
		if (selector) next[role] = selector;
		else delete next[role];
		await api("/api/omp/config", { method: "PUT", body: JSON.stringify({ key: "modelRoles", value: next }) });
		set({ assignments: next });
	},
}));

/** All roles: built-ins first, then custom roles found in the config. */
export function useRoles(): { roles: RoleInfo[]; assignments: Record<string, string>; loaded: boolean; error: string | null } {
	const { assignments, loaded, error, load } = useRolesStore();
	const [requested, setRequested] = useState(false);
	useEffect(() => {
		if (!loaded && !requested) {
			setRequested(true);
			void load();
		}
	}, [loaded, requested, load]);
	const custom = Object.keys(assignments)
		.filter(id => !BUILTIN_ROLES.some(r => r.id === id))
		.map(id => ({ id, name: id, section: "chat" as const, builtin: false }));
	return { roles: [...BUILTIN_ROLES, ...custom], assignments, loaded, error };
}

export function roleLabel(id: string): string {
	return BUILTIN_ROLES.find(r => r.id === id)?.name ?? id;
}
