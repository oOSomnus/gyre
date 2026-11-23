/**
 * Agent Studio: create and edit omp task agents (`.omp/agents/*.md`). Edits are
 * drafts until published; publishing writes the agent file, which omp picks up
 * on the next sub-agent spawn. Model routing per agent uses either the file's
 * `model:` field or omp's `task.agentModelOverrides` setting.
 */
import type { PaneSpec } from "@gyre/protocol";
import { Bot, Copy, FilePlus2, Save, Send, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createDraftStore, type Draft, DraftConflictError, type Drafts } from "../lib/agent-drafts";
import { api, apiWithEtag, GatewayError } from "../lib/gateway";
import { useRoles } from "../lib/roles";
import { useRoutingStore } from "../lib/config-map";
import { FALLBACK_TOOLS, fetchTools, groupTools, type ToolInfo } from "../lib/tools";
import { useApp } from "../store/app";
import { useChats } from "../store/chats";

interface AgentFile {
	name: string;
	scope: "user" | "project" | "bundled";
	path?: string;
	frontmatter: Record<string, unknown>;
	instructions: string;
	shadowed?: boolean;
}

const DRAFTS_URL = "/api/kv/ui.agentDrafts";
/** Shared draft record; every write is conditional on the version read (`If-Match`). */
const draftStore = createDraftStore({
	async read() {
		const { body, etag } = await apiWithEtag<Drafts | null>(DRAFTS_URL);
		return { body, etag: etag ?? '"absent"' };
	},
	async write(body, etag) {
		try {
			await api(DRAFTS_URL, { method: "PUT", body: JSON.stringify(body), headers: { "if-match": etag } });
			return true;
		} catch (error) {
			if (error instanceof GatewayError && error.status === 412) return false;
			throw error;
		}
	},
});

const THINKING = ["", "off", "minimal", "low", "medium", "high", "xhigh"];

function toList(value: unknown): string[] | null {
	if (value === undefined || value === null || value === "") return null;
	if (Array.isArray(value)) return value.map(String);
	return String(value)
		.split(",")
		.map(s => s.trim())
		.filter(Boolean);
}

function draftFrom(agent: AgentFile): Draft {
	const fm = agent.frontmatter;
	const model = Array.isArray(fm.model) ? String(fm.model[0] ?? "") : String(fm.model ?? "");
	return {
		name: agent.name,
		description: String(fm.description ?? ""),
		scope: agent.scope === "project" ? "project" : "user",
		model,
		thinking: String(fm.thinking ?? fm["thinking-level"] ?? ""),
		tools: toList(fm.tools),
		spawns: Array.isArray(fm.spawns) ? fm.spawns.join(", ") : String(fm.spawns ?? ""),
		instructions: agent.instructions,
		previousName: agent.scope === "bundled" ? undefined : agent.name,
	};
}

const EMPTY: Draft = { name: "", description: "", scope: "user", model: "", thinking: "", tools: null, spawns: "", instructions: "" };

export function StudioPane({ pane }: { pane: PaneSpec }) {
	const projects = useApp(s => s.projects);
	const [projectId, setProjectId] = useState<string | undefined>(pane.projectId ?? projects[0]?.id);
	return <StudioProject key={projectId ?? "user"} projectId={projectId} setProjectId={setProjectId} />;
}

function StudioProject({ projectId, setProjectId }: { projectId?: string; setProjectId(value: string | undefined): void }) {
	const projects = useApp(s => s.projects);
	const editorEpoch = useRef(0);
	const publishing = useRef(false);
	const [pendingPublish, setPendingPublish] = useState(false);
	const [cleanupKey, setCleanupKey] = useState<string | null>(null);
	/** `savedAt` of the stored draft that the pending cleanup may remove. */
	const cleanupVersion = useRef<number | undefined>(undefined);
	useEffect(() => () => {
		editorEpoch.current++;
	}, []);
	const [loaded, setLoaded] = useState(false);
	const [agents, setAgents] = useState<AgentFile[]>([]);
	const [selected, setSelected] = useState<string | null>(null);
	const [draft, setDraft] = useState<Draft>(EMPTY);
	/** Cache of the shared draft record (draft chips, contents to load). */
	const [drafts, setDrafts] = useState<Drafts>({});
	/**
	 * The stored version the editor's contents are based on, which saves and publish cleanup
	 * use as their conflict base. It changes only when this editor loads, saves or explicitly
	 * adopts a draft, never because the shared cache was refreshed for another reason.
	 */
	const editorBase = useRef<{ key: string; savedAt: number | undefined } | null>(null);
	const baseFor = (key: string) => (editorBase.current?.key === key ? editorBase.current.savedAt : undefined);
	const overrides = useRoutingStore(s => s.assignments);
	const [tools, setTools] = useState<ToolInfo[]>(FALLBACK_TOOLS);
	const [message, setMessage] = useState<string | null>(null);
	const { roles } = useRoles();
	const chatId = useChats(s => Object.values(s.chats).find(c => c.info.status === "ready" && (!projectId || c.info.projectId === projectId))?.info.chatId);

	const generation = useChats(s => (chatId ? s.chats[chatId]?.info.generation : undefined));
	const reloadGeneration = useRef(0);
	const reload = async () => {
		const request = ++reloadGeneration.current;
		const [list, saved] = await Promise.all([
			api<AgentFile[]>(`/api/agents${projectId ? `?projectId=${projectId}` : ""}`),
			draftStore.load(),
			useRoutingStore.getState().load(),
		]);
		if (request !== reloadGeneration.current) return;
		setAgents(list);
		setDrafts(saved);
		setLoaded(true);
		// Shared routing store was loaded above.
	};

	useEffect(() => {
		setSelected(null);
		setDraft(EMPTY);
		void reload().catch(e => setMessage(String((e as Error).message)));
		return () => {
			reloadGeneration.current++;
		};
		// biome-ignore lint/correctness/useExhaustiveDependencies: reload on project change
	}, [projectId]);

	useEffect(() => {
		let current = true;
		if (chatId)
			void fetchTools(chatId).then(list => {
				if (current) setTools(list.filter(t => t.name !== "submit_plan"));
			});
		return () => {
			current = false;
		};
	}, [chatId, generation]);

	const keyOf = (scope: string, name: string) => (scope === "project" ? `project:${projectId}:${name}` : `${scope}:${name}`);
	const select = (agent: AgentFile | null) => {
		editorEpoch.current++;
		setCleanupKey(null);
		const key = agent ? keyOf(agent.scope, agent.name) : drafts[`new:project:${projectId}`] ? `new:project:${projectId}` : "new:user";
		setSelected(key);
		setDraft(drafts[key] ?? (agent ? draftFrom(agent) : { ...EMPTY }));
		editorBase.current = { key, savedAt: drafts[key]?.savedAt };
		setMessage(null);
	};

	const draftKey = () => {
		if (selected && !selected.startsWith("new:")) return selected;
		return draft.scope === "project" ? `new:project:${projectId}` : "new:user";
	};

	const saveDraft = async () => {
		const epoch = editorEpoch.current;
		const key = draftKey();
		try {
			const { saved, drafts: next } = await draftStore.save(key, draft, baseFor(key));
			setDrafts(next);
			if (epoch !== editorEpoch.current) return;
			editorBase.current = { key, savedAt: saved.savedAt };
			setMessage("Draft saved (not yet visible to omp).");
		} catch (error) {
			if (error instanceof DraftConflictError) setDrafts(error.drafts);
			if (epoch !== editorEpoch.current) return;
			// The user was told about the newer version: saving again replaces it on purpose.
			if (error instanceof DraftConflictError) editorBase.current = { key, savedAt: error.drafts[key]?.savedAt };
			setMessage((error as Error).message);
		}
	};

	const cleanDraft = (key: string, publishedSavedAt: number | undefined) => draftStore.removePublished(key, publishedSavedAt);
	const KEPT_NEWER = "Published; kept the newer draft saved meanwhile.";
	const retryCleanup = async () => {
		if (!cleanupKey) return;
		const epoch = editorEpoch.current;
		try {
			const { removed, drafts: next } = await cleanDraft(cleanupKey, cleanupVersion.current);
			if (epoch !== editorEpoch.current) return;
			setDrafts(next);
			setCleanupKey(null);
			setMessage(removed ? "Published; draft cleanup completed." : KEPT_NEWER);
		} catch (error) {
			if (epoch === editorEpoch.current) setMessage(`Published; draft cleanup failed: ${(error as Error).message}`);
		}
	};
	const publish = async () => {
		if (publishing.current || cleanupKey) return;
		publishing.current = true;
		setPendingPublish(true);
		const epoch = editorEpoch.current;
		const ownsEditor = () => epoch === editorEpoch.current;
		const savedDraftKey = draftKey();
		const publishedVersion = baseFor(savedDraftKey);
		setMessage(null);
		const frontmatter: Record<string, unknown> = {
			description: draft.description,
			model: draft.model || undefined,
			thinking: draft.thinking || undefined,
			tools: draft.tools ?? undefined,
			spawns: draft.spawns.trim()
				? draft.spawns.trim() === "*"
					? "*"
					: draft.spawns
							.split(",")
							.map(s => s.trim())
							.filter(Boolean)
				: undefined,
		};
		try {
			await api("/api/agents", {
				method: "PUT",
				body: JSON.stringify({
					scope: draft.scope,
					projectId,
					name: draft.name,
					previousName: draft.previousName,
					frontmatter,
					instructions: draft.instructions,
				}),
			});
			// The agent file is committed even if draft cleanup subsequently fails.
			if (ownsEditor()) {
				const publishedKey = keyOf(draft.scope, draft.name);
				setSelected(publishedKey);
				setDraft(d => ({ ...d, previousName: draft.name }));
				// The editor now shows the published file, not any stored draft of it.
				editorBase.current = { key: publishedKey, savedAt: undefined };
			}
			let removed: boolean;
			try {
				const result = await cleanDraft(savedDraftKey, publishedVersion);
				removed = result.removed;
				if (ownsEditor()) setDrafts(result.drafts);
			} catch (error) {
				if (ownsEditor()) {
					cleanupVersion.current = publishedVersion;
					setCleanupKey(savedDraftKey);
					setMessage(`Published; draft cleanup failed: ${(error as Error).message}`);
				}
				return;
			}
			if (!ownsEditor()) return;
			await reload();
			if (ownsEditor()) setMessage(removed ? `Published ${draft.name}. omp uses it on the next sub-agent spawn.` : KEPT_NEWER);
		} catch (e) {
			if (ownsEditor()) setMessage(String((e as Error).message));
		} finally {
			publishing.current = false;
			setPendingPublish(false);
		}
	};

	const remove = async (agent: AgentFile) => {
		if (agent.scope === "bundled" || !confirm(`Delete agent ${agent.name}?`)) return;
		await api(`/api/agents?scope=${agent.scope}&name=${encodeURIComponent(agent.name)}${projectId ? `&projectId=${projectId}` : ""}`, { method: "DELETE" });
		await reload();
		select(null);
	};

	const setOverride = async (name: string, selector: string) => {
		await useRoutingStore
			.getState()
			.assign(name, selector)
			.catch(e => setMessage((e as Error).message));
	};

	const groups = useMemo(() => groupTools(tools), [tools]);
	const toolSet = new Set(draft.tools ?? tools.map(t => t.name));
	const toggleTool = (name: string) => {
		const next = new Set(toolSet);
		if (next.has(name)) next.delete(name);
		else next.add(name);
		setDraft(d => ({ ...d, tools: [...next] }));
	};
	const toggleArea = (names: string[], on: boolean) => {
		const next = new Set(toolSet);
		for (const n of names) on ? next.add(n) : next.delete(n);
		setDraft(d => ({ ...d, tools: [...next] }));
	};
	const current = agents.find(a => keyOf(a.scope, a.name) === selected);
	const readOnly = current?.scope === "bundled";

	return (
		<div className="flex h-full min-h-0" style={{ background: "var(--panel)" }}>
			{/* agent list */}
			<div className="flex w-60 shrink-0 flex-col border-r" style={{ borderColor: "var(--border-strong)" }}>
				<div className="flex items-center gap-1.5 p-2">
					<select className="gy-input h-7 min-w-0 flex-1 text-[12px]" value={projectId ?? ""} onChange={e => setProjectId(e.target.value || undefined)}>
						<option value="">No project (user only)</option>
						{projects.map(p => (
							<option key={p.id} value={p.id}>
								{p.name}
							</option>
						))}
					</select>
					<button type="button" className="gy-btn" onClick={() => select(null)} disabled={!loaded} title="New agent" data-jump="new-agent">
						<FilePlus2 size={12} />
					</button>
				</div>
				<div className="min-h-0 flex-1 overflow-auto">
					{(["project", "user", "bundled"] as const).map(scope => {
						const list = agents.filter(a => a.scope === scope);
						if (list.length === 0) return null;
						return (
							<div key={scope}>
								<div className="gy-section py-1">{scope}</div>
								{list.map(agent => {
									const key = keyOf(agent.scope, agent.name);
									return (
										<button
											type="button"
											key={key}
											className="gy-row w-full text-left"
											style={selected === key ? { background: "var(--tint-tool)" } : undefined}
											onClick={() => select(agent)}
										>
											<Bot size={13} className="shrink-0" />
											<div className="min-w-0 flex-1">
												<div className="truncate text-[13px] font-medium" style={agent.shadowed ? { textDecoration: "line-through" } : undefined}>
													{agent.name}
													{drafts[key] && <span className="gy-chip warn ml-1.5">draft</span>}
												</div>
												<div className="truncate text-[11px]" style={{ color: "var(--muted)" }}>
													{String(agent.frontmatter.description ?? "")}
												</div>
											</div>
										</button>
									);
								})}
							</div>
						);
					})}
				</div>
			</div>

			{/* editor */}
			<div className="min-w-0 flex-1 overflow-auto">
				{message && (
					<div className="gy-row text-[12px]">
						{message}
						{!loaded && <button type="button" className="gy-btn" onClick={() => void reload().catch(e => setMessage((e as Error).message))}>Retry loading agents</button>}
						{cleanupKey && <button type="button" className="gy-btn" onClick={() => void retryCleanup()}>Retry draft cleanup</button>}
					</div>
				)}
				{selected === null ? (
					<div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
						<Bot size={28} />
						<div className="text-[15px] font-medium">Agent Studio</div>
						<div className="max-w-sm text-[12.5px]" style={{ color: "var(--text-dim)" }}>
							Build sub-agents the main agent can delegate to: a description, the model or role it runs on, the tools it may use, and its instructions.
						</div>
						<button type="button" className="gy-btn primary" disabled={!loaded} onClick={() => select(null)}>
							<FilePlus2 size={12} /> New agent
						</button>
					</div>
				) : (
					<div className="space-y-0">
						<div className="gy-section">
							{readOnly ? "Bundled agent (read-only)" : draft.previousName ? `Edit ${draft.previousName}` : "New agent"}
							<span className="ml-auto flex gap-1.5 font-normal tracking-normal normal-case">
								{readOnly ? (
									<button
										type="button"
										className="gy-btn"
										onClick={() => {
											editorEpoch.current++;
											setCleanupKey(null);
											setSelected("new:user");
											setDraft(d => ({ ...d, previousName: undefined, scope: "user", name: `${d.name}-custom` }));
											// A copy, not a loaded draft: saving over a stored new-agent draft reports a conflict.
											editorBase.current = { key: "new:user", savedAt: undefined };
										}}
									>
										<Copy size={11} /> Customize
									</button>
								) : (
									<>
										{current && (
											<button type="button" className="gy-btn danger" onClick={() => void remove(current)}>
												<Trash2 size={11} /> Delete
											</button>
										)}
										<button type="button" className="gy-btn" onClick={() => void saveDraft()}>
											<Save size={11} /> Save draft
										</button>
										<button
											type="button"
											className="gy-btn primary"
											onClick={() => void publish()}
											disabled={!draft.name || !draft.description || pendingPublish || cleanupKey !== null}
											data-testid="publish-agent"
										>
											<Send size={11} /> {pendingPublish ? "Publishing…" : "Publish"}
										</button>
									</>
								)}
							</span>
						</div>
						<fieldset disabled={readOnly} className="contents">
							<div className="gy-row">
								<label className="w-28 shrink-0 text-[12.5px]">Name</label>
								<input
									className="gy-input flex-1"
									value={draft.name}
									onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
									placeholder="reviewer-strict"
									data-testid="agent-name"
								/>
								<select className="gy-input" value={draft.scope} onChange={e => setDraft(d => ({ ...d, scope: e.target.value as Draft["scope"] }))}>
									<option value="user">User (all projects)</option>
									<option value="project" disabled={!projectId}>
										This project
									</option>
								</select>
							</div>
							<div className="gy-row">
								<label className="w-28 shrink-0 text-[12.5px]">Description</label>
								<input
									className="gy-input flex-1"
									value={draft.description}
									onChange={e => setDraft(d => ({ ...d, description: e.target.value }))}
									placeholder="One sentence: when should the main agent use this agent?"
									data-testid="agent-description"
								/>
							</div>
							<div className="gy-row">
								<label className="w-28 shrink-0 text-[12.5px]">Model</label>
								<select
									className="gy-input"
									value={draft.model.startsWith("@") || draft.model === "" ? draft.model : "custom"}
									onChange={e => setDraft(d => ({ ...d, model: e.target.value === "custom" ? "" : e.target.value }))}
								>
									<option value="">Inherit (task role)</option>
									{roles
										.filter(r => r.section === "chat")
										.map(r => (
											<option key={r.id} value={`@${r.id}`}>
												Role: {r.name}
											</option>
										))}
									<option value="custom">Specific model…</option>
								</select>
								{!draft.model.startsWith("@") && (
									<input
										className="gy-input flex-1"
										placeholder="provider/model-id"
										value={draft.model}
										onChange={e => setDraft(d => ({ ...d, model: e.target.value }))}
									/>
								)}
								<label className="text-[12.5px]">Thinking</label>
								<select className="gy-input" value={draft.thinking} onChange={e => setDraft(d => ({ ...d, thinking: e.target.value }))}>
									{THINKING.map(t => (
										<option key={t} value={t}>
											{t || "default"}
										</option>
									))}
								</select>
							</div>
							<div className="gy-row">
								<label className="w-28 shrink-0 text-[12.5px]">Can spawn</label>
								<input
									className="gy-input flex-1"
									value={draft.spawns}
									onChange={e => setDraft(d => ({ ...d, spawns: e.target.value }))}
									placeholder="Agent names, comma-separated, or * (needs the task tool)"
								/>
							</div>
						</fieldset>
						<div className="gy-row">
							<label className="w-28 shrink-0 text-[12.5px]">Routing override</label>
							<select
								className="gy-input"
								value={overrides[draft.name] ?? ""}
								onChange={e => void setOverride(draft.name, e.target.value)}
								disabled={!draft.name}
							>
								<option value="">None (use the agent's model)</option>
								{roles
									.filter(r => r.section === "chat")
									.map(r => (
										<option key={r.id} value={`@${r.id}`}>
											Role: {r.name}
										</option>
									))}
							</select>
							<span className="text-[11.5px]" style={{ color: "var(--muted)" }}>
								omp setting <span className="font-mono">task.agentModelOverrides</span>; applies to bundled agents too.
							</span>
						</div>
						<div className="gy-section">
							Actions
							<span className="ml-auto font-normal tracking-normal normal-case">
								<button type="button" className="gy-btn ghost" disabled={readOnly} onClick={() => setDraft(d => ({ ...d, tools: null }))}>
									Use default toolset
								</button>
							</span>
						</div>
						{draft.tools === null && (
							<div className="gy-row text-[12px]" style={{ color: "var(--muted)" }}>
								Default toolset (all built-ins). Untick anything to make an explicit allowlist; MCP and extension tools are always added by omp.
							</div>
						)}
						{groups.map(group => {
							const names = group.tools.map(t => t.name);
							const all = names.every(n => toolSet.has(n));
							return (
								<div key={group.area} className="border-b" style={{ borderColor: "color-mix(in srgb, var(--border-strong) 20%, transparent)" }}>
									<label className="flex items-center gap-2 px-3 py-1.5 text-[12.5px] font-semibold" style={{ background: "var(--panel)" }}>
										<input type="checkbox" disabled={readOnly} checked={all} onChange={e => toggleArea(names, e.target.checked)} />
										{group.area}
									</label>
									<div className="grid grid-cols-1 gap-x-4 px-8 pb-2 md:grid-cols-2">
										{group.tools.map(tool => (
											<label key={tool.name} className="flex items-start gap-2 py-0.5 text-[12px]" title={tool.description}>
												<input type="checkbox" disabled={readOnly} checked={toolSet.has(tool.name)} onChange={() => toggleTool(tool.name)} />
												<span className="font-mono">{tool.name}</span>
											</label>
										))}
									</div>
								</div>
							);
						})}
						<div className="gy-section">Instructions</div>
						<div className="p-3">
							<textarea
								className="gy-input min-h-48 w-full py-2 font-mono text-[12.5px]"
								value={draft.instructions}
								disabled={readOnly}
								onChange={e => setDraft(d => ({ ...d, instructions: e.target.value }))}
								placeholder="The agent's system prompt."
							/>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
