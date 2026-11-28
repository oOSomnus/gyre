/**
 * Open beneath a pinned directory, then inspect and read only that descriptor.
 * Writes create a temporary file beside the target through a pinned directory
 * descriptor and publish it in place (an atomic swap, a no-replace rename or a link), so
 * no step follows a symlink out of the root.
 */
import { randomBytes } from "node:crypto";
import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, openSync, readSync, writeSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

const darwin = process.platform === "darwin";
const LIBC = darwin ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
const libc = dlopen(LIBC, {
	openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
	renameat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
	linkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	unlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	syscall: { args: [FFIType.i64, FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
});
/** The calling thread's errno location: `__error` on macOS, `__errno_location` on glibc. */
const errnoLocation = darwin
	? dlopen(LIBC, { __error: { args: [], returns: FFIType.ptr } }).symbols.__error
	: dlopen(LIBC, { __errno_location: { args: [], returns: FFIType.ptr } }).symbols.__errno_location;
/**
 * Rename with flags (`renameat2` on Linux, `renameatx_np` on macOS), when libc has it.
 * Filesystems that lack a flag fail the call, and callers fall back.
 */
const renameWithFlags = (() => {
	const args = [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32] as const;
	try {
		return darwin
			? dlopen(LIBC, { renameatx_np: { args, returns: FFIType.i32 } }).symbols.renameatx_np
			: dlopen(LIBC, { renameat2: { args, returns: FFIType.i32 } }).symbols.renameat2;
	} catch {
		return undefined;
	}
})();
/** RENAME_NOREPLACE (Linux) / RENAME_EXCL (macOS): fail if the new name exists. */
const RENAME_NOREPLACE = darwin ? 0x4 : 0x1;
/** RENAME_EXCHANGE (Linux) / RENAME_SWAP (macOS): swap the two names atomically. */
const RENAME_EXCHANGE = 0x2;
const ENOENT = 2;
const EEXIST = 17;
const cstr = (s: string) => Buffer.from(`${s}\0`);

export function isContained(root: string, target: string): boolean {
	const rel = relative(root, target);
	return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

/** The error for a refused open; a missing file carries `code: "ENOENT"` so callers can tell it from a refusal. */
function openError(errno: number): Error {
	return Object.assign(new Error("file changed or cannot be opened inside project"), errno === 2 ? { code: "ENOENT" } : {});
}

/**
 * Open `target` (inside `root`) read-only. `extraFlags` adds open flags such as
 * `O_DIRECTORY`; they apply to the final component only.
 */
export function openContained(root: string, target: string, extraFlags = 0): number {
	if (!isContained(root, target)) throw new Error("path escapes root");
	let dir = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		const rel = relative(root, target) || ".";
		if (process.platform === "linux") {
			const name = cstr(rel);
			// openat2: RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS. A rename/symlink
			// race is rejected by the kernel rather than reopened after validation.
			const how = new BigUint64Array([BigInt(constants.O_RDONLY | constants.O_NONBLOCK | 0x80000 | extraFlags), 0n, 0x0an]);
			const fd = Number(libc.symbols.syscall(437, dir, ptr(name), ptr(how), 24));
			if (fd >= 0) return fd;
			const error = lastErrno();
			// Only ENOSYS means this kernel lacks openat2. All security errors stay authoritative.
			if (error !== 38) throw openError(error);
		}
		// Canonical paths contain no symlinks. Pin each directory and reject
		// any component replaced by a symlink before its descriptor is opened.
		const parts = rel.split(sep);
		for (let i = 0; i < parts.length; i++) {
			const name = cstr(parts[i]!);
			const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (i < parts.length - 1 ? constants.O_DIRECTORY : extraFlags);
			const fd = libc.symbols.openat(dir, ptr(name), flags, 0);
			if (fd < 0) throw openError(lastErrno());
			if (i === parts.length - 1) return fd;
			closeSync(dir);
			dir = fd;
		}
		throw new Error("missing file");
	} finally {
		closeSync(dir);
	}
}

/** A file name that stays in its directory: no separators, not `.` or `..`, no NUL. */
export function isPlainName(name: string): boolean {
	return name.length > 0 && Buffer.byteLength(name) <= 255 && name !== "." && name !== ".." && !/[/\\\0]/.test(name);
}

export interface ContainedWrite {
	/** `create` fails if `name` exists; `replace` swaps the new bytes in atomically. */
	mode: "create" | "replace";
	/** Permission bits for the written file (`replace` keeps the old file's by passing them here). */
	permissions?: number;
	/**
	 * `replace` only: checks the file being replaced, given as an open descriptor (null when
	 * it is gone), and throws to refuse the write. Where the filesystem can swap two names
	 * atomically it runs after the swap, on the file that was swapped out, and a throw swaps
	 * it back: a version another process committed at any moment before the commit is kept
	 * and reported, never silently replaced. Elsewhere it runs just before the rename.
	 */
	verify?: (fd: number | null) => void;
}

const tempName = () => `.gyre-${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
const TEMP_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | 0x80000;

/**
 * Write `data` to `dir/name`, where `dir` is a canonical directory inside `root`. Both modes
 * write and sync a temporary sibling first, then publish it under `name` in one step, so
 * readers see the old file (or none) or the new one and never a partial one, and a failed
 * write only ever removes its own temporary file.
 */
export function writeContained(root: string, dir: string, name: string, data: Uint8Array, options: ContainedWrite): void {
	if (!isPlainName(name)) throw new Error("invalid file name");
	const dirFd = openContained(root, dir, constants.O_DIRECTORY);
	try {
		const target = cstr(name);
		// A short name independent of the target's, which may already be near NAME_MAX bytes.
		const tmpLabel = tempName();
		const tmp = cstr(tmpLabel);
		const fd = libc.symbols.openat(dirFd, ptr(tmp), TEMP_FLAGS, 0o600);
		if (fd < 0) throw new Error(options.mode === "create" ? "cannot create file inside project" : "cannot write inside project");
		/** Whether the temporary name still holds this write's bytes (and is ours to remove). */
		let tmpIsOurs = true;
		try {
			if (options.mode === "create") {
				writeAll(fd, data, options.permissions ?? 0o666 & ~process.umask());
				tmpIsOurs = !publishNew(dirFd, tmp, target);
				return;
			}
			writeAll(fd, data, options.permissions ?? 0o644);
			if (renameWithFlags && renameWithFlags(dirFd, ptr(tmp), dirFd, ptr(target), RENAME_EXCHANGE) === 0) {
				// `tmp` now names the file that was replaced.
				try {
					checkAt(dirFd, tmp, options.verify);
				} catch (error) {
					tmpIsOurs = false;
					if (!renameWithFlags || renameWithFlags(dirFd, ptr(tmp), dirFd, ptr(target), RENAME_EXCHANGE) !== 0) {
						throw new Error(`${(error as Error).message}; the other version could not be put back and is kept beside it as ${tmpLabel}`);
					}
					// Swapped back. Remove the temporary file only if it holds these bytes again:
					// a third writer may have replaced the target in between.
					tmpIsOurs = sameBytesAt(dirFd, tmp, data);
					throw error;
				}
				libc.symbols.unlinkat(dirFd, ptr(tmp), 0);
				tmpIsOurs = false;
				return;
			}
			// No atomic swap here (or no target to swap with): check, then rename. The interval
			// between the two stays open on such filesystems.
			checkAt(dirFd, target, options.verify);
			if (libc.symbols.renameat(dirFd, ptr(tmp), dirFd, ptr(target)) !== 0) throw new Error("cannot replace file inside project");
			tmpIsOurs = false;
		} finally {
			if (tmpIsOurs) libc.symbols.unlinkat(dirFd, ptr(tmp), 0);
		}
	} finally {
		closeSync(dirFd);
	}
}

/**
 * Publish the synced temporary file `tmp` as `target` unless `target` exists: a no-replace
 * rename, else a hard link (which never replaces either). Returns whether `tmp` was
 * consumed (renamed away); after a link, the caller removes it.
 */
function publishNew(dirFd: number, tmp: Buffer, target: Buffer): boolean {
	if (renameWithFlags) {
		if (renameWithFlags(dirFd, ptr(tmp), dirFd, ptr(target), RENAME_NOREPLACE) === 0) return true;
		if (lastErrno() === EEXIST) throw new Error("file already exists");
	}
	if (libc.symbols.linkat(dirFd, ptr(tmp), dirFd, ptr(target), 0) === 0) return false;
	throw new Error(lastErrno() === EEXIST ? "file already exists" : "cannot create file inside project");
}

/** Run `verify` on `dir/name` (opened without following a symlink), or on null when it is gone. */
function checkAt(dirFd: number, name: Buffer, verify: ContainedWrite["verify"]): void {
	if (!verify) return;
	const fd = libc.symbols.openat(dirFd, ptr(name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | 0x80000, 0);
	if (fd < 0) {
		if (lastErrno() === ENOENT) return verify(null);
		throw new Error("file changed or cannot be opened inside project");
	}
	try {
		verify(fd);
	} finally {
		closeSync(fd);
	}
}

/** Whether `dir/name` holds exactly `data`. */
function sameBytesAt(dirFd: number, name: Buffer, data: Uint8Array): boolean {
	const fd = libc.symbols.openat(dirFd, ptr(name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | 0x80000, 0);
	if (fd < 0) return false;
	try {
		if (fstatSync(fd).size !== data.length) return false;
		const buffer = Buffer.alloc(data.length);
		let length = 0;
		while (length < buffer.length) {
			const n = readSync(fd, buffer, length, buffer.length - length, null);
			if (!n) break;
			length += n;
		}
		return length === data.length && buffer.equals(data);
	} finally {
		closeSync(fd);
	}
}

function writeAll(fd: number, data: Uint8Array, permissions: number | undefined): void {
	try {
		let offset = 0;
		while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
		if (permissions !== undefined) fchmodSync(fd, permissions & 0o7777);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function lastErrno(): number {
	return new Int32Array(toArrayBuffer(errnoLocation()!, 0, 4))[0]!;
}
