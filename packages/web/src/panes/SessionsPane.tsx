import type { PaneSpec, SessionSummary } from "@gyre/protocol";
import { GitFork, Loader2, MessageSquarePlus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/gateway";
import { useApp } from "../store/app";

function relTime(iso: string): string {
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return "";
	const s = (Date.now() - t) / 1000;
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

export function SessionsPane({ pane }: { pane: PaneSpec }) {
	const { projects, addPane, activeWorkspace } = useApp();
	const [projectId, setProjectId] = useState(pane.projectId ?? projects[0]?.id);
	const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");

	const load = useCallback(async () => {
		if (!projectId) return;
		setSessions(null);
		setError(null);
		try {
			setSessions(await api<SessionSummary[]>(`/api/sessions?projectId=${projectId}`));
		} catch (e) {
			setError((e as Error).message);
			setSessions([]);
		}
	}, [projectId]);

	useEffect(() => {
		void load();
	}, [load]);

	const open = (session?: SessionSummary) => {
		const ws = activeWorkspace();
		// Reuse an existing pane already bound to this session.
		const existing = session ? Object.values(ws?.panes ?? {}).find(p => p.kind === "chat" && p.sessionPath === session.path) : undefined;
		if (existing) {
			useApp.getState().focusPane(existing.id);
			return;
		}
		addPane({ kind: "chat", projectId, sessionPath: session?.path }, { nextTo: pane.id });
	};

	const filtered = (sessions ?? []).filter(s => !query || `${s.title ?? ""} ${s.firstMessage}`.toLowerCase().includes(query.toLowerCase()));

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center gap-2 border-b p-2" style={{ borderColor: "var(--border)" }}>
				<select className="gy-input" value={projectId} onChange={e => setProjectId(e.target.value)}>
					{projects.map(p => (
						<option key={p.id} value={p.id}>
							{p.name}
						</option>
					))}
				</select>
				<input className="gy-input min-w-0 flex-1" placeholder="Filter sessions…" value={query} onChange={e => setQuery(e.target.value)} />
				<button type="button" className="gy-icon-btn" onClick={() => void load()} title="Refresh">
					<RefreshCw size={14} />
				</button>
				<button type="button" className="gy-btn primary" onClick={() => open()} data-jump="new-chat">
					<MessageSquarePlus size={13} /> New
				</button>
			</div>
			<div className="min-h-0 flex-1 overflow-auto p-2">
				{sessions === null && (
					<div className="flex items-center gap-2 p-3" style={{ color: "var(--muted)" }}>
						<Loader2 size={14} className="animate-spin" /> Loading sessions…
					</div>
				)}
				{error && <div className="p-3 text-[12px]" style={{ color: "var(--err)" }}>{error}</div>}
				{sessions && filtered.length === 0 && !error && <div className="p-3 text-[12.5px]" style={{ color: "var(--muted)" }}>No sessions yet for this project.</div>}
				<div className="flex flex-col gap-1">
					{filtered.map(s => (
						<button
							type="button"
							key={s.path}
							data-jump="session"
							onClick={() => open(s)}
							className="group flex flex-col gap-0.5 rounded-md border px-3 py-2 text-left hover:brightness-110"
							style={{ borderColor: "var(--border)", background: "var(--panel-2)" }}
						>
							<div className="flex items-center gap-2">
								<span className="min-w-0 flex-1 truncate text-[13px]">{s.title || s.firstMessage || "(empty session)"}</span>
								<span className="gy-label">{relTime(s.modified)}</span>
							</div>
							<div className="flex items-center gap-2 text-[11.5px]" style={{ color: "var(--muted)" }}>
								<span>{s.messageCount} messages</span>
								{s.status && <span className="gy-chip">{s.status}</span>}
								<GitFork size={11} className="ml-auto opacity-0 group-hover:opacity-60" />
							</div>
						</button>
					))}
				</div>
			</div>
		</div>
	);
}
