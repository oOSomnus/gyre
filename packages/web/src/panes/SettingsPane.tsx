/**
 * Settings: everything omp would otherwise need config files for, edited
 * through omp's own CLI/config files by the gateway (changes apply live where
 * omp hot-reloads, otherwise a chat restart is offered).
 */
import type { PaneSpec, ProjectUsage } from "@gyre/protocol";
import { CheckCircle2, Copy, FolderGit2, KeyRound, Loader2, LogOut, MessagesSquare, Pencil, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { api, gateway, token } from "../lib/gateway";
import type { ModelPickerRow } from "../lib/omp";
import { ROLE_EFFORTS, roleSelector, selectorEffort } from "../lib/role-selector";
import { useRoles, useRolesStore } from "../lib/roles";
import { useRoutingStore } from "../lib/config-map";
import { SHORTCUT_HELP } from "../shell/shortcuts";
import { needsSetup, useOmpStatus } from "../lib/ompStatus";
import { OmpSetupGuide } from "../shell/OmpSetup";
import { useApp } from "../store/app";
import { useChats } from "../store/chats";
import { THEME_FAMILIES, type ThemeId, THEMES, ThemeSwatch } from "../lib/themes";

const SECTIONS = [
	["general", "General"],
	["projects", "Projects"],
	["providers", "Providers"],
	["roles", "Models & roles"],
	["routing", "Agent routing"],
	["mcp", "MCP servers"],
	["sources", "Config sources"],
	["skills", "Skills"],
	["remote", "Remote access"],
	["keyboard", "Keyboard"],
	["about", "About"],
] as const;
type Section = (typeof SECTIONS)[number][0];

function useAnyReadyChat(projectId?: string): string | null {
	return useChats(
		s =>
			Object.values(s.chats).find(c => c.info.status === "ready" && (!projectId || c.info.projectId === projectId))?.info.chatId ??
			Object.values(s.chats).find(c => c.info.status === "ready")?.info.chatId ??
			null,
	);
}

function Head({ children, right }: { children: ReactNode; right?: ReactNode }) {
	return (
		<div className="gy-section">
			{children}
			{right && <span className="ml-auto flex gap-1.5 font-normal tracking-normal normal-case">{right}</span>}
		</div>
	);
}

function Hint({ children }: { children: ReactNode }) {
	return (
		<div className="gy-row text-[12px]" style={{ color: "var(--muted)" }}>
			<div className="min-w-0 flex-1">{children}</div>
		</div>
	);
}

export function SettingsPane({ pane }: { pane?: PaneSpec }) {
	const [section, setSection] = useState<Section>((pane?.section as Section) ?? "general");
	// Opening settings at a section (e.g. "Manage projects…") retargets an existing pane too.
	useEffect(() => {
		if (pane?.section) setSection(pane.section as Section);
	}, [pane?.section]);
	return (
		<div className="flex h-full min-h-0" style={{ background: "var(--panel)" }}>
			<nav className="w-44 shrink-0 overflow-auto border-r py-1" style={{ borderColor: "var(--border-strong)", background: "var(--panel-2)" }}>
				{SECTIONS.map(([id, label]) => (
					<button
						type="button"
						key={id}
						onClick={() => setSection(id)}
						className="block w-full px-3 py-1.5 text-left font-mono text-[11.5px] font-semibold tracking-wider uppercase"
						style={section === id ? { background: "var(--tint-tool)", borderLeft: "3px solid var(--border-strong)" } : { borderLeft: "3px solid transparent" }}
						data-settings-section={id}
					>
						{label}
					</button>
				))}
			</nav>
			<div className="min-w-0 flex-1 overflow-auto">
				{section === "general" && <General />}
				{section === "projects" && <ProjectsSection />}
				{section === "providers" && <Providers />}
				{section === "roles" && <Roles />}
				{section === "routing" && <Routing />}
				{section === "mcp" && <Mcp />}
				{section === "sources" && <Sources />}
				{section === "skills" && <Skills />}
				{section === "remote" && <Remote />}
				{section === "keyboard" && <Keyboard />}
				{section === "about" && <About />}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------- general

function General() {
	const { theme, setTheme } = useApp();
	const label = "font-mono text-[10px] tracking-[0.16em] uppercase";
	return (
		<>
			<Head>Theme</Head>
			<div className="grid items-stretch gap-2 p-3" style={{ gridTemplateColumns: "auto minmax(0, 1fr) minmax(0, 1fr)" }}>
				<span />
				<span className={label} style={{ color: "var(--muted)" }}>
					Light
				</span>
				<span className={label} style={{ color: "var(--muted)" }}>
					Dark
				</span>
				{THEME_FAMILIES.map(family => (
					<Fragment key={family.id}>
						<span className={`${label} self-center pr-1 font-semibold`} style={{ color: "var(--text-dim)" }}>
							{family.label}
						</span>
						<ThemeCard id={family.light} on={theme === family.light} onPick={setTheme} />
						<ThemeCard id={family.dark} on={theme === family.dark} onPick={setTheme} />
					</Fragment>
				))}
			</div>
		</>
	);
}

function ThemeCard({ id, on, onPick }: { id: ThemeId; on: boolean; onPick: (id: ThemeId) => void }) {
	const meta = THEMES[id];
	return (
		<button
			type="button"
			data-testid={`theme-${id}`}
			aria-pressed={on}
			onClick={() => onPick(id)}
			className="flex flex-col items-start gap-2 p-3 text-left"
			style={{
				background: on ? "var(--choice-active)" : "var(--panel-2)",
				border: `1px solid ${on ? "var(--border-strong)" : "var(--border)"}`,
				borderRadius: "var(--radius)",
				boxShadow: on ? "2px 2px 0 var(--border-strong)" : "none",
			}}
		>
			<span className="flex w-full flex-wrap items-center justify-between gap-2">
				<span className="font-mono text-[11px] font-semibold tracking-[0.14em] uppercase">{meta.label}</span>
				<ThemeSwatch theme={meta} />
			</span>
			<span className="text-[12px] leading-snug" style={{ color: "var(--text-dim)" }}>
				{meta.description}
			</span>
		</button>
	);
}

// ---------------------------------------------------------------- projects

function ProjectsSection() {
	const { projects, removeProject, renameProject, setAddProjectOpen, addPane, workspaces } = useApp();
	const chats = useChats(s => s.chats);
	const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
	const [confirming, setConfirming] = useState<{ id: string; usage: ProjectUsage | null } | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const panesOf = (id: string) => workspaces.reduce((n, ws) => n + Object.values(ws.panes).filter(p => p.projectId === id).length, 0);
	const runningChats = (id: string) => Object.values(chats).filter(c => c.info.projectId === id && c.info.status !== "exited").length;

	const askRemove = async (id: string) => {
		setMessage(null);
		setConfirming({ id, usage: null });
		const usage = await api<ProjectUsage>(`/api/projects/${id}/usage`).catch(() => null);
		setConfirming(current => (current?.id === id ? { id, usage } : current));
	};
	const remove = async (id: string) => {
		try {
			await removeProject(id);
			setConfirming(null);
		} catch (e) {
			setMessage((e as Error).message);
		}
	};
	const rename = async () => {
		if (!editing) return;
		const name = editing.name.trim();
		try {
			if (name) await renameProject(editing.id, name);
			setEditing(null);
		} catch (e) {
			setMessage((e as Error).message);
		}
	};

	return (
		<>
			<Head
				right={
					<button type="button" className="gy-btn primary" onClick={() => setAddProjectOpen(true)} data-testid="settings-add-project">
						<Plus size={11} /> Add project
					</button>
				}
			>
				Projects
			</Head>
			<Hint>A project is a folder on this machine. Removing one stops its chats and terminals and closes its panes; files on disk are untouched.</Hint>
			{message && <div className="gy-row text-[12.5px]" style={{ color: "var(--err)" }}>{message}</div>}
			{projects.length === 0 && <Hint>No projects yet.</Hint>}
			{projects.map(p => {
				const panes = panesOf(p.id);
				const running = runningChats(p.id);
				return (
					<div key={p.id} className="border-b" style={{ borderColor: "color-mix(in srgb, var(--border-strong) 20%, transparent)" }} data-testid="project-row">
						<div className="gy-row flex-wrap">
							<FolderGit2 size={14} className="shrink-0" />
							{editing?.id === p.id ? (
								<form
									className="flex min-w-0 flex-1 gap-1.5"
									onSubmit={e => {
										e.preventDefault();
										void rename();
									}}
								>
									<input
										autoFocus
										className="gy-input h-7 min-w-0 flex-1"
										value={editing.name}
										onChange={e => setEditing({ id: p.id, name: e.target.value })}
										onKeyDown={e => e.key === "Escape" && setEditing(null)}
									/>
									<button type="submit" className="gy-btn primary">
										Save
									</button>
									<button type="button" className="gy-btn" onClick={() => setEditing(null)}>
										Cancel
									</button>
								</form>
							) : (
								<div className="min-w-0 flex-1">
									<div className="truncate text-[13px] font-medium">{p.name}</div>
									<div className="truncate font-mono text-[11.5px]" style={{ color: "var(--muted)" }} title={p.path}>
										{p.path}
									</div>
								</div>
							)}
							{running > 0 && <span className="gy-chip ok">{running} chat{running === 1 ? "" : "s"} running</span>}
							{panes > 0 && <span className="gy-chip">{panes} pane{panes === 1 ? "" : "s"}</span>}
							<button type="button" className="gy-btn" onClick={() => addPane({ kind: "chat", projectId: p.id })}>
								<MessagesSquare size={11} /> New chat
							</button>
							<button type="button" className="gy-icon-btn" title="Rename" onClick={() => setEditing({ id: p.id, name: p.name })}>
								<Pencil size={13} />
							</button>
							<button type="button" className="gy-icon-btn" title="Remove from Gyre" onClick={() => void askRemove(p.id)} data-testid="remove-project">
								<Trash2 size={13} />
							</button>
						</div>
						{confirming?.id === p.id && (
							<div className="gy-row flex-wrap text-[12.5px]" style={{ background: "var(--panel-2)" }}>
								<span className="min-w-0 flex-1">
									Remove <b>{p.name}</b> from Gyre?{" "}
									{confirming.usage === null
										? "Checking what is running…"
										: confirming.usage.chats + confirming.usage.terminals > 0
											? `This stops ${confirming.usage.chats} chat(s) and ${confirming.usage.terminals} terminal(s)${panes ? ` and closes ${panes} pane(s)` : ""}.`
											: panes
												? `This closes ${panes} pane(s).`
												: "Nothing is running in it."}{" "}
									Files are not touched.
								</span>
								<button type="button" className="gy-btn danger" onClick={() => void remove(p.id)} data-testid="confirm-remove-project">
									Remove
								</button>
								<button type="button" className="gy-btn" onClick={() => setConfirming(null)}>
									Cancel
								</button>
							</div>
						)}
					</div>
				);
			})}
		</>
	);
}

// ---------------------------------------------------------------- providers

interface Provider {
	id: string;
	name: string;
	available: boolean;
	authenticated: boolean;
}

function Providers() {
	const chatId = useAnyReadyChat();
	const ompStatus = useOmpStatus(s => s.status);
	const loginNotice = useChats(s => {
		const items = chatId ? s.chats[chatId]?.items : undefined;
		const last = items ? [...items].reverse().find(i => i.kind === "notice" && i.url) : undefined;
		return last?.kind === "notice" ? last : null;
	});
	const [providers, setProviders] = useState<Provider[] | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const loadGeneration = useRef(0);
	const load = () => {
		const request = ++loadGeneration.current;
		if (!chatId) return;
		void gateway
			.rpc<Provider[] | { providers?: Provider[] }>(chatId, { type: "get_login_providers" })
			.then(d => {
				if (request !== loadGeneration.current) return;
				setProviders(Array.isArray(d) ? d : (d?.providers ?? []));
				setMessage(null);
			})
			.catch(e => {
				if (request !== loadGeneration.current) return;
				setProviders([]);
				setMessage((e as Error).message);
			});
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: reload when a chat becomes available
	useEffect(() => {
		setProviders(null);
		load();
		return () => { loadGeneration.current++; };
	}, [chatId]);
	const login = async (provider: Provider) => {
		if (!chatId) return;
		setBusy(provider.id);
		setMessage(`Signing in to ${provider.name}… follow the link below.`);
		try {
			await gateway.rpc(chatId, { type: "login", providerId: provider.id }, 600_000);
			setMessage(`Signed in to ${provider.name}.`);
			load();
		} catch (e) {
			setMessage((e as Error).message);
		} finally {
			setBusy(null);
		}
	};
	const logout = async (provider: Provider) => {
		if (!chatId) return;
		const data = await gateway.rpc<{ accounts?: Array<{ credentialId: number }> }>(chatId, { type: "get_logout_accounts", providerId: provider.id });
		for (const account of data?.accounts ?? []) await gateway.rpc(chatId, { type: "logout", providerId: provider.id, credentialId: account.credentialId });
		load();
	};
	if (needsSetup(ompStatus)) {
		return (
			<>
				<Head>Model providers</Head>
				<div className="p-3">
					<OmpSetupGuide />
				</div>
			</>
		);
	}
	return (
		<>
			<Head>Model providers</Head>
			<Hint>Credentials are stored by omp itself and shared with the omp CLI.</Hint>
			{!chatId && (
				<Hint>
					Open a chat to sign in from here (sign-in runs through an omp process), or run <span className="font-mono">omp login</span> in a terminal.
				</Hint>
			)}
			{chatId && providers === null && (
				<div className="gy-row">
					<Loader2 size={14} className="animate-spin" />
				</div>
			)}
			{message && (
				<button type="button" className="gy-btn" onClick={load}>
					Retry loading providers
				</button>
			)}
			{message && <div className="gy-row text-[12.5px]">{message}</div>}
			{busy && loginNotice?.url && (
				<div className="gy-row">
					<a className="gy-btn primary" href={loginNotice.url} target="_blank" rel="noreferrer">
						Open sign-in link
					</a>
				</div>
			)}
			{providers?.map(p => (
				<div key={p.id} className="gy-row">
					{p.authenticated ? <CheckCircle2 size={14} style={{ color: "var(--ok)" }} /> : <KeyRound size={14} style={{ color: "var(--muted)" }} />}
					<span className="min-w-0 flex-1 truncate text-[13px]">{p.name}</span>
					{p.authenticated ? (
						<>
							<span className="gy-chip ok">signed in</span>
							<button type="button" className="gy-btn" onClick={() => void logout(p)}>
								<LogOut size={11} /> Sign out
							</button>
						</>
					) : (
						<button type="button" className="gy-btn" disabled={!p.available || busy !== null} onClick={() => void login(p)}>
							{busy === p.id ? <Loader2 size={11} className="animate-spin" /> : null} Sign in
						</button>
					)}
				</div>
			))}
		</>
	);
}

// ---------------------------------------------------------------- roles

function ModelSearch({
	chatId,
	initial,
	onPick,
	onClose,
}: {
	chatId: string | null;
	/** The role's current selector: its effort carries over to a newly picked model. */
	initial?: string;
	onPick: (selector: string) => void;
	onClose: () => void;
}) {
	const [query, setQuery] = useState("");
	const [rows, setRows] = useState<ModelPickerRow[]>([]);
	const [thinking, setThinking] = useState(() => selectorEffort(initial));
	const [manual, setManual] = useState(initial ?? "");
	useEffect(() => {
		if (!chatId) return;
		const timer = setTimeout(() => {
			void gateway
				.rpc<{ rows: ModelPickerRow[] }>(chatId, { type: "get_model_picker", query, limit: 30 })
				.then(d => setRows((d?.rows ?? []).filter(r => !r.role)))
				.catch(() => setRows([]));
		}, 120);
		return () => clearTimeout(timer);
	}, [chatId, query]);
	const pick = (selector: string) => onPick(roleSelector(selector, thinking));
	// A typed selector that names its own effort, or a fallback list, is saved as typed.
	const pickManual = (selector: string) => onPick(selectorEffort(selector) || selector.includes(",") ? selector : roleSelector(selector, thinking));
	return (
		<div className="border-y px-3 py-2" style={{ borderColor: "var(--border-strong)", background: "var(--panel)" }}>
			<div className="mb-2 flex items-center gap-2">
				<input
					autoFocus
					className="gy-input flex-1"
					placeholder={chatId ? "Search models…" : "Open a chat to search models"}
					value={query}
					onChange={e => setQuery(e.target.value)}
				/>
				<select className="gy-input" value={thinking} onChange={e => setThinking(e.target.value)} title="Effort saved with this role's model" aria-label="Role effort">
					{["", ...ROLE_EFFORTS].map(t => (
						<option key={t} value={t}>
							{t ? `effort: ${t}` : "effort: inherit"}
						</option>
					))}
				</select>
				<button type="button" className="gy-icon-btn" onClick={onClose}>
					<X size={14} />
				</button>
			</div>
			<div className="max-h-56 overflow-auto">
				{rows.map(row => (
					<button type="button" key={`${row.provider}/${row.id}`} className="gy-row w-full text-left" onClick={() => pick(`${row.provider}/${row.id}`)}>
						<span className="font-mono text-[12px]">
							{row.provider}/{row.id}
						</span>
						<span className="min-w-0 flex-1 truncate text-[12px]" style={{ color: "var(--muted)" }}>
							{row.name}
						</span>
						{(row.roles ?? []).map(r => (
							<span key={r.role} className="gy-chip">
								{r.label}
							</span>
						))}
					</button>
				))}
			</div>
			<form
				className="mt-2 flex gap-2"
				onSubmit={e => {
					e.preventDefault();
					if (manual.trim()) pickManual(manual.trim());
				}}
			>
				<input
					className="gy-input flex-1 font-mono"
					placeholder="…or type a selector (provider/model, @role, comma fallbacks)"
					value={manual}
					onChange={e => setManual(e.target.value)}
				/>
				<button type="submit" className="gy-btn" disabled={!manual.trim()}>
					Use
				</button>
			</form>
		</div>
	);
}

function Roles() {
	const chatId = useAnyReadyChat();
	const { roles, assignments, loaded, error } = useRoles();
	const assign = useRolesStore(s => s.assign);
	const reload = useRolesStore(s => s.load);
	const [editing, setEditing] = useState<string | null>(null);
	const [custom, setCustom] = useState("");
	const [storage, setStorage] = useState<string>("global");
	const [message, setMessage] = useState<string | null>(null);
	useEffect(() => {
		void api<{ value: string }>("/api/omp/config?key=modelRoleStorage")
			.then(d => setStorage(String(d.value ?? "global")))
			.catch(() => undefined);
	}, []);
	const save = async (role: string, selector: string | null) => {
		setMessage(null);
		try {
			await assign(role, selector);
			setEditing(null);
			setMessage(selector ? `${role} → ${selector}. Running chats pick this up for new sub-agents and plan mode.` : `${role} reset to automatic.`);
		} catch (e) {
			setMessage(String((e as Error).message));
		}
	};
	const renderRole = (role: (typeof roles)[number]) => (
		<div key={role.id}>
			<div className="gy-row" data-role={role.id}>
				<div className="w-44 shrink-0">
					<div className="text-[13px] font-medium">{role.name}</div>
					<div className="font-mono text-[11px]" style={{ color: "var(--muted)" }}>
						@{role.id}
					</div>
				</div>
				<div className="min-w-0 flex-1 truncate font-mono text-[12px]">{assignments[role.id] ?? <span style={{ color: "var(--muted)" }}>auto</span>}</div>
				<button type="button" className="gy-btn" onClick={() => setEditing(editing === role.id ? null : role.id)} data-testid={`role-edit-${role.id}`}>
					Change
				</button>
				{assignments[role.id] && (
					<button type="button" className="gy-icon-btn" title="Reset to automatic" onClick={() => void save(role.id, null)}>
						<RotateCcw size={13} />
					</button>
				)}
			</div>
			{editing === role.id && (
					<ModelSearch chatId={chatId} initial={assignments[role.id]} onPick={selector => void save(role.id, selector)} onClose={() => setEditing(null)} />
				)}
		</div>
	);
	return (
		<>
			<Head
				right={
					<button type="button" className="gy-btn" onClick={() => void reload().catch(e => setMessage((e as Error).message))}>
						<RotateCcw size={11} /> Reload
					</button>
				}
			>
				Model roles
			</Head>
			<Hint>
				omp maps roles to models. The main chat uses <b>default</b>, plan mode uses <b>plan</b>, sub-agents use <b>task</b> unless an agent names its own role
				(see Agent routing), and omp uses the rest for specific jobs.
			</Hint>
			{error && (
				<div className="gy-row text-[12px]" style={{ color: "var(--err)" }}>
					{error}
				</div>
			)}
			{message && <div className="gy-row text-[12px]">{message}</div>}
			{!loaded && (
				<div className="gy-row">
					<Loader2 size={14} className="animate-spin" />
				</div>
			)}
			<div className="px-3 pt-2 pb-1 font-mono text-[11px] font-semibold tracking-wider uppercase" style={{ color: "var(--text-dim)" }}>
				Chat roles
			</div>
			{roles.filter(r => r.section === "chat").map(renderRole)}
			<div className="px-3 pt-2 pb-1 font-mono text-[11px] font-semibold tracking-wider uppercase" style={{ color: "var(--text-dim)" }}>
				Capability roles
			</div>
			{roles.filter(r => r.section === "kind").map(renderRole)}
			<form
				className="gy-row"
				onSubmit={e => {
					e.preventDefault();
					const id = custom.trim();
					if (/^[A-Za-z0-9_-]{1,40}$/.test(id)) {
						setEditing(id);
						setCustom("");
					}
				}}
			>
				<input
					className="gy-input flex-1"
					placeholder="Add a custom role (e.g. reviewer), then pick its model"
					value={custom}
					onChange={e => setCustom(e.target.value)}
				/>
				<button type="submit" className="gy-btn" disabled={!/^[A-Za-z0-9_-]{1,40}$/.test(custom.trim())}>
					<Plus size={11} /> Add role
				</button>
			</form>
			{editing && !roles.some(r => r.id === editing) && (
				<ModelSearch chatId={chatId} initial={assignments[editing]} onPick={selector => void save(editing, selector)} onClose={() => setEditing(null)} />
			)}
			<Head>Storage</Head>
			<div className="gy-row">
				<span className="flex-1 text-[12.5px]">Where role assignments made from model pickers are saved</span>
				<select
					className="gy-input"
					value={storage}
					onChange={e => {
						setStorage(e.target.value);
						void api("/api/omp/config", { method: "PUT", body: JSON.stringify({ key: "modelRoleStorage", value: e.target.value }) });
					}}
				>
					<option value="global">Global (all projects)</option>
					<option value="project">Project (.omp/config.yml)</option>
				</select>
			</div>
		</>
	);
}

// ---------------------------------------------------------------- agent routing

function Routing() {
	const projects = useApp(s => s.projects);
	const addPane = useApp(s => s.addPane);
	const { roles } = useRoles();
	const [agents, setAgents] = useState<Array<{ name: string; scope: string; frontmatter: Record<string, unknown>; shadowed?: boolean }>>([]);
	const overrides = useRoutingStore(s => s.assignments);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		void Promise.all([api<typeof agents>(`/api/agents${projects[0] ? `?projectId=${projects[0].id}` : ""}`), useRoutingStore.getState().load()])
			.then(([list]) => {
				setAgents(list.filter(a => !a.shadowed));
				// Shared routing store was loaded above.
			})
			.catch(e => setError(String((e as Error).message)));
	}, [projects]);
	const set = async (name: string, selector: string) => {
		await useRoutingStore
			.getState()
			.assign(name, selector)
			.catch(e => setError((e as Error).message));
	};
	return (
		<>
			<Head
				right={
					<button type="button" className="gy-btn" onClick={() => addPane({ kind: "studio" })}>
						Open Agent Studio
					</button>
				}
			>
				Sub-agent models
			</Head>
			<Hint>
				Route each sub-agent to a role (or keep the model its definition asks for). Saved as omp's <span className="font-mono">task.agentModelOverrides</span>;
				applies to the next spawn.
			</Hint>
			{error && (
				<div className="gy-row text-[12px]" style={{ color: "var(--err)" }}>
					{error}
				</div>
			)}
			{agents.map(agent => (
				<div key={`${agent.scope}:${agent.name}`} className="gy-row" data-agent={agent.name}>
					<div className="w-44 shrink-0">
						<div className="text-[13px] font-medium">{agent.name}</div>
						<div className="font-mono text-[11px]" style={{ color: "var(--muted)" }}>
							{agent.scope} · {String(agent.frontmatter.model ?? "inherits task")}
						</div>
					</div>
					<div className="min-w-0 flex-1 truncate text-[12px]" style={{ color: "var(--text-dim)" }}>
						{String(agent.frontmatter.description ?? "")}
					</div>
					<select
						className="gy-input"
						value={overrides[agent.name] ?? ""}
						onChange={e => void set(agent.name, e.target.value)}
						data-testid={`route-${agent.name}`}
					>
						<option value="">Agent's own model</option>
						{roles
							.filter(r => r.section === "chat")
							.map(r => (
								<option key={r.id} value={`@${r.id}`}>
									@{r.id} · {r.name}
								</option>
							))}
						{overrides[agent.name] && !overrides[agent.name]?.startsWith("@") && <option value={overrides[agent.name]}>{overrides[agent.name]}</option>}
					</select>
				</div>
			))}
		</>
	);
}

// ---------------------------------------------------------------- MCP

interface McpEntry {
	name: string;
	scope: "user" | "project";
	enabled: boolean;
	config: Record<string, unknown>;
}

const EMPTY_MCP = {
	name: "",
	scope: "user" as "user" | "project",
	type: "stdio",
	command: "",
	args: [] as string[],
	url: "",
	auth: "none",
	token: "",
	previousName: undefined as string | undefined,
};

function Mcp() {
	const projects = useApp(s => s.projects);
	const [projectId, setProjectId] = useState<string | undefined>(projects[0]?.id);
	return <McpProjectSettings key={projectId ?? "user"} projectId={projectId} setProjectId={setProjectId} />;
}

function McpProjectSettings({ projectId, setProjectId }: { projectId?: string; setProjectId(value: string | undefined): void }) {
	const projects = useApp(s => s.projects);
	const chatId = useAnyReadyChat(projectId);
	const [servers, setServers] = useState<McpEntry[]>([]);
	const [form, setForm] = useState<typeof EMPTY_MCP | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const [dirty, setDirty] = useState(false);
	const output = useChats(s => {
		const items = chatId ? s.chats[chatId]?.items : undefined;
		const last = items ? [...items].reverse().find(i => i.kind === "command_output") : undefined;
		return last?.kind === "command_output" ? last : null;
	});
	const [awaiting, setAwaiting] = useState<number | null>(null);
	const loadGeneration = useRef(0);
	const load = () => {
		const request = ++loadGeneration.current;
		void api<McpEntry[]>(`/api/mcp${projectId ? `?projectId=${projectId}` : ""}`)
			.then(rows => { if (request === loadGeneration.current) setServers(rows); })
			.catch(e => { if (request === loadGeneration.current) setMessage(String((e as Error).message)); });
	};
	useEffect(() => {
		load();
		return () => { loadGeneration.current++; };
	}, [projectId]);

	const save = async () => {
		if (!form) return;
		try {
			const config: Record<string, unknown> =
				form.type === "stdio"
					? (() => {
							const command = form.command.trim();
							const args = form.args;
							return { type: "stdio", command, ...(args.length ? { args } : {}) };
						})()
					: {
							type: form.type,
							url: form.url.trim(),
							...(form.auth === "token" && form.token ? { headers: { Authorization: `Bearer ${form.token}` } } : {}),
							...(form.auth === "oauth" ? { auth: { type: "oauth" } } : {}),
						};
			await api("/api/mcp", {
				method: "PUT",
				body: JSON.stringify({ scope: form.scope, projectId, name: form.name, previousName: form.previousName, config }),
			});
			setForm(null);
			setDirty(true);
			setMessage(`Saved ${form.name}. Restart this project's chats to connect it.`);
			load();
		} catch (e) {
			setMessage(String((e as Error).message));
		}
	};
	const runMcp = (args: string) => {
		if (!chatId) {
			setMessage("Open a chat in this project to run MCP commands.");
			return;
		}
		setAwaiting(Date.now());
		void gateway.rpc(chatId, { type: "prompt", message: `/mcp ${args}` }, 120_000).catch(e => setMessage(String((e as Error).message)));
	};
	const edit = (s: McpEntry) => {
		const c = s.config;
		const headers = c.headers as Record<string, string> | undefined;
		setForm({
			name: s.name,
			scope: s.scope,
			type: String(c.type ?? (c.url ? "http" : "stdio")),
			command: String(c.command ?? ""),
			args: Array.isArray(c.args) ? c.args.map(String) : [],
			url: String(c.url ?? ""),
			auth: c.auth ? "oauth" : headers?.Authorization ? "token" : "none",
			token: headers?.Authorization?.replace(/^Bearer\s+/, "") ?? "",
			previousName: s.name,
		});
	};
	return (
		<>
			<Head
				right={
					<>
						<select className="gy-input h-7 text-[12px]" value={projectId ?? ""} onChange={e => setProjectId(e.target.value || undefined)}>
							<option value="">User servers only</option>
							{projects.map(p => (
								<option key={p.id} value={p.id}>
									{p.name}
								</option>
							))}
						</select>
						<button type="button" className="gy-btn primary" onClick={() => setForm({ ...EMPTY_MCP })} data-testid="mcp-add">
							<Plus size={11} /> Add server
						</button>
					</>
				}
			>
				MCP servers
			</Head>
			{message && (
				<div className="gy-row text-[12.5px]">
					<span className="flex-1">{message}</span>
					{dirty && projectId && (
						<button
							type="button"
							className="gy-btn"
							onClick={() =>
								void api<{ restarted: number; failed: string[] }>(`/api/projects/${projectId}/restart-chats`, { method: "POST" }).then(r => {
									setDirty(r.failed.length > 0);
									setMessage(`Restarted ${r.restarted} chat(s).${r.failed.length ? ` Failed: ${r.failed.join(", ")}. Retry restarting these chats.` : ""}`);
								}).catch(e => setMessage((e as Error).message))
							}
						>
							<RotateCcw size={11} /> Restart chats in project
						</button>
					)}
				</div>
			)}
			{form && (
				<div className="space-y-0 border-b" style={{ borderColor: "var(--border-strong)" }}>
					<div className="gy-row">
						<label className="w-24 text-[12.5px]">Name</label>
						<input
							className="gy-input flex-1"
							value={form.name}
							onChange={e => setForm({ ...form, name: e.target.value })}
							placeholder="github"
							data-testid="mcp-name"
						/>
						<select className="gy-input" value={form.scope} onChange={e => setForm({ ...form, scope: e.target.value as "user" | "project" })}>
							<option value="user">All projects</option>
							<option value="project" disabled={!projectId}>
								This project
							</option>
						</select>
					</div>
					<div className="gy-row">
						<label className="w-24 text-[12.5px]">Address</label>
						<select className="gy-input" value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}>
							<option value="stdio">Local command</option>
							<option value="http">Web address (HTTP)</option>
							<option value="sse">Web address (SSE)</option>
						</select>
						{form.type === "stdio" ? (
							<>
								<input
									className="gy-input flex-1 font-mono"
									value={form.command}
									onChange={e => setForm({ ...form, command: e.target.value })}
									placeholder="npx"
									data-testid="mcp-command"
								/>
								<div className="flex min-w-0 flex-1 flex-col gap-1">
									<span className="gy-label">Arguments</span>
									{form.args.map((argument, index) => (
										<div className="flex gap-1" key={index}>
											<input
												aria-label={`Argument ${index + 1}`}
												className="gy-input min-w-0 flex-1"
												value={argument}
												onChange={e => setForm({ ...form, args: form.args.map((value, i) => (i === index ? e.target.value : value)) })}
											/>
											<button
												type="button"
												className="gy-icon-btn"
												aria-label={`Remove argument ${index + 1}`}
												onClick={() => setForm({ ...form, args: form.args.filter((_, i) => i !== index) })}
											>
												<X size={12} />
											</button>
										</div>
									))}
									<button type="button" className="gy-btn" onClick={() => setForm({ ...form, args: [...form.args, ""] })}>
										Add argument
									</button>
								</div>
							</>
						) : (
							<input
								className="gy-input flex-1 font-mono"
								value={form.url}
								onChange={e => setForm({ ...form, url: e.target.value })}
								placeholder="https://example.com/mcp"
							/>
						)}
					</div>
					{form.type !== "stdio" && (
						<div className="gy-row">
							<label className="w-24 text-[12.5px]">Sign-in</label>
							<select className="gy-input" value={form.auth} onChange={e => setForm({ ...form, auth: e.target.value })}>
								<option value="none">None</option>
								<option value="token">Saved key</option>
								<option value="oauth">OAuth</option>
							</select>
							{form.auth === "token" && (
								<input
									className="gy-input flex-1"
									type="password"
									value={form.token}
									onChange={e => setForm({ ...form, token: e.target.value })}
									placeholder="API key"
								/>
							)}
							{form.auth === "oauth" && (
								<span className="text-[12px]" style={{ color: "var(--muted)" }}>
									After saving, use Reauth to sign in.
								</span>
							)}
						</div>
					)}
					<div className="gy-row justify-end">
						<button type="button" className="gy-btn" onClick={() => setForm(null)}>
							Cancel
						</button>
						<button type="button" className="gy-btn primary" onClick={() => void save()} disabled={!form.name.trim()} data-testid="mcp-save">
							Save
						</button>
					</div>
				</div>
			)}
			{servers.length === 0 && (
				<Hint>
					No MCP servers configured in omp's mcp.json files. Servers from other tools' configs (Claude, Cursor…) load when enabled under Config sources.
				</Hint>
			)}
			{servers.map(s => (
				<div key={`${s.scope}:${s.name}`} className="gy-row" data-mcp={s.name}>
					<button
						type="button"
						className="gy-toggle"
						data-on={s.enabled}
						title={s.enabled ? "Disable" : "Enable"}
						onClick={() =>
							void api("/api/mcp/enabled", { method: "POST", body: JSON.stringify({ scope: s.scope, projectId, name: s.name, enabled: !s.enabled }) }).then(
								() => {
									setDirty(true);
									setMessage("Changed. Restart chats to apply.");
									load();
								},
							)
						}
					/>
					<div className="min-w-0 flex-1">
						<div className="text-[13px] font-medium">
							{s.name} <span className="gy-chip ml-1">{s.scope}</span> <span className="gy-chip">{String(s.config.type ?? "stdio")}</span>
						</div>
						<div className="truncate font-mono text-[11px]" style={{ color: "var(--muted)" }}>
							{String(s.config.url ?? [s.config.command, ...((s.config.args as string[] | undefined) ?? [])].join(" "))}
						</div>
					</div>
					<button type="button" className="gy-btn" onClick={() => runMcp(`test ${s.name}`)}>
						Test
					</button>
					<button type="button" className="gy-btn" onClick={() => runMcp(`reauth ${s.name}`)}>
						Reauth
					</button>
					<button type="button" className="gy-btn" onClick={() => edit(s)}>
						Edit
					</button>
					<button
						type="button"
						className="gy-icon-btn"
						title="Remove"
						onClick={() =>
							void api(`/api/mcp?scope=${s.scope}&name=${encodeURIComponent(s.name)}${projectId ? `&projectId=${projectId}` : ""}`, { method: "DELETE" }).then(
								() => {
									setDirty(true);
									setMessage("Removed. Restart chats to apply.");
									load();
								},
							)
						}
					>
						<Trash2 size={13} />
					</button>
				</div>
			))}
			{awaiting && output && output.ts >= awaiting && (
				<div className="p-3">
					<pre className="gy-pre">{output.text}</pre>
				</div>
			)}
		</>
	);
}

// ---------------------------------------------------------------- config sources

const SOURCES: Array<[string, string]> = [
	["claude", "Claude Code (~/.claude: skills, agents, commands, MCP, CLAUDE.md)"],
	["codex", "OpenAI Codex (~/.codex)"],
	["gemini", "Gemini CLI (~/.gemini)"],
	["opencode", "OpenCode (~/.config/opencode)"],
	["cursor", "Cursor"],
	["windsurf", "Windsurf"],
	["cline", "Cline"],
	["github", "GitHub Copilot"],
	["vscode", "VS Code"],
];

function Sources() {
	const saving = useRef(false);
	const [pending, setPending] = useState(false);
	const [value, setValue] = useState<unknown[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		void api<{ value: unknown[] }>("/api/omp/config?key=enabledProviders")
			.then(d => setValue(Array.isArray(d.value) ? d.value : []))
			.catch(e => setError(String((e as Error).message)));
	}, []);
	const toggle = async (id: string, on: boolean) => {
		if (saving.current || value === null) return;
		saving.current = true;
		setPending(true);
		const current = value;
		const next = on ? [...current.filter(v => v !== id), id] : current.filter(v => v !== id);
		try {
			await api("/api/omp/config", { method: "PUT", body: JSON.stringify({ key: "enabledProviders", value: next }) });
			setValue(next);
		} catch (e) {
			setError(String((e as Error).message));
		} finally {
			saving.current = false;
			setPending(false);
		}
	};
	return (
		<>
			<Head>Use settings from other tools</Head>
			<Hint>
				omp reads other coding tools' user-level skills, agents, commands, rules and MCP servers live: nothing is copied. Project-level files from these tools
				are always read. Turn on the tools whose user configuration Gyre should pick up (omp setting <span className="font-mono">enabledProviders</span>).
			</Hint>
			{error && (
				<div className="gy-row text-[12px]" style={{ color: "var(--err)" }}>
					{error}
				</div>
			)}
			{SOURCES.map(([id, label]) => {
				const on = value?.includes(id) ?? false;
				return (
					<div key={id} className="gy-row">
						<span className="min-w-0 flex-1 text-[13px]">{label}</span>
						<button
							type="button"
							className="gy-toggle"
							data-on={on}
							disabled={pending || value === null}
							onClick={() => void toggle(id, !on)}
							data-source={id}
						/>
					</div>
				);
			})}
		</>
	);
}

// ---------------------------------------------------------------- skills

function Skills() {
	const projects = useApp(s => s.projects);
	const [skills, setSkills] = useState<Array<{ name: string; description?: string; source?: string; hide?: boolean }> | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		void api<{ skills?: typeof skills }>(`/api/omp/skills${projects[0] ? `?projectId=${projects[0].id}` : ""}`)
			.then(d => setSkills(d.skills ?? []))
			.catch(e => setError(String((e as Error).message)));
	}, [projects]);
	return (
		<>
			<Head>Skills</Head>
			<Hint>
				Skills omp can load. Run one in a chat with <span className="font-mono">/skill:name</span>. Add skills under{" "}
				<span className="font-mono">~/.omp/agent/skills/</span> or the project's <span className="font-mono">.omp/skills/</span>.
			</Hint>
			{error && (
				<div className="gy-row text-[12px]" style={{ color: "var(--err)" }}>
					{error}
				</div>
			)}
			{skills === null && !error && (
				<div className="gy-row">
					<Loader2 size={14} className="animate-spin" />
				</div>
			)}
			{skills?.map(s => (
				<div key={s.name} className="gy-row items-start">
					<div className="w-56 shrink-0">
						<div className="font-mono text-[12.5px]">{s.name}</div>
						<div className="font-mono text-[10.5px]" style={{ color: "var(--muted)" }}>
							{s.source}
						</div>
					</div>
					<div className="min-w-0 flex-1 text-[12px]" style={{ color: "var(--text-dim)" }}>
						{s.description}
					</div>
				</div>
			))}
		</>
	);
}

// ---------------------------------------------------------------- remote

function Remote() {
	const [info, setInfo] = useState<{ host: string; port: number; allowedHosts: string[]; loopbackOnly: boolean } | null>(null);
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		void api<typeof info>("/api/remote").then(setInfo);
	}, []);
	const link = `${location.protocol}//${location.host}/#token=${token}`;
	return (
		<>
			<Head>Remote access</Head>
			<Hint>
				Gyre runs on this machine; any browser that can reach the gateway can use it, including a phone. Remote browsers sign in once with the token link below
				(it sets a 30-day cookie).
			</Hint>
			<div className="gy-row">
				<span className="w-40 text-[12.5px]">Listening on</span>
				<span className="font-mono text-[12.5px]">
					{info ? `${info.host}:${info.port}` : "…"} {info?.loopbackOnly && <span className="gy-chip warn ml-2">this machine only</span>}
				</span>
			</div>
			<div className="gy-row">
				<span className="w-40 text-[12.5px]">Allowed host names</span>
				<span className="font-mono text-[12.5px]">{info?.allowedHosts.length ? info.allowedHosts.join(", ") : "loopback only"}</span>
			</div>
			<div className="gy-row">
				<span className="w-40 text-[12.5px]">Sign-in link</span>
				<span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{link.replace(token, "•••••")}</span>
				<button
					type="button"
					className="gy-btn"
					onClick={() => {
						void navigator.clipboard.writeText(link);
						setCopied(true);
						setTimeout(() => setCopied(false), 1500);
					}}
				>
					<Copy size={11} /> {copied ? "Copied" : "Copy"}
				</button>
			</div>
			<Head>Set up</Head>
			<div className="p-3 text-[12.5px]" style={{ color: "var(--text-dim)" }}>
				<p className="mb-2">Replace the token placeholder with a long secret, then start the gateway listening on your network and name the hosts you will use:</p>
				<pre className="gy-pre">
					{"GYRE_HOST=0.0.0.0 \\\nGYRE_ALLOWED_HOSTS=my-laptop.tailnet.ts.net,192.168.1.20 \\\nGYRE_TOKEN='replace-with-a-long-secret' gyre-gateway"}
				</pre>
				<ul className="mt-2 list-disc pl-5">
					<li>
						<b>Tailscale</b>: reach the machine by its tailnet name and add that name to <span className="font-mono">GYRE_ALLOWED_HOSTS</span>.
					</li>
					<li>
						<b>Cloudflare Tunnel</b>: point the tunnel at <span className="font-mono">http://127.0.0.1:{info?.port ?? 7341}</span> and allow the tunnel host
						name.
					</li>
					<li>
						<b>Port forwarding / SSH</b>: <span className="font-mono">ssh -L 7341:127.0.0.1:{info?.port ?? 7341} host</span> needs no settings at all.
					</li>
				</ul>
				<p className="mt-2">Plannotator plan reviews are served on the gateway machine's localhost; remote browsers use Gyre's built-in review instead.</p>
			</div>
		</>
	);
}

// ---------------------------------------------------------------- keyboard / about

function Keyboard() {
	return (
		<>
			{SHORTCUT_HELP.map(group => (
				<div key={group.title}>
					<Head>{group.title}</Head>
					{group.keys.map(([keys, desc]) => (
						<div key={keys} className="gy-row py-1.5">
							<span className="flex w-48 shrink-0 flex-wrap gap-1">
								{keys.split(" ").map(k => (
									<span key={k} className="gy-kbd">
										{k}
									</span>
								))}
							</span>
							<span className="text-[12.5px]" style={{ color: "var(--text-dim)" }}>
								{desc}
							</span>
						</div>
					))}
				</div>
			))}
		</>
	);
}

function About() {
	return (
		<>
			<Head>About</Head>
			<div className="space-y-1 p-3 text-[12.5px]" style={{ color: "var(--text-dim)" }}>
				<div>Gyre: a tiled, keyboard-first desktop for the omp coding agent.</div>
				<div>Agent engine: omp {gateway.ompVersion ?? "unknown"} (unmodified, MIT licensed), driven over its RPC protocol.</div>
			</div>
		</>
	);
}
