/** Read-only, project-scoped file access for the file viewer pane. */
import { readdir, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { FsEntry } from "@gyre/protocol";

const MAX_READ_BYTES = 2 * 1024 * 1024;
const HIDDEN_DIRS = new Set([".git", "node_modules", ".venv", "__pycache__", "target", "dist", ".next"]);

export class FsAccessError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

/** Resolve `relPath` inside `root`, rejecting traversal and symlink escapes. */
export async function resolveInside(root: string, relPath: string): Promise<string> {
	const realRoot = await realpath(root);
	const candidate = resolve(realRoot, relPath || ".");
	let real: string;
	try {
		real = await realpath(candidate);
	} catch {
		throw new FsAccessError("not found", 404);
	}
	if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new FsAccessError("path escapes project", 403);
	return real;
}

export async function listDir(root: string, relPath: string, showHidden = false): Promise<FsEntry[]> {
	const dir = await resolveInside(root, relPath);
	const realRoot = await realpath(root);
	const entries = await readdir(dir, { withFileTypes: true });
	const result: FsEntry[] = [];
	for (const entry of entries) {
		if (!showHidden && entry.isDirectory() && HIDDEN_DIRS.has(entry.name)) continue;
		const abs = join(dir, entry.name);
		let kind: FsEntry["kind"] = entry.isDirectory() ? "dir" : "file";
		let size: number | undefined;
		if (entry.isSymbolicLink()) {
			try {
				const info = await stat(abs);
				kind = info.isDirectory() ? "dir" : "file";
				size = info.size;
			} catch {
				continue;
			}
		}
		result.push({ name: entry.name, path: relative(realRoot, abs), kind, size });
	}
	result.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
	return result;
}

export async function readText(
	root: string,
	relPath: string,
): Promise<{ path: string; content: string; truncated: boolean; binary: boolean; size: number }> {
	const abs = await resolveInside(root, relPath);
	const info = await stat(abs);
	if (!info.isFile()) throw new FsAccessError("not a file", 400);
	const file = Bun.file(abs);
	const bytes = new Uint8Array(await file.slice(0, MAX_READ_BYTES).arrayBuffer());
	const binary = bytes.subarray(0, 8000).includes(0);
	return {
		path: relPath,
		content: binary ? "" : new TextDecoder().decode(bytes),
		truncated: info.size > MAX_READ_BYTES,
		binary,
		size: info.size,
	};
}
