/**
 * Open beneath a pinned directory, then inspect and read only that descriptor.
 * Writes create a temporary file beside the target through a pinned directory
 * descriptor and rename it into place, so neither step follows a symlink out of the root.
 */
import { randomBytes } from "node:crypto";
import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import { closeSync, constants, fchmodSync, fsyncSync, openSync, writeSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

const libc = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
	openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
	renameat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
	unlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	syscall: { args: [FFIType.i64, FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
});
const errno = process.platform === "linux" ? dlopen("libc.so.6", {
	__errno_location: { args: [], returns: FFIType.ptr },
}) : undefined;
const cstr = (s: string) => Buffer.from(`${s}\0`);

export function isContained(root: string, target: string): boolean {
	const rel = relative(root, target);
	return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
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
			const error = new Int32Array(toArrayBuffer(errno!.symbols.__errno_location()!, 0, 4))[0];
			// Only ENOSYS means this kernel lacks openat2. All security errors stay authoritative.
			if (error !== 38) throw new Error("file changed or cannot be opened inside project");
		}
		// Canonical paths contain no symlinks. Pin each directory and reject
		// any component replaced by a symlink before its descriptor is opened.
		const parts = rel.split(sep);
		for (let i = 0; i < parts.length; i++) {
			const name = cstr(parts[i]!);
			const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (i < parts.length - 1 ? constants.O_DIRECTORY : extraFlags);
			const fd = libc.symbols.openat(dir, ptr(name), flags, 0);
			if (fd < 0) throw new Error("file changed or cannot be opened inside project");
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
	return name.length > 0 && name.length <= 255 && name !== "." && name !== ".." && !/[/\\\0]/.test(name);
}

export interface ContainedWrite {
	/** `create` fails if `name` exists; `replace` swaps the new bytes in atomically. */
	mode: "create" | "replace";
	/** Permission bits for the written file (`replace` keeps the old file's by passing them here). */
	permissions?: number;
}

/**
 * Write `data` to `dir/name`, where `dir` is a canonical directory inside `root`.
 * `replace` writes a temporary sibling, syncs it and renames it over `name`, so readers
 * see the old or the new file and never a partial one.
 */
export function writeContained(root: string, dir: string, name: string, data: Uint8Array, options: ContainedWrite): void {
	if (!isPlainName(name)) throw new Error("invalid file name");
	const dirFd = openContained(root, dir, constants.O_DIRECTORY);
	try {
		const base = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | 0x80000;
		const target = cstr(name);
		if (options.mode === "create") {
			const fd = libc.symbols.openat(dirFd, ptr(target), base, options.permissions ?? 0o666);
			if (fd < 0) throw new Error(lastErrno() === 17 ? "file already exists" : "cannot create file inside project");
			writeAll(fd, data, options.permissions);
			return;
		}
		const tmpName = cstr(`.${name.slice(0, 200)}.gyre-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
		const fd = libc.symbols.openat(dirFd, ptr(tmpName), base, 0o600);
		if (fd < 0) throw new Error("cannot write inside project");
		try {
			writeAll(fd, data, options.permissions ?? 0o644);
			if (libc.symbols.renameat(dirFd, ptr(tmpName), dirFd, ptr(target)) !== 0) throw new Error("cannot replace file inside project");
		} catch (error) {
			libc.symbols.unlinkat(dirFd, ptr(tmpName), 0);
			throw error;
		}
	} finally {
		closeSync(dirFd);
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

function lastErrno(): number | undefined {
	if (!errno) return undefined;
	return new Int32Array(toArrayBuffer(errno.symbols.__errno_location()!, 0, 4))[0];
}
