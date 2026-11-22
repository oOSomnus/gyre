import type { PaneSpec } from "@gyre/protocol";
import { useMemo, useState } from "react";
import { useApp } from "../store/app";
import { useChats } from "../store/chats";

/**
 * Raw omp frame log. Everything omp emits is visible here, including event
 * types this UI does not know yet — the safety net for upstream changes.
 */
export function EventsPane({ pane }: { pane: PaneSpec }) {
	const panes = useApp(s => s.workspaces.find(w => w.id === s.activeWorkspaceId)?.panes ?? {});
	const chatPanes = Object.values(panes).filter(p => p.kind === "chat");
	const [chatId, setChatId] = useState<string | undefined>(pane.chatId ?? chatPanes[0]?.id);
	const frames = useChats(s => (chatId ? s.chats[chatId]?.frames : undefined)) ?? [];
	const [filter, setFilter] = useState("");
	const [hideDeltas, setHideDeltas] = useState(true);
	const [open, setOpen] = useState<number | null>(null);

	const shown = useMemo(
		() =>
			frames
				.map((f, i) => ({ ...f, i }))
				.filter(({ frame }) => (!hideDeltas || frame.type !== "message_update") && (!filter || frame.type.includes(filter) || String(frame.method ?? "").includes(filter)))
				.reverse(),
		[frames, filter, hideDeltas],
	);

	return (
		<div className="flex h-full flex-col" data-pane-kind={pane.kind}>
			<div className="flex items-center gap-2 border-b p-2" style={{ borderColor: "var(--border)" }}>
				<select className="gy-input" value={chatId} onChange={e => setChatId(e.target.value)}>
					{chatPanes.map(p => (
						<option key={p.id} value={p.id}>
							Chat {p.id.slice(0, 6)}
						</option>
					))}
				</select>
				<input className="gy-input min-w-0 flex-1" placeholder="Filter by type…" value={filter} onChange={e => setFilter(e.target.value)} />
				<label className="flex items-center gap-1 text-[12px]" style={{ color: "var(--text-dim)" }}>
					<input type="checkbox" checked={hideDeltas} onChange={e => setHideDeltas(e.target.checked)} /> hide deltas
				</label>
			</div>
			<div className="min-h-0 flex-1 overflow-auto font-mono text-[11.5px]">
				{shown.map(({ frame, ts, i }) => (
					<div key={i} className="border-b" style={{ borderColor: "var(--border)" }}>
						<button type="button" className="flex w-full gap-3 px-3 py-1 text-left hover:bg-[var(--panel-2)]" onClick={() => setOpen(open === i ? null : i)}>
							<span style={{ color: "var(--muted)" }}>{new Date(ts).toLocaleTimeString()}</span>
							<span style={{ color: "var(--accent)" }}>{frame.type}</span>
							{frame.method ? <span style={{ color: "var(--highlight)" }}>{String(frame.method)}</span> : null}
						</button>
						{open === i && <pre className="gy-pre m-2">{JSON.stringify(frame, null, 2).slice(0, 20000)}</pre>}
					</div>
				))}
				{shown.length === 0 && <div className="p-3" style={{ color: "var(--muted)" }}>No frames yet.</div>}
			</div>
		</div>
	);
}
