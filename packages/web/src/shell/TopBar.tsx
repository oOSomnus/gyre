import * as Dropdown from "@radix-ui/react-dropdown-menu";
import type { PaneKind, Workspace } from "@gyre/protocol";
import { AlertTriangle, Bell, Bot, Command, FolderCog, FolderPlus, Home, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { gateway, useConnectionState } from "../lib/gateway";
import { needsSetup, useOmpStatus } from "../lib/ompStatus";
import { paneStatus } from "../lib/status";
import { isThemeId, THEME_ORDER, THEMES, ThemeSwatch } from "../lib/themes";
import { computeRects, useApp } from "../store/app";
import { useChats } from "../store/chats";
import { PANE_META } from "./panes";
import { Gyroscope } from "./Gyroscope";

const itemCls = "gy-menu-item";

export function NewPaneMenu({ children }: { children: React.ReactNode }) {
	const { projects, addPane, setAddProjectOpen, activeWorkspace } = useApp();
	const focused = activeWorkspace()?.focusedPaneId;
	const focusedProject = focused ? activeWorkspace()?.panes[focused]?.projectId : undefined;
	const kinds = (Object.keys(PANE_META) as PaneKind[]).filter(k => PANE_META[k].creatable);
	return (
		<Dropdown.Root>
			<Dropdown.Trigger asChild>{children}</Dropdown.Trigger>
			<Dropdown.Portal>
				<Dropdown.Content sideOffset={6} align="start" className="gy-menu min-w-56">
					{kinds.map(kind => {
						const { icon: Icon, title, needsProject } = PANE_META[kind];
						return needsProject && projects.length > 1 ? (
							<Dropdown.Sub key={kind}>
								<Dropdown.SubTrigger className={itemCls}>
									<Icon size={14} /> {title}
									<span className="ml-auto">›</span>
								</Dropdown.SubTrigger>
								<Dropdown.Portal>
									<Dropdown.SubContent className="gy-menu min-w-48">
										{projects.map(project => (
											<Dropdown.Item key={project.id} className={itemCls} onSelect={() => addPane({ kind, projectId: project.id })}>
												{project.name}
												{project.id === focusedProject && <span className="gy-label ml-auto">current</span>}
											</Dropdown.Item>
										))}
									</Dropdown.SubContent>
								</Dropdown.Portal>
							</Dropdown.Sub>
						) : (
							<Dropdown.Item
								key={kind}
								className={itemCls}
								disabled={needsProject && projects.length === 0}
								onSelect={() => addPane({ kind, projectId: focusedProject ?? projects[0]?.id })}
							>
								<Icon size={14} /> {title}
							</Dropdown.Item>
						);
					})}
					<Dropdown.Separator className="my-1 h-px" style={{ background: "var(--border-strong)" }} />
					<Dropdown.Item className={itemCls} onSelect={() => setAddProjectOpen(true)}>
						<FolderPlus size={14} /> Add project…
					</Dropdown.Item>
					<Dropdown.Item className={itemCls} onSelect={() => addPane({ kind: "settings", section: "projects" })}>
						<FolderCog size={14} /> Manage projects…
					</Dropdown.Item>
				</Dropdown.Content>
			</Dropdown.Portal>
		</Dropdown.Root>
	);
}

/** Shown while omp cannot start chats; opens the setup guidance. */
function OmpSetupChip() {
	const status = useOmpStatus(s => s.status);
	const addPane = useApp(s => s.addPane);
	if (!needsSetup(status)) return null;
	return (
		<button
			type="button"
			className="gy-chip warn shrink-0"
			title="omp cannot start chats yet"
			onClick={() => addPane({ kind: "settings", section: "providers" })}
			data-testid="omp-setup-chip"
		>
			<AlertTriangle size={11} /> {status === "missing" ? "Install omp" : "Add a provider"}
		</button>
	);
}

/** Miniature of a workspace's layout; each pane gets a status light. */
export function Minimap({ ws, active, onClick }: { ws: Workspace; active: boolean; onClick: () => void }) {
	const chats = useChats(s => s.chats);
	const W = 54;
	const H = 30;
	const rects = computeRects(ws.layout, W - 2, H - 2);
	const hidden = (ws.hidden ?? []).filter(id => ws.panes[id]).length;
	const floating = Object.keys(ws.floating ?? {}).filter(id => ws.panes[id]);
	const all = Object.values(ws.panes);
	const anyWaiting = all.some(p => paneStatus(p, chats) === "waiting");
	const anyRunning = all.some(p => paneStatus(p, chats) === "running");
	return (
		<button
			type="button"
			className="gy-minimap"
			data-active={active}
			onClick={onClick}
			title={`${ws.name}${anyWaiting ? " · needs you" : anyRunning ? " · running" : ""}${hidden ? ` · ${hidden} hidden` : ""}`}
			data-jump="workspace"
			data-minimap={ws.id}
		>
			{Object.entries(rects).map(([id, r]) => {
				const pane = ws.panes[id];
				const status = pane ? paneStatus(pane, chats) : "none";
				return (
					<span
						key={id}
						className={`cell gy-light-${status}`}
						data-status={status}
						style={{ left: r.x + 1, top: r.y + 1, width: Math.max(2, r.w - 1), height: Math.max(2, r.h - 1), outline: id === ws.focusedPaneId && active ? "1px solid #fff" : undefined }}
					/>
				);
			})}
			{floating.map((id, i) => {
				const pane = ws.panes[id];
				return <span key={id} className={`cell gy-light-${pane ? paneStatus(pane, chats) : "none"}`} style={{ right: 2 + i * 4, top: 2, width: 12, height: 9 }} />;
			})}
			{hidden > 0 && (
				<span className="absolute right-0 bottom-0 px-0.5 font-mono text-[8px] leading-none" style={{ background: "#000", color: "#ddd" }}>
					+{hidden}
				</span>
			)}
		</button>
	);
}

export function TopBar() {
	const app = useApp();
	const { workspaces, activeWorkspaceId, switchWorkspace, createWorkspace, renameWorkspace, deleteWorkspace, theme, setTheme, jumpMode, setJumpMode, kbdMode, setKbdMode, openPalette } = app;
	const [editing, setEditing] = useState(false);
	const conn = useConnectionState();
	const active = workspaces.find(ws => ws.id === activeWorkspaceId);
	const chats = useChats(s => s.chats);
	const busy = Object.values(chats).some(c => c.busy);
	const waiting = Object.values(chats).filter(c => c.pendingUi.length > 0 || c.plan?.phase === "reviewing").length;
	const subagents = Object.values(chats).reduce(
		(n, c) => n + Object.values(c.subagents).filter(s => ["running", "pending", "started"].includes(String((s.progress as { status?: string } | undefined)?.status ?? s.status))).length,
		0,
	);

	const jumpToWaiting = () => {
		for (const ws of workspaces) {
			const pane = Object.values(ws.panes).find(p => p.kind === "chat" && (chats[p.id]?.pendingUi.length || chats[p.id]?.plan?.phase === "reviewing"));
			if (pane) {
				app.revealPane(pane.id);
				return;
			}
		}
	};

	return (
		<header className="gy-topbar relative flex h-[52px] shrink-0 items-center gap-2 px-3">
			{/* left */}
			<div className="flex min-w-0 flex-1 items-center gap-2">
				<span className="hidden font-mono text-[12px] font-semibold tracking-[0.2em] uppercase md:inline" style={{ color: "var(--chrome-text)" }}>
					Gyre
				</span>
				<NewPaneMenu>
					<button type="button" className="gy-chrome-icon" title="New pane" data-jump="new-pane">
						<Plus size={15} />
					</button>
				</NewPaneMenu>
				<button type="button" className="gy-chrome-icon" title="Command palette (Alt+X / Ctrl+K)" onClick={() => openPalette()} data-jump="palette">
					<Command size={14} />
				</button>
				{conn !== "open" && (
					<span className="gy-chip warn" title="gateway connection">
						{conn}
					</span>
				)}
			</div>

			{/* center */}
			<div className="flex items-center gap-2">
				<div className="gy-chrome-group hidden sm:inline-flex">
					<span className="flex items-center px-2 font-mono text-[9.5px] tracking-widest uppercase" style={{ color: "var(--chrome-muted)" }}>
						modes
					</span>
					<button type="button" className="gy-chrome-btn" data-on={jumpMode} onClick={() => setJumpMode(!jumpMode)} title="Marks: label everything clickable (Alt+W)" data-jump="marks">
						<span className="gy-led" /> Marks <span style={{ color: "var(--chrome-muted)" }}>Alt+W</span>
					</button>
					<button type="button" className="gy-chrome-btn" data-on={kbdMode} onClick={() => setKbdMode(!kbdMode)} title="Keyboard mode (Alt+M)" data-jump="kbd">
						<span className="gy-led" /> Kbd
					</button>
				</div>
				<Gyroscope
					state={waiting > 0 ? "needs" : busy ? "working" : "idle"}
					size={40}
					className="mx-2"
					title={waiting > 0 ? `${waiting} chat(s) need you · open the palette` : busy ? "Agents are working · open the palette" : "Gyre · open the palette"}
					onClick={() => openPalette()}
				/>
				<button type="button" className="gy-chrome-icon" title={waiting ? `${waiting} chat(s) need you` : "Nothing needs you"} onClick={jumpToWaiting} data-jump="needs-you">
					<Bell size={14} />
					<span className={`gy-badge ${waiting ? "hot" : ""}`}>
						{waiting}
					</span>
				</button>
				<button type="button" className="gy-chrome-icon" title={`${subagents} sub-agent(s) running`} onClick={() => app.addPane({ kind: "tasks" })} data-jump="tasks">
					<Bot size={14} />
					<span className="gy-badge">{subagents}</span>
				</button>
			</div>

			{/* right */}
			<div className="flex min-w-0 flex-1 items-center justify-end gap-2">
				{editing && active ? (
					<input
						autoFocus
						defaultValue={active.name}
						className="gy-input h-7 w-28"
						onBlur={e => {
							renameWorkspace(active.id, e.target.value.trim() || active.name);
							setEditing(false);
						}}
						onKeyDown={e => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
					/>
				) : (
					<Dropdown.Root>
						<Dropdown.Trigger asChild>
							<button type="button" className="truncate font-mono text-[12px] font-semibold tracking-[0.18em] uppercase" style={{ color: "var(--chrome-text)" }} data-jump="workspace-menu">
								{active?.name ?? "—"}
							</button>
						</Dropdown.Trigger>
						<Dropdown.Portal>
							<Dropdown.Content sideOffset={8} align="end" className="gy-menu">
								<Dropdown.Item className={itemCls} onSelect={() => setEditing(true)}>
									<Pencil size={13} /> Rename workspace
								</Dropdown.Item>
								{active && (
									<Dropdown.Item className={itemCls} onSelect={() => deleteWorkspace(active.id)}>
										<Trash2 size={13} /> Delete workspace
									</Dropdown.Item>
								)}
								<Dropdown.Separator className="my-1 h-px" style={{ background: "var(--border-strong)" }} />
								<Dropdown.Label className="px-2 pt-1 pb-0.5 font-mono text-[9.5px] tracking-[0.16em] uppercase" style={{ color: "var(--muted)" }}>
									Theme
								</Dropdown.Label>
								<Dropdown.RadioGroup value={theme} onValueChange={value => isThemeId(value) && setTheme(value)}>
									{THEME_ORDER.map(id => (
										<Dropdown.RadioItem key={id} value={id} className={itemCls} data-testid={`menu-theme-${id}`}>
											<span className="w-3 text-center">{theme === id ? "●" : ""}</span>
											<span className="flex-1">{THEMES[id].label}</span>
											<ThemeSwatch theme={THEMES[id]} height={8} />
										</Dropdown.RadioItem>
									))}
								</Dropdown.RadioGroup>
							</Dropdown.Content>
						</Dropdown.Portal>
					</Dropdown.Root>
				)}
				<div className="flex items-center gap-1.5 overflow-x-auto">
					{workspaces.map(ws => (
						<Minimap key={ws.id} ws={ws} active={ws.id === activeWorkspaceId} onClick={() => switchWorkspace(ws.id)} />
					))}
				</div>
				<button type="button" className="gy-chrome-icon" title="Home (first workspace)" onClick={() => workspaces[0] && switchWorkspace(workspaces[0].id)}>
					<Home size={14} />
				</button>
				<button type="button" className="gy-chrome-icon" title="New workspace" onClick={() => createWorkspace(`Space ${workspaces.length + 1}`)} data-jump="new-workspace">
					<Plus size={14} />
				</button>
				<OmpSetupChip />
				<span className="hidden font-mono text-[10px] lg:inline" style={{ color: "var(--chrome-muted)" }} title="omp version">
					omp {gateway.ompVersion ?? "?"}
				</span>
			</div>
		</header>
	);
}
