/**
 * Review the agent's changes turn by turn. Gyre's omp extension snapshots the work tree
 * (as git trees) when each agent run starts and ends (`gyre.turns`). "This turn" shows what
 * one run changed; "Since then" compares the run's start with the work tree now and can
 * revert whole files or single hunks. Clicking a line number adds a comment; the comments
 * go to the chat's composer as one message.
 */
import type { GitDiff, PaneSpec, ReviewChanges, ReviewFile } from "@gyre/protocol";
import { FileDiff, Loader2, MessageSquarePlus, RefreshCw, Send, Undo2, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/gateway";
import { commentsMessage, rangeFor, type ReviewComment, type ReviewMode, reviewableTurns, timeLabel, turnChanged } from "../lib/review";
import { sendToChat } from "../store/actions";
import { useChats } from "../store/chats";
import { useNarrow } from "./GitPane";

const MonacoDiffViewer = lazy(() => import("./MonacoDiffViewer"));

const STATUS_LABEL: Record<string, string> = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type changed" };

export function ReviewPane({ pane }: { pane: PaneSpec }) {
	const chatId = pane.chatId ?? "";
	const chat = useChats(s => s.chats[chatId]);
	const projectId = chat?.info.projectId ?? pane.projectId;
	const turnsState = chat?.turns ?? null;
	const turns = useMemo(() => reviewableTurns(turnsState), [turnsState]);
	const [rootRef, narrow] = useNarrow();
	const [selectedN, setSelectedN] = useState<number | null>(null);
	const turn = turns.find(t => t.n === selectedN) ?? turns.find(turnChanged) ?? turns[0];
	const [mode, setMode] = useState<ReviewMode>("turn");
	const effectiveMode: ReviewMode = turn && !turn.after ? "since" : mode;
	const range = turn ? rangeFor(turn, effectiveMode) : null;
	// Each result is kept with the request it answers and shown only while that request is
	// still the current one: another turn's file list, or another file's diff (which line
	// comments would be filed against), never stands in while the next one loads.
	const rangeKey = range ? `${range.from}..${range.to}` : null;
	const [loadedChanges, setChanges] = useState<{ key: string; changes: ReviewChanges } | null>(null);
	const changes = loadedChanges && loadedChanges.key === rangeKey ? loadedChanges.changes : null;
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const diffKey = `${rangeKey}|${selectedPath}`;
	const [loadedDiff, setDiff] = useState<{ key: string; diff: GitDiff } | null>(null);
	const diff = loadedDiff && loadedDiff.key === diffKey ? loadedDiff.diff : null;
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [busy, setBusy] = useState(false);
	const [comments, setComments] = useState<ReviewComment[]>([]);
	const [refreshKey, setRefreshKey] = useState(0);
	const generation = useRef(0);
	const base = projectId ? `/api/projects/${projectId}/review` : null;

	useEffect(() => {
		if (!base || !range || !rangeKey) {
			setChanges(null);
			return;
		}
		const key = rangeKey;
		const request = ++generation.current;
		setLoading(true);
		setError(null);
		api<ReviewChanges>(`${base}/files?${new URLSearchParams(range)}`)
			.then(result => {
				if (request !== generation.current) return;
				setChanges({ key, changes: result });
				setSelectedPath(current => (current && result.files.some(f => f.path === current) ? current : (result.files[0]?.path ?? null)));
			})
			.catch(e => request === generation.current && setError((e as Error).message))
			.finally(() => request === generation.current && setLoading(false));
	}, [base, rangeKey, refreshKey]);

	useEffect(() => {
		if (!base || !range || !selectedPath || !changes?.files.some(f => f.path === selectedPath)) {
			setDiff(null);
			return;
		}
		let current = true;
		const key = diffKey;
		api<GitDiff>(`${base}/diff?${new URLSearchParams({ ...range, path: selectedPath })}`)
			.then(d => current && setDiff({ key, diff: d }))
			.catch(e => current && setError((e as Error).message));
		return () => {
			current = false;
		};
	}, [base, diffKey, selectedPath, changes]);

	// "Since then" follows the work tree: refresh when this chat finishes a run.
	useEffect(() => {
		let wasBusy = useChats.getState().chats[chatId]?.busy ?? false;
		return useChats.subscribe(state => {
			const isBusy = state.chats[chatId]?.busy ?? false;
			if (wasBusy && !isBusy) setRefreshKey(k => k + 1);
			wasBusy = isBusy;
		});
	}, [chatId]);

	const revert = useCallback(
		async (file: ReviewFile, hunkId?: string) => {
			if (!base || !turn?.before) return;
			const what = hunkId ? `this hunk of ${file.path}` : file.status === "A" ? `${file.path} (it will be deleted)` : file.path;
			if (!confirm(`Revert ${what} to how it was before turn ${turn.n}? This changes the work tree and cannot be undone.`)) return;
			setBusy(true);
			setError(null);
			try {
				await api(`${base}/revert`, { method: "POST", body: JSON.stringify({ from: turn.before, path: file.path, ...(hunkId ? { hunkId } : {}) }) });
				setRefreshKey(k => k + 1);
			} catch (e) {
				setError((e as Error).message);
			} finally {
				setBusy(false);
			}
		},
		[base, turn],
	);

	const addComment = (line: number) => {
		// Only against the diff on screen: it must be the selected file's, in this range.
		if (!turn || !selectedPath || diff?.path !== selectedPath) return;
		const text = prompt(`Comment on ${selectedPath}:${line}`);
		if (!text?.trim()) return;
		setComments(list => [...list, { id: crypto.randomUUID(), turn: turn.n, path: selectedPath, line, text }]);
	};

	const sendComments = () => {
		if (!comments.length) return;
		if (sendToChat(commentsMessage(comments), projectId)) setComments([]);
		else setError("Open the chat to send the comments.");
	};

	if (!chat) return <Empty text="This chat is no longer open." />;
	if (turnsState?.unavailable) return <Empty text={turnsState.unavailable} />;
	if (!turns.length) {
		// A turn whose first snapshot failed cannot be reviewed, but its error should still show.
		const failed = turnsState?.turns.filter(t => t.error).at(-1);
		if (failed) return <Empty text={`Turn #${failed.n} could not be snapshotted: ${failed.error}`} />;
		return <Empty text={turnsState ? "No turns recorded yet. Each agent run is snapshotted when it starts and ends." : "Waiting for the chat to report its turns…"} />;
	}

	const file = changes?.files.find(f => f.path === selectedPath);
	const actionable = effectiveMode === "since";

	return (
		<div ref={rootRef} className={`flex h-full min-h-0 ${narrow ? "flex-col" : ""}`} style={{ background: "var(--panel)" }} data-review-pane>
			<div className={`${narrow ? "max-h-40 border-b" : "w-56 border-r"} shrink-0 overflow-auto`} style={{ borderColor: "var(--border-strong)" }}>
				{turns.map(t => (
					<button
						type="button"
						key={t.n}
						className="gy-row w-full text-left"
						style={t.n === turn?.n ? { background: "var(--tint-tool)" } : undefined}
						onClick={() => setSelectedN(t.n)}
						data-turn={t.n}
					>
						<div className="min-w-0 flex-1">
							<div className="truncate text-[12.5px]" style={t.after && !turnChanged(t) ? { color: "var(--muted)" } : undefined}>
								<span className="font-mono">#{t.n}</span> {t.prompt || "(continued)"}
							</div>
							<div className="truncate text-[11px]" style={{ color: t.error ? "var(--err)" : "var(--muted)" }}>
								{t.error ? t.error : !t.after ? "running…" : turnChanged(t) ? `changed files · ${timeLabel(t.startedAt)}` : `no changes · ${timeLabel(t.startedAt)}`}
							</div>
						</div>
					</button>
				))}
			</div>

			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				<div className="gy-section flex-wrap gap-1.5">
					<span className="normal-case tracking-normal">Turn #{turn?.n}</span>
					<div className="ml-auto flex gap-1 font-normal normal-case tracking-normal">
						<button
							type="button"
							className={`gy-btn ${effectiveMode === "turn" ? "primary" : ""}`}
							disabled={!turn?.after}
							onClick={() => setMode("turn")}
							title="What this run changed"
						>
							This turn
						</button>
						<button type="button" className={`gy-btn ${effectiveMode === "since" ? "primary" : ""}`} onClick={() => setMode("since")} title="Everything that changed since this run started; revertable">
							Since then
						</button>
						<button type="button" className="gy-btn" aria-label="Refresh" onClick={() => setRefreshKey(k => k + 1)}>
							<RefreshCw size={11} className={loading ? "animate-spin" : ""} />
						</button>
					</div>
				</div>
				{error && (
					<div className="gy-row text-[12px]" role="alert" style={{ color: "var(--err)" }}>
						<span className="flex-1">{error}</span>
						<button type="button" className="gy-btn" aria-label="Dismiss" onClick={() => setError(null)}>
							<X size={11} />
						</button>
					</div>
				)}
				<div className="max-h-[35%] shrink-0 overflow-auto border-b" style={{ borderColor: "var(--border)" }}>
					{changes && changes.files.length === 0 && (
						<div className="p-3 text-[12px]" style={{ color: "var(--muted)" }}>
							{effectiveMode === "turn" ? "This turn changed no files." : "Nothing changed since this turn started (or it was all reverted)."}
						</div>
					)}
					{changes?.files.map(f => (
						<div key={f.path} className="gy-row" style={f.path === selectedPath ? { background: "var(--tint-tool)" } : undefined} data-review-file={f.path}>
							<button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setSelectedPath(f.path)}>
								<span className="gy-chip shrink-0 font-mono" title={STATUS_LABEL[f.status] ?? f.status}>
									{f.status}
								</span>
								<span className="truncate font-mono text-[12px]">
									{f.origPath ? `${f.origPath} → ` : ""}
									{f.path}
								</span>
								<span className="shrink-0 font-mono text-[11px]" style={{ color: "var(--muted)" }}>
									{f.added !== undefined ? `+${f.added} −${f.removed ?? 0}` : "binary"}
								</span>
							</button>
							{actionable && (
								<button type="button" className="gy-btn danger" disabled={busy} onClick={() => void revert(f)} title="Revert this file to the turn's start">
									<Undo2 size={11} /> Revert
								</button>
							)}
						</div>
					))}
				</div>
				{actionable && file && diff && diff.hunks.some(h => h.id) && (
					<div className="flex shrink-0 flex-wrap gap-1 border-b px-2 py-1" style={{ borderColor: "var(--border)" }}>
						{diff.hunks.map(h => (
							<button key={h.id} type="button" className="gy-btn" disabled={busy} onClick={() => void revert(file, h.id)} title={`Revert ${h.header}`}>
								<Undo2 size={10} /> <span className="font-mono text-[11px]">{h.header.match(/@@ [^@]+ @@/)?.[0] ?? h.header}</span>
							</button>
						))}
					</div>
				)}
				<div className="min-h-0 flex-1">
					{diff?.binary || diff?.truncated ? (
						<div className="p-3 text-[12px]" style={{ color: "var(--muted)" }}>
							{diff.binary ? "Binary file." : "Too large to show."}
						</div>
					) : diff ? (
						<Suspense fallback={<Loader2 size={14} className="m-3 animate-spin" />}>
							<MonacoDiffViewer
								key={`${range?.from}-${range?.to}-${diff.path}`}
								modelKey={`review-${pane.id}`}
								path={diff.path}
								oldText={diff.oldText}
								newText={diff.newText}
								inline={narrow}
								onLineClick={addComment}
							/>
						</Suspense>
					) : null}
				</div>
				<div className="shrink-0 border-t" style={{ borderColor: "var(--border)" }}>
					{comments.length === 0 ? (
						<div className="flex items-center gap-1.5 px-2 py-1 text-[11.5px]" style={{ color: "var(--muted)" }}>
							<MessageSquarePlus size={11} /> Click a line number in the diff to comment on it.
						</div>
					) : (
						<>
							<div className="max-h-32 overflow-auto">
								{comments.map(c => (
									<div key={c.id} className="gy-row text-[12px]">
										<span className="shrink-0 font-mono" style={{ color: "var(--muted)" }}>
											{c.path}:{c.line}
										</span>
										<span className="min-w-0 flex-1 truncate">{c.text}</span>
										<button type="button" className="gy-btn" aria-label="Remove comment" onClick={() => setComments(list => list.filter(x => x.id !== c.id))}>
											<X size={10} />
										</button>
									</div>
								))}
							</div>
							<div className="gy-row justify-end">
								<button type="button" className="gy-btn primary" onClick={sendComments} data-testid="send-review-comments">
									<Send size={11} /> Send {comments.length} comment{comments.length === 1 ? "" : "s"} to the chat
								</button>
							</div>
						</>
					)}
				</div>
			</div>
		</div>
	);
}

function Empty({ text }: { text: string }) {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center" style={{ background: "var(--panel)", color: "var(--muted)" }}>
			<FileDiff size={24} />
			<div className="max-w-sm text-[12.5px]">{text}</div>
		</div>
	);
}

