import * as Dialog from "@radix-ui/react-dialog";
import { FolderGit2 } from "lucide-react";
import { useState } from "react";
import { useApp } from "../store/app";

export function AddProjectDialog() {
	const { addProjectOpen, setAddProjectOpen, addProject, addPane, projects } = useApp();
	const [path, setPath] = useState("");
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const submit = async () => {
		setBusy(true);
		setError(null);
		try {
			const project = await addProject(path.trim(), name.trim() || undefined);
			setAddProjectOpen(false);
			setPath("");
			setName("");
			const ws = useApp.getState().activeWorkspace();
			if (!ws?.layout) addPane({ kind: "chat", projectId: project.id });
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog.Root open={addProjectOpen} onOpenChange={setAddProjectOpen}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-40" style={{ background: "rgb(0 0 0 / 0.4)" }} />
				<Dialog.Content
					aria-describedby={undefined}
					className="fixed left-1/2 top-[18vh] z-50 w-[min(520px,92vw)] -translate-x-1/2 space-y-4 rounded-xl border p-5"
					style={{ background: "var(--panel)", borderColor: "var(--border-strong)", boxShadow: "var(--shadow)" }}
				>
					<Dialog.Title className="flex items-center gap-2 text-[15px] font-semibold">
						<FolderGit2 size={16} style={{ color: "var(--highlight)" }} />
						{projects.length === 0 ? "Welcome to Gyre — add your first project" : "Add a project"}
					</Dialog.Title>
					<p className="text-[12.5px]" style={{ color: "var(--muted)" }}>
						A project is a folder on this machine. Chats, terminals and the file viewer run inside it.
					</p>
					<form
						className="space-y-3"
						onSubmit={e => {
							e.preventDefault();
							void submit();
						}}
					>
						<label className="block space-y-1">
							<span className="gy-label">folder path</span>
							<input autoFocus className="gy-input w-full font-mono" placeholder="~/workspace/my-app" value={path} onChange={e => setPath(e.target.value)} />
						</label>
						<label className="block space-y-1">
							<span className="gy-label">name (optional)</span>
							<input className="gy-input w-full" placeholder="defaults to the folder name" value={name} onChange={e => setName(e.target.value)} />
						</label>
						{error && <div className="text-[12.5px]" style={{ color: "var(--err)" }}>{error}</div>}
						<div className="flex justify-end gap-2">
							{projects.length > 0 && (
								<button type="button" className="gy-btn" onClick={() => setAddProjectOpen(false)}>
									Cancel
								</button>
							)}
							<button type="submit" className="gy-btn primary" disabled={!path.trim() || busy}>
								Add project
							</button>
						</div>
					</form>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
