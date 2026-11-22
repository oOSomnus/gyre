import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { OmpSetupGuide } from "./OmpSetup";
import type { FloatRect, LayoutNode, PaneSpec, Workspace } from "@gyre/protocol";
import {
	ArrowRightLeft,
	ClipboardCopy,
	Columns2,
	Download,
	EyeOff,
	FolderGit2,
	Maximize2,
	Minimize2,
	MessagesSquare,
	PictureInPicture2,
	RotateCcw,
	Rows2,
	SlidersHorizontal,
	X,
} from "lucide-react";
import { Fragment, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Group, Panel, Separator, useGroupRef } from "react-resizable-panels";
import { ChatPane } from "../chat/ChatPane";
import { exportSessionLog } from "../lib/exportSessionLog";
import { api } from "../lib/gateway";
import { paneStatus } from "../lib/status";
import { EventsPane } from "../panes/EventsPane";
import { FilePane } from "../panes/FilePane";
import { GraphPane } from "../panes/GraphPane";
import { ImagePane } from "../panes/ImagePane";
import { MessagePane } from "../panes/MessagePane";
import { ObjectivesPane } from "../panes/ObjectivesPane";
import { PlanPane } from "../panes/PlanPane";
import { SessionsPane } from "../panes/SessionsPane";
import { SettingsPane } from "../panes/SettingsPane";
import { StudioPane } from "../panes/StudioPane";
import { SubagentPane } from "../panes/SubagentPane";
import { SubagentsPane } from "../panes/SubagentsPane";
import { TasksPane } from "../panes/TasksPane";
import { TerminalPane } from "../panes/TerminalPane";
import { openChatPane, useApp } from "../store/app";
import { closePaneAndResources, numberedPanes } from "../store/actions";
import { useChats } from "../store/chats";
import { PANE_META, paneTitle } from "./panes";
import { Gyroscope } from "./Gyroscope";

const menuItem = "gy-menu-item";

export function PaneMenu({ pane, floating }: { pane: PaneSpec; floating: boolean }) {
	const app = useApp();
	const others = app.workspaces.filter(ws => ws.id !== app.activeWorkspaceId);
	const split = (direction: "row" | "column") =>
		app.addPane({ kind: "chat", projectId: pane.projectId ?? app.projects[0]?.id }, { direction, nextTo: pane.id });
	const chatId = pane.kind === "chat" ? pane.id : pane.chatId;
	return (
		<Dropdown.Root>
			<Dropdown.Trigger asChild>
				<button type="button" className="gy-frame-btn" title="Pane actions" data-jump="pane-menu">
					<SlidersHorizontal size={12} />
				</button>
			</Dropdown.Trigger>
			<Dropdown.Portal>
				<Dropdown.Content sideOffset={4} align="start" className="gy-menu">
					{!floating && (
						<>
							<Dropdown.Item className={menuItem} onSelect={() => split("row")}>
								<Columns2 size={13} /> Split right (new chat)
							</Dropdown.Item>
							<Dropdown.Item className={menuItem} onSelect={() => split("column")}>
								<Rows2 size={13} /> Split down (new chat)
							</Dropdown.Item>
						</>
					)}
					<Dropdown.Item className={menuItem} onSelect={() => (floating ? app.dockPane(pane.id) : app.floatPane(pane.id))}>
						<PictureInPicture2 size={13} /> {floating ? "Dock into grid" : "Float"}
					</Dropdown.Item>
					<Dropdown.Item className={menuItem} onSelect={() => app.hidePane(pane.id)}>
						<EyeOff size={13} /> Hide <span className="gy-kbd ml-auto">H</span>
					</Dropdown.Item>
					{others.length > 0 && (
						<Dropdown.Sub>
							<Dropdown.SubTrigger className={menuItem}>
								<ArrowRightLeft size={13} /> Move to workspace <span className="ml-auto">›</span>
							</Dropdown.SubTrigger>
							<Dropdown.Portal>
								<Dropdown.SubContent className="gy-menu">
									{others.map(ws => (
										<Dropdown.Item key={ws.id} className={menuItem} onSelect={() => app.movePaneToWorkspace(pane.id, ws.id)}>
											{ws.name}
										</Dropdown.Item>
									))}
								</Dropdown.SubContent>
							</Dropdown.Portal>
						</Dropdown.Sub>
					)}
					{chatId && (
						<>
							<Dropdown.Separator className="my-1 h-px" style={{ background: "var(--border-strong)" }} />
							{(["plan", "objectives", "graph", "events"] as const).map(kind => {
								const Icon = PANE_META[kind].icon;
								return (
									<Dropdown.Item key={kind} className={menuItem} onSelect={() => openChatPane(kind, chatId)}>
										<Icon size={13} /> {PANE_META[kind].title}
									</Dropdown.Item>
								);
							})}
							{pane.kind === "chat" && (
								<Dropdown.Item className={menuItem} onSelect={() => void api(`/api/chats/${encodeURIComponent(pane.id)}/restart`, { method: "POST" })}>
									<RotateCcw size={13} /> Restart omp (same session)
								</Dropdown.Item>
							)}
							{pane.kind === "chat" && (
								<>
									<Dropdown.Item className={menuItem} onSelect={() => void exportSessionLog(pane.id, "download")}>
										<Download size={13} /> Export session log
									</Dropdown.Item>
									<Dropdown.Item className={menuItem} onSelect={() => void exportSessionLog(pane.id, "copy")}>
										<ClipboardCopy size={13} /> Copy session log
									</Dropdown.Item>
								</>
							)}
						</>
					)}
				</Dropdown.Content>
			</Dropdown.Portal>
		</Dropdown.Root>
	);
}

function PaneFrame({
	pane,
	focused,
	floating,
	number,
	onHeadPointerDown,
	children,
}: {
	pane: PaneSpec;
	focused: boolean;
	floating?: boolean;
	number?: number;
	onHeadPointerDown?: (e: React.PointerEvent) => void;
	children: ReactNode;
}) {
	const focusPane = useApp(s => s.focusPane);
	const toggleMaximize = useApp(s => s.toggleMaximize);
	const maximized = useApp(s => s.maximizedPaneId === pane.id);
	const kbdMode = useApp(s => s.kbdMode);
	const project = useApp(s => s.projects.find(p => p.id === pane.projectId));
	// Subscribe so titles and status lights update as chats stream.
	useChats(s => {
		const id = pane.kind === "chat" ? pane.id : pane.chatId;
		const chat = id ? s.chats[id] : undefined;
		return chat ? `${chat.state?.sessionName ?? ""}|${chat.items.length}|${chat.busy}|${chat.pendingUi.length}|${chat.plan?.phase ?? ""}` : "";
	});
	const status = paneStatus(pane, useChats.getState().chats);
	const Icon = PANE_META[pane.kind]?.icon ?? MessagesSquare;

	return (
		<section
			data-pane={pane.id}
			data-kind={pane.kind}
			onMouseDownCapture={() => focusPane(pane.id)}
			onFocusCapture={() => focusPane(pane.id)}
			className={`gy-frame relative ${focused ? "focused" : ""}`}
		>
			<header className="gy-frame-head" onPointerDown={onHeadPointerDown} style={floating ? { cursor: "move" } : undefined}>
				<button type="button" className="gy-frame-btn close" title="Close pane" onClick={() => closePaneAndResources(pane)} data-jump="close">
					<X size={13} strokeWidth={3} />
				</button>
				{!floating && (
					<button
						type="button"
						className="gy-frame-btn"
						title={maximized ? "Restore" : "Maximize"}
						onClick={() => toggleMaximize(pane.id)}
						data-jump="maximize"
					>
						{maximized ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
					</button>
				)}
				<PaneMenu pane={pane} floating={Boolean(floating)} />
				{status === "running" && <span className="gy-light-running ml-1 inline-block h-2.5 w-2.5 rounded-full border border-black" title="running" />}
				{status === "waiting" && <span className="gy-light-waiting ml-1 inline-block h-2.5 w-2.5 rounded-full border border-black" title="needs you" />}
				{status === "error" && <span className="gy-light-error ml-1 inline-block h-2.5 w-2.5 rounded-full border border-black" title="error" />}
				<div className="gy-frame-title">
					<Icon size={13} className="shrink-0 opacity-80" />
					{project && (
						<>
							<span className="project truncate">{project.name}</span>
							<span className="opacity-80">/</span>
						</>
					)}
					<span className="truncate">{paneTitle(pane)}</span>
				</div>
			</header>
			<div className="min-h-0 flex-1">{children}</div>
			{kbdMode && number !== undefined && number <= 9 && (
				<div className="gy-pane-number">
					<span>{number}</span>
				</div>
			)}
		</section>
	);
}

export function PaneContent({ pane, focused }: { pane: PaneSpec; focused: boolean }) {
	switch (pane.kind) {
		case "chat":
			return <ChatPane pane={pane} focused={focused} />;
		case "file":
			return <FilePane pane={pane} />;
		case "terminal":
			return <TerminalPane pane={pane} focused={focused} />;
		case "sessions":
			return <SessionsPane pane={pane} />;
		case "subagents":
			return <SubagentsPane pane={pane} />;
		case "settings":
			return <SettingsPane pane={pane} />;
		case "events":
			return <EventsPane pane={pane} />;
		case "plan":
			return <PlanPane pane={pane} />;
		case "objectives":
			return <ObjectivesPane pane={pane} />;
		case "graph":
			return <GraphPane pane={pane} />;
		case "tasks":
			return <TasksPane pane={pane} />;
		case "message":
			return <MessagePane pane={pane} />;
		case "image":
			return <ImagePane pane={pane} />;
		case "subagent":
			return <SubagentPane pane={pane} />;
		case "studio":
			return <StudioPane pane={pane} />;
		default:
			return null;
	}
}

function Node({ node, path, ws, numbers }: { node: LayoutNode; path: number[]; ws: Workspace; numbers: Map<string, number> }) {
	const setSizes = useApp(s => s.setSizes);
	const groupRef = useGroupRef();
	const ids = node.type === "split" ? node.children.map((child, i) => (child.type === "pane" ? child.paneId : `split-${path.join("-")}-${i}`)) : [];
	const sizesKey = node.type === "split" ? node.sizes.map(s => s.toFixed(1)).join(",") : "";

	// Keyboard resizes change sizes in the store; push them into the mounted group.
	useEffect(() => {
		if (node.type !== "split") return;
		const group = groupRef.current;
		if (!group) return;
		const current = group.getLayout();
		const target = Object.fromEntries(ids.map((id, i) => [id, node.sizes[i] ?? 100 / ids.length]));
		if (ids.some(id => Math.abs((current[id] ?? 0) - (target[id] ?? 0)) > 0.5)) group.setLayout(target);
		// biome-ignore lint/correctness/useExhaustiveDependencies: sizesKey captures node.sizes
	}, [sizesKey]);

	if (node.type === "pane") {
		const pane = ws.panes[node.paneId];
		if (!pane) return null;
		const focused = pane.id === ws.focusedPaneId;
		return (
			<PaneFrame pane={pane} focused={focused} number={numbers.get(pane.id)}>
				<PaneContent pane={pane} focused={focused} />
			</PaneFrame>
		);
	}
	const defaultLayout = Object.fromEntries(ids.map((id, i) => [id, node.sizes[i] ?? 100 / ids.length]));
	return (
		<Group
			key={ids.join("|")}
			groupRef={groupRef}
			orientation={node.direction === "row" ? "horizontal" : "vertical"}
			defaultLayout={defaultLayout}
			onLayoutChanged={layout =>
				setSizes(
					path,
					ids.map(id => layout[id] ?? 0),
				)
			}
			className="h-full w-full"
		>
			{node.children.map((child, i) => (
				<Fragment key={ids[i]}>
					{i > 0 && <Separator className={node.direction === "row" ? "w-[6px]" : "h-[6px]"} />}
					<Panel id={ids[i]} minSize="8">
						<Node node={child} path={[...path, i]} ws={ws} numbers={numbers} />
					</Panel>
				</Fragment>
			))}
		</Group>
	);
}

function FloatingPane({ pane, rect, ws, number }: { pane: PaneSpec; rect: FloatRect; ws: Workspace; number?: number }) {
	const setFloatRect = useApp(s => s.setFloatRect);
	const drag = (e: React.PointerEvent, mode: "move" | "resize") => {
		if (mode === "move" && (e.target as HTMLElement).closest("button")) return;
		useApp.getState().focusPane(pane.id);
		e.preventDefault();
		const start = { x: e.clientX, y: e.clientY, rect };
		const onMove = (ev: PointerEvent) => {
			const dx = ev.clientX - start.x;
			const dy = ev.clientY - start.y;
			if (mode === "move") setFloatRect(pane.id, { x: Math.max(-start.rect.w + 80, start.rect.x + dx), y: Math.max(0, start.rect.y + dy) });
			else setFloatRect(pane.id, { w: Math.max(260, start.rect.w + dx), h: Math.max(160, start.rect.h + dy) });
		};
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	};
	const focused = ws.focusedPaneId === pane.id;
	return (
		<div className="absolute" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: rect.z, boxShadow: "var(--soft-shadow)" }}>
			<PaneFrame pane={pane} focused={focused} floating number={number} onHeadPointerDown={e => drag(e, "move")}>
				<PaneContent pane={pane} focused={focused} />
			</PaneFrame>
			<div
				className="absolute right-0 bottom-0 h-4 w-4 cursor-nwse-resize"
				style={{ background: "linear-gradient(135deg, transparent 50%, var(--chrome-ink) 50%)" }}
				onPointerDown={e => drag(e, "resize")}
			/>
		</div>
	);
}

function HiddenBar({ ws }: { ws: Workspace }) {
	const [hovered, setHovered] = useState<string | null>(null);
	const restorePane = useApp(s => s.restorePane);
	const chats = useChats(s => s.chats);
	const hidden = (ws.hidden ?? []).filter(id => ws.panes[id]);
	if (hidden.length === 0) return null;
	return (
		<div className="gy-chromebar flex h-8 shrink-0 items-center gap-1.5 overflow-x-auto px-2" data-testid="hidden-bar">
			<span className="font-mono text-[10px] tracking-widest uppercase" style={{ color: "var(--chrome-muted)" }}>
				Hidden
			</span>
			{hidden.map(id => {
				const pane = ws.panes[id] as PaneSpec;
				const Icon = PANE_META[pane.kind]?.icon ?? MessagesSquare;
				const status = paneStatus(pane, chats);
				return (
					<div key={id} className="group relative" onMouseEnter={() => setHovered(id)} onMouseLeave={() => setHovered(null)}>
						<button type="button" className="gy-chrome-btn h-6" onClick={() => restorePane(id)} data-jump="hidden-pane" data-hidden-pane={id}>
							<span className={`inline-block h-2 w-2 rounded-full border border-black gy-light-${status}`} />
							<Icon size={12} />
							<span className="max-w-40 truncate normal-case tracking-normal">{paneTitle(pane)}</span>
						</button>
						{/* Live preview on hover (terminals show a placeholder: one live view per shell). */}
						<div
							className="pointer-events-none absolute bottom-8 left-0 z-50 hidden overflow-hidden group-hover:block"
							style={{ width: 300, height: 190, border: "2px solid var(--chrome-ink)", boxShadow: "var(--soft-shadow)", background: "var(--panel)" }}
						>
							{hovered === id &&
								(pane.kind === "terminal" ? (
									<div
										className="flex h-full items-center justify-center font-mono text-[12px]"
										style={{ background: "var(--terminal-bg)", color: "var(--terminal-fg)" }}
									>
										Terminal (running)
									</div>
								) : (
									<div style={{ width: 750, height: 475, transform: "scale(0.4)", transformOrigin: "top left" }}>
										<PaneContent pane={pane} focused={false} />
									</div>
								))}
						</div>
					</div>
				);
			})}
		</div>
	);
}

export function PaneGrid() {
	const workspace = useApp(s => s.workspaces.find(ws => ws.id === s.activeWorkspaceId));
	const maximizedPaneId = useApp(s => s.maximizedPaneId);
	const setGridSize = useApp(s => s.setGridSize);
	const gridRef = useRef<HTMLDivElement>(null);

	useLayoutEffect(() => {
		const el = gridRef.current;
		if (!el) return;
		const observer = new ResizeObserver(() => {
			const rect = el.getBoundingClientRect();
			setGridSize(Math.round(rect.width), Math.round(rect.height));
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [setGridSize]);

	const numbers = new Map(numberedPanes(workspace).map((id, i) => [id, i + 1]));
	const maximized = maximizedPaneId ? workspace?.panes[maximizedPaneId] : undefined;
	const floating = Object.entries(workspace?.floating ?? {}).filter(([id]) => workspace?.panes[id]);
	const empty = !workspace?.layout && floating.length === 0;

	return (
		<div className="flex h-full flex-col">
			<div ref={gridRef} className="relative min-h-0 flex-1 p-[6px]">
				{workspace && maximized ? (
					<PaneFrame pane={maximized} focused number={numbers.get(maximized.id)}>
						<PaneContent pane={maximized} focused />
					</PaneFrame>
				) : workspace?.layout ? (
					<Node node={workspace.layout} path={[]} ws={workspace} numbers={numbers} />
				) : empty ? (
					<EmptyWorkspace />
				) : null}
				{workspace &&
					!maximized &&
					floating.map(([id, rect]) => <FloatingPane key={id} pane={workspace.panes[id] as PaneSpec} rect={rect} ws={workspace} number={numbers.get(id)} />)}
			</div>
			{workspace && <HiddenBar ws={workspace} />}
		</div>
	);
}

function EmptyWorkspace() {
	const { projects, addPane, setAddProjectOpen } = useApp();
	return (
		<div className="h-full overflow-auto p-4" style={{ color: "var(--chrome-text)" }}>
		<div className="flex min-h-full flex-col items-center justify-center gap-5">
			<Gyroscope state="idle" size={72} />
			<OmpSetupGuide />
			<div className="text-[17px] font-medium">This workspace is empty</div>
			<div className="flex flex-wrap justify-center gap-2">
				{projects.map(project => (
					<button type="button" key={project.id} className="gy-btn" onClick={() => addPane({ kind: "chat", projectId: project.id })}>
						<MessagesSquare size={13} /> New chat in {project.name}
					</button>
				))}
				<button type="button" className="gy-btn primary" onClick={() => setAddProjectOpen(true)}>
					<FolderGit2 size={13} /> Add project
				</button>
			</div>
		</div>
		</div>
	);
}
