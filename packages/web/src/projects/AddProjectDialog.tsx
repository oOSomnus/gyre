/**
 * Add a project by browsing folders on the gateway machine (works the same in a
 * browser, the desktop app and remote/phone sessions). The path field stays
 * editable, so typing or pasting a path (including `~`) still works.
 */
import type { BrowseListing } from "@gyre/protocol";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowUp, Check, ChevronRight, Eye, EyeOff, Folder, FolderGit2, Home, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/gateway";
import { baseName, crumbs, parentDir } from "../lib/paths";
import { useApp } from "../store/app";

const LAST_DIR_KEY = "gyre.addProject.lastDir";

function readLastDir(): string | undefined {
	try {
		return localStorage.getItem(LAST_DIR_KEY) ?? undefined;
	} catch {
		return undefined;
	}
}

export function AddProjectDialog() {
	const { addProjectOpen, setAddProjectOpen, addProject, addPane, projects } = useApp();
	const [listing, setListing] = useState<BrowseListing | null>(null);
	const [path, setPath] = useState("");
	const [filter, setFilter] = useState("");
	const [hidden, setHidden] = useState(false);
	const [highlight, setHighlight] = useState(0);
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [busy, setBusy] = useState(false);
	const request = useRef(0);
	/** The user typed in the path field; a background listing must not overwrite it. */
	const pathDirty = useRef(false);
	const listRef = useRef<HTMLDivElement>(null);
	const added = useMemo(() => new Set(projects.map(p => p.path)), [projects]);

	/** Open a folder in the browser; resolves false if it could not be listed. */
	const browse = async (target?: string, showHidden = hidden): Promise<boolean> => {
		const id = ++request.current;
		setLoading(true);
		try {
			const query = new URLSearchParams();
			if (target) query.set("path", target);
			if (showHidden) query.set("hidden", "1");
			const next = await api<BrowseListing>(`/api/fs/browse?${query}`);
			if (id !== request.current) return true;
			setListing(next);
			if (!pathDirty.current) setPath(next.path);
			setFilter("");
			setHighlight(0);
			setError(null);
			return true;
		} catch (e) {
			if (id === request.current) setError((e as Error).message);
			return false;
		} finally {
			if (id === request.current) setLoading(false);
		}
	};

	/** Navigate on a user action: the path field follows the opened folder again. */
	const go = (target?: string, showHidden = hidden) => {
		pathDirty.current = false;
		return browse(target, showHidden);
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: load once per opening
	useEffect(() => {
		if (!addProjectOpen) return;
		setName("");
		setError(null);
		pathDirty.current = false;
		const last = readLastDir();
		// The remembered folder may be gone; fall back to home.
		void browse(last).then(ok => {
			if (!ok && last) void browse();
		});
	}, [addProjectOpen]);

	const entries = useMemo(() => {
		const needle = filter.trim().toLowerCase();
		return (listing?.entries ?? []).filter(e => !needle || e.name.toLowerCase().includes(needle));
	}, [listing, filter]);

	useEffect(() => {
		listRef.current?.querySelector(`[data-index="${highlight}"]`)?.scrollIntoView({ block: "nearest" });
	}, [highlight]);

	const target = path.trim();
	const alreadyAdded = listing !== null && target === listing.path && added.has(listing.path);

	const submit = async () => {
		if (!target) return;
		setBusy(true);
		setError(null);
		try {
			const project = await addProject(target, name.trim() || undefined);
			try {
				localStorage.setItem(LAST_DIR_KEY, parentDir(project.path));
			} catch {}
			setAddProjectOpen(false);
			const ws = useApp.getState().activeWorkspace();
			if (!ws?.layout) addPane({ kind: "chat", projectId: project.id });
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	};

	const onListKey = (e: React.KeyboardEvent) => {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setHighlight(h => Math.min(h + 1, Math.max(entries.length - 1, 0)));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setHighlight(h => Math.max(h - 1, 0));
		} else if (e.key === "Enter" && entries[highlight]) {
			e.preventDefault();
			void go(entries[highlight].path);
		} else if (e.key === "Backspace" && !filter && listing?.parent) {
			e.preventDefault();
			void go(listing.parent);
		}
	};

	return (
		<Dialog.Root open={addProjectOpen} onOpenChange={setAddProjectOpen}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-40" style={{ background: "rgb(0 0 0 / 0.4)" }} />
				<Dialog.Content
					aria-describedby={undefined}
					className="fixed left-1/2 top-[8vh] z-50 flex max-h-[84vh] w-[min(680px,94vw)] -translate-x-1/2 flex-col gap-3 rounded-xl border p-5"
					style={{ background: "var(--panel)", borderColor: "var(--border-strong)", boxShadow: "var(--shadow)" }}
				>
					<Dialog.Title className="flex items-center gap-2 text-[15px] font-semibold">
						<FolderGit2 size={16} style={{ color: "var(--highlight)" }} />
						{projects.length === 0 ? "Welcome to Gyre — add your first project" : "Add a project"}
					</Dialog.Title>
					<p className="text-[12.5px]" style={{ color: "var(--muted)" }}>
						A project is a folder on this machine. Chats, terminals and the file viewer run inside it. Browse to the folder, or type its path.
					</p>
					<form
						className="flex min-h-0 flex-1 flex-col gap-3"
						onSubmit={e => {
							e.preventDefault();
							void submit();
						}}
					>
						<div className="flex gap-1.5">
							<input
								className="gy-input min-w-0 flex-1 font-mono"
								placeholder="~/workspace/my-app"
								value={path}
								onChange={e => {
									pathDirty.current = true;
									setPath(e.target.value);
								}}
								onKeyDown={e => {
									// Enter in the path field opens that folder instead of adding it.
									if (e.key === "Enter" && target && target !== listing?.path) {
										e.preventDefault();
										void go(target);
									}
								}}
								aria-label="folder path"
								data-testid="project-path"
							/>
							<button type="button" className="gy-btn" disabled={!target || target === listing?.path} onClick={() => void go(target)}>
								Go
							</button>
						</div>

						<div className="flex flex-wrap items-center gap-1 text-[12px]">
							<button type="button" className="gy-icon-btn" title="Home" onClick={() => void go(listing?.home)}>
								<Home size={13} />
							</button>
							<button type="button" className="gy-icon-btn" title="Up one folder" disabled={!listing?.parent} onClick={() => listing?.parent && void go(listing.parent)}>
								<ArrowUp size={13} />
							</button>
							<div className="flex min-w-0 flex-1 flex-wrap items-center">
								{listing &&
									crumbs(listing.path).map((c, i, all) => (
										<span key={c.path} className="flex items-center">
											{i > 1 && <ChevronRight size={11} style={{ color: "var(--muted)" }} />}
											<button
												type="button"
												className="rounded px-1 font-mono hover:underline"
												style={{ fontWeight: i === all.length - 1 ? 600 : 400 }}
												onClick={() => void go(c.path)}
											>
												{c.label}
											</button>
										</span>
									))}
							</div>
							<button
								type="button"
								className="gy-icon-btn"
								title={hidden ? "Hide hidden folders" : "Show hidden folders"}
								onClick={() => {
									setHidden(!hidden);
									void go(listing?.path, !hidden);
								}}
							>
								{hidden ? <EyeOff size={13} /> : <Eye size={13} />}
							</button>
						</div>

						<input
							className="gy-input w-full"
							placeholder="Filter folders… (↑↓ to move, Enter to open, Backspace for parent)"
							value={filter}
							autoFocus
							onChange={e => {
								setFilter(e.target.value);
								setHighlight(0);
							}}
							onKeyDown={onListKey}
							data-testid="project-filter"
						/>

						<div
							ref={listRef}
							className="min-h-[160px] flex-1 overflow-auto rounded border"
							style={{ borderColor: "var(--border)", maxHeight: "42vh" }}
							data-testid="project-browser"
						>
							{loading && !listing && (
								<div className="gy-row">
									<Loader2 size={14} className="animate-spin" />
								</div>
							)}
							{listing && entries.length === 0 && (
								<div className="gy-row text-[12px]" style={{ color: "var(--muted)" }}>
									{filter ? "No matching folders." : "No subfolders."}
								</div>
							)}
							{entries.map((entry, index) => (
								<button
									type="button"
									key={entry.path}
									data-index={index}
									className="gy-row w-full text-left"
									style={index === highlight ? { background: "var(--tint-tool)" } : undefined}
									onMouseEnter={() => setHighlight(index)}
									onClick={() => void go(entry.path)}
									title={entry.path}
								>
									{entry.isGitRepo ? <FolderGit2 size={14} style={{ color: "var(--highlight)" }} /> : <Folder size={14} style={{ color: "var(--muted)" }} />}
									<span className="min-w-0 flex-1 truncate text-[12.5px]">{entry.name}</span>
									{entry.isGitRepo && <span className="gy-chip">git</span>}
									{added.has(entry.path) && (
										<span className="gy-chip ok">
											<Check size={10} /> added
										</span>
									)}
								</button>
							))}
						</div>

						<label className="block space-y-1">
							<span className="gy-label">name (optional)</span>
							<input className="gy-input w-full" placeholder={target ? baseName(target) : "defaults to the folder name"} value={name} onChange={e => setName(e.target.value)} />
						</label>
						{error && <div className="text-[12.5px]" style={{ color: "var(--err)" }}>{error}</div>}
						<div className="flex items-center justify-end gap-2">
							<span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" style={{ color: "var(--muted)" }}>
								{target}
							</span>
							{projects.length > 0 && (
								<button type="button" className="gy-btn" onClick={() => setAddProjectOpen(false)}>
									Cancel
								</button>
							)}
							<button type="submit" className="gy-btn primary" disabled={!target || busy || alreadyAdded} data-testid="add-project-submit">
								{alreadyAdded ? "Already added" : "Add this folder"}
							</button>
						</div>
					</form>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
