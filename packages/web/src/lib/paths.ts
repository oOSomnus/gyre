/** Path helpers for the folder browser (pure, no DOM). */

/** Breadcrumb segments for an absolute path: [{label, path}]. */
export function crumbs(path: string): Array<{ label: string; path: string }> {
	const parts = path.split("/").filter(Boolean);
	return [{ label: "/", path: "/" }, ...parts.map((label, i) => ({ label, path: `/${parts.slice(0, i + 1).join("/")}` }))];
}

export function baseName(path: string): string {
	return path.replace(/\/+$/, "").split("/").pop() || path;
}

/** The folder containing `path` ("/" for top-level folders). */
export function parentDir(path: string): string {
	return path.replace(/\/+$/, "").replace(/\/[^/]+$/, "") || "/";
}
