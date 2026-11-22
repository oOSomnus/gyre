import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { useMemo } from "react";
import type { PaneKind } from "@gyre/protocol";
import { localCommands, runLocalCommand } from "../chat/localCommands";
import { exportSessionLog } from "../lib/exportSessionLog";
import { api, gateway } from "../lib/gateway";
import type { SlashCommand } from "../lib/omp";
import { closePaneAndResources, sendToChat, terminals } from "../store/actions";
import { THEME_ORDER, THEMES } from "../lib/themes";
import { PANE_META, paneTitle } from "../shell/panes";
import { focusedChatId, openChatPane, useApp } from "../store/app";
import { startFreshSession, useChats } from "../store/chats";

interface Action {
	id: string;
	group: string;
	label: string;
	hint?: string;
	keywords?: string;
	run: () => void;
}

function groupBy(actions: Action[]): Array<[string, Action[]]> {
	const groups = new Map<string, Action[]>();
	for (const action of actions) groups.set(action.group, [...(groups.get(action.group) ?? []), action]);
	return [...groups.entries()];
}

function insertIntoComposer(chatId: string, text: string) {
	useChats.getState().patch(chatId, { editorInject: { text, nonce: Date.now() } });
}

export function runSlashCommand(chatId: string, cmd: SlashCommand) {
	// Commands that take input go to the composer so the user can complete them.
	if (cmd.input?.hint || (cmd.subcommands && cmd.subcommands.length > 0)) insertIntoComposer(chatId, `/${cmd.name} `);
	else
		void runLocalCommand(chatId, `/${cmd.name}`)
			.then(handled => (handled ? undefined : gateway.rpc(chatId, { type: "prompt", message: `/${cmd.name}` })))
			.catch(e => useChats.getState().apply(chatId, { type: "notice", level: "error", message: (e as Error).message }));
}

export function CommandPalette() {
	const app = useApp();
	const chatId = focusedChatId();
	const chat = useChats(s => (chatId ? s.chats[chatId] : undefined));
	const close = app.closePalette;

	const actions = useMemo<Action[]>(() => {
		const list: Action[] = [];
		const ws = app.activeWorkspace();
		const focused = ws?.focusedPaneId ? ws.panes[ws.focusedPaneId] : undefined;
		const projectId = focused?.projectId ?? app.projects[0]?.id;

		if (app.paletteScope === "pane") {
			if (!focused) return list;
			const group = `${PANE_META[focused.kind]?.title ?? focused.kind}: ${paneTitle(focused)}`;
			const add = (id: string, label: string, run: () => void, hint?: string) => list.push({ id, group, label, run, hint });
			const paneChat = focused.kind === "chat" ? focused.id : focused.chatId;
			if (focused.kind === "chat") {
				const planOn = chat?.plan && chat.plan.phase !== "idle";
				if (chat?.commands.some(c => c.name === "gyre-plan")) {
					add(
						"plan",
						planOn ? "Leave plan mode" : "Enter plan mode",
						() => void gateway.rpc(focused.id, { type: "prompt", message: `/gyre-plan ${JSON.stringify({ action: planOn ? "cancel" : "enter" })}` }),
					);
				}
				add("model", "Switch model…", () => app.openModelPicker(focused.id), "Ctrl M");
				add("new-session", "Start a fresh session in this pane", () => {
					void startFreshSession(focused.id)
						.then(ok => {
							if (!ok) useChats.getState().apply(focused.id, { type: "notice", level: "warning", message: "New session was cancelled." });
						})
						.catch(error => useChats.getState().apply(focused.id, { type: "notice", level: "error", message: (error as Error).message }));
				});
				add("compact", "Compact context", () => void gateway.rpc(focused.id, { type: "compact" }, 600_000));
				add("abort", "Stop the agent", () => void gateway.rpc(focused.id, { type: "abort" }));
				add("restart", "Restart omp (same session)", () => void api(`/api/chats/${encodeURIComponent(focused.id)}/restart`, { method: "POST" }));
				add("export-log", "Export session log (Markdown)", () => void exportSessionLog(focused.id, "download"));
				add("copy-log", "Copy session log to clipboard", () => void exportSessionLog(focused.id, "copy"));
			}
			if (focused.kind === "terminal") {
				add("send", "Send selection to AI", () => {
					const selection = terminals.get(focused.id)?.getSelection() ?? "";
					if (selection.trim()) sendToChat(`Terminal output:\n\n\`\`\`\n${selection.trimEnd()}\n\`\`\`\n`, focused.projectId);
				});
				add("clear", "Clear screen", () => terminals.get(focused.id)?.clear());
			}
			if (paneChat) {
				for (const kind of ["plan", "objectives", "graph", "events", "subagents"] as PaneKind[]) {
					if (kind !== focused.kind) add(`open:${kind}`, `Open ${PANE_META[kind].title}`, () => openChatPane(kind, paneChat));
				}
			}
			const floating = Boolean(ws?.floating?.[focused.id]);
			add("float", floating ? "Dock into the grid" : "Float above the grid", () => (floating ? app.dockPane(focused.id) : app.floatPane(focused.id)), "F");
			add("hide", "Hide", () => app.hidePane(focused.id), "H");
			add("max", app.maximizedPaneId === focused.id ? "Restore size" : "Maximize", () => app.toggleMaximize(focused.id), "Alt Z");
			for (const other of app.workspaces.filter(w => w.id !== app.activeWorkspaceId)) {
				add(`move:${other.id}`, `Move to workspace ${other.name}`, () => app.movePaneToWorkspace(focused.id, other.id));
			}
			add("close", "Close pane", () => closePaneAndResources(focused), "X");
			return list;
		}

		for (const kind of Object.keys(PANE_META) as PaneKind[]) {
			const meta = PANE_META[kind];
			if (!meta.creatable) continue;
			list.push({
				id: `pane:${kind}`,
				group: "Open",
				label: kind === "chat" ? "New chat" : kind === "terminal" ? "New terminal" : meta.title,
				run: () => app.addPane({ kind, projectId }),
			});
		}
		if (chatId) {
			list.push(
				{ id: "chat:model", group: "Chat", label: "Switch model…", hint: "Ctrl M", run: () => app.openModelPicker(chatId) },
				{ id: "chat:fork", group: "Chat", label: "Fork session", run: () => void gateway.rpc(chatId, { type: "fork" }) },
				{ id: "chat:abort", group: "Chat", label: "Stop the agent", run: () => void gateway.rpc(chatId, { type: "abort" }) },
				{
					id: "chat:export-log",
					group: "Chat",
					label: "Export session log",
					keywords: "debug transcript download markdown",
					run: () => void exportSessionLog(chatId, "download"),
				},
				{
					id: "chat:copy-log",
					group: "Chat",
					label: "Copy session log to clipboard",
					keywords: "debug transcript clipboard markdown",
					run: () => void exportSessionLog(chatId, "copy"),
				},
				{ id: "chat:plan", group: "Chat", label: "Open plan review", run: () => openChatPane("plan", chatId) },
				{ id: "chat:objectives", group: "Chat", label: "Open objectives", run: () => openChatPane("objectives", chatId) },
				{ id: "chat:graph", group: "Chat", label: "Open event graph", run: () => openChatPane("graph", chatId) },
			);
		}
		for (const w of app.workspaces) {
			list.push({ id: `ws:${w.id}`, group: "Workspaces", label: `Switch to ${w.name}`, run: () => app.switchWorkspace(w.id) });
		}
		list.push({ id: "ws:new", group: "Workspaces", label: "New workspace", run: () => app.createWorkspace(`Space ${app.workspaces.length + 1}`) });
		for (const id of ws?.hidden ?? []) {
			const pane = ws?.panes[id];
			if (pane) list.push({ id: `restore:${id}`, group: "Hidden panes", label: `Show ${paneTitle(pane)}`, run: () => app.restorePane(id) });
		}
		list.push(
			...THEME_ORDER.map(id => ({
				id: `view:theme:${id}`,
				group: "View",
				label: `Theme: ${THEMES[id].label}${app.theme === id ? " (current)" : ""}`,
				keywords: `theme ${THEMES[id].family} ${THEMES[id].scheme} ${THEMES[id].description}`,
				run: () => app.setTheme(id),
			})),
			{ id: "view:jump", group: "View", label: "Marks (label everything)", hint: "Alt W", run: () => app.setJumpMode(true) },
			{ id: "view:kbd", group: "View", label: "Keyboard mode", hint: "Alt M", run: () => app.setKbdMode(true) },
			{ id: "settings:roles", group: "Settings", label: "Models & roles", run: () => app.addPane({ kind: "settings", section: "roles" }) },
			{ id: "settings:mcp", group: "Settings", label: "MCP servers", run: () => app.addPane({ kind: "settings", section: "mcp" }) },
			{ id: "settings:studio", group: "Settings", label: "Agent Studio", run: () => app.addPane({ kind: "studio" }) },
			{ id: "settings:providers", group: "Settings", label: "Model providers", keywords: "login sign in api key omp setup", run: () => app.addPane({ kind: "settings", section: "providers" }) },
			{ id: "project:add", group: "Projects", label: "Add project…", keywords: "folder open", run: () => app.setAddProjectOpen(true) },
			{ id: "project:manage", group: "Projects", label: "Manage projects…", keywords: "remove delete rename list", run: () => app.addPane({ kind: "settings", section: "projects" }) },
		);
		return list;
	}, [app, chatId, chat]);

	const commands = useMemo(() => [...(chat?.commands ?? []), ...localCommands(chat?.commands ?? [])], [chat?.commands]);
	const commandsOnly = app.paletteQuery.startsWith("/");
	const showCommands = chatId && commands.length > 0 && app.paletteScope === "global";

	return (
		<Dialog.Root open={app.paletteOpen} onOpenChange={open => !open && close()}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-40" style={{ background: "rgb(0 0 0 / 0.35)" }} />
				<Dialog.Content
					aria-describedby={undefined}
					className="fixed left-1/2 top-[12vh] z-50 w-[min(680px,92vw)] -translate-x-1/2 overflow-hidden border"
					style={{ background: "var(--panel-2)", borderColor: "var(--border-strong)", boxShadow: "var(--shadow)" }}
				>
					<Dialog.Title className="sr-only">Command palette</Dialog.Title>
					<Command
						loop
						filter={(value, search, keywords) => {
							const s = search.replace(/^\//, "").toLowerCase();
							if (!s) return 1;
							const hay = `${value} ${(keywords ?? []).join(" ")}`.toLowerCase();
							return hay.includes(s) ? (value.toLowerCase().startsWith(s) ? 1 : 0.6) : 0;
						}}
					>
						<Command.Input
							autoFocus
							defaultValue={app.paletteQuery}
							placeholder={
								app.paletteScope === "pane" ? "Actions for the focused pane…" : chatId ? "Type a command or search omp commands with /…" : "Type a command…"
							}
							className="h-12 w-full border-b bg-transparent px-4 text-[14px] outline-none"
							style={{ borderColor: "var(--border)" }}
						/>
						<Command.List className="max-h-[60vh] overflow-auto p-1">
							<Command.Empty className="p-4 text-[12.5px]" style={{ color: "var(--muted)" }}>
								Nothing matches.
							</Command.Empty>
							{!commandsOnly &&
								groupBy(actions).map(([group, items]) => (
									<Command.Group key={group} heading={group}>
										{items?.map(action => (
											<Command.Item
												key={action.id}
												value={action.label}
												keywords={action.keywords ? [action.keywords] : undefined}
												onSelect={() => {
													close();
													action.run();
												}}
												className="flex cursor-pointer items-center gap-3 px-3 py-2 text-[13px]"
											>
												<span className="flex-1">{action.label}</span>
												{action.hint && <span className="gy-kbd">{action.hint}</span>}
											</Command.Item>
										))}
									</Command.Group>
								))}
							{showCommands && chatId && (
								<Command.Group heading={`omp commands (${commands.length})`}>
									{commands.map(cmd => (
										<Command.Item
											key={cmd.name}
											value={`/${cmd.name}`}
											keywords={[...(cmd.aliases ?? []), cmd.description ?? ""]}
											onSelect={() => {
												close();
												runSlashCommand(chatId, cmd);
											}}
											className="flex cursor-pointer items-baseline gap-3 px-3 py-2"
										>
											<span className="font-mono text-[12.5px]" style={{ color: "var(--info)" }}>
												/{cmd.name}
											</span>
											<span className="min-w-0 flex-1 truncate text-[12px]" style={{ color: "var(--text-dim)" }}>
												{cmd.description}
											</span>
											<span className="gy-label">{cmd.source}</span>
										</Command.Item>
									))}
								</Command.Group>
							)}
						</Command.List>
					</Command>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
