import type { FsEntry, FsFile, FsWriteResult, PaneSpec } from "@gyre/protocol";
import { ChevronDown, ChevronRight, File, FilePlus, Folder, Loader2, Save } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { api, GatewayError } from "../lib/gateway";
import { keptFileDrafts, navigateFilePane, unsavedPanes } from "../store/actions";
import { useApp } from "../store/app";

const MonacoViewer = lazy(() => import("./MonacoViewer"));
const MonacoDiffViewer = lazy(() => import("./MonacoDiffViewer"));

function TreeNode({
	projectId,
	entry,
	depth,
	selected,
	onOpen,
}: {
	projectId: string;
	entry: FsEntry;
	depth: number;
	selected?: string;
	onOpen: (path: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [retry, setRetry] = useState(0);
	const [children, setChildren] = useState<FsEntry[] | null>(null);
	useEffect(() => {
		let current = true;
		if (open && entry.kind === "dir" && children === null) {
			setError(null);
			void api<FsEntry[]>(`/api/fs/list?projectId=${projectId}&path=${encodeURIComponent(entry.path)}`)
				.then(rows => {
					if (current) setChildren(rows);
				})
				.catch(e => {
					if (current) setError((e as Error).message);
				});
		}
		return () => {
			current = false;
		};
	}, [open, entry.kind, entry.path, projectId, children, retry]);
	const isSelected = selected === entry.path;
	return (
		<div>
			<button
				type="button"
				onClick={() => (entry.kind === "dir" ? setOpen(o => !o) : onOpen(entry.path))}
				className="flex w-full items-center gap-1 rounded px-1 py-[3px] text-left text-[12.5px]"
				style={{
					paddingLeft: 4 + depth * 12,
					background: isSelected ? "var(--panel-3)" : "transparent",
					color: isSelected ? "var(--text)" : "var(--text-dim)",
				}}
			>
				{entry.kind === "dir" ? open ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : <span className="w-3" />}
				{entry.kind === "dir" ? <Folder size={13} style={{ color: "var(--highlight)" }} /> : <File size={13} style={{ color: "var(--muted)" }} />}
				<span className="truncate">{entry.name}</span>
			</button>
			{open && error && (
				<div className="px-3 text-[12px]" role="alert">
					{error} <button type="button" className="gy-btn" onClick={() => setRetry(n => n + 1)}>Retry</button>
				</div>
			)}
			{open && children?.map(child => <TreeNode key={child.path} projectId={projectId} entry={child} depth={depth + 1} selected={selected} onOpen={onOpen} />)}
		</div>
	);
}

/** The file changed on disk (or appeared/vanished) since it was opened. */
interface Conflict {
	currentVersion: string | null;
	/** What is on disk now, for the diff; null when the file is gone. */
	disk: string | null;
	showDiff: boolean;
}

const readFile = (projectId: string, path: string) => api<FsFile>(`/api/fs/read?projectId=${projectId}&path=${encodeURIComponent(path)}`);

export function FilePane({ pane }: { pane: PaneSpec }) {
	const [root, setRoot] = useState<FsEntry[] | null>(null);
	const [treeKey, setTreeKey] = useState(0);
	const [file, setFile] = useState<FsFile | null>(null);
	/** Unsaved text; null when the buffer matches the file. */
	const [draft, setDraft] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [conflict, setConflict] = useState<Conflict | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [readError, setReadError] = useState<string | null>(null);
	const projectId = pane.projectId;
	const draftRef = useRef(draft);
	draftRef.current = draft;
	const fileRef = useRef(file);
	fileRef.current = file;
	/** The editor's text right now, whether or not it matches the saved file. */
	const bufferRef = useRef<string | null>(null);
	/**
	 * Bumped when the pane switches to another project or file: a save, conflict read or
	 * reload that finishes after that belongs to the old selection and is not applied.
	 */
	const selection = useRef(0);
	/** Counts edits in the editor, so a reload never lands over text typed while it ran. */
	const edits = useRef(0);
	/** The text an in-flight save is writing; null when no save runs. */
	const inFlightSave = useRef<string | null>(null);

	useEffect(() => {
		if (!projectId) return;
		let current = true;
		setError(null);
		void api<FsEntry[]>(`/api/fs/list?projectId=${projectId}&path=`)
			.then(rows => {
				if (current) setRoot(rows);
			})
			.catch(e => {
				if (current) setError(String(e.message));
			});
		return () => {
			current = false;
		};
	}, [projectId, treeKey]);

	useEffect(() => {
		if (!projectId || !pane.filePath) return;
		let current = true;
		selection.current++;
		setConflict(null);
		setSaveError(null);
		setReadError(null);
		// Edits kept while the pane was hidden in a background workspace come back as they
		// were, still based on the version they were made against.
		const kept = keptFileDrafts.get(pane.id);
		keptFileDrafts.delete(pane.id);
		if (kept && kept.projectId === projectId && kept.file.path === pane.filePath) {
			setFile(kept.file);
			setDraft(kept.draft);
			bufferRef.current = kept.draft;
			return;
		}
		setFile(null);
		setDraft(null);
		bufferRef.current = null;
		void readFile(projectId, pane.filePath)
			.then(file => {
				if (!current) return;
				setFile(file);
				bufferRef.current = file.content;
			})
			.catch(e => {
				if (current) setReadError(String(e.message));
			});
		return () => {
			current = false;
		};
	}, [projectId, pane.filePath]);

	// Closing the pane or the page asks first while edits are unsaved, or while a save runs:
	// until it lands, the editor's text may differ from what ends up on disk.
	useEffect(() => {
		if ((draft === null && !saving) || !file) {
			unsavedPanes.delete(pane.id);
			return;
		}
		unsavedPanes.set(pane.id, file.path);
		const warn = (event: BeforeUnloadEvent) => event.preventDefault();
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [draft, file, saving, pane.id]);
	// Unmounting (its workspace switched away) keeps unsaved edits for when it is shown again;
	// the pane stays registered as unsaved, so closing it from elsewhere still asks. A pane that
	// was closed is gone from every workspace, and its edits go with it.
	useEffect(
		() => () => {
			const file = fileRef.current;
			const exists = useApp.getState().workspaces.some(ws => ws.panes[pane.id]);
			// While a save runs, whether it lands is unknown, so the editor's text is kept even if
			// it matches the file as opened; the save drops the copy if it wrote that same text.
			const draft = inFlightSave.current !== null ? (bufferRef.current ?? draftRef.current) : draftRef.current;
			if (exists && draft !== null && file && projectId) {
				keptFileDrafts.set(pane.id, { projectId, file, draft });
				unsavedPanes.set(pane.id, file.path);
			} else unsavedPanes.delete(pane.id);
		},
		[pane.id, projectId],
	);

	const editable = !!file && !file.binary && !file.truncated && !!file.version;

	const save = useCallback(
		async (baseVersion?: string | null) => {
			if (!projectId || !file || draftRef.current === null || saving) return;
			const content = draftRef.current;
			const owner = selection.current;
			const owns = () => owner === selection.current;
			setSaving(true);
			setSaveError(null);
			inFlightSave.current = content;
			try {
				const result = await api<FsWriteResult>("/api/fs/write", {
					method: "PUT",
					body: JSON.stringify({ projectId, path: file.path, content, baseVersion: baseVersion === undefined ? file.version : baseVersion }),
				});
				// Unmounted meanwhile with exactly this text kept: it is saved now.
				const kept = keptFileDrafts.get(pane.id);
				if (kept && kept.file.path === file.path && kept.file.version === file.version && kept.draft === content) {
					keptFileDrafts.delete(pane.id);
					unsavedPanes.delete(pane.id);
				}
				if (!owns()) return;
				setFile({ ...file, content, version: result.version, size: result.size });
				// Whatever the editor holds now stays as typed: newer text, or even the text from
				// before this save, is unsaved relative to what was just written.
				const now = bufferRef.current ?? content;
				setDraft(now === content ? null : now);
				setConflict(null);
			} catch (e) {
				if (!owns()) return;
				if (e instanceof GatewayError && e.status === 412) {
					const disk = await readFile(projectId, file.path).catch(() => null);
					if (owns()) setConflict({ currentVersion: disk?.version ?? null, disk: disk?.content ?? null, showDiff: false });
				} else setSaveError((e as Error).message);
			} finally {
				inFlightSave.current = null;
				setSaving(false);
			}
		},
		[projectId, file, saving, pane.id],
	);

	const reload = async () => {
		if (!projectId || !file) return;
		const owner = selection.current;
		const editsAtStart = edits.current;
		try {
			const fresh = await readFile(projectId, file.path);
			// Another file, or text typed since the click: that text is not discarded unseen.
			if (owner !== selection.current || editsAtStart !== edits.current) return;
			setFile(fresh);
			setDraft(null);
			bufferRef.current = fresh.content;
			setConflict(null);
		} catch (e) {
			if (owner === selection.current) setReadError((e as Error).message);
		}
	};

	const openPath = (path: string) => {
		navigateFilePane(pane, path);
	};

	const newFile = async () => {
		if (!projectId) return;
		const dir = pane.filePath?.includes("/") ? `${pane.filePath.slice(0, pane.filePath.lastIndexOf("/"))}/` : "";
		const path = prompt("New file (path relative to the project):", dir)?.trim().replace(/^\/+/, "");
		if (!path || path.endsWith("/")) return;
		try {
			await api<FsWriteResult>("/api/fs/write", { method: "PUT", body: JSON.stringify({ projectId, path, content: "", baseVersion: null }) });
			setTreeKey(k => k + 1);
			openPath(path);
		} catch (e) {
			alert(`Could not create ${path}: ${(e as Error).message}`);
		}
	};

	if (!projectId) return <div className="p-4">No project selected.</div>;

	return (
		<div className="flex h-full min-h-0">
			<div className="flex w-60 shrink-0 flex-col border-r" style={{ borderColor: "var(--border)" }}>
				<div className="flex items-center justify-end px-1 pt-1">
					<button type="button" className="gy-btn" title="New file" aria-label="New file" onClick={() => void newFile()}>
						<FilePlus size={13} />
					</button>
				</div>
				<div className="min-h-0 flex-1 overflow-auto p-1" key={treeKey}>
					{root === null && !error && <Loader2 size={14} className="m-2 animate-spin" />}
					{root?.map(entry => (
						<TreeNode key={entry.path} projectId={projectId} entry={entry} depth={0} selected={pane.filePath} onOpen={openPath} />
					))}
				</div>
			</div>
			<div className="flex min-w-0 flex-1 flex-col">
				{(error || readError) && (
					<div className="p-3 text-[12px]" style={{ color: "var(--err)" }}>
						{error || readError}
					</div>
				)}
				{!pane.filePath && !error && (
					<div className="flex h-full items-center justify-center text-[12.5px]" style={{ color: "var(--muted)" }}>
						Pick a file to view or edit it.
					</div>
				)}
				{pane.filePath && !file && !error && !readError && <Loader2 size={14} className="m-3 animate-spin" />}
				{file && (
					<div className="flex shrink-0 items-center gap-2 border-b px-2 py-1 text-[12px]" style={{ borderColor: "var(--border)" }} data-file-bar>
						<span className="min-w-0 flex-1 truncate font-mono" style={{ color: "var(--text-dim)" }}>
							{file.path}
							{draft !== null && (
								<span title="Unsaved changes" style={{ color: "var(--highlight)" }} data-unsaved>
									{" "}
									●
								</span>
							)}
						</span>
						{file.truncated && <span style={{ color: "var(--muted)" }}>Too large to edit; showing the first 2 MB.</span>}
						{!file.truncated && !file.binary && !editable && <span style={{ color: "var(--muted)" }}>Read-only</span>}
						{saveError && (
							<span role="alert" style={{ color: "var(--err)" }}>
								{saveError}
							</span>
						)}
						{editable && (
							<button type="button" className="gy-btn" disabled={draft === null || saving} onClick={() => void save()} title="Save (Ctrl+S)">
								{saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Save
							</button>
						)}
					</div>
				)}
				{conflict && (
					<div className="flex shrink-0 flex-wrap items-center gap-2 px-2 py-1 text-[12px]" role="alert" style={{ background: "var(--panel-3)" }} data-file-conflict>
						<span className="flex-1">
							{conflict.disk === null ? "The file was deleted or created elsewhere since you opened it." : "The file changed on disk since you opened it."}
						</span>
						<button type="button" className="gy-btn" onClick={() => void reload()}>
							Reload (discard mine)
						</button>
						<button type="button" className="gy-btn" onClick={() => void save(conflict.currentVersion)}>
							Overwrite
						</button>
						{conflict.disk !== null && (
							<button type="button" className="gy-btn" onClick={() => setConflict({ ...conflict, showDiff: !conflict.showDiff })}>
								{conflict.showDiff ? "Hide diff" : "Show diff"}
							</button>
						)}
					</div>
				)}
				{file?.binary && (
					<div className="p-4 text-[12.5px]" style={{ color: "var(--muted)" }}>
						Binary file — not shown.
					</div>
				)}
				{file && !file.binary && (
					<div className="min-h-0 flex-1">
						<Suspense fallback={<Loader2 size={14} className="m-3 animate-spin" />}>
							{conflict?.showDiff && conflict.disk !== null ? (
								<MonacoDiffViewer modelKey={`file-${pane.id}`} path={file.path} oldText={conflict.disk} newText={draft ?? file.content} inline={false} />
							) : (
								<MonacoViewer
									modelKey={`file-${pane.id}`}
									path={file.path}
									content={draft ?? file.content}
									readOnly={!editable}
									onChange={value => {
										edits.current++;
										bufferRef.current = value;
										setDraft(value === file.content ? null : value);
									}}
									onSave={() => void save()}
								/>
							)}
						</Suspense>
					</div>
				)}
			</div>
		</div>
	);
}
