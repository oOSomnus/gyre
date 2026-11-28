/** Project-scoped file access for the file pane: list, read, and conditional writes. */
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { BrowseEntry, BrowseListing, FsEntry, FsFile, FsWriteResult } from "@gyre/protocol";
import { closeSync, existsSync, fstatSync, readSync } from "node:fs";
import { isContained, isPlainName, openContained, writeContained } from "./contained-file";

export const MAX_READ_BYTES = 2 * 1024 * 1024;
const HIDDEN_DIRS = new Set([".git", "node_modules", ".venv", "__pycache__", "target", "dist", ".next"]);

export class FsAccessError extends Error {
	constructor(
		message: string,
		readonly status: number,
		/** Extra fields for the JSON error body (e.g. `currentVersion` on a 412). */
		readonly data?: Record<string, unknown>,
	) {
		super(message);
	}
}

/** Content version of a file: the sha256 of its bytes. */
export const contentVersion = (bytes: Uint8Array | string): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

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

interface OpenedFile {
	bytes: Buffer;
	size: number;
	mode: number;
	truncated: boolean;
}

/** Read up to `limit` bytes of a canonical file inside `realRoot` through a contained descriptor. */
function readContained(realRoot: string, abs: string, limit = MAX_READ_BYTES): OpenedFile {
	let fd: number;
	try {
		fd = openContained(realRoot, abs);
	} catch {
		throw new FsAccessError("file changed or escapes project", 403);
	}
	try {
		return readOpened(fd, limit);
	} finally {
		closeSync(fd);
	}
}

/** Read up to `limit` bytes of an open regular file. */
function readOpened(fd: number, limit: number): OpenedFile {
	const info = fstatSync(fd);
	if (!info.isFile()) throw new FsAccessError("not a file", 400);
	const buffer = Buffer.alloc(Math.min(info.size, limit));
	let length = 0;
	while (length < buffer.length) {
		const n = readSync(fd, buffer, length, buffer.length - length, null);
		if (!n) break;
		length += n;
	}
	return { bytes: buffer.subarray(0, length), size: info.size, mode: info.mode & 0o7777, truncated: info.size > limit };
}

export async function readText(root: string, relPath: string): Promise<FsFile> {
	const abs = await resolveInside(root, relPath);
	const file = readContained(await realpath(root), abs);
	const binary = file.bytes.subarray(0, 8000).includes(0);
	return {
		path: relPath,
		content: binary ? "" : new TextDecoder().decode(file.bytes),
		truncated: file.truncated,
		binary,
		size: file.size,
		// Only a file read whole can be saved back; a partial read has no version to match.
		version: file.truncated ? undefined : contentVersion(file.bytes),
	};
}

const writeLocks = new Map<string, Promise<unknown>>();
/**
 * Serialise Gyre's own writes to one file. Other processes (the agent) are not locked out;
 * the commit itself checks the replaced file's version (see `writeContained`).
 */
function withWriteLock<T>(key: string, work: () => Promise<T>): Promise<T> {
	const next = (writeLocks.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
	writeLocks.set(key, next);
	void next.finally(() => {
		if (writeLocks.get(key) === next) writeLocks.delete(key);
	}).catch(() => {});
	return next;
}

/** Throws the 412 (or 413) for a file that is no longer at `baseVersion`. */
function expectVersion(current: OpenedFile | null, baseVersion: string): void {
	if (!current) throw new FsAccessError("file was deleted since it was opened", 412, { currentVersion: null });
	if (current.truncated) throw new FsAccessError("file is too large to save from Gyre", 413);
	const currentVersion = contentVersion(current.bytes);
	if (currentVersion !== baseVersion) throw new FsAccessError("file changed on disk since it was opened", 412, { currentVersion });
}

/**
 * Save `content` to `relPath` inside `root` if the file still has `baseVersion`
 * (from `readText`), or create it when `baseVersion` is null. A changed file is a 412
 * carrying `currentVersion`, so the editor can offer reload, overwrite or a diff.
 * A symlinked file is written at its (contained) target, keeping the link.
 */
export async function writeText(root: string, relPath: string, content: string, baseVersion: string | null): Promise<FsWriteResult> {
	if (typeof content !== "string") throw new FsAccessError("content must be a string", 400);
	const rel = relPath.replace(/^\.\//, "");
	if (!rel || isAbsolute(rel)) throw new FsAccessError("path must be relative to the project", 400);
	const name = basename(rel);
	if (!isPlainName(name)) throw new FsAccessError("invalid file name", 400);
	const bytes = Buffer.from(content, "utf8");
	if (bytes.length > MAX_READ_BYTES) throw new FsAccessError("file is too large to save from Gyre", 413);
	const realRoot = await realpath(root).catch(() => {
		throw new FsAccessError("project directory not found", 404);
	});
	let target: string | undefined;
	try {
		target = await resolveInside(realRoot, rel);
	} catch (error) {
		if (!(error instanceof FsAccessError) || error.status !== 404) throw error;
	}
	if (target) {
		return withWriteLock(target, async () => {
			if (baseVersion === null) throw new FsAccessError("file already exists", 412, { currentVersion: null });
			// An early check spares writing bytes that would be refused; the commit checks again
			// on the very file it replaces.
			const current = readContained(realRoot, target, MAX_READ_BYTES);
			expectVersion(current, baseVersion);
			try {
				writeContained(realRoot, dirname(target), basename(target), bytes, {
					mode: "replace",
					permissions: current.mode,
					verify: fd => expectVersion(fd === null ? null : readOpened(fd, MAX_READ_BYTES), baseVersion),
				});
			} catch (error) {
				if (error instanceof FsAccessError) throw error;
				throw new FsAccessError(error instanceof Error ? error.message : String(error), 403);
			}
			return { path: rel, version: contentVersion(bytes), size: bytes.length };
		});
	}
	if (baseVersion !== null) throw new FsAccessError("file was deleted since it was opened", 412, { currentVersion: null });
	const dir = await resolveInside(realRoot, dirname(rel));
	return withWriteLock(join(dir, name), async () => {
		try {
			writeContained(realRoot, dir, name, bytes, { mode: "create" });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new FsAccessError(message, message === "file already exists" ? 412 : 403, message === "file already exists" ? { currentVersion: null } : undefined);
		}
		return { path: rel, version: contentVersion(bytes), size: bytes.length };
	});
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
