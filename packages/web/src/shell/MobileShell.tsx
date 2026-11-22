/** Phone layout: the same panes, one at a time, with a bottom tab strip. */
import type { PaneSpec } from "@gyre/protocol";
import { MessagesSquare, Plus, X, EyeOff } from "lucide-react";
import { paneStatus } from "../lib/status";
import { useApp } from "../store/app";
import { useChats } from "../store/chats";
import { numberedPanes, closePaneAndResources } from "../store/actions";
import { NewPaneMenu } from "./TopBar";
import { OmpSetupGuide } from "./OmpSetup";
import { PaneContent, PaneMenu } from "./PaneGrid";
import { PANE_META, paneTitle } from "./panes";

export function MobileShell() {
	const ws = useApp(s => s.workspaces.find(w => w.id === s.activeWorkspaceId));
	const focusPane = useApp(s => s.focusPane);
	const chats = useChats(s => s.chats);
	if (!ws) return null;
	const ids = [...numberedPanes(ws), ...(ws.hidden ?? [])].filter((id, i, all) => ws.panes[id] && all.indexOf(id) === i);
	const current = (ws.focusedPaneId && ws.panes[ws.focusedPaneId]) || (ids[0] ? ws.panes[ids[0]] : undefined);
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="min-h-0 flex-1">
				{current ? (
					<section className="gy-frame focused" data-kind={current.kind} data-pane={current.id}>
						<header className="gy-frame-head">
							<div className="gy-frame-title justify-start">{paneTitle(current)}</div>
							<PaneMenu pane={current} floating={Boolean(ws.floating?.[current.id])} />
							<button type="button" className="gy-frame-btn h-6 w-6" aria-label="Hide pane" onClick={() => useApp.getState().hidePane(current.id)}>
								<EyeOff size={14} />
							</button>
							<button type="button" className="gy-frame-btn close h-6 w-6" aria-label="Close pane" onClick={() => closePaneAndResources(current)}>
								<X size={14} />
							</button>
						</header>
						<div className="min-h-0 flex-1">
							<PaneContent pane={current} focused />
						</div>
					</section>
				) : (
					<div className="flex h-full flex-col items-center justify-center gap-4 overflow-auto p-3" style={{ color: "var(--chrome-text)" }}>
						<OmpSetupGuide />
						No panes yet
					</div>
				)}
			</div>
			<nav className="gy-chromebar flex h-14 shrink-0 items-stretch gap-1 overflow-x-auto px-1 py-1">
				{ids.map(id => {
					const pane = ws.panes[id] as PaneSpec;
					const Icon = PANE_META[pane.kind]?.icon ?? MessagesSquare;
					const status = paneStatus(pane, chats);
					return (
						<button
							type="button"
							key={id}
							onClick={() => focusPane(id)}
							className="gy-chrome-btn flex-col justify-center gap-0.5 px-2"
							data-on={current?.id === id}
							style={{ minWidth: 64, maxWidth: 120 }}
						>
							<span className="flex items-center gap-1">
								<Icon size={14} />
								<span className={`inline-block h-2 w-2 rounded-full border border-black gy-light-${status}`} />
							</span>
							<span className="max-w-full truncate text-[9px] normal-case tracking-normal">{paneTitle(pane)}</span>
						</button>
					);
				})}
				<NewPaneMenu>
					<button type="button" className="gy-chrome-icon h-full w-12">
						<Plus size={16} />
					</button>
				</NewPaneMenu>
			</nav>
		</div>
	);
}
