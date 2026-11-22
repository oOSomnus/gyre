/** Product state owned by Gyre (never stored in omp's session files). */
import { Database } from "bun:sqlite";
import type { Project, Workspace } from "@gyre/protocol";

export class WorkspaceConflictError extends Error {}

export class Store {
	readonly db: Database;

	constructor(path: string) {
		this.db = new Database(path, { create: true });
		this.db.exec("PRAGMA journal_mode = WAL;");
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS projects (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				path TEXT NOT NULL UNIQUE,
				created_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS workspaces (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				body TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS kv (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
		`);
	}

	listProjects(): Project[] {
		return this.db
			.query<{ id: string; name: string; path: string; created_at: number }, []>("SELECT id, name, path, created_at FROM projects ORDER BY created_at")
			.all()
			.map(row => ({ id: row.id, name: row.name, path: row.path, createdAt: row.created_at }));
	}

	getProject(id: string): Project | undefined {
		return this.listProjects().find(project => project.id === id);
	}

	addProject(name: string, path: string): Project {
		const existing = this.listProjects().find(project => project.path === path);
		if (existing) return existing;
		const project: Project = { id: crypto.randomUUID(), name, path, createdAt: Date.now() };
		this.db.query("INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)").run(project.id, project.name, project.path, project.createdAt);
		return project;
	}

	renameProject(id: string, name: string): void {
		this.db.query("UPDATE projects SET name = ? WHERE id = ?").run(name, id);
	}

	removeProject(id: string): void {
		this.db.query("DELETE FROM projects WHERE id = ?").run(id);
	}

	listWorkspaces(): Workspace[] {
		return this.db
			.query<{ body: string }, []>("SELECT body FROM workspaces ORDER BY updated_at DESC")
			.all()
			.map(row => {
				const ws = JSON.parse(row.body) as Workspace;
				return { ...ws, revision: ws.revision ?? 0 };
			});
	}

	saveWorkspace(workspace: Workspace): Workspace {
		return this.db.transaction(() => {
			const row = this.db.query<{ body: string }, [string]>("SELECT body FROM workspaces WHERE id = ?").get(workspace.id);
			const current = row ? (JSON.parse(row.body) as Workspace) : undefined;
			if ((workspace.revision ?? 0) !== (current?.revision ?? 0))
				throw new WorkspaceConflictError("Workspace changed in another client. Reloaded the saved layout; your last layout edit was not saved.");
			const saved = { ...workspace, revision: (current?.revision ?? 0) + 1, updatedAt: Date.now() };
			this.db
				.query(
					`INSERT INTO workspaces (id, name, body, updated_at) VALUES (?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET name = excluded.name, body = excluded.body, updated_at = excluded.updated_at`,
				)
				.run(saved.id, saved.name, JSON.stringify(saved), saved.updatedAt);
			return saved;
		})();
	}

	removeWorkspace(id: string): void {
		this.db.query("DELETE FROM workspaces WHERE id = ?").run(id);
	}

	getKv<T>(key: string): T | undefined {
		const row = this.db.query<{ value: string }, [string]>("SELECT value FROM kv WHERE key = ?").get(key);
		return row ? (JSON.parse(row.value) as T) : undefined;
	}

	setKv(key: string, value: unknown): void {
		this.db.query("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
	}

	close(): void {
		this.db.close();
	}
}
