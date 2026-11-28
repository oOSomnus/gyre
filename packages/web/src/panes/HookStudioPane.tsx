/**
 * Hook Studio: create and edit omp hook modules (`<agentDir>/hooks/{pre,post}/*.ts`
 * and `<project>/.omp/hooks/{pre,post}/*.ts`). A guided form or a template generates
 * the module; the editor saves it conditionally on the version read. omp loads hooks
 * when a chat starts, so saving offers to restart the affected chats.
 */
import type { HookFile, HookPhase, PaneSpec } from "@gyre/protocol";
import { FilePlus2, Loader2, Plus, RotateCw, Save, Trash2, Webhook, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, GatewayError } from "../lib/gateway";
import {
	ACTIONS,
	EMPTY_FORM,
	formProblems,
	generateHook,
	HOOK_TEMPLATES,
	type HookForm,
	isToolTrigger,
	phaseFor,
	suggestedName,
	TRIGGERS,
} from "../lib/hook-templates";
import { unsavedPanes } from "../store/actions";
import { useApp } from "../store/app";

const MonacoViewer = lazy(() => import("./MonacoViewer"));

type Scope = HookFile["scope"];

/** The hook open in the editor. `version` null: not saved yet. */
interface Editing {
	scope: Scope;
	phase: HookPhase;
	name: string;
	content: string;
	version: string | null;
	/** Where the file is saved now, so a rename or move replaces it. */
	saved?: { scope: Scope; phase: HookPhase; name: string };
}

const keyOf = (h: { scope: Scope; phase: HookPhase; name: string }) => `${h.scope}:${h.phase}:${h.name}`;

export function HookStudioPane({ pane }: { pane: PaneSpec }) {
	const projects = useApp(s => s.projects);
	const [projectId, setProjectId] = useState<string | undefined>(pane.projectId ?? projects[0]?.id);
	return <HookStudio key={projectId ?? "user"} paneId={pane.id} initial={pane.section} projectId={projectId} setProjectId={setProjectId} />;
}

function HookStudio({
	paneId,
	initial,
	projectId,
	setProjectId,
}: {
	paneId: string;
	/** `scope:phase:name` to open first (e.g. from an error notification). */
	initial?: string;
	projectId?: string;
	setProjectId: (id: string | undefined) => void;
}) {
	const projects = useApp(s => s.projects);
	const [hooks, setHooks] = useState<HookFile[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [editing, setEditing] = useState<Editing | null>(null);
	/** Text in the editor; differs from `editing.content` while unsaved. */
	const [buffer, setBuffer] = useState("");
	const [creating, setCreating] = useState(false);
	const [form, setForm] = useState<HookForm>(EMPTY_FORM);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
	const [diagnostics, setDiagnostics] = useState<string[]>([]);
	const [restartable, setRestartable] = useState<Scope | null>(null);
	const loadGeneration = useRef(0);
	const project = projects.find(p => p.id === projectId);
	const dirty = !!editing && (buffer !== editing.content || editing.version === null);

	const load = useCallback(async () => {
		const generation = ++loadGeneration.current;
		try {
			const list = await api<HookFile[]>(`/api/hooks${projectId ? `?projectId=${projectId}` : ""}`);
			if (generation === loadGeneration.current) {
				setHooks(list);
				setLoadError(null);
			}
			return list;
		} catch (e) {
			if (generation === loadGeneration.current) setLoadError((e as Error).message);
			return null;
		}
	}, [projectId]);

	const open = useCallback(
		async (hook: { scope: Scope; phase: HookPhase; name: string }) => {
			try {
				const query = new URLSearchParams({ scope: hook.scope, phase: hook.phase, name: hook.name });
				if (projectId) query.set("projectId", projectId);
				const file = await api<HookFile>(`/api/hooks/file?${query}`);
				const content = file.content ?? "";
				setEditing({ scope: file.scope, phase: file.phase, name: file.name, content, version: file.version ?? null, saved: { scope: file.scope, phase: file.phase, name: file.name } });
				setBuffer(content);
				setCreating(false);
				setDiagnostics([]);
				setMessage(null);
			} catch (e) {
				setMessage({ text: (e as Error).message, tone: "err" });
			}
		},
		[projectId],
	);

	useEffect(() => {
		void load().then(list => {
			const target = initial && list?.find(h => keyOf(h) === initial);
			if (target) void open(target);
		});
	}, [load, open, initial]);

	useEffect(() => {
		if (dirty && editing) unsavedPanes.set(paneId, `Hook ${editing.name}`);
		else unsavedPanes.delete(paneId);
	}, [dirty, editing, paneId]);
	useEffect(() => () => void unsavedPanes.delete(paneId), [paneId]);

	const confirmDiscard = () => !dirty || confirm(`Discard unsaved changes to ${editing?.name}?`);

	const startNew = () => {
		if (!confirmDiscard()) return;
		setEditing(null);
		setCreating(true);
		setForm(EMPTY_FORM);
		setDiagnostics([]);
		setMessage(null);
	};

	const useContent = (content: string, phase: HookPhase, name: string) => {
		setEditing({ scope: projectId ? "project" : "user", phase, name, content, version: null });
		setBuffer(content);
		setCreating(false);
	};

	const save = async () => {
		if (!editing || busy) return;
		setBusy(true);
		setMessage(null);
		setDiagnostics([]);
		try {
			const moved = editing.saved && keyOf(editing.saved) !== keyOf(editing);
			// Moving across scopes is a new file plus a delete of the old one.
			const crossScope = moved && editing.saved!.scope !== editing.scope;
			const saved = await api<HookFile>("/api/hooks", {
				method: "PUT",
				body: JSON.stringify({
					scope: editing.scope,
					projectId,
					phase: editing.phase,
					name: editing.name,
					content: buffer,
					baseVersion: crossScope ? null : editing.version,
					previous: moved && !crossScope ? { phase: editing.saved!.phase, name: editing.saved!.name } : undefined,
				}),
			});
			if (crossScope) await deleteFile(editing.saved!);
			setEditing({ ...editing, content: buffer, version: saved.version ?? null, saved: { scope: saved.scope, phase: saved.phase, name: saved.name } });
			setMessage({ text: "Saved. omp loads hooks when a chat starts.", tone: "ok" });
			setRestartable(saved.scope);
			await load();
		} catch (e) {
			const error = e as GatewayError;
			if (error.status === 422 && Array.isArray(error.body?.diagnostics)) setDiagnostics((error.body.diagnostics as unknown[]).map(String));
			setMessage({
				text: error.status === 412 ? (editing.version === null ? "A hook with that name already exists." : "The hook changed on disk since you opened it. Reopen it to see the current file.") : error.message,
				tone: "err",
			});
		} finally {
			setBusy(false);
		}
	};

	const deleteFile = async (hook: { scope: Scope; phase: HookPhase; name: string }) => {
		const query = new URLSearchParams({ scope: hook.scope, phase: hook.phase, name: hook.name });
		if (projectId) query.set("projectId", projectId);
		await api(`/api/hooks?${query}`, { method: "DELETE" });
	};

	const remove = async () => {
		if (!editing?.saved || !confirm(`Delete hook ${editing.saved.name}?`)) return;
		try {
			await deleteFile(editing.saved);
			setRestartable(editing.saved.scope);
			setEditing(null);
			setMessage({ text: "Deleted. Running chats keep the hook until they restart.", tone: "ok" });
			await load();
		} catch (e) {
			setMessage({ text: (e as Error).message, tone: "err" });
		}
	};

	const restart = async () => {
		const targets = restartable === "project" && projectId ? [projectId] : projects.map(p => p.id);
		setBusy(true);
		try {
			const results = await Promise.all(targets.map(id => api<{ restarted: number; failed: string[] }>(`/api/projects/${id}/restart-chats`, { method: "POST" })));
			const restarted = results.reduce((n, r) => n + r.restarted, 0);
			const failed = results.reduce((n, r) => n + r.failed.length, 0);
			setMessage({ text: `Restarted ${restarted} chat${restarted === 1 ? "" : "s"}${failed ? `; ${failed} failed to restart` : ""}.`, tone: failed ? "err" : "ok" });
			setRestartable(null);
		} catch (e) {
			setMessage({ text: (e as Error).message, tone: "err" });
		} finally {
			setBusy(false);
		}
	};

	const grouped = useMemo(() => {
		const groups: { label: string; items: HookFile[] }[] = [];
		for (const scope of ["project", "user"] as const)
			for (const phase of ["pre", "post"] as const) {
				const items = (hooks ?? []).filter(h => h.scope === scope && h.phase === phase);
				if (items.length) groups.push({ label: `${scope} · ${phase}`, items });
			}
		return groups;
	}, [hooks]);

	return (
		<div className="flex h-full min-h-0" style={{ background: "var(--panel)" }}>
			<div className="flex w-60 shrink-0 flex-col border-r" style={{ borderColor: "var(--border-strong)" }}>
				<div className="flex items-center gap-1.5 p-2">
					<select
						className="gy-input h-7 min-w-0 flex-1 text-[12px]"
						value={projectId ?? ""}
						onChange={e => confirmDiscard() && setProjectId(e.target.value || undefined)}
					>
						<option value="">No project (user only)</option>
						{projects.map(p => (
							<option key={p.id} value={p.id}>
								{p.name}
							</option>
						))}
					</select>
					<button type="button" className="gy-btn" onClick={startNew} title="New hook" data-testid="new-hook">
						<FilePlus2 size={12} />
					</button>
				</div>
				<div className="min-h-0 flex-1 overflow-auto">
					{hooks === null && !loadError && <Loader2 size={14} className="m-2 animate-spin" />}
					{loadError && (
						<div className="gy-row text-[12px]" role="alert">
							{loadError}
							<button type="button" className="gy-btn" onClick={() => void load()}>
								Retry
							</button>
						</div>
					)}
					{hooks?.length === 0 && (
						<div className="p-3 text-[12px]" style={{ color: "var(--muted)" }}>
							No hooks yet.
						</div>
					)}
					{grouped.map(group => (
						<div key={group.label}>
							<div className="gy-section py-1">{group.label}</div>
							{group.items.map(hook => (
								<button
									type="button"
									key={keyOf(hook)}
									className="gy-row w-full text-left"
									style={editing?.saved && keyOf(editing.saved) === keyOf(hook) ? { background: "var(--tint-tool)" } : undefined}
									onClick={() => confirmDiscard() && void open(hook)}
									title={hook.path}
								>
									<Webhook size={13} className="shrink-0" />
									<div className="min-w-0 flex-1">
										<div className="truncate font-mono text-[12.5px]">{hook.name}</div>
										<div className="truncate text-[11px]" style={{ color: "var(--muted)" }}>
											{hook.tool === "*" ? "every tool" : hook.tool}
										</div>
									</div>
								</button>
							))}
						</div>
					))}
				</div>
			</div>

			<div className="flex min-w-0 flex-1 flex-col">
				{message && (
					<div className="gy-row text-[12px]" role={message.tone === "err" ? "alert" : "status"} style={{ color: message.tone === "err" ? "var(--err)" : undefined }}>
						<span className="flex-1">{message.text}</span>
						{restartable && message.tone === "ok" && (
							<button type="button" className="gy-btn" disabled={busy} onClick={() => void restart()}>
								<RotateCw size={11} /> Restart {restartable === "project" && project ? `chats in ${project.name}` : "all chats"}
							</button>
						)}
						<button type="button" className="gy-btn" aria-label="Dismiss" onClick={() => setMessage(null)}>
							<X size={11} />
						</button>
					</div>
				)}
				{diagnostics.length > 0 && (
					<ul className="px-3 py-1 font-mono text-[11.5px]" style={{ color: "var(--err)" }} data-hook-diagnostics>
						{diagnostics.map(d => (
							<li key={d}>{d}</li>
						))}
					</ul>
				)}
				{creating ? (
					<NewHook form={form} setForm={setForm} projectScoped={!!projectId} onUse={useContent} />
				) : editing ? (
					<>
						<div className="gy-section flex-wrap gap-1.5">
							<select className="gy-input h-7 text-[12px] normal-case tracking-normal" value={editing.scope} onChange={e => setEditing({ ...editing, scope: e.target.value as Scope })}>
								<option value="user">User (all projects)</option>
								<option value="project" disabled={!projectId}>
									Project{project ? ` (${project.name})` : ""}
								</option>
							</select>
							<select className="gy-input h-7 text-[12px] normal-case tracking-normal" value={editing.phase} onChange={e => setEditing({ ...editing, phase: e.target.value as HookPhase })}>
								<option value="pre">pre</option>
								<option value="post">post</option>
							</select>
							<input
								className="gy-input h-7 min-w-24 flex-1 font-mono text-[12px] normal-case tracking-normal"
								value={editing.name}
								onChange={e => setEditing({ ...editing, name: e.target.value })}
								aria-label="Hook file name"
								data-testid="hook-name"
							/>
							<span className="ml-auto flex gap-1.5 font-normal normal-case tracking-normal">
								{editing.saved && (
									<button type="button" className="gy-btn danger" onClick={() => void remove()}>
										<Trash2 size={11} /> Delete
									</button>
								)}
								<button type="button" className="gy-btn primary" disabled={busy || (!dirty && !!editing.saved && keyOf(editing) === keyOf(editing.saved))} onClick={() => void save()} data-testid="save-hook">
									{busy ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />} Save
								</button>
							</span>
						</div>
						<div className="min-h-0 flex-1">
							<Suspense fallback={<Loader2 size={14} className="m-3 animate-spin" />}>
								<MonacoViewer modelKey={`hook-${paneId}`} path={editing.name.endsWith(".js") ? "hook.js" : "hook.ts"} content={buffer} readOnly={false} onChange={setBuffer} onSave={() => void save()} />
							</Suspense>
						</div>
					</>
				) : (
					<div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
						<Webhook size={28} />
						<div className="text-[15px] font-medium">Hook Studio</div>
						<div className="max-w-sm text-[12.5px]" style={{ color: "var(--text-dim)" }}>
							Hooks run your code on agent events: block or confirm tool calls, run a command after edits, notify when the agent stops.
						</div>
						<button type="button" className="gy-btn primary" onClick={startNew}>
							<FilePlus2 size={12} /> New hook
						</button>
					</div>
				)}
			</div>
		</div>
	);
}

function NewHook({
	form,
	setForm,
	projectScoped,
	onUse,
}: {
	form: HookForm;
	setForm: (form: HookForm) => void;
	projectScoped: boolean;
	onUse: (content: string, phase: HookPhase, name: string) => void;
}) {
	const problems = formProblems(form);
	const preview = problems.length ? "" : generateHook(form);
	const actions = ACTIONS.filter(a => !a.triggers || a.triggers.includes(form.trigger));
	const set = (patch: Partial<HookForm>) => {
		const next = { ...form, ...patch };
		if (!ACTIONS.find(a => a.id === next.action)?.triggers?.includes(next.trigger) && (next.action === "block" || next.action === "confirm")) next.action = "notify";
		setForm(next);
	};
	return (
		<div className="min-h-0 flex-1 overflow-auto" data-testid="new-hook-form">
			<div className="gy-section">Start from a template</div>
			<div className="grid gap-1.5 p-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}>
				{HOOK_TEMPLATES.map(t => (
					<button key={t.id} type="button" className="gy-row flex-col items-start rounded border text-left" style={{ borderColor: "var(--border)" }} onClick={() => onUse(t.content, t.phase, t.name)}>
						<div className="text-[12.5px] font-medium">{t.label}</div>
						<div className="text-[11.5px]" style={{ color: "var(--muted)" }}>
							{t.description}
						</div>
					</button>
				))}
			</div>
			<div className="gy-section">Or describe it</div>
			<div className="gy-row">
				<label className="w-28 shrink-0 text-[12.5px]">When</label>
				<select className="gy-input flex-1" value={form.trigger} onChange={e => set({ trigger: e.target.value as HookForm["trigger"] })} data-testid="hook-trigger">
					{TRIGGERS.map(t => (
						<option key={t.id} value={t.id}>
							{t.label} ({t.hint})
						</option>
					))}
				</select>
			</div>
			{isToolTrigger(form.trigger) && (
				<>
					<div className="gy-row">
						<label className="w-28 shrink-0 text-[12.5px]">Tools</label>
						<input className="gy-input flex-1 font-mono" value={form.tools} onChange={e => set({ tools: e.target.value })} placeholder="bash, edit (empty: every tool)" />
					</div>
					<div className="gy-row">
						<label className="w-28 shrink-0 text-[12.5px]">Input matches</label>
						<input className="gy-input flex-1 font-mono" value={form.match} onChange={e => set({ match: e.target.value })} placeholder="regular expression, e.g. rm -rf (empty: always)" />
					</div>
				</>
			)}
			<div className="gy-row">
				<label className="w-28 shrink-0 text-[12.5px]">Then</label>
				<select className="gy-input flex-1" value={form.action} onChange={e => set({ action: e.target.value as HookForm["action"] })} data-testid="hook-action">
					{actions.map(a => (
						<option key={a.id} value={a.id}>
							{a.label}
						</option>
					))}
				</select>
			</div>
			{form.action === "command" ? (
				<>
					<div className="gy-row">
						<label className="w-28 shrink-0 text-[12.5px]">Command</label>
						<input className="gy-input flex-1 font-mono" value={form.command} onChange={e => set({ command: e.target.value })} placeholder="bun run lint" data-testid="hook-command" />
					</div>
					<div className="gy-row">
						<label className="w-28 shrink-0 text-[12.5px]">Timeout</label>
						<input className="gy-input w-24" type="number" min={1} value={form.timeoutSeconds} onChange={e => set({ timeoutSeconds: Number(e.target.value) })} />
						<span className="text-[12px]">seconds</span>
						<label className="ml-4 flex items-center gap-1.5 text-[12.5px]">
							<input type="checkbox" checked={form.sendOutput} onChange={e => set({ sendOutput: e.target.checked })} /> Send the output to the agent
						</label>
					</div>
				</>
			) : (
				<div className="gy-row">
					<label className="w-28 shrink-0 text-[12.5px]">{form.action === "block" ? "Reason" : form.action === "confirm" ? "Question" : "Message"}</label>
					<input className="gy-input flex-1" value={form.message} onChange={e => set({ message: e.target.value })} />
				</div>
			)}
			<div className="gy-row items-start">
				<label className="w-28 shrink-0 pt-1 text-[12.5px]">Variables</label>
				<div className="flex flex-1 flex-col gap-1">
					{form.variables.map((v, i) => (
						<div key={i} className="flex gap-1.5">
							<input
								className="gy-input w-40 font-mono"
								value={v.name}
								placeholder="NAME"
								onChange={e => set({ variables: form.variables.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })}
							/>
							<input
								className="gy-input flex-1 font-mono"
								value={v.value}
								placeholder="value"
								onChange={e => set({ variables: form.variables.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })}
							/>
							<button type="button" className="gy-btn" aria-label="Remove variable" onClick={() => set({ variables: form.variables.filter((_, j) => j !== i) })}>
								<X size={11} />
							</button>
						</div>
					))}
					<button type="button" className="gy-btn self-start" onClick={() => set({ variables: [...form.variables, { name: "", value: "" }] })}>
						<Plus size={11} /> Add variable
					</button>
				</div>
			</div>
			{problems.length > 0 && (
				<ul className="px-3 py-1 text-[12px]" style={{ color: "var(--err)" }}>
					{problems.map(p => (
						<li key={p}>{p}</li>
					))}
				</ul>
			)}
			<div className="gy-row">
				<span className="flex-1 text-[12px]" style={{ color: "var(--muted)" }}>
					Saved as <span className="font-mono">{phaseFor(form.trigger)}/{suggestedName(form)}</span> in {projectScoped ? "the project" : "your user"} hooks; you can edit the code next.
				</span>
				<button
					type="button"
					className="gy-btn primary"
					disabled={problems.length > 0}
					onClick={() => onUse(preview, phaseFor(form.trigger), suggestedName(form))}
					data-testid="generate-hook"
				>
					Generate
				</button>
			</div>
			{preview && <pre className="m-2 overflow-auto rounded p-2 font-mono text-[11.5px]" style={{ background: "var(--panel-2)", maxHeight: 260 }}>{preview}</pre>}
		</div>
	);
}
