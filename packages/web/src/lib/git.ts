/** Pure helpers for the Git pane (grouping, labels, hunk positions). */
import type { GitFile, GitStatus } from "@gyre/protocol";

export interface GitGroups {
	conflicts: GitFile[];
	staged: GitFile[];
	changes: GitFile[];
}

/** Split status into the sidebar's groups. A file with staged and unstaged edits is in both. */
export function groupFiles(status: Pick<GitStatus, "files">): GitGroups {
	const groups: GitGroups = { conflicts: [], staged: [], changes: [] };
	for (const file of status.files) {
		if (file.conflicted) groups.conflicts.push(file);
		else {
			if (!file.untracked && file.index !== ".") groups.staged.push(file);
			if (file.untracked || file.worktree !== ".") groups.changes.push(file);
		}
	}
	return groups;
}

export type GitSide = "staged" | "changes" | "conflicts";

/** The status letter shown for a file in a group. */
export function statusCode(file: GitFile, side: GitSide): string {
	if (file.untracked) return "U";
	if (file.conflicted) return "!";
	return side === "staged" ? file.index : file.worktree;
}

const CODE_INFO: Record<string, { label: string; color: string }> = {
	M: { label: "Modified", color: "var(--warn)" },
	T: { label: "Type changed", color: "var(--warn)" },
	A: { label: "Added", color: "var(--ok)" },
	U: { label: "Untracked", color: "var(--ok)" },
	D: { label: "Deleted", color: "var(--err)" },
	R: { label: "Renamed", color: "var(--info)" },
	C: { label: "Copied", color: "var(--info)" },
	"!": { label: "Conflicted", color: "var(--err)" },
};

export function codeInfo(code: string): { label: string; color: string } {
	return CODE_INFO[code] ?? { label: code, color: "var(--muted)" };
}

/** First line of a hunk on the new side, from `@@ -a,b +c,d @@`. */
export function hunkNewStart(header: string): number {
	const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
	return match ? Number(match[1]) : 1;
}

/** `+12 −3`, or "binary", for a file's counts on one side. */
export function countLabel(counts: GitFile["staged"]): string {
	if (!counts) return "";
	if (counts.binary) return "binary";
	return `+${counts.added ?? 0} −${counts.removed ?? 0}`;
}

/** Split `dir/sub/name.ts` into its name and folder for the file list. */
export function splitPath(path: string): { name: string; dir: string } {
	const at = path.lastIndexOf("/");
	return at < 0 ? { name: path, dir: "" } : { name: path.slice(at + 1), dir: path.slice(0, at) };
}

/** Where the selection should go after a refresh: same file and side, else the same file on the other side, else nothing. */
export function nextSelection(
	groups: GitGroups,
	selection: { path: string; side: GitSide } | null,
): { path: string; side: GitSide } | null {
	if (!selection) return null;
	const has = (side: GitSide) => groups[side].some(f => f.path === selection.path);
	if (has(selection.side)) return selection;
	for (const side of ["changes", "staged", "conflicts"] as const) if (has(side)) return { path: selection.path, side };
	return null;
}
