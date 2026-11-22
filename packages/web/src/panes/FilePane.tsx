import type { FsEntry, PaneSpec } from "@gyre/protocol";
import { ChevronDown, ChevronRight, File, Folder, Loader2 } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { api } from "../lib/gateway";
import { useApp } from "../store/app";

const MonacoViewer = lazy(() => import("./MonacoViewer"));

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
	const [children, setChildren] = useState<FsEntry[] | null>(null);
	useEffect(() => {
		if (open && entry.kind === "dir" && children === null) {
			void api<FsEntry[]>(`/api/fs/list?projectId=${projectId}&path=${encodeURIComponent(entry.path)}`)
				.then(setChildren)
				.catch(() => setChildren([]));
		}
	}, [open, entry, projectId, children]);
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
			{open && children?.map(child => <TreeNode key={child.path} projectId={projectId} entry={child} depth={depth + 1} selected={selected} onOpen={onOpen} />)}
		</div>
	);
}

export function FilePane({ pane }: { pane: PaneSpec }) {
	const updatePane = useApp(s => s.updatePane);
	const [root, setRoot] = useState<FsEntry[] | null>(null);
	const [file, setFile] = useState<{ path: string; content: string; binary: boolean; truncated: boolean } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [readError, setReadError] = useState<string | null>(null);
	const projectId = pane.projectId;

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
	}, [projectId]);

	useEffect(() => {
		if (!projectId || !pane.filePath) return;
		let current = true;
		setFile(null);
		setReadError(null);
		void api<{ path: string; content: string; binary: boolean; truncated: boolean }>(
			`/api/fs/read?projectId=${projectId}&path=${encodeURIComponent(pane.filePath)}`,
		)
			.then(file => {
				if (current) setFile(file);
			})
			.catch(e => {
				if (current) setReadError(String(e.message));
			});
		return () => {
			current = false;
		};
	}, [projectId, pane.filePath]);

	if (!projectId) return <div className="p-4">No project selected.</div>;

	return (
		<div className="flex h-full min-h-0">
			<div className="w-60 shrink-0 overflow-auto border-r p-1" style={{ borderColor: "var(--border)" }}>
				{root === null && !error && <Loader2 size={14} className="m-2 animate-spin" />}
				{root?.map(entry => (
					<TreeNode
						key={entry.path}
						projectId={projectId}
						entry={entry}
						depth={0}
						selected={pane.filePath}
						onOpen={path => updatePane(pane.id, { filePath: path })}
					/>
				))}
			</div>
			<div className="min-w-0 flex-1">
				{(error || readError) && (
					<div className="p-3 text-[12px]" style={{ color: "var(--err)" }}>
						{error || readError}
					</div>
				)}
				{!pane.filePath && !error && (
					<div className="flex h-full items-center justify-center text-[12.5px]" style={{ color: "var(--muted)" }}>
						Pick a file to view it.
					</div>
				)}
				{pane.filePath && !file && !error && !readError && <Loader2 size={14} className="m-3 animate-spin" />}
				{file?.binary && (
					<div className="p-4 text-[12.5px]" style={{ color: "var(--muted)" }}>
						Binary file — not shown.
					</div>
				)}
				{file && !file.binary && (
					<Suspense fallback={<Loader2 size={14} className="m-3 animate-spin" />}>
						<MonacoViewer path={file.path} content={file.content} />
					</Suspense>
				)}
			</div>
		</div>
	);
}
