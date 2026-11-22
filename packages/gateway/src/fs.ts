/** Read-only, project-scoped file access for the file viewer pane. */
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { BrowseEntry, BrowseListing, FsEntry } from "@gyre/protocol";
import { closeSync, existsSync, fstatSync, readSync } from "node:fs";
import { isContained, openContained } from "./contained-file";

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
	let realRoot: string;
	try {
		realRoot = await realpath(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new FsAccessError("project directory not found", 404);
		throw error;
	}
	const candidate = resolve(realRoot, relPath || ".");
	let real: string;
	try {
		real = await realpath(candidate);
	} catch {
		throw new FsAccessError("not found", 404);
	}
	if (!isContained(realRoot, real)) throw new FsAccessError("path escapes project", 403);
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
				const target = await resolveInside(realRoot, relative(realRoot, abs));
				const fd = openContained(realRoot, target);
				try {
					const info = fstatSync(fd);
					kind = info.isDirectory() ? "dir" : "file";
					size = info.size;
				} finally {
					closeSync(fd);
				}
			} catch {
				continue;
			}
		}
		result.push({ name: entry.name, path: relative(realRoot, abs), kind, size });
	}
	result.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
	return result;
}

export async function readText(root: string, relPath: string): Promise<{ path: string; content: string; truncated: boolean; binary: boolean; size: number }> {
	const abs = await resolveInside(root, relPath);
	const realRoot = await realpath(root);
	let fd: number;
	try {
		fd = openContained(realRoot, abs);
	} catch {
		throw new FsAccessError("file changed or escapes project", 403);
	}
	try {
		const info = fstatSync(fd);
		if (!info.isFile()) throw new FsAccessError("not a file", 400);
		const buffer = Buffer.alloc(Math.min(info.size, MAX_READ_BYTES));
		let length = 0;
		while (length < buffer.length) {
			const n = readSync(fd, buffer, length, buffer.length - length, null);
			if (!n) break;
			length += n;
		}
		const bytes = buffer.subarray(0, length);
		const binary = bytes.subarray(0, 8000).includes(0);
		return {
			path: relPath,
			content: binary ? "" : new TextDecoder().decode(bytes),
			truncated: info.size > MAX_READ_BYTES,
			binary,
			size: info.size,
		};
	} finally {
		closeSync(fd);
	}
}

const MAX_BROWSE_ENTRIES = 2000;

/** Expand a leading `~` to the home directory. */
export function expandHome(path: string, home = homedir()): string {
	return path.replace(/^~(?=\/|$)/, home);
}

/**
 * Directories under an absolute path, for the "add project" folder browser. Unlike the
 * project-scoped calls above this may look anywhere the gateway user can read: anyone
 * holding the gateway token can already open a shell, so it grants nothing new.
 */
export async function browseDirs(path: string | null, showHidden = false): Promise<BrowseListing> {
	const home = homedir();
	const requested = expandHome(path?.trim() || home, home);
	if (!isAbsolute(requested)) throw new FsAccessError("path must be absolute (or start with ~)", 400);
	let dir: string;
	try {
		dir = await realpath(resolve(requested));
		if (!(await stat(dir)).isDirectory()) throw new FsAccessError(`not a directory: ${requested}`, 400);
	} catch (error) {
		if (error instanceof FsAccessError) throw error;
		throw new FsAccessError(`not found: ${requested}`, 404);
	}
	let dirents: import("node:fs").Dirent[];
	try {
		dirents = await readdir(dir, { withFileTypes: true });
	} catch {
		throw new FsAccessError(`cannot read ${dir}`, 403);
	}
	const entries: BrowseEntry[] = [];
	for (const entry of dirents) {
		if (!showHidden && (entry.name.startsWith(".") || HIDDEN_DIRS.has(entry.name))) continue;
		const abs = join(dir, entry.name);
		let isDir = entry.isDirectory();
		if (entry.isSymbolicLink()) isDir = await stat(abs).then(info => info.isDirectory()).catch(() => false);
		if (!isDir) continue;
		entries.push({ name: entry.name, path: abs, isGitRepo: existsSync(join(abs, ".git")) });
		if (entries.length >= MAX_BROWSE_ENTRIES) break;
	}
	entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
	const parent = dirname(dir);
	return { path: dir, parent: parent === dir ? null : parent, home, entries };
}
