/** Open beneath a pinned directory, then inspect and read only that descriptor. */
import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import { closeSync, constants, openSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

const libc = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
	openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
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

export function openContained(root: string, target: string): number {
	if (!isContained(root, target)) throw new Error("path escapes root");
	let dir = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		const rel = relative(root, target) || ".";
		if (process.platform === "linux") {
			const name = cstr(rel);
			// openat2: RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS. A rename/symlink
			// race is rejected by the kernel rather than reopened after validation.
			const how = new BigUint64Array([BigInt(constants.O_RDONLY | constants.O_NONBLOCK | 0x80000), 0n, 0x0an]);
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
			const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (i < parts.length - 1 ? constants.O_DIRECTORY : 0);
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
