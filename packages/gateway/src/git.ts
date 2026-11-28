/**
 * Git operations for the Git pane, through the `git` CLI.
 *
 * omp's `/git` is a TUI-only command, so Gyre has its own pane. It runs the
 * user's `git` (argv only, never a shell) instead of omp's native VCS bindings,
 * so the gateway gains no new coupling to omp internals. Every path a caller
 * passes must be one the current status lists, and every revision is verified
 * with `rev-parse` before use. Commands run at the repository root, so all
 * paths are root-relative, as `git status --porcelain` reports them.
 */
import type { GitCommitInfo, GitDiff, GitFile, GitHunk, GitHunkAction, GitStatus, ReviewChanges, ReviewFile } from "@gyre/protocol";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, copyFileSync, fstatSync, lstatSync, readSync, realpathSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { isContained, openContained } from "./contained-file";

export class GitError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

/** Largest side of a diff sent whole for the split view. */
const MAX_SIDE_BYTES = 1024 * 1024;
const READ_TIMEOUT_MS = 20_000;
/** Commit hooks (lint, tests) can take a while. */
const COMMIT_TIMEOUT_MS = 180_000;
/** Flags that make diff output independent of the user's diff config, so patches apply. */
const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/"];

/**
 * Variables that point git at a repository other than the one `cwd` is in. A
 * gateway started from a git hook (or a shell that exported them) would
 * otherwise run every project's commands against that one repository.
 */
const REPO_LOCATION_VARS = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_COMMON_DIR",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_NAMESPACE",
	"GIT_PREFIX",
];

/** `env` (default: this process's) without the repository-location variables, so git discovers the repo from `cwd`. */
export function gitChildEnv(env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
	const clean = { ...env };
	for (const name of REPO_LOCATION_VARS) delete clean[name];
	return clean;
}

interface RunResult {
	code: number;
	stdout: Uint8Array;
	stderr: string;
}

const decoder = new TextDecoder();
const text = (bytes: Uint8Array) => decoder.decode(bytes);
const isBinary = (bytes: Uint8Array) => bytes.subarray(0, 8000).includes(0);

/** Run git with `args` in `cwd`. Never throws for a non-zero exit; see `GitRepo.git` for that. */
export async function runGit(cwd: string, args: string[], options: { stdin?: string; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<RunResult> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...gitChildEnv(),
			GIT_TERMINAL_PROMPT: "0",
			// Paths are file names from status, never patterns: `*.txt` means that one file.
			GIT_LITERAL_PATHSPECS: "1",
			GIT_OPTIONAL_LOCKS: "0",
			// A commit never opens an editor: the message always comes on stdin.
			GIT_EDITOR: "true",
			GIT_SEQUENCE_EDITOR: "true",
			LC_ALL: "C",
			NO_COLOR: "1",
			...options.env,
		},
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeoutMs = options.timeoutMs ?? READ_TIMEOUT_MS;
	try {
		return await Promise.race([
			Promise.all([new Response(proc.stdout).bytes(), new Response(proc.stderr).text(), proc.exited]).then(([stdout, stderr, code]) => ({
				code,
				stdout,
				stderr,
			})),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					proc.kill("SIGKILL");
					reject(new GitError(`git ${args[0]} timed out after ${Math.round(timeoutMs / 1000)}s`, 504));
				}, timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** The repository root containing `dir`, or null when it is not in a work tree. */
export async function repoRoot(dir: string): Promise<string | null> {
	try {
		const result = await runGit(dir, ["rev-parse", "--show-toplevel"]);
		return result.code === 0 ? text(result.stdout).trim() || null : null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Parsers (exported for tests)
// ---------------------------------------------------------------------------

/** Parse `git status --porcelain=v2 --branch -z --untracked-files=all`. */
export function parseStatus(output: string): Omit<GitStatus, "root"> {
	const status: Omit<GitStatus, "root"> = { branch: null, ahead: 0, behind: 0, files: [] };
	const records = output.split("\0");
	for (let i = 0; i < records.length; i++) {
		const record = records[i]!;
		if (!record) continue;
		if (record.startsWith("# ")) {
			const [, key, ...rest] = record.split(" ");
			const value = rest.join(" ");
			if (key === "branch.oid" && value !== "(initial)") status.headSha = value;
			else if (key === "branch.head") status.branch = value === "(detached)" ? null : value;
			else if (key === "branch.upstream") status.upstream = value;
			else if (key === "branch.ab") {
				const match = /^\+(\d+) -(\d+)$/.exec(value);
				if (match) {
					status.ahead = Number(match[1]);
					status.behind = Number(match[2]);
				}
			}
			continue;
		}
		const type = record[0];
		if (type === "?") {
			status.files.push({ path: record.slice(2), index: "?", worktree: "?", untracked: true });
			continue;
		}
		// Fields before the path: 1 → 8, 2 → 9 (plus the origin path as the next record), u → 10.
		const skip = type === "1" ? 8 : type === "2" ? 9 : type === "u" ? 10 : -1;
		if (skip < 0) continue;
		const fields = splitFields(record, skip);
		if (!fields) continue;
		const xy = fields.head[1] ?? "..";
		const file: GitFile = { path: fields.rest, index: xy[0] ?? ".", worktree: xy[1] ?? ".", untracked: false };
		if (type === "2") file.origPath = records[++i];
		if (type === "u") file.conflicted = true;
		status.files.push(file);
	}
	return status;
}

/** Split `count` space-separated fields off the front; the remainder (a path) may contain spaces. */
function splitFields(record: string, count: number): { head: string[]; rest: string } | null {
	const head: string[] = [];
	let at = 0;
	for (let n = 0; n < count; n++) {
		const next = record.indexOf(" ", at);
		if (next < 0) return null;
		head.push(record.slice(at, next));
		at = next + 1;
	}
	return { head, rest: record.slice(at) };
}

export interface NumstatEntry {
	path: string;
	added?: number;
	removed?: number;
	binary: boolean;
}

/** Parse `git diff --numstat -z`: `A\tR\tpath\0`, or `A\tR\t\0old\0new\0` for a rename. */
export function parseNumstat(output: string): NumstatEntry[] {
	const entries: NumstatEntry[] = [];
	const records = output.split("\0");
	for (let i = 0; i < records.length; i++) {
		const record = records[i]!;
		if (!record) continue;
		const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(record);
		if (!match) continue;
		let path = match[3]!;
		if (path === "") {
			i++; // origin path
			path = records[++i] ?? "";
		}
		const binary = match[1] === "-";
		entries.push({ path, binary, added: binary ? undefined : Number(match[1]), removed: binary ? undefined : Number(match[2]) });
	}
	return entries;
}

export interface ParsedFileDiff {
	/** Everything before the first hunk (`diff --git`, mode and `---`/`+++` lines). */
	header: string[];
	hunks: GitHunk[];
	binary: boolean;
}

export function hunkId(header: string, lines: readonly string[]): string {
	return createHash("sha1").update(header).update("\n").update(lines.join("\n")).digest("hex").slice(0, 16);
}

/** Split one file's unified diff into its header and hunks. */
export function parseFileDiff(diff: string): ParsedFileDiff {
	const lines = diff.split("\n");
	if (lines.at(-1) === "") lines.pop();
	const header: string[] = [];
	const hunks: GitHunk[] = [];
	let current: { header: string; lines: string[] } | null = null;
	let binary = false;
	const flush = () => {
		if (current) hunks.push({ id: hunkId(current.header, current.lines), header: current.header, lines: current.lines });
	};
	for (const line of lines) {
		if (line.startsWith("@@")) {
			flush();
			current = { header: line, lines: [] };
		} else if (current) {
			current.lines.push(line);
		} else {
			if (line.startsWith("Binary files ") || line === "GIT binary patch") binary = true;
			header.push(line);
		}
	}
	flush();
	return { header, hunks, binary };
}

/** A patch holding only `hunk`, for `git apply`. */
export function hunkPatch(header: readonly string[], hunk: GitHunk): string {
	return `${[...header, hunk.header, ...hunk.lines].join("\n")}\n`;
}

/**
 * `header` reduced to a content change of the new path: no rename or copy
 * lines, and the new path on both sides. Reverse-applying a staged rename's
 * hunk with the rename lines would undo the rename in the index as well.
 */
export function contentOnlyHeader(header: readonly string[]): string[] {
	const plus = header.find(line => line.startsWith("+++ "));
	if (!plus || !header.some(line => /^(rename|copy) (from|to) /.test(line))) return [...header];
	// `+++ b/path` or, for a quoted path, `+++ "b/path"`.
	const bSide = plus.slice(4);
	const aSide = bSide.startsWith('"b/') ? `"a/${bSide.slice(3)}` : bSide.startsWith("b/") ? `a/${bSide.slice(2)}` : bSide;
	return header.flatMap(line => {
		if (/^(similarity index|dissimilarity index|rename from|rename to|copy from|copy to) /.test(line)) return [];
		if (line.startsWith("diff --git ")) return [`diff --git ${aSide} ${bSide}`];
		if (line.startsWith("--- ")) return [`--- ${aSide}`];
		return [line];
	});
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Mutations per repository run one at a time, so two clicks never race for `index.lock`. */
const locks = new Map<string, Promise<unknown>>();

export class GitRepo {
	private constructor(readonly root: string) {}

	/** The repository containing `projectPath`. Throws a 404 `GitError` when there is none. */
	static async open(projectPath: string): Promise<GitRepo> {
		const root = await repoRoot(projectPath);
		if (!root) throw new GitError("not a git repository", 404);
		return new GitRepo(await realpath(root));
	}

	/** Run git and return stdout; a non-zero exit throws with git's message. */
	async git(args: string[], options: { stdin?: string; timeoutMs?: number; status?: number } = {}): Promise<Uint8Array> {
		const result = await runGit(this.root, args, options);
		if (result.code !== 0) {
			const message = result.stderr.trim() || text(result.stdout).trim() || `git ${args[0]} failed (exit ${result.code})`;
			throw new GitError(message, options.status ?? 400);
		}
		return result.stdout;
	}

	/** Run `work` while no other mutation of this repository runs. */
	exclusive<T>(work: () => Promise<T>): Promise<T> {
		return this.#mutate(work);
	}

	async #mutate<T>(work: () => Promise<T>): Promise<T> {
		const previous = locks.get(this.root) ?? Promise.resolve();
		const next = previous.catch(() => {}).then(work);
		locks.set(this.root, next);
		try {
			return await next;
		} finally {
			if (locks.get(this.root) === next) locks.delete(this.root);
		}
	}

	async status(): Promise<GitStatus> {
		const [statusOut, stagedOut, unstagedOut] = await Promise.all([
			this.git(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]),
			runGit(this.root, ["diff", "--cached", "--numstat", "-z", "-M", "--no-ext-diff", "--no-textconv"]),
			runGit(this.root, ["diff", "--numstat", "-z", "-M", "--no-ext-diff", "--no-textconv"]),
		]);
		const status = { root: this.root, ...parseStatus(text(statusOut)) };
		const counts = (result: RunResult) => new Map(parseNumstat(result.code === 0 ? text(result.stdout) : "").map(e => [e.path, e]));
		const staged = counts(stagedOut);
		const unstaged = counts(unstagedOut);
		for (const file of status.files) {
			const s = staged.get(file.path);
			if (s && file.index !== ".") file.staged = { added: s.added, removed: s.removed, binary: s.binary || undefined };
			const u = unstaged.get(file.path);
			if (u && file.worktree !== ".") file.unstaged = { added: u.added, removed: u.removed, binary: u.binary || undefined };
		}
		return status;
	}

	/** The status entry for `path`, or a 400 when status does not list it. */
	async #file(path: string): Promise<GitFile> {
		const file = (await this.status()).files.find(f => f.path === path);
		if (!file) throw new GitError(`not a changed path: ${path}`);
		return file;
	}

	/** Every path must be listed by status (a changed path or a rename source). */
	async #checkPaths(paths: unknown): Promise<{ files: GitFile[]; status: GitStatus }> {
		if (!Array.isArray(paths) || paths.length === 0 || paths.some(p => typeof p !== "string" || !p)) throw new GitError("paths required");
		const status = await this.status();
		const byPath = new Map(status.files.map(f => [f.path, f]));
		const files = (paths as string[]).map(path => {
			const file = byPath.get(path);
			if (!file) throw new GitError(`not a changed path: ${path}`);
			return file;
		});
		return { files, status };
	}

	/** Resolve `revision` to a commit sha. Rejects option-like and malformed input before git sees it. */
	async resolveCommit(revision: unknown): Promise<string> {
		if (typeof revision !== "string" || !revision || revision.length > 256 || revision.startsWith("-") || /[\0\n\r]/.test(revision)) {
			throw new GitError("invalid revision");
		}
		const result = await runGit(this.root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${revision}^{commit}`]);
		const sha = text(result.stdout).trim();
		if (result.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) throw new GitError(`unknown revision: ${revision}`, 404);
		return sha;
	}

	/** Bytes of `spec` (`rev:path` or `:path`), or null when it does not exist. */
	async #blob(spec: string): Promise<Uint8Array | null> {
		const result = await runGit(this.root, ["cat-file", "blob", spec]);
		return result.code === 0 ? result.stdout : null;
	}

	/** The work-tree file, opened beneath the root so a symlink cannot point the read elsewhere. */
	#worktree(path: string): Uint8Array | null {
		let fd: number;
		try {
			fd = openContained(this.root, join(this.root, path));
		} catch {
			return null;
		}
		try {
			const info = fstatSync(fd);
			if (!info.isFile()) return null;
			const buffer = Buffer.alloc(Math.min(info.size, MAX_SIDE_BYTES + 1));
			let length = 0;
			while (length < buffer.length) {
				const n = readSync(fd, buffer, length, buffer.length - length, null);
				if (!n) break;
				length += n;
			}
			return buffer.subarray(0, length);
		} finally {
			closeSync(fd);
		}
	}

	/** Diff text for one file. `staged`: index vs HEAD; otherwise work tree vs index. */
	async #diffText(file: GitFile, staged: boolean): Promise<string> {
		if (file.untracked) {
			// No index entry yet: show the whole file as added (display only; hunks of untracked files are not actionable).
			const result = await runGit(this.root, ["diff", ...DIFF_FLAGS, "--no-index", "--", "/dev/null", file.path]);
			return text(result.stdout);
		}
		const paths = file.origPath && staged ? [file.origPath, file.path] : [file.path];
		return text(await this.git(["diff", ...DIFF_FLAGS, ...(staged ? ["--cached", "-M"] : []), "-U3", "--", ...paths]));
	}

	async diff(path: string, options: { staged: boolean; revision?: string }): Promise<GitDiff> {
		if (options.revision) return this.#revisionDiff(path, options.revision);
		const file = await this.#file(path);
		const staged = options.staged && !file.untracked;
		const oldPath = staged && file.origPath ? file.origPath : file.path;
		const hasHead = (await runGit(this.root, ["rev-parse", "--verify", "--quiet", "HEAD"])).code === 0;
		const [diffText, oldBytes, newBytes] = await Promise.all([
			this.#diffText(file, staged),
			file.untracked ? null : staged ? (hasHead ? this.#blob(`HEAD:${oldPath}`) : null) : this.#blob(`:0:${file.path}`),
			staged ? this.#blob(`:0:${file.path}`) : this.#worktree(file.path),
		]);
		return this.#buildDiff({ path: file.path, oldPath, staged, diffText, oldBytes, newBytes, actionable: !file.untracked && !file.conflicted });
	}

	async #revisionDiff(path: string, revision: string): Promise<GitDiff> {
		const sha = await this.resolveCommit(revision);
		const info = await this.show(sha);
		const entry = info.files.find(f => f.path === path);
		if (!entry) throw new GitError(`${path} is not changed in ${revision}`);
		const base = info.parents[0];
		const oldPath = entry.origPath ?? path;
		const range = base ? [base, sha] : ["--root", sha];
		const paths = entry.origPath ? [entry.origPath, path] : [path];
		const [diffText, oldBytes, newBytes] = await Promise.all([
			this.git(["diff-tree", "-p", "-M", ...DIFF_FLAGS, "-U3", ...range, "--", ...paths]).then(text),
			base ? this.#blob(`${base}:${oldPath}`) : null,
			this.#blob(`${sha}:${path}`),
		]);
		return { ...this.#buildDiff({ path, oldPath, staged: false, diffText, oldBytes, newBytes, actionable: false }), revision: sha };
	}

	#buildDiff(input: {
		path: string;
		oldPath: string;
		staged: boolean;
		diffText: string;
		oldBytes: Uint8Array | null;
		newBytes: Uint8Array | null;
		actionable: boolean;
	}): GitDiff {
		const parsed = parseFileDiff(input.diffText);
		const binary = parsed.binary || (input.oldBytes ? isBinary(input.oldBytes) : false) || (input.newBytes ? isBinary(input.newBytes) : false);
		const tooBig = (b: Uint8Array | null) => (b?.length ?? 0) > MAX_SIDE_BYTES;
		const truncated = tooBig(input.oldBytes) || tooBig(input.newBytes);
		const side = (b: Uint8Array | null) => (!b || binary || truncated ? "" : text(b));
		return {
			path: input.path,
			oldPath: input.oldPath,
			staged: input.staged,
			binary,
			oldText: side(input.oldBytes),
			newText: side(input.newBytes),
			truncated: truncated || undefined,
			// Untracked and conflicted files have no hunks to apply; the lines are still shown in the split view.
			hunks: binary ? [] : input.actionable ? parsed.hunks : parsed.hunks.map(h => ({ ...h, id: "" })),
		};
	}

	stage(paths: unknown): Promise<void> {
		return this.#mutate(async () => {
			const { files } = await this.#checkPaths(paths);
			await this.git(["add", "-A", "--", ...files.map(f => f.path)]);
		});
	}

	unstage(paths: unknown): Promise<void> {
		return this.#mutate(async () => {
			const { files, status } = await this.#checkPaths(paths);
			const targets = files.flatMap(f => (f.origPath ? [f.path, f.origPath] : [f.path]));
			// An unborn branch has no HEAD to restore the index from: drop the entries instead.
			if (status.headSha) await this.git(["restore", "--staged", "--", ...targets]);
			// `-f`: the work-tree file may have changed since it was staged; only the index entry goes.
			else await this.git(["rm", "--cached", "-f", "-r", "-q", "--", ...targets]);
		});
	}

	/** Throw away unstaged changes: untracked files are deleted, tracked files go back to their index version. */
	discard(paths: unknown): Promise<void> {
		return this.#mutate(async () => {
			const { files } = await this.#checkPaths(paths);
			const untracked = files.filter(f => f.untracked).map(f => f.path);
			const tracked = files.filter(f => !f.untracked && f.worktree !== ".").map(f => f.path);
			if (untracked.length) await this.git(["clean", "-f", "-q", "--", ...untracked]);
			if (tracked.length) await this.git(["restore", "--worktree", "--", ...tracked]);
		});
	}

	/**
	 * Stage or unstage one hunk of the index diff, or discard one hunk of the
	 * work tree. The hunk is found again by id, so a tree that changed since the
	 * UI loaded it gets a 409 instead of a wrong patch.
	 */
	applyHunk(path: string, id: string, action: GitHunkAction): Promise<void> {
		return this.#mutate(async () => {
			if (typeof id !== "string" || !id) throw new GitError("hunk id required");
			if (!["stage", "unstage", "discard"].includes(action)) throw new GitError("invalid hunk action");
			const file = await this.#file(path);
			if (file.untracked || file.conflicted) throw new GitError("hunks of untracked or conflicted files cannot be applied separately");
			const staged = action === "unstage";
			const parsed = parseFileDiff(await this.#diffText(file, staged));
			const hunk = parsed.hunks.find(h => h.id === id);
			if (!hunk) throw new GitError("the file changed since the diff was loaded; refresh and try again", 409);
			const args = action === "stage" ? ["--cached"] : action === "unstage" ? ["--cached", "-R"] : ["-R"];
			// Only the staged diff detects renames; unstaging a hunk keeps the rename staged.
			const header = action === "unstage" ? contentOnlyHeader(parsed.header) : parsed.header;
			await this.git(["apply", "--whitespace=nowarn", ...args, "-"], { stdin: hunkPatch(header, hunk) });
		});
	}

	commit(message: unknown, options: { amend?: boolean } = {}): Promise<{ sha: string }> {
		return this.#mutate(async () => {
			if (typeof message !== "string" || !message.trim()) throw new GitError("commit message required");
			await this.git(["commit", "-q", "--cleanup=strip", ...(options.amend ? ["--amend"] : []), "-F", "-"], {
				stdin: message,
				timeoutMs: COMMIT_TIMEOUT_MS,
			});
			return { sha: text(await this.git(["rev-parse", "HEAD"])).trim() };
		});
	}

	async lastCommitMessage(): Promise<string> {
		const result = await runGit(this.root, ["log", "-1", "--format=%B"]);
		return result.code === 0 ? text(result.stdout).trimEnd() : "";
	}

	async show(revision: string): Promise<GitCommitInfo> {
		const sha = await this.resolveCommit(revision);
		const meta = text(await this.git(["show", "-s", "--format=%H%x00%an%x00%ae%x00%aI%x00%P%x00%s%x00%b", sha])).split("\0");
		const parents = (meta[4] ?? "").split(" ").filter(Boolean);
		// Merges list their changes against the first parent, like `git show --first-parent`.
		const files = await this.#treeChanges(parents[0] ? [parents[0], sha] : ["--root", sha]);
		return {
			sha,
			author: meta[1] ?? "",
			email: meta[2] ?? "",
			date: meta[3] ?? "",
			parents,
			subject: meta[5] ?? "",
			body: (meta[6] ?? "").trimEnd(),
			files,
		};
	}

	/** Files changed in a `diff-tree` range, with line counts. */
	async #treeChanges(range: string[]): Promise<ReviewFile[]> {
		const [names, stats] = await Promise.all([
			this.git(["diff-tree", "-r", "-z", "-M", "--name-status", "--no-commit-id", ...range]).then(text),
			this.git(["diff-tree", "-r", "-z", "-M", "--numstat", "--no-commit-id", "--no-ext-diff", "--no-textconv", ...range]).then(text),
		]);
		const counts = new Map(parseNumstat(stats).map(e => [e.path, e]));
		const files: ReviewFile[] = [];
		const records = names.split("\0");
		for (let i = 0; i < records.length; i++) {
			const status = records[i];
			if (!status) continue;
			const rename = status[0] === "R" || status[0] === "C";
			const origPath = rename ? records[++i] : undefined;
			const path = records[++i] ?? "";
			const count = counts.get(path);
			files.push({ path, origPath, status: status[0]!, added: count?.added, removed: count?.removed });
		}
		return files;
	}

	// ---------------------------------------------------------------- per-turn review

	/** Verify `id` names a tree object (a turn snapshot). */
	async resolveTree(id: unknown): Promise<string> {
		if (typeof id !== "string" || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(id)) throw new GitError("invalid tree id");
		const result = await runGit(this.root, ["cat-file", "-t", id]);
		if (result.code !== 0 || text(result.stdout).trim() !== "tree") throw new GitError("unknown snapshot; it may have been pruned", 404);
		return id;
	}

	/**
	 * The work tree as a tree object, ignored files excluded: `git add -A` into a temporary
	 * index seeded from the real one (to reuse its stat cache), then `write-tree`. The real
	 * index and refs are untouched.
	 */
	async snapshotWorktree(): Promise<string> {
		const gitDir = text(await this.git(["rev-parse", "--absolute-git-dir"])).trim();
		const index = join(tmpdir(), `gyre-index-${process.pid}-${randomBytes(6).toString("hex")}`);
		try {
			try {
				copyFileSync(join(gitDir, "index"), index);
			} catch {}
			const env = { GIT_INDEX_FILE: index };
			const add = await runGit(this.root, ["add", "-A", "--", "."], { env, timeoutMs: 30_000 });
			if (add.code !== 0) throw new GitError(add.stderr.trim() || "could not snapshot the work tree");
			const tree = await runGit(this.root, ["write-tree"], { env });
			const sha = text(tree.stdout).trim();
			if (tree.code !== 0 || !sha) throw new GitError(tree.stderr.trim() || "could not snapshot the work tree");
			return sha;
		} finally {
			rmSync(index, { force: true });
		}
	}

	/** Files changed from tree `from` to tree `to`, or to the current work tree. */
	async reviewChanges(from: unknown, to: unknown): Promise<ReviewChanges> {
		const fromTree = await this.resolveTree(from);
		const toTree = to === "worktree" ? await this.snapshotWorktree() : await this.resolveTree(to);
		return { from: fromTree, to: toTree, files: fromTree === toTree ? [] : await this.#treeChanges([fromTree, toTree]) };
	}

	/**
	 * One file's diff from tree `from` to tree `to` or the work tree. Only a diff against
	 * the work tree has actionable hunks: those are what `revert` can undo.
	 */
	async reviewDiff(from: unknown, to: unknown, path: string): Promise<GitDiff> {
		const changes = await this.reviewChanges(from, to);
		const entry = changes.files.find(f => f.path === path);
		if (!entry) throw new GitError(`${path} did not change`, 404);
		const oldPath = entry.origPath ?? path;
		const paths = entry.origPath ? [entry.origPath, path] : [path];
		const [diffText, oldBytes, newBytes] = await Promise.all([
			this.git(["diff-tree", "-p", "-M", ...DIFF_FLAGS, "-U3", changes.from, changes.to, "--", ...paths]).then(text),
			entry.status === "A" ? null : this.#blob(`${changes.from}:${oldPath}`),
			entry.status === "D" ? null : to === "worktree" ? this.#worktree(path) : this.#blob(`${changes.to}:${path}`),
		]);
		return this.#buildDiff({ path, oldPath, staged: false, diffText, oldBytes, newBytes, actionable: to === "worktree" });
	}

	/**
	 * Put `path` back the way it was in tree `from`, in the work tree only (the index is left
	 * alone). With `hunkId`, undo just that hunk of the from→work-tree diff; a hunk that changed
	 * since it was shown is a 409.
	 */
	revert(from: unknown, path: unknown, hunkId?: unknown): Promise<void> {
		return this.#mutate(async () => {
			if (typeof path !== "string" || !path) throw new GitError("path required");
			const changes = await this.reviewChanges(from, "worktree");
			const entry = changes.files.find(f => f.path === path);
			if (!entry) throw new GitError(`${path} has no changes since that turn`, 409);
			if (hunkId !== undefined) {
				if (typeof hunkId !== "string" || !hunkId) throw new GitError("hunk id required");
				const paths = entry.origPath ? [entry.origPath, path] : [path];
				const parsed = parseFileDiff(text(await this.git(["diff-tree", "-p", "-M", ...DIFF_FLAGS, "-U3", changes.from, changes.to, "--", ...paths])));
				const hunk = parsed.hunks.find(h => h.id === hunkId);
				if (!hunk) throw new GitError("the file changed since the diff was loaded; refresh and try again", 409);
				await this.git(["apply", "--whitespace=nowarn", "-R", "-"], { stdin: hunkPatch(contentOnlyHeader(parsed.header), hunk) });
				return;
			}
			// Added in the turn (or the new side of a rename): remove it. Then restore what the turn changed or removed.
			if (entry.status === "A" || entry.status === "R") this.#removeWorktreeFile(path);
			const restore = entry.status === "A" ? undefined : (entry.origPath ?? path);
			if (restore) await this.git(["restore", `--source=${changes.from}`, "--worktree", "--", restore]);
		});
	}

	/** Delete a work-tree file (or symlink) inside the root; never a directory. */
	#removeWorktreeFile(path: string): void {
		const abs = join(this.root, path);
		if (isAbsolute(path) || !isContained(this.root, abs)) throw new GitError("path escapes the repository");
		let info: ReturnType<typeof lstatSync>;
		try {
			info = lstatSync(abs);
		} catch {
			return;
		}
		if (info.isDirectory()) throw new GitError(`${path} is a directory`);
		// A parent swapped for a symlink must not redirect the delete outside the repository.
		if (!isContained(this.root, realpathSync(dirname(abs)))) throw new GitError("path escapes the repository");
		rmSync(abs);
	}
}
