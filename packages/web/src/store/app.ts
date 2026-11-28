/**
 * App-level state: projects, workspaces and the tiling window manager, modes
 * (jump marks, keyboard mode) and overlays.
 *
 * Window manager model: each workspace has a split tree of docked panes, a list
 * of hidden panes and a map of floating panes. New panes split the largest
 * docked pane along its longer side. After every change a fit pass hides the
 * least-recently-focused pane while any docked pane would fall below its
 * minimum size, and brings automatically hidden panes back once there is room.
 */
import type { FloatRect, LayoutNode, PaneKind, PaneSpec, Project, Workspace } from "@gyre/protocol";
import { create } from "zustand";
import { api, GatewayError } from "../lib/gateway";
import { closePaneResources } from "./actions";
import { DEFAULT_THEME, isThemeId, type ThemeId } from "../lib/themes";

export type Theme = ThemeId;
export type SplitDirection = "row" | "column";
export type Direction = "left" | "right" | "up" | "down";
export type PaletteScope = "global" | "pane";

/** Smallest usable size of each pane kind, in px. */
const MIN_SIZE: Partial<Record<PaneKind, { w: number; h: number }>> = {
	chat: { w: 360, h: 260 },
	terminal: { w: 280, h: 150 },
	file: { w: 320, h: 220 },
	settings: { w: 380, h: 280 },
	studio: { w: 420, h: 300 },
	plan: { w: 380, h: 300 },
	graph: { w: 320, h: 240 },
	tasks: { w: 320, h: 220 },
	objectives: { w: 300, h: 220 },
};
const DEFAULT_MIN = { w: 280, h: 180 };
export const minSizeOf = (kind: PaneKind) => MIN_SIZE[kind] ?? DEFAULT_MIN;

interface AddPaneOptions {
	direction?: SplitDirection;
	nextTo?: string;
	floating?: boolean;
}

interface AppStore {
	projects: Project[];
	workspaces: Workspace[];
	activeWorkspaceId: string | null;
	theme: Theme;
	jumpMode: boolean;
	kbdMode: boolean;
	paletteOpen: boolean;
	paletteQuery: string;
	paletteScope: PaletteScope;
	modelPickerChatId: string | null;
	/** The model picker's view: models to pick from, or each role and its model. Remembered. */
	modelPickerView: ModelPickerView;
	addProjectOpen: boolean;
	loaded: boolean;
	saveError: string | null;
	maximizedPaneId: string | null;
	gridSize: { w: number; h: number } | null;

	load(): Promise<void>;
	addProject(path: string, name?: string): Promise<Project>;
	/** Remove a project: the gateway stops its chats and terminals; its panes close everywhere. */
	removeProject(id: string): Promise<void>;
	renameProject(id: string, name: string): Promise<void>;

	activeWorkspace(): Workspace | null;
	createWorkspace(name: string): void;
	switchWorkspace(id: string): void;
	cycleWorkspace(step: 1 | -1): void;
	renameWorkspace(id: string, name: string): void;
	deleteWorkspace(id: string): void;

	addPane(spec: Omit<PaneSpec, "id"> & { id?: string }, opts?: AddPaneOptions): string;
	closePane(paneId: string): void;
	updatePane(paneId: string, patch: Partial<PaneSpec>): void;
	focusPane(paneId: string): void;
	setSizes(path: number[], sizes: number[]): void;
	toggleMaximize(paneId: string): void;
	hidePane(paneId: string): void;
	restorePane(paneId: string): void;
	floatPane(paneId: string): void;
	dockPane(paneId: string): void;
	setFloatRect(paneId: string, rect: Partial<FloatRect>): void;
	swapPanes(a: string, b: string): void;
	resizePane(paneId: string, dir: Direction, step?: number): void;
	movePaneToWorkspace(paneId: string, workspaceId: string): void;
	setGridSize(w: number, h: number): void;
	/** Find a pane (in any workspace) and switch to it. */
	revealPane(paneId: string): boolean;

	setTheme(theme: Theme): void;
	setJumpMode(on: boolean): void;
	setKbdMode(on: boolean): void;
	openPalette(query?: string, scope?: PaletteScope): void;
	closePalette(): void;
	openModelPicker(chatId: string | null): void;
	setModelPickerView(view: ModelPickerView): void;
	setAddProjectOpen(open: boolean): void;
}

export type ModelPickerView = "models" | "roles";

// ---------------------------------------------------------------------------
// Layout tree helpers
// ---------------------------------------------------------------------------

function newWorkspace(name: string): Workspace {
	return { id: crypto.randomUUID(), name, panes: {}, layout: null, hidden: [], hiddenManual: [], floating: {}, lastFocus: {}, updatedAt: Date.now() };
}

export function insertPane(layout: LayoutNode | null, targetId: string | undefined, paneId: string, direction: SplitDirection): LayoutNode {
	const leaf: LayoutNode = { type: "pane", paneId };
	if (!layout) return leaf;
	if (!targetId || !paneIdsInOrder(layout).includes(targetId)) {
		if (layout.type === "split" && layout.direction === direction) {
			const n = layout.children.length + 1;
			return { ...layout, children: [...layout.children, leaf], sizes: Array(n).fill(100 / n) };
		}
		return { type: "split", direction, sizes: [50, 50], children: [layout, leaf] };
	}
	const walk = (node: LayoutNode): LayoutNode => {
		if (node.type === "pane") {
			return node.paneId === targetId ? { type: "split", direction, sizes: [50, 50], children: [node, leaf] } : node;
		}
		// Prefer adding a sibling in a same-direction split over nesting.
		const index = node.children.findIndex(child => child.type === "pane" && child.paneId === targetId);
		if (index !== -1 && node.direction === direction) {
			const children = node.children.slice();
			children.splice(index + 1, 0, leaf);
			return { ...node, children, sizes: Array(children.length).fill(100 / children.length) };
		}
		return { ...node, children: node.children.map(walk) };
	};
	return walk(layout);
}

export function removePane(layout: LayoutNode | null, paneId: string): LayoutNode | null {
	if (!layout) return null;
	if (layout.type === "pane") return layout.paneId === paneId ? null : layout;
	const kept = layout.children
		.map((child, i) => ({ child: removePane(child, paneId), size: layout.sizes[i] ?? 0 }))
		.filter((k): k is { child: LayoutNode; size: number } => k.child !== null);
	if (kept.length === 0) return null;
	if (kept.length === 1) return kept[0]?.child ?? null;
	const total = kept.reduce((sum, k) => sum + k.size, 0) || 1;
	return { ...layout, children: kept.map(k => k.child), sizes: kept.map(k => (k.size / total) * 100) };
}

export function paneIdsInOrder(layout: LayoutNode | null): string[] {
	if (!layout) return [];
	if (layout.type === "pane") return [layout.paneId];
	return layout.children.flatMap(paneIdsInOrder);
}

/** Pixel size of every docked pane for a grid of `w`×`h`. */
export function computeRects(layout: LayoutNode | null, w: number, h: number, x = 0, y = 0): Record<string, { x: number; y: number; w: number; h: number }> {
	if (!layout) return {};
	if (layout.type === "pane") return { [layout.paneId]: { x, y, w, h } };
	const out: Record<string, { x: number; y: number; w: number; h: number }> = {};
	const total = layout.sizes.reduce((a, b) => a + b, 0) || 100;
	let offset = 0;
	layout.children.forEach((child, i) => {
		const share = (layout.sizes[i] ?? 100 / layout.children.length) / total;
		if (layout.direction === "row") {
			Object.assign(out, computeRects(child, w * share, h, x + offset, y));
			offset += w * share;
		} else {
			Object.assign(out, computeRects(child, w, h * share, x, y + offset));
			offset += h * share;
		}
	});
	return out;
}

function swapLeaves(layout: LayoutNode | null, a: string, b: string): LayoutNode | null {
	if (!layout) return null;
	if (layout.type === "pane") {
		if (layout.paneId === a) return { type: "pane", paneId: b };
		if (layout.paneId === b) return { type: "pane", paneId: a };
		return layout;
	}
	return { ...layout, children: layout.children.map(child => swapLeaves(child, a, b) as LayoutNode) };
}

/** Insert `paneId` by splitting the largest docked pane along its longer side. */
function autoInsert(ws: Workspace, paneId: string, size: { w: number; h: number } | null): LayoutNode {
	if (!ws.layout) return { type: "pane", paneId };
	const rects = computeRects(ws.layout, size?.w ?? 1600, size?.h ?? 900);
	let target: string | undefined;
	let best = -1;
	for (const [id, r] of Object.entries(rects)) {
		const area = r.w * r.h;
		if (area > best) {
			best = area;
			target = id;
		}
	}
	const rect = target ? rects[target] : undefined;
	const direction: SplitDirection = rect && rect.w >= rect.h * 1.15 ? "row" : "column";
	return insertPane(ws.layout, target, paneId, direction);
}

function fits(ws: Workspace, layout: LayoutNode | null, size: { w: number; h: number }): boolean {
	const rects = computeRects(layout, size.w, size.h);
	return Object.entries(rects).every(([id, r]) => {
		const kind = ws.panes[id]?.kind ?? "chat";
		const min = minSizeOf(kind);
		return r.w >= min.w - 1 && r.h >= min.h - 1;
	});
}

/** Hide panes that do not fit, and bring back automatically hidden panes that now do. */
export function fitWorkspace(ws: Workspace, size: { w: number; h: number } | null): Workspace {
	if (!size || size.w < 50 || size.h < 50) return ws;
	let layout = ws.layout;
	const hidden = [...(ws.hidden ?? [])];
	const manual = new Set(ws.hiddenManual ?? []);
	const lastFocus = ws.lastFocus ?? {};
	let guard = 0;
	while (!fits(ws, layout, size) && paneIdsInOrder(layout).length > 1 && guard++ < 32) {
		const candidates = paneIdsInOrder(layout).filter(id => id !== ws.focusedPaneId);
		const victim = candidates.sort((a, b) => (lastFocus[a] ?? 0) - (lastFocus[b] ?? 0))[0];
		if (!victim) break;
		layout = removePane(layout, victim);
		hidden.push(victim);
	}
	for (let i = hidden.length - 1; i >= 0; i--) {
		const id = hidden[i];
		if (!id || manual.has(id) || !ws.panes[id]) continue;
		const trial = autoInsert({ ...ws, layout }, id, size);
		if (fits(ws, trial, size)) {
			layout = trial;
			hidden.splice(i, 1);
		} else {
			break;
		}
	}
	if (layout === ws.layout && hidden.length === (ws.hidden ?? []).length) return ws;
	return { ...ws, layout, hidden };
}

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingSaves = new Map<string, Workspace>();
const saving = new Map<string, Promise<void>>();
const deleted = new Set<string>();
const resyncing = new Set<string>();
function persist(workspace: Workspace | null | undefined) {
	if (!workspace || deleted.has(workspace.id) || resyncing.has(workspace.id)) return;
	pendingSaves.set(workspace.id, workspace);
	clearTimeout(saveTimers.get(workspace.id));
	saveTimers.set(
		workspace.id,
		setTimeout(() => {
			saveTimers.delete(workspace.id);
			void flushWorkspace(workspace.id);
		}, 400),
	);
}
async function flushWorkspace(id: string): Promise<void> {
	if (saving.has(id)) return saving.get(id);
	const run = async () => {
		while (!deleted.has(id) && pendingSaves.has(id)) {
			const workspace = pendingSaves.get(id)!;
			pendingSaves.delete(id);
			const revision = useApp.getState().workspaces.find(ws => ws.id === id)?.revision ?? workspace.revision ?? 0;
			try {
				const saved = await api<Workspace>(`/api/workspaces/${id}`, { method: "PUT", body: JSON.stringify({ ...workspace, revision }) });
				useApp.setState(state => ({ saveError: null, workspaces: state.workspaces.map(ws => (ws.id === id ? { ...ws, revision: saved.revision } : ws)) }));
			} catch (error) {
				pendingSaves.delete(id);
				clearTimeout(saveTimers.get(id));
				if (error instanceof GatewayError && error.status === 409 && !deleted.has(id)) {
					resyncing.add(id);
					try {
						const fresh = await api<Workspace[]>("/api/workspaces");
						if (!deleted.has(id))
							useApp.setState(state => {
								const local = state.workspaces.find(ws => ws.id === id);
								const saved = fresh.find(ws => ws.id === id);
								// Close only panes no workspace holds any more (a pane may have moved to another one).
								const stillHeld = (paneId: string) =>
									fresh.some(ws => ws.panes[paneId]) || state.workspaces.some(ws => ws.id !== id && ws.panes[paneId]);
								for (const pane of Object.values(local?.panes ?? {})) if (!saved?.panes[pane.id] && !stillHeld(pane.id)) closePaneResources(pane);
								const workspaces = state.workspaces.flatMap(ws => (ws.id === id ? fresh.filter(ws => ws.id === id).map(normalize) : [ws]));
								return {
									workspaces,
									activeWorkspaceId: workspaces.some(ws => ws.id === state.activeWorkspaceId) ? state.activeWorkspaceId : (workspaces[0]?.id ?? null),
								};
							});
					} finally {
						resyncing.delete(id);
					}
				}
				useApp.setState({ saveError: (error as Error).message });
				return;
			}
		}
	};
	const work = run()
		.catch(error => {
			useApp.setState({ saveError: (error as Error).message });
		})
		.finally(() => saving.delete(id));
	saving.set(id, work);
	return work;
}

function readModelPickerView(): ModelPickerView {
	try {
		return localStorage.getItem("gyre.modelPickerView") === "roles" ? "roles" : "models";
	} catch {
		return "models";
	}
}

export function readTheme(): Theme {
	try {
		const saved = localStorage.getItem("gyre.theme");
		return isThemeId(saved) ? saved : DEFAULT_THEME;
	} catch {
		return DEFAULT_THEME;
	}
}

function normalize(ws: Workspace): Workspace {
	return { hidden: [], hiddenManual: [], floating: {}, lastFocus: {}, ...ws };
}

export const useApp = create<AppStore>((set, get) => {
	const mutate = (workspaceId: string | null | undefined, fn: (ws: Workspace) => Workspace, fit = true) => {
		if (!workspaceId) return;
		const { workspaces, gridSize, activeWorkspaceId } = get();
		const next = workspaces.map(ws => {
			if (ws.id !== workspaceId) return ws;
			const changed = fn(ws);
			const fitted = fit && ws.id === activeWorkspaceId ? fitWorkspace(changed, gridSize) : changed;
			return fitted === ws ? ws : { ...fitted, updatedAt: Date.now() };
		});
		set({ workspaces: next });
		persist(next.find(ws => ws.id === workspaceId));
	};
	const mutateActive = (fn: (ws: Workspace) => Workspace, fit = true) => mutate(get().activeWorkspaceId, fn, fit);

	const detach = (ws: Workspace, paneId: string): Workspace => {
		const floating = { ...(ws.floating ?? {}) };
		delete floating[paneId];
		return {
			...ws,
			layout: removePane(ws.layout, paneId),
			hidden: (ws.hidden ?? []).filter(id => id !== paneId),
			hiddenManual: (ws.hiddenManual ?? []).filter(id => id !== paneId),
			floating,
		};
	};

	return {
		projects: [],
		workspaces: [],
		activeWorkspaceId: null,
		theme: readTheme(),
		jumpMode: false,
		kbdMode: false,
		paletteOpen: false,
		paletteQuery: "",
		paletteScope: "global",
		modelPickerChatId: null,
		modelPickerView: readModelPickerView(),
		addProjectOpen: false,
		loaded: false,
		saveError: null,
		maximizedPaneId: null,
		gridSize: null,

		async load() {
			const [projects, workspaces] = await Promise.all([api<Project[]>("/api/projects"), api<Workspace[]>("/api/workspaces")]);
			let list = workspaces.map(normalize);
			if (list.length === 0) {
				const first = newWorkspace("Main");
				list = [first];
				persist(first);
			}
			const remembered = localStorage.getItem("gyre.workspace");
			const active = list.find(ws => ws.id === remembered)?.id ?? list[0]?.id ?? null;
			set({ projects, workspaces: list, activeWorkspaceId: active, loaded: true, addProjectOpen: projects.length === 0 });
		},

		async addProject(path, name) {
			const project = await api<Project>("/api/projects", { method: "POST", body: JSON.stringify({ path, name }) });
			set(state => ({ projects: state.projects.some(p => p.id === project.id) ? state.projects : [...state.projects, project] }));
			return project;
		},

		async removeProject(id) {
			await api(`/api/projects/${id}`, { method: "DELETE" });
			set(state => ({ projects: state.projects.filter(p => p.id !== id) }));
			for (const ws of get().workspaces) {
				for (const pane of Object.values(ws.panes)) {
					if (pane.projectId !== id) continue;
					closePaneResources(pane);
					get().closePane(pane.id);
				}
			}
		},

		async renameProject(id, name) {
			const project = await api<Project>(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });
			set(state => ({ projects: state.projects.map(p => (p.id === id ? project : p)) }));
		},

		activeWorkspace() {
			const { workspaces, activeWorkspaceId } = get();
			return workspaces.find(ws => ws.id === activeWorkspaceId) ?? null;
		},

		createWorkspace(name) {
			const ws = newWorkspace(name);
			set(state => ({ workspaces: [...state.workspaces, ws], activeWorkspaceId: ws.id, maximizedPaneId: null }));
			localStorage.setItem("gyre.workspace", ws.id);
			persist(ws);
		},

		switchWorkspace(id) {
			set({ activeWorkspaceId: id, maximizedPaneId: null });
			localStorage.setItem("gyre.workspace", id);
			// The grid size may differ from when this workspace was last laid out.
			mutateActive(ws => ws);
		},

		cycleWorkspace(step) {
			const { workspaces, activeWorkspaceId } = get();
			if (workspaces.length < 2) return;
			const index = workspaces.findIndex(ws => ws.id === activeWorkspaceId);
			const next = workspaces[(index + step + workspaces.length) % workspaces.length];
			if (next) get().switchWorkspace(next.id);
		},

		renameWorkspace(id, name) {
			mutate(id, ws => ({ ...ws, name }), false);
		},

		deleteWorkspace(id) {
			deleted.add(id);
			clearTimeout(saveTimers.get(id));
			saveTimers.delete(id);
			pendingSaves.delete(id);
			const removed = get().workspaces.find(ws => ws.id === id);
			for (const pane of Object.values(removed?.panes ?? {})) closePaneResources(pane);
			const remaining = get().workspaces.filter(ws => ws.id !== id);
			if (remaining.length === 0) {
				const replacement = newWorkspace("Main");
				remaining.push(replacement);
				persist(replacement);
			}
			const active = get().activeWorkspaceId === id ? (remaining[0]?.id ?? null) : get().activeWorkspaceId;
			set({ workspaces: remaining, activeWorkspaceId: active });
			void (saving.get(id) ?? Promise.resolve())
				.then(() => api(`/api/workspaces/${id}`, { method: "DELETE" }))
				.catch(e => set({ saveError: (e as Error).message }));
		},

		addPane(spec, opts = {}) {
			const id = spec.id ?? crypto.randomUUID();
			const { gridSize } = get();
			mutateActive(ws => {
				const panes = { ...ws.panes, [id]: { ...spec, id } };
				const lastFocus = { ...(ws.lastFocus ?? {}), [id]: Date.now() };
				if (opts.floating) {
					const w = Math.min(560, (gridSize?.w ?? 1200) * 0.6);
					const h = Math.min(460, (gridSize?.h ?? 800) * 0.7);
					const z = Math.max(10, ...Object.values(ws.floating ?? {}).map(f => f.z)) + 1;
					const rect: FloatRect = { x: ((gridSize?.w ?? 1200) - w) / 2, y: ((gridSize?.h ?? 800) - h) / 3, w, h, z };
					return { ...ws, panes, lastFocus, focusedPaneId: id, floating: { ...(ws.floating ?? {}), [id]: rect } };
				}
				const base = { ...ws, panes };
				const layout =
					opts.nextTo && paneIdsInOrder(ws.layout).includes(opts.nextTo)
						? insertPane(ws.layout, opts.nextTo, id, opts.direction ?? "row")
						: autoInsert(base, id, gridSize);
				return { ...base, layout, lastFocus, focusedPaneId: id };
			});
			set({ maximizedPaneId: null });
			return id;
		},

		closePane(paneId) {
			const owner = get().workspaces.find(ws => ws.panes[paneId]);
			mutate(owner?.id, ws => {
				const detached = detach(ws, paneId);
				const panes = { ...detached.panes };
				delete panes[paneId];
				const lastFocus = { ...(ws.lastFocus ?? {}) };
				delete lastFocus[paneId];
				const order = paneIdsInOrder(detached.layout);
				const byRecency = [...order, ...Object.keys(detached.floating ?? {})].sort((a, b) => (lastFocus[b] ?? 0) - (lastFocus[a] ?? 0));
				return {
					...detached,
					panes,
					lastFocus,
					focusedPaneId: ws.focusedPaneId === paneId ? byRecency[0] : ws.focusedPaneId,
				};
			});
			if (get().maximizedPaneId === paneId) set({ maximizedPaneId: null });
		},

		updatePane(paneId, patch) {
			const { workspaces } = get();
			const owner = workspaces.find(ws => ws.panes[paneId]);
			mutate(
				owner?.id,
				ws => {
					const pane = ws.panes[paneId];
					if (!pane) return ws;
					return { ...ws, panes: { ...ws.panes, [paneId]: { ...pane, ...patch } } };
				},
				false,
			);
		},

		focusPane(paneId) {
			const ws = get().activeWorkspace();
			if (!ws?.panes[paneId]) return;
			const isHidden = (ws.hidden ?? []).includes(paneId);
			if (ws.focusedPaneId === paneId && !isHidden) return;
			if (isHidden) {
				get().restorePane(paneId);
				return;
			}
			mutateActive(w => {
				const floating = w.floating?.[paneId]
					? { ...w.floating, [paneId]: { ...w.floating[paneId], z: Math.max(10, ...Object.values(w.floating).map(f => f.z)) + 1 } as FloatRect }
					: w.floating;
				return { ...w, focusedPaneId: paneId, floating, lastFocus: { ...(w.lastFocus ?? {}), [paneId]: Date.now() } };
			}, false);
		},

		setSizes(path, sizes) {
			mutateActive(ws => {
				const walk = (node: LayoutNode, depth: number): LayoutNode => {
					if (node.type !== "split") return node;
					if (depth === path.length) return { ...node, sizes };
					const index = path[depth] ?? 0;
					return { ...node, children: node.children.map((c, i) => (i === index ? walk(c, depth + 1) : c)) };
				};
				return ws.layout ? { ...ws, layout: walk(ws.layout, 0) } : ws;
			}, false);
		},

		toggleMaximize(paneId) {
			set(state => ({ maximizedPaneId: state.maximizedPaneId === paneId ? null : paneId }));
		},

		hidePane(paneId) {
			mutateActive(ws => {
				if (!ws.panes[paneId]) return ws;
				const detached = detach(ws, paneId);
				const order = paneIdsInOrder(detached.layout);
				return {
					...detached,
					hidden: [...(detached.hidden ?? []), paneId],
					hiddenManual: [...(detached.hiddenManual ?? []), paneId],
					focusedPaneId: ws.focusedPaneId === paneId ? order[order.length - 1] : ws.focusedPaneId,
				};
			});
			if (get().maximizedPaneId === paneId) set({ maximizedPaneId: null });
		},

		restorePane(paneId) {
			const { gridSize } = get();
			mutateActive(ws => {
				if (!ws.panes[paneId]) return ws;
				const detached = detach(ws, paneId);
				const now = Date.now();
				return {
					...detached,
					layout: autoInsert(detached, paneId, gridSize),
					focusedPaneId: paneId,
					lastFocus: { ...(ws.lastFocus ?? {}), [paneId]: now },
				};
			});
		},

		floatPane(paneId) {
			const { gridSize } = get();
			mutateActive(ws => {
				if (!ws.panes[paneId] || ws.floating?.[paneId]) return ws;
				const detached = detach(ws, paneId);
				const w = Math.min(620, (gridSize?.w ?? 1200) * 0.55);
				const h = Math.min(480, (gridSize?.h ?? 800) * 0.65);
				const z = Math.max(10, ...Object.values(ws.floating ?? {}).map(f => f.z)) + 1;
				const offset = Object.keys(ws.floating ?? {}).length * 24;
				return {
					...detached,
					floating: { ...(detached.floating ?? {}), [paneId]: { x: ((gridSize?.w ?? 1200) - w) / 2 + offset, y: 40 + offset, w, h, z } },
					focusedPaneId: paneId,
				};
			});
			if (get().maximizedPaneId === paneId) set({ maximizedPaneId: null });
		},

		dockPane(paneId) {
			get().restorePane(paneId);
		},

		setFloatRect(paneId, rect) {
			mutateActive(ws => {
				const current = ws.floating?.[paneId];
				if (!current) return ws;
				return { ...ws, floating: { ...ws.floating, [paneId]: { ...current, ...rect } } };
			}, false);
		},

		swapPanes(a, b) {
			mutateActive(ws => ({ ...ws, layout: swapLeaves(ws.layout, a, b) }), false);
		},

		resizePane(paneId, dir, step = 6) {
			mutateActive(ws => {
				if (!ws.layout) return ws;
				const orientation: SplitDirection = dir === "left" || dir === "right" ? "row" : "column";
				// Find the deepest split of this orientation containing the pane.
				const findPath = (node: LayoutNode, path: number[]): { path: number[]; index: number } | null => {
					if (node.type !== "split") return null;
					for (let i = 0; i < node.children.length; i++) {
						const child = node.children[i] as LayoutNode;
						if (!paneIdsInOrder(child).includes(paneId)) continue;
						const deeper = findPath(child, [...path, i]);
						if (deeper) return deeper;
						if (node.direction === orientation) return { path, index: i };
					}
					return null;
				};
				const found = findPath(ws.layout, []);
				if (!found) return ws;
				const walk = (node: LayoutNode, depth: number): LayoutNode => {
					if (node.type !== "split") return node;
					if (depth === found.path.length) {
						const sizes = node.sizes.slice();
						const i = found.index;
						const grow = dir === "right" || dir === "down";
						const [a, b] = grow ? (i + 1 < sizes.length ? [i, i + 1] : [i - 1, i]) : i > 0 ? [i - 1, i] : [i, i + 1];
						if (a === undefined || b === undefined || a < 0 || b >= sizes.length) return node;
						// Moving the shared edge right/down grows `a`; left/up grows `b`.
						const delta = grow ? step : -step;
						const na = (sizes[a] ?? 0) + delta;
						const nb = (sizes[b] ?? 0) - delta;
						if (na < 8 || nb < 8) return node;
						sizes[a] = na;
						sizes[b] = nb;
						return { ...node, sizes };
					}
					const index = found.path[depth] ?? 0;
					return { ...node, children: node.children.map((c, i) => (i === index ? walk(c, depth + 1) : c)) };
				};
				return { ...ws, layout: walk(ws.layout, 0) };
			});
		},

		movePaneToWorkspace(paneId, workspaceId) {
			const { workspaces, activeWorkspaceId, gridSize } = get();
			const source = workspaces.find(ws => ws.panes[paneId]);
			const target = workspaces.find(ws => ws.id === workspaceId);
			if (!source || !target || source.id === target.id) return;
			const pane = source.panes[paneId];
			if (!pane) return;
			mutate(source.id, ws => {
				const detached = detach(ws, paneId);
				const panes = { ...detached.panes };
				delete panes[paneId];
				const order = paneIdsInOrder(detached.layout);
				return { ...detached, panes, focusedPaneId: ws.focusedPaneId === paneId ? order[order.length - 1] : ws.focusedPaneId };
			});
			mutate(
				target.id,
				ws => {
					const base = { ...ws, panes: { ...ws.panes, [paneId]: pane } };
					return { ...base, layout: autoInsert(base, paneId, gridSize), lastFocus: { ...(ws.lastFocus ?? {}), [paneId]: Date.now() } };
				},
				target.id === activeWorkspaceId,
			);
		},

		setGridSize(w, h) {
			const prev = get().gridSize;
			if (prev && Math.abs(prev.w - w) < 4 && Math.abs(prev.h - h) < 4) return;
			set({ gridSize: { w, h } });
			mutateActive(ws => ws);
		},

		revealPane(paneId) {
			const owner = get().workspaces.find(ws => ws.panes[paneId]);
			if (!owner) return false;
			if (owner.id !== get().activeWorkspaceId) get().switchWorkspace(owner.id);
			get().focusPane(paneId);
			return true;
		},

		setTheme(theme) {
			localStorage.setItem("gyre.theme", theme);
			document.documentElement.dataset.theme = theme;
			set({ theme });
		},
		setJumpMode(on) {
			set({ jumpMode: on, kbdMode: on ? false : get().kbdMode });
		},
		setKbdMode(on) {
			set({ kbdMode: on, jumpMode: on ? false : get().jumpMode });
		},
		openPalette(query = "", scope = "global") {
			set({ paletteOpen: true, paletteQuery: query, paletteScope: scope });
		},
		closePalette() {
			set({ paletteOpen: false, paletteQuery: "" });
		},
		openModelPicker(chatId) {
			set({ modelPickerChatId: chatId });
		},
		setModelPickerView(view) {
			try {
				localStorage.setItem("gyre.modelPickerView", view);
			} catch {}
			set({ modelPickerView: view });
		},
		setAddProjectOpen(open) {
			set({ addProjectOpen: open });
		},
	};
});

/** The chat bound to the focused pane: a chat pane itself, or a pane attached to a chat. */
export function focusedChatId(): string | null {
	const ws = useApp.getState().activeWorkspace();
	const pane = ws?.focusedPaneId ? ws.panes[ws.focusedPaneId] : undefined;
	if (pane?.kind === "chat") return pane.id;
	return pane?.chatId ?? null;
}

/** Open (or focus) a pane attached to a chat, e.g. its plan or objectives. */
export function openChatPane(kind: PaneKind, chatId: string, extra: Partial<PaneSpec> = {}): string {
	const app = useApp.getState();
	for (const ws of app.workspaces) {
		const existing = Object.values(ws.panes).find(p => p.kind === kind && p.chatId === chatId && (extra.ref === undefined || p.ref === extra.ref));
		if (existing) {
			if (extra.section !== undefined) app.updatePane(existing.id, { section: extra.section });
			app.revealPane(existing.id);
			return existing.id;
		}
	}
	const chatPane = app.workspaces.flatMap(ws => Object.values(ws.panes)).find(p => p.id === chatId);
	return app.addPane(
		{ kind, chatId, projectId: chatPane?.projectId, ...extra },
		paneIdsInOrder(app.activeWorkspace()?.layout ?? null).includes(chatId) ? { nextTo: chatId, direction: "row" } : {},
	);
}

/**
 * Open the Git pane for a project (`/git [revision]`), next to `nextTo` when it
 * is in the layout. An existing pane for the same project and revision is
 * revealed instead of opening another one.
 */
export function openGitPane(projectId: string, revision?: string, nextTo?: string): string {
	const app = useApp.getState();
	for (const ws of app.workspaces) {
		const existing = Object.values(ws.panes).find(p => p.kind === "git" && p.projectId === projectId && (p.revision ?? "") === (revision ?? ""));
		if (existing) {
			// Another pane filling the grid would hide the one being revealed.
			if (app.maximizedPaneId && app.maximizedPaneId !== existing.id) useApp.setState({ maximizedPaneId: null });
			app.revealPane(existing.id);
			return existing.id;
		}
	}
	const inLayout = nextTo !== undefined && paneIdsInOrder(app.activeWorkspace()?.layout ?? null).includes(nextTo);
	return app.addPane({ kind: "git", projectId, ...(revision ? { revision } : {}) }, inLayout ? { nextTo, direction: "row" } : {});
}

/** Reveal the first pane matching `match` in any workspace, or add `spec` (next to `nextTo` when it is docked). */
export function openOrRevealPane(spec: Omit<PaneSpec, "id">, match: (pane: PaneSpec) => boolean, nextTo?: string): string {
	const app = useApp.getState();
	for (const ws of app.workspaces) {
		const existing = Object.values(ws.panes).find(match);
		if (existing) {
			if (app.maximizedPaneId && app.maximizedPaneId !== existing.id) useApp.setState({ maximizedPaneId: null });
			app.revealPane(existing.id);
			return existing.id;
		}
	}
	const inLayout = nextTo !== undefined && paneIdsInOrder(app.activeWorkspace()?.layout ?? null).includes(nextTo);
	return app.addPane(spec, inLayout ? { nextTo, direction: "row" } : {});
}

export const openJobsPane = (nextTo?: string) => openOrRevealPane({ kind: "jobs" }, p => p.kind === "jobs", nextTo);

/** Show `url` in a browser pane: the first one in the active workspace, else a new one. */
export function openBrowserPane(url: string, nextTo?: string): string {
	const app = useApp.getState();
	const existing = Object.values(app.activeWorkspace()?.panes ?? {}).find(p => p.kind === "browser");
	if (existing) {
		app.updatePane(existing.id, { url });
		app.revealPane(existing.id);
		return existing.id;
	}
	const inLayout = nextTo !== undefined && paneIdsInOrder(app.activeWorkspace()?.layout ?? null).includes(nextTo);
	return app.addPane({ kind: "browser", url }, inLayout ? { nextTo, direction: "row" } : {});
}
