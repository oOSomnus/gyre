/**
 * Git pane: changed files, a split diff, staging per file or hunk, and a commit
 * composer. omp's `/git` is a TUI-only command, so Gyre draws its own; the
 * gateway runs the git CLI (`packages/gateway/src/git.ts`). With
 * `pane.revision` the pane is a read-only view of one commit.
 */
import type { GitCommitInfo, GitDiff, GitFile, GitHunk, GitHunkAction, GitStatus, PaneSpec } from "@gyre/protocol";
import { ArrowDown, ArrowUp, GitBranch, GitCommitHorizontal, Loader2, Minus, Plus, RefreshCw, Sparkles, Undo2 } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { api, GatewayError } from "../lib/gateway";
import { codeInfo, countLabel, type GitSide, groupFiles, hunkNewStart, nextSelection, splitPath, statusCode } from "../lib/git";
import { useChats } from "../store/chats";
import type { DiffReveal } from "./MonacoDiffViewer";

const MonacoDiffViewer = lazy(() => import("./MonacoDiffViewer"));

/** Below this width the sidebar stacks above the diff and the diff goes inline. */
const NARROW_PX = 640;

/** A callback ref for the pane root and whether it is narrow. A callback ref, because the root mounts after loading. */
function useNarrow(): [(el: HTMLDivElement | null) => void, boolean] {
	const [narrow, setNarrow] = useState(false);
	const observer = useRef<ResizeObserver | null>(null);
	const ref = useCallback((el: HTMLDivElement | null) => {
		observer.current?.disconnect();
		observer.current = null;
		if (!el) return;
		const measure = () => setNarrow(el.clientWidth < NARROW_PX);
		measure();
		observer.current = new ResizeObserver(measure);
		observer.current.observe(el);
	}, []);
	return [ref, narrow];
}

const gitPath = (projectId: string, action: string, query: Record<string, string> = {}) => {
	const qs = new URLSearchParams(query).toString();
	return `/api/projects/${encodeURIComponent(projectId)}/git/${action}${qs ? `?${qs}` : ""}`;
};
const post = <T,>(projectId: string, action: string, body: unknown) => api<T>(gitPath(projectId, action), { method: "POST", body: JSON.stringify(body) });

function Message({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "err" | "warn" }) {
	return (
		<div className="p-3 text-[12.5px]" style={{ color: tone === "muted" ? "var(--muted)" : `var(--${tone})` }} role={tone === "err" ? "alert" : undefined}>
			{children}
		</div>
	);
}

export function GitPane({ pane, focused }: { pane: PaneSpec; focused: boolean }) {
	if (!pane.projectId) return <Message>No project selected.</Message>;
	return pane.revision ? (
		<CommitView pane={pane} projectId={pane.projectId} revision={pane.revision} />
	) : (
		<WorkingTreeView pane={pane} projectId={pane.projectId} focused={focused} />
	);
}

// ---------------------------------------------------------------------------
// Working tree
// ---------------------------------------------------------------------------

type Selection = { path: string; side: GitSide };

function WorkingTreeView({ pane, projectId, focused }: { pane: PaneSpec; projectId: string; focused: boolean }) {
	const [rootRef, narrow] = useNarrow();
	const [status, setStatus] = useState<GitStatus | null>(null);
	const [loadError, setLoadError] = useState<{ message: string; notRepo: boolean } | null>(null);
	const [selection, setSelection] = useState<Selection | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [diffNonce, setDiffNonce] = useState(0);
	const request = useRef(0);

	const refresh = useCallback(async () => {
		const id = ++request.current;
		try {
			const next = await api<GitStatus>(gitPath(projectId, "status"));
			if (id !== request.current) return;
			setStatus(next);
			setLoadError(null);
			setSelection(current => nextSelection(groupFiles(next), current));
			setDiffNonce(n => n + 1);
		} catch (error) {
			if (id !== request.current) return;
			const notRepo = error instanceof GatewayError && error.status === 404 && /not a git repository/.test(error.message);
			setLoadError({ message: (error as Error).message, notRepo });
		}
	}, [projectId]);

	useEffect(() => {
		void refresh();
	}, [refresh]);
	useEffect(() => {
		if (focused) void refresh();
	}, [focused, refresh]);
	useEffect(() => {
		const onFocus = () => void refresh();
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [refresh]);
	// The agent edits files: refresh when a chat in this project finishes a turn.
	useEffect(() => {
		const busyChats = () =>
			new Set(
				Object.values(useChats.getState().chats)
					.filter(c => c.info.projectId === projectId && c.busy)
					.map(c => c.info.chatId),
			);
		let previous = busyChats();
		return useChats.subscribe(() => {
			const now = busyChats();
			const finished = [...previous].some(id => !now.has(id));
			previous = now;
			if (finished) void refresh();
		});
	}, [projectId, refresh]);

	const run = async (label: string, work: () => Promise<unknown>) => {
		setBusy(label);
		setActionError(null);
		try {
			await work();
		} catch (error) {
			setActionError((error as Error).message);
		} finally {
			setBusy(null);
			await refresh();
		}
	};

	if (loadError?.notRepo) {
		return (
			<Message>
				This project is not inside a git repository. Run <code>git init</code> in a terminal to start one.
			</Message>
		);
	}
	if (!status) return loadError ? <Message tone="err">{loadError.message}</Message> : <Loader2 size={14} className="m-3 animate-spin" />;

	const groups = groupFiles(status);
	const selectedFile = selection ? status.files.find(f => f.path === selection.path) : undefined;
	const stagedCount = groups.staged.length;

	const fileAction = (action: "stage" | "unstage" | "discard", files: GitFile[]) => {
		if (!files.length) return;
		if (action === "discard") {
			const untracked = files.filter(f => f.untracked).length;
			const what = files.length === 1 ? files[0]!.path : `${files.length} files`;
			const detail = untracked ? ` ${untracked === files.length ? "Untracked files are deleted." : `${untracked} untracked file(s) will be deleted.`}` : "";
			if (!confirm(`Discard unstaged changes to ${what}?${detail} This cannot be undone.`)) return;
		}
		const label = action === "stage" ? "Staging" : action === "unstage" ? "Unstaging" : "Discarding";
		void run(label, () => post(projectId, action, { paths: files.map(f => f.path) }));
	};

	const hunkAction = (action: GitHunkAction, hunk: GitHunk) => {
		if (!selection) return;
		if (action === "discard" && !confirm(`Discard this hunk of ${selection.path}? This cannot be undone.`)) return;
		const label = action === "stage" ? "Staging hunk" : action === "unstage" ? "Unstaging hunk" : "Discarding hunk";
		void run(label, () => post(projectId, "hunk", { path: selection.path, id: hunk.id, action }));
	};

	return (
		<div ref={rootRef} className={`flex h-full min-h-0 ${narrow ? "flex-col" : ""}`}>
			<aside
				className={`flex min-h-0 shrink-0 flex-col ${narrow ? "max-h-[55%] border-b" : "w-72 border-r"}`}
				style={{ borderColor: "var(--border)" }}
			>
				<BranchBar status={status} busy={busy} onRefresh={() => void refresh()} />
				{loadError && (
					<div className="px-2 py-1 text-[12px]" style={{ color: "var(--err)" }} role="alert">
						Could not refresh: {loadError.message}
					</div>
				)}
				{actionError && (
					<div className="flex items-start gap-2 px-2 py-1 text-[12px]" style={{ color: "var(--err)" }} role="alert">
						<span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{actionError}</span>
						<button type="button" className="gy-btn ghost" onClick={() => setActionError(null)}>
							Dismiss
						</button>
					</div>
				)}
				<div className="min-h-0 flex-1 overflow-auto px-1 pb-2">
					{status.files.length === 0 && <Message>No changes. The working tree is clean.</Message>}
					<FileGroup
						title="Conflicts"
						side="conflicts"
						files={groups.conflicts}
						selection={selection}
						onSelect={setSelection}
						actions={[{ label: "Mark resolved (stage)", icon: Plus, run: f => fileAction("stage", f) }]}
					/>
					<FileGroup
						title="Staged"
						side="staged"
						files={groups.staged}
						selection={selection}
						onSelect={setSelection}
						actions={[{ label: "Unstage", icon: Minus, run: f => fileAction("unstage", f) }]}
					/>
					<FileGroup
						title="Changes"
						side="changes"
						files={groups.changes}
						selection={selection}
						onSelect={setSelection}
						actions={[
							{ label: "Discard", icon: Undo2, run: f => fileAction("discard", f) },
							{ label: "Stage", icon: Plus, run: f => fileAction("stage", f) },
						]}
					/>
				</div>
				<CommitComposer projectId={projectId} stagedCount={stagedCount} hasHead={Boolean(status.headSha)} busy={busy} run={run} />
			</aside>
			<section className="flex min-h-0 min-w-0 flex-1 flex-col">
				{selection && selectedFile ? (
					<DiffArea
						key={`${selection.path}:${selection.side}`}
						modelKey={pane.id}
						projectId={projectId}
						path={selection.path}
						staged={selection.side === "staged"}
						nonce={diffNonce}
						narrow={narrow}
						hunkActions={
							selectedFile.untracked || selectedFile.conflicted
								? []
								: selection.side === "staged"
									? [{ action: "unstage", label: "Unstage", icon: Minus }]
									: [
											{ action: "discard", label: "Discard", icon: Undo2 },
											{ action: "stage", label: "Stage", icon: Plus },
										]
						}
						onHunk={hunkAction}
						disabled={busy !== null}
					/>
				) : (
					<Message>{status.files.length ? "Pick a file to see its diff." : ""}</Message>
				)}
			</section>
		</div>
	);
}

function BranchBar({ status, busy, onRefresh }: { status: GitStatus; busy: string | null; onRefresh: () => void }) {
	return (
		<div className="flex items-center gap-1.5 border-b px-2 py-1.5 text-[12.5px]" style={{ borderColor: "var(--border)" }}>
			<GitBranch size={13} style={{ color: "var(--highlight)" }} />
			<span className="min-w-0 truncate font-medium" title={status.root}>
				{status.branch ?? (status.headSha ? `detached at ${status.headSha.slice(0, 7)}` : "no commits yet")}
			</span>
			{status.upstream && (status.ahead > 0 || status.behind > 0) && (
				<span className="flex shrink-0 items-center gap-0.5 text-[11.5px]" style={{ color: "var(--muted)" }} title={`Compared with ${status.upstream}`}>
					{status.ahead > 0 && (
						<>
							<ArrowUp size={11} />
							{status.ahead}
						</>
					)}
					{status.behind > 0 && (
						<>
							<ArrowDown size={11} />
							{status.behind}
						</>
					)}
				</span>
			)}
			<span className="ml-auto flex items-center gap-1 text-[11.5px]" style={{ color: "var(--muted)" }}>
				{busy && (
					<>
						<Loader2 size={12} className="animate-spin" /> {busy}…
					</>
				)}
			</span>
			<button type="button" className="gy-icon-btn" title="Refresh" aria-label="Refresh" onClick={onRefresh}>
				<RefreshCw size={13} />
			</button>
		</div>
	);
}

interface FileAction {
	label: string;
	icon: typeof Plus;
	run(files: GitFile[]): void;
}

function FileGroup({
	title,
	side,
	files,
	selection,
	onSelect,
	actions,
}: {
	title: string;
	side: GitSide;
	files: GitFile[];
	selection: Selection | null;
	onSelect(selection: Selection): void;
	actions: FileAction[];
}) {
	if (!files.length) return null;
	return (
		<div className="mt-2">
			<div className="flex items-center gap-1 px-1 py-0.5">
				<span className="gy-label">
					{title} · {files.length}
				</span>
				<span className="ml-auto flex gap-0.5">
					{actions.map(action => (
						<button
							key={action.label}
							type="button"
							className="gy-icon-btn"
							title={`${action.label} all`}
							aria-label={`${action.label} all ${title.toLowerCase()}`}
							onClick={() => action.run(files)}
						>
							<action.icon size={13} />
						</button>
					))}
				</span>
			</div>
			{files.map(file => {
				const selected = selection?.path === file.path && selection.side === side;
				const code = statusCode(file, side);
				const info = codeInfo(code);
				const { name, dir } = splitPath(file.path);
				const counts = countLabel(side === "staged" ? file.staged : file.unstaged);
				return (
					<div
						key={file.path}
						className="group flex items-center gap-1 rounded px-1"
						style={{ background: selected ? "var(--panel-3)" : "transparent" }}
					>
						<button
							type="button"
							className="flex min-w-0 flex-1 items-center gap-1.5 py-[3px] text-left text-[12.5px]"
							style={{ color: selected ? "var(--text)" : "var(--text-dim)" }}
							title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
							onClick={() => onSelect({ path: file.path, side })}
						>
							<span className="w-3 shrink-0 text-center font-mono text-[11px] font-semibold" style={{ color: info.color }} title={info.label}>
								{code}
							</span>
							<span className="truncate">{name}</span>
							{dir && (
								<span className="min-w-0 truncate text-[11px]" style={{ color: "var(--muted)" }}>
									{dir}
								</span>
							)}
							{counts && (
								<span className="ml-auto shrink-0 pl-1 font-mono text-[10.5px]" style={{ color: "var(--muted)" }}>
									{counts}
								</span>
							)}
						</button>
						<span className="flex shrink-0 gap-0.5 opacity-60 group-hover:opacity-100">
							{actions.map(action => (
								<button
									key={action.label}
									type="button"
									className="gy-icon-btn"
									title={action.label}
									aria-label={`${action.label} ${file.path}`}
									onClick={() => action.run([file])}
								>
									<action.icon size={12} />
								</button>
							))}
						</span>
					</div>
				);
			})}
		</div>
	);
}

function CommitComposer({
	projectId,
	stagedCount,
	hasHead,
	busy,
	run,
}: {
	projectId: string;
	stagedCount: number;
	hasHead: boolean;
	busy: string | null;
	run(label: string, work: () => Promise<unknown>): Promise<void>;
}) {
	const [message, setMessage] = useState("");
	const [amend, setAmend] = useState(false);
	const [generating, setGenerating] = useState(false);
	const [notice, setNotice] = useState<{ tone: "warn" | "err"; text: string } | null>(null);
	// Bumped on every change to the draft, so a slow response never overwrites newer text.
	const draftVersion = useRef(0);
	const setDraft = (text: string) => {
		draftVersion.current++;
		setMessage(text);
	};
	const canCommit = message.trim() !== "" && (stagedCount > 0 || amend) && busy === null && !generating;

	const toggleAmend = async (on: boolean) => {
		setAmend(on);
		if (on && !message.trim()) {
			const version = draftVersion.current;
			try {
				const last = (await api<{ message: string }>(gitPath(projectId, "last-message"))).message;
				if (draftVersion.current === version) setDraft(last);
			} catch {}
		}
	};

	const generate = async () => {
		setGenerating(true);
		setNotice(null);
		const version = draftVersion.current;
		try {
			const result = await post<{ message: string; validationError: string | null }>(projectId, "generate-message", {});
			if (draftVersion.current !== version) return;
			setDraft(result.message);
			if (result.validationError) setNotice({ tone: "warn", text: `Check the message: ${result.validationError}` });
		} catch (error) {
			setNotice({ tone: "err", text: (error as Error).message });
		} finally {
			setGenerating(false);
		}
	};

	const commit = () => {
		const submitted = message;
		const version = draftVersion.current;
		return run(amend ? "Amending" : "Committing", async () => {
			await post(projectId, "commit", { message: submitted, amend });
			// Text typed while the commit ran is a new draft: keep it.
			if (draftVersion.current !== version) return;
			setDraft("");
			setAmend(false);
			setNotice(null);
		});
	};

	return (
		<div className="flex flex-col gap-1.5 border-t p-2" style={{ borderColor: "var(--border)" }}>
			<textarea
				className="gy-input min-h-[64px] resize-y py-1 font-mono text-[12px]"
				placeholder={stagedCount ? `Commit message (${stagedCount} staged)` : "Stage changes to commit"}
				aria-label="Commit message"
				value={message}
				onChange={e => setDraft(e.target.value)}
				onKeyDown={e => {
					if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && canCommit) {
						e.preventDefault();
						void commit();
					}
				}}
				rows={3}
			/>
			{notice && (
				<div className="text-[11.5px]" style={{ color: `var(--${notice.tone})` }} role={notice.tone === "err" ? "alert" : undefined}>
					{notice.text}
				</div>
			)}
			<div className="flex items-center gap-1.5">
				<label className="flex items-center gap-1 text-[12px]" style={{ color: "var(--text-dim)" }} title={hasHead ? "Replace the last commit" : "No commit to amend yet"}>
					<input type="checkbox" checked={amend} disabled={!hasHead} onChange={e => void toggleAmend(e.target.checked)} />
					Amend
				</label>
				<button
					type="button"
					className="gy-btn ml-auto"
					title="Write a message for the staged changes with omp's commit model"
					disabled={stagedCount === 0 || generating || busy !== null}
					onClick={() => void generate()}
				>
					{generating ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />} Generate
				</button>
				<button type="button" className="gy-btn primary" disabled={!canCommit} onClick={() => void commit()} title="Commit (Ctrl+Enter)">
					<GitCommitHorizontal size={12} /> {amend ? "Amend" : "Commit"}
				</button>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

interface HunkAction {
	action: GitHunkAction;
	label: string;
	icon: typeof Plus;
}

function DiffArea({
	modelKey,
	projectId,
	path,
	staged,
	revision,
	nonce,
	narrow,
	hunkActions,
	onHunk,
	disabled,
}: {
	modelKey: string;
	projectId: string;
	path: string;
	staged: boolean;
	revision?: string;
	nonce: number;
	narrow: boolean;
	hunkActions: HunkAction[];
	onHunk?(action: GitHunkAction, hunk: GitHunk): void;
	disabled?: boolean;
}) {
	const [diff, setDiff] = useState<GitDiff | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [reveal, setReveal] = useState<DiffReveal | undefined>();

	useEffect(() => {
		let current = true;
		const query: Record<string, string> = { path, staged: staged ? "1" : "0" };
		if (revision) query.rev = revision;
		void api<GitDiff>(gitPath(projectId, "diff", query))
			.then(next => {
				if (!current) return;
				setDiff(next);
				setError(null);
			})
			.catch(e => {
				if (current) setError((e as Error).message);
			});
		return () => {
			current = false;
		};
	}, [projectId, path, staged, revision, nonce]);

	if (error) return <Message tone="err">{error}</Message>;
	if (!diff) return <Loader2 size={14} className="m-3 animate-spin" />;

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex items-center gap-2 border-b px-2 py-1 text-[12px]" style={{ borderColor: "var(--border)" }}>
				<span className="min-w-0 truncate font-mono" title={path}>
					{diff.oldPath !== diff.path ? `${diff.oldPath} → ${diff.path}` : diff.path}
				</span>
				<span className="gy-label shrink-0">{revision ? revision.slice(0, 7) : staged ? "staged" : "unstaged"}</span>
			</div>
			{diff.hunks.length > 1 || (diff.hunks.length === 1 && hunkActions.length > 0) ? (
				<div className="max-h-28 shrink-0 overflow-auto border-b px-1 py-0.5" style={{ borderColor: "var(--border)" }}>
					{diff.hunks.map((hunk, index) => (
						<div key={`${index}:${hunk.header}`} className="flex items-center gap-1">
							<button
								type="button"
								className="min-w-0 flex-1 truncate py-[2px] text-left font-mono text-[11px]"
								style={{ color: "var(--text-dim)" }}
								title="Show this hunk"
								onClick={() => setReveal({ line: hunkNewStart(hunk.header), nonce: Date.now() })}
							>
								{hunk.header}
							</button>
							{hunk.id &&
								hunkActions.map(action => (
									<button
										key={action.action}
										type="button"
										className="gy-btn ghost"
										style={{ height: 20 }}
										disabled={disabled}
										aria-label={`${action.label} hunk ${hunk.header}`}
										onClick={() => onHunk?.(action.action, hunk)}
									>
										<action.icon size={11} /> {action.label}
									</button>
								))}
						</div>
					))}
				</div>
			) : null}
			<div className="min-h-0 flex-1">
				{diff.binary ? (
					<Message>Binary file. No text diff.</Message>
				) : diff.truncated ? (
					<Message>
						This file is too large to show here.
						{diff.hunks.length > 0 && " The hunk list above still works."}
					</Message>
				) : (
					<Suspense fallback={<Loader2 size={14} className="m-3 animate-spin" />}>
						<MonacoDiffViewer modelKey={modelKey} path={diff.path} oldText={diff.oldText} newText={diff.newText} inline={narrow} reveal={reveal} />
					</Suspense>
				)}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Pinned commit
// ---------------------------------------------------------------------------

function CommitView({ pane, projectId, revision }: { pane: PaneSpec; projectId: string; revision: string }) {
	const [rootRef, narrow] = useNarrow();
	const [info, setInfo] = useState<GitCommitInfo | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<string | null>(null);

	useEffect(() => {
		let current = true;
		setInfo(null);
		setError(null);
		void api<GitCommitInfo>(gitPath(projectId, "commit", { rev: revision }))
			.then(next => {
				if (!current) return;
				setInfo(next);
				setSelected(next.files[0]?.path ?? null);
			})
			.catch(e => {
				if (current) setError((e as Error).message);
			});
		return () => {
			current = false;
		};
	}, [projectId, revision]);

	if (error) return <Message tone="err">{error}</Message>;
	if (!info) return <Loader2 size={14} className="m-3 animate-spin" />;

	return (
		<div ref={rootRef} className={`flex h-full min-h-0 ${narrow ? "flex-col" : ""}`}>
			<aside className={`flex min-h-0 shrink-0 flex-col ${narrow ? "max-h-[50%] border-b" : "w-72 border-r"}`} style={{ borderColor: "var(--border)" }}>
				<div className="border-b px-2 py-1.5" style={{ borderColor: "var(--border)" }}>
					<div className="flex items-center gap-1.5 text-[12.5px] font-medium">
						<GitCommitHorizontal size={13} style={{ color: "var(--highlight)" }} />
						<span className="font-mono">{info.sha.slice(0, 10)}</span>
						{info.parents.length > 1 && <span className="gy-label">merge · vs first parent</span>}
					</div>
					<div className="mt-1 text-[12.5px]">{info.subject}</div>
					{info.body && (
						<pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap text-[11.5px]" style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
							{info.body}
						</pre>
					)}
					<div className="mt-1 text-[11.5px]" style={{ color: "var(--muted)" }}>
						{info.author} · {new Date(info.date).toLocaleString()}
					</div>
				</div>
				<div className="min-h-0 flex-1 overflow-auto p-1">
					{info.files.length === 0 && <Message>No file changes.</Message>}
					{info.files.map(file => {
						const { name, dir } = splitPath(file.path);
						const code = codeInfo(file.status);
						const isSelected = file.path === selected;
						return (
							<button
								key={file.path}
								type="button"
								className="flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-[3px] text-left text-[12.5px]"
								style={{ background: isSelected ? "var(--panel-3)" : "transparent", color: isSelected ? "var(--text)" : "var(--text-dim)" }}
								title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
								onClick={() => setSelected(file.path)}
							>
								<span className="w-3 shrink-0 text-center font-mono text-[11px] font-semibold" style={{ color: code.color }} title={code.label}>
									{file.status}
								</span>
								<span className="truncate">{name}</span>
								{dir && (
									<span className="min-w-0 truncate text-[11px]" style={{ color: "var(--muted)" }}>
										{dir}
									</span>
								)}
								{file.added !== undefined && (
									<span className="ml-auto shrink-0 pl-1 font-mono text-[10.5px]" style={{ color: "var(--muted)" }}>
										+{file.added} −{file.removed ?? 0}
									</span>
								)}
							</button>
						);
					})}
				</div>
			</aside>
			<section className="flex min-h-0 min-w-0 flex-1 flex-col">
				{selected ? (
					<DiffArea
						key={selected}
						modelKey={pane.id}
						projectId={projectId}
						path={selected}
						staged={false}
						revision={info.sha}
						nonce={0}
						narrow={narrow}
						hunkActions={[]}
					/>
				) : null}
			</section>
		</div>
	);
}

