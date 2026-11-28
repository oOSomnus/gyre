/** The Git pane's gateway side: porcelain parsing, staging, hunks, commits and the HTTP routes. */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitCommitInfo, GitDiff, GitStatus } from "@gyre/protocol";
import { contentOnlyHeader, GitError, GitRepo, gitChildEnv, parseFileDiff, parseNumstat, parseStatus } from "../src/git";
import { GENERATE_ARGS, generateCommitMessage, parseDryRun } from "../src/commit-message";
import { type Gateway, startGateway } from "../src/server";
import { validWorkspace } from "../src/validation";

const FAKE_OMP = join(import.meta.dir, "fixtures/fake-omp.ts");
const tmp = mkdtempSync(join(tmpdir(), "gyre-git-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let counter = 0;
function sh(cwd: string, ...args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], { cwd, env: { ...gitChildEnv(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
	return result.stdout.toString();
}

/** A fresh repository with one commit holding `files`. */
function repoWith(files: Record<string, string>): string {
	const dir = join(tmp, `repo-${++counter}`);
	mkdirSync(dir, { recursive: true });
	sh(dir, "init", "-q", "-b", "main");
	sh(dir, "config", "user.name", "Test");
	sh(dir, "config", "user.email", "test@example.com");
	sh(dir, "config", "commit.gpgsign", "false");
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(join(dir, name, ".."), { recursive: true });
		writeFileSync(join(dir, name), content);
	}
	if (Object.keys(files).length) {
		sh(dir, "add", "-A");
		sh(dir, "commit", "-q", "-m", "initial");
	}
	return dir;
}

const lines = (n: number, tag = "line") => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join("\n") + "\n";

describe("parsers", () => {
	test("porcelain v2: branch header, ordinary, rename, unmerged, untracked and paths with spaces", () => {
		const out = [
			"# branch.oid 0123456789abcdef0123456789abcdef01234567",
			"# branch.head feature/x",
			"# branch.upstream origin/feature/x",
			"# branch.ab +2 -1",
			"1 .M N... 100644 100644 100644 aaa bbb dir/a file.txt",
			"2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt",
			"old name.txt",
			"u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.txt",
			"? untracked dir/x.txt",
			"",
		].join("\0");
		const status = parseStatus(out);
		expect(status).toMatchObject({ branch: "feature/x", upstream: "origin/feature/x", ahead: 2, behind: 1, headSha: "0123456789abcdef0123456789abcdef01234567" });
		expect(status.files).toEqual([
			{ path: "dir/a file.txt", index: ".", worktree: "M", untracked: false },
			{ path: "new name.txt", origPath: "old name.txt", index: "R", worktree: ".", untracked: false },
			{ path: "conflict.txt", index: "U", worktree: "U", untracked: false, conflicted: true },
			{ path: "untracked dir/x.txt", index: "?", worktree: "?", untracked: true },
		]);
		const unborn = parseStatus("# branch.oid (initial)\0# branch.head (detached)\0");
		expect(unborn.branch).toBeNull();
		expect(unborn.headSha).toBeUndefined();
	});

	test("numstat: counts, binary and renames", () => {
		expect(parseNumstat("3\t1\ta.txt\0-\t-\tlogo.png\0" + "2\t0\t\0old.txt\0new.txt\0")).toEqual([
			{ path: "a.txt", added: 3, removed: 1, binary: false },
			{ path: "logo.png", added: undefined, removed: undefined, binary: true },
			{ path: "new.txt", added: 2, removed: 0, binary: false },
		]);
	});

	test("file diff: header, hunks with stable ids, no-newline marker kept", () => {
		const diff = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1 +1 @@", "-a", "+b", "\\ No newline at end of file", "@@ -9 +9 @@", "-c", "+d", ""].join("\n");
		const parsed = parseFileDiff(diff);
		expect(parsed.header).toEqual(["diff --git a/x b/x", "--- a/x", "+++ b/x"]);
		expect(parsed.hunks.map(h => h.lines)).toEqual([["-a", "+b", "\\ No newline at end of file"], ["-c", "+d"]]);
		expect(parsed.hunks[0]!.id).toBe(parseFileDiff(diff).hunks[0]!.id);
		expect(parsed.hunks[0]!.id).not.toBe(parsed.hunks[1]!.id);
	});
});

describe("GitRepo", () => {
	test("a folder outside any repository is a 404", async () => {
		const dir = join(tmp, "plain");
		mkdirSync(dir, { recursive: true });
		const error = await GitRepo.open(dir).catch(e => e);
		expect(error).toBeInstanceOf(GitError);
		expect(error.status).toBe(404);
	});

	test("status lists staged and unstaged counts from the repository root, even from a subfolder", async () => {
		const dir = repoWith({ "a.txt": lines(3), "sub/b.txt": "b\n" });
		writeFileSync(join(dir, "a.txt"), lines(4));
		writeFileSync(join(dir, "sub/b.txt"), "b2\n");
		sh(dir, "add", "sub/b.txt");
		writeFileSync(join(dir, "new file.txt"), "n\n");
		const repo = await GitRepo.open(join(dir, "sub"));
		const status = await repo.status();
		expect(status.branch).toBe("main");
		const byPath = Object.fromEntries(status.files.map(f => [f.path, f]));
		expect(byPath["a.txt"]).toMatchObject({ index: ".", worktree: "M", unstaged: { added: 1, removed: 0 } });
		expect(byPath["sub/b.txt"]).toMatchObject({ index: "M", worktree: ".", staged: { added: 1, removed: 1 } });
		expect(byPath["new file.txt"]).toMatchObject({ untracked: true });
	});

	test("stage, unstage and discard; paths not in status are rejected", async () => {
		const dir = repoWith({ "a.txt": "a\n" });
		writeFileSync(join(dir, "a.txt"), "changed\n");
		writeFileSync(join(dir, "u.txt"), "u\n");
		const repo = await GitRepo.open(dir);
		await repo.stage(["a.txt", "u.txt"]);
		expect((await repo.status()).files.map(f => [f.path, f.index, f.worktree])).toEqual([
			["a.txt", "M", "."],
			["u.txt", "A", "."],
		]);
		await repo.unstage(["a.txt", "u.txt"]);
		expect((await repo.status()).files.map(f => [f.path, f.index, f.worktree])).toEqual([
			["a.txt", ".", "M"],
			["u.txt", "?", "?"],
		]);
		await repo.discard(["a.txt", "u.txt"]);
		expect((await repo.status()).files).toEqual([]);
		expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("a\n");
		for (const bad of [["../etc/passwd"], ["a.txt"], [], "a.txt", [42]]) {
			await expect(repo.stage(bad)).rejects.toThrow();
		}
	});

	test("unstage on an unborn branch drops the index entry", async () => {
		const dir = repoWith({});
		writeFileSync(join(dir, "first.txt"), "1\n");
		const repo = await GitRepo.open(dir);
		await repo.stage(["first.txt"]);
		await repo.unstage(["first.txt"]);
		expect((await repo.status()).files).toEqual([{ path: "first.txt", index: "?", worktree: "?", untracked: true }]);
	});

	test("unstage on an unborn branch after the staged file was edited keeps the edit", async () => {
		const dir = repoWith({});
		writeFileSync(join(dir, "first.txt"), "1\n");
		const repo = await GitRepo.open(dir);
		await repo.stage(["first.txt"]);
		writeFileSync(join(dir, "first.txt"), "1\n2\n");
		await repo.unstage(["first.txt"]);
		expect((await repo.status()).files).toEqual([{ path: "first.txt", index: "?", worktree: "?", untracked: true }]);
		expect(readFileSync(join(dir, "first.txt"), "utf8")).toBe("1\n2\n");
	});

	test("paths are literal: a file named like a glob touches only itself", async () => {
		const dir = repoWith({ "a.txt": "a\n" });
		writeFileSync(join(dir, "a.txt"), "a2\n");
		writeFileSync(join(dir, "*.txt"), "star\n");
		writeFileSync(join(dir, "b.txt"), "b\n");
		const repo = await GitRepo.open(dir);
		await repo.stage(["*.txt"]);
		const byPath = Object.fromEntries((await repo.status()).files.map(f => [f.path, [f.index, f.worktree]]));
		expect(byPath).toEqual({ "*.txt": ["A", "."], "a.txt": [".", "M"], "b.txt": ["?", "?"] });
		await repo.unstage(["*.txt"]);
		await repo.discard(["*.txt"]);
		expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("b\n");
		expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("a2\n");
		expect((await repo.status()).files.map(f => f.path)).toEqual(["a.txt", "b.txt"]);
	});

	test("an inherited GIT_DIR / GIT_WORK_TREE does not redirect commands to another repository", async () => {
		const other = repoWith({ "other.txt": "o\n" });
		const dir = repoWith({ "a.txt": "a\n" });
		writeFileSync(join(dir, "a.txt"), "a2\n");
		const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
		process.env.GIT_DIR = join(other, ".git");
		process.env.GIT_WORK_TREE = other;
		try {
			expect(gitChildEnv().GIT_DIR).toBeUndefined();
			const repo = await GitRepo.open(dir);
			expect(repo.root).toBe(realpathSync(dir));
			await repo.stage(["a.txt"]);
			expect((await repo.status()).files).toMatchObject([{ path: "a.txt", index: "M" }]);
		} finally {
			for (const [name, value] of [["GIT_DIR", saved.dir], ["GIT_WORK_TREE", saved.tree]] as const) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
		expect(sh(other, "status", "--porcelain")).toBe("");
	});

	test("hunks: stage one of two, unstage it, discard one, and a stale id is a 409", async () => {
		const dir = repoWith({ "f.txt": lines(30) });
		const edited = lines(30).replace("line 2\n", "line 2 edited\n").replace("line 28\n", "line 28 edited\n");
		writeFileSync(join(dir, "f.txt"), edited);
		const repo = await GitRepo.open(dir);

		const diff = await repo.diff("f.txt", { staged: false });
		expect(diff.hunks).toHaveLength(2);
		expect(diff.oldText).toBe(lines(30));
		expect(diff.newText).toBe(edited);

		await repo.applyHunk("f.txt", diff.hunks[1]!.id, "stage");
		const staged = await repo.diff("f.txt", { staged: true });
		expect(staged.hunks).toHaveLength(1);
		expect(staged.hunks[0]!.lines).toContain("+line 28 edited");
		expect((await repo.diff("f.txt", { staged: false })).hunks).toHaveLength(1);

		await repo.applyHunk("f.txt", staged.hunks[0]!.id, "unstage");
		expect((await repo.status()).files[0]).toMatchObject({ index: ".", worktree: "M" });

		const again = await repo.diff("f.txt", { staged: false });
		await repo.applyHunk("f.txt", again.hunks[0]!.id, "discard");
		expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe(lines(30).replace("line 28\n", "line 28 edited\n"));

		const error = await repo.applyHunk("f.txt", again.hunks[0]!.id, "discard").catch(e => e);
		expect(error.status).toBe(409);
	});

	test("unstaging one hunk of a staged rename keeps the rename and the other hunk", async () => {
		const dir = repoWith({ "a.txt": lines(30) });
		sh(dir, "mv", "a.txt", "b.txt");
		const edited = lines(30).replace("line 2\n", "line 2 edited\n").replace("line 28\n", "line 28 edited\n");
		writeFileSync(join(dir, "b.txt"), edited);
		const repo = await GitRepo.open(dir);
		await repo.stage(["b.txt"]);
		const staged = await repo.diff("b.txt", { staged: true });
		expect(staged.oldPath).toBe("a.txt");
		expect(staged.hunks).toHaveLength(2);

		await repo.applyHunk("b.txt", staged.hunks[1]!.id, "unstage");
		expect((await repo.status()).files).toMatchObject([{ path: "b.txt", origPath: "a.txt", index: "R", worktree: "M" }]);
		expect(sh(dir, "show", ":0:b.txt")).toBe(lines(30).replace("line 2\n", "line 2 edited\n"));
		expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe(edited);
	});

	test("contentOnlyHeader drops rename lines and names the new path on both sides", () => {
		const header = ["diff --git a/old name.txt b/new.txt", "similarity index 90%", "rename from old name.txt", "rename to new.txt", "index 1111111..2222222 100644", "--- a/old name.txt", "+++ b/new.txt"];
		expect(contentOnlyHeader(header)).toEqual(["diff --git a/new.txt b/new.txt", "index 1111111..2222222 100644", "--- a/new.txt", "+++ b/new.txt"]);
		const quoted = ["diff --git a/x \"b/t\\tab\"", "rename from x", "rename to \"t\\tab\"", "--- a/x", '+++ "b/t\\tab"'];
		expect(contentOnlyHeader(quoted)).toEqual(['diff --git "a/t\\tab" "b/t\\tab"', '--- "a/t\\tab"', '+++ "b/t\\tab"']);
		const plain = ["diff --git a/f b/f", "index 1..2 100644", "--- a/f", "+++ b/f"];
		expect(contentOnlyHeader(plain)).toEqual(plain);
	});

	test("untracked files show as added but their hunks are not actionable", async () => {
		const dir = repoWith({ "a.txt": "a\n" });
		writeFileSync(join(dir, "n.txt"), "x\ny\n");
		const repo = await GitRepo.open(dir);
		const diff = await repo.diff("n.txt", { staged: false });
		expect(diff).toMatchObject({ oldText: "", newText: "x\ny\n", binary: false });
		expect(diff.hunks.map(h => h.id)).toEqual([""]);
		await expect(repo.applyHunk("n.txt", "abc", "stage")).rejects.toThrow(/untracked/);
	});

	test("binary files have no text sides and no hunks", async () => {
		const dir = repoWith({ "a.txt": "a\n" });
		writeFileSync(join(dir, "b.bin"), Buffer.from([0, 1, 2, 0, 3]));
		sh(dir, "add", "b.bin");
		const repo = await GitRepo.open(dir);
		const diff = await repo.diff("b.bin", { staged: true });
		expect(diff).toMatchObject({ binary: true, oldText: "", newText: "", hunks: [] });
	});

	test("commit, amend, last message and the pinned commit view", async () => {
		const dir = repoWith({ "a.txt": "a\n" });
		writeFileSync(join(dir, "a.txt"), "b\n");
		const repo = await GitRepo.open(dir);
		await expect(repo.commit("  ")).rejects.toThrow(/message/);
		await repo.stage(["a.txt"]);
		const { sha } = await repo.commit("feat: change a\n\nbody line");
		expect(await repo.lastCommitMessage()).toBe("feat: change a\n\nbody line");
		const amended = await repo.commit("feat: change a (amended)", { amend: true });
		expect(amended.sha).not.toBe(sha);
		expect(sh(dir, "rev-list", "--count", "HEAD").trim()).toBe("2");

		const info = await repo.show("HEAD");
		expect(info).toMatchObject({ sha: amended.sha, subject: "feat: change a (amended)", author: "Test", files: [{ path: "a.txt", status: "M", added: 1, removed: 1 }] });
		const root = await repo.show("HEAD~1");
		expect(root.parents).toEqual([]);
		expect(root.files.map(f => f.path)).toEqual(["a.txt"]);

		const diff = await repo.diff("a.txt", { staged: false, revision: "HEAD" });
		expect(diff).toMatchObject({ oldText: "a\n", newText: "b\n", revision: amended.sha });
		expect(diff.hunks.every(h => h.id === "")).toBe(true);
		const rootDiff = await repo.diff("a.txt", { staged: false, revision: "HEAD~1" });
		expect(rootDiff).toMatchObject({ oldText: "", newText: "a\n" });
	});

	test("revisions that look like options or do not exist are rejected", async () => {
		const dir = repoWith({ "a.txt": "a\n" });
		const repo = await GitRepo.open(dir);
		for (const bad of ["--output=/tmp/x", "-n1", "", "a\nb", 7]) {
			expect(((await repo.resolveCommit(bad).catch(e => e)) as GitError).status).toBe(400);
		}
		expect(((await repo.resolveCommit("nope").catch(e => e)) as GitError).status).toBe(404);
		expect(await repo.resolveCommit("main")).toMatch(/^[0-9a-f]{40}$/);
	});
});

describe("git routes", () => {
	let gateway: Gateway | undefined;
	afterEach(async () => {
		await gateway?.stop();
		gateway = undefined;
	});
	const authed = { "x-gyre-token": "tok", "content-type": "application/json" };

	test("status, diff, stage, commit and show over HTTP; auth and error statuses", async () => {
		gateway = await startGateway({ host: "127.0.0.1", port: 0, token: "tok", dataDir: join(tmp, "gw"), ompPath: FAKE_OMP, idleReapMs: 0 });
		const dir = repoWith({ "a.txt": "a\n" });
		const plain = join(tmp, "plain-project");
		mkdirSync(plain, { recursive: true });
		const add = async (path: string) =>
			((await (await fetch(`${gateway!.url}/api/projects`, { method: "POST", headers: authed, body: JSON.stringify({ path }) })).json()) as { id: string }).id;
		const id = await add(dir);
		const base = `${gateway.url}/api/projects/${id}/git`;
		const get = (p: string) => fetch(`${base}/${p}`, { headers: authed });
		const post = (p: string, body: unknown) => fetch(`${base}/${p}`, { method: "POST", headers: authed, body: JSON.stringify(body) });

		expect((await fetch(`${base}/status`)).status).toBe(401);
		expect((await fetch(`${gateway.url}/api/projects/nope/git/status`, { headers: authed })).status).toBe(404);
		expect((await fetch(`${gateway.url}/api/projects/${await add(plain)}/git/status`, { headers: authed })).status).toBe(404);

		writeFileSync(join(dir, "a.txt"), "b\n");
		const status = (await (await get("status")).json()) as GitStatus;
		expect(status.files.map(f => f.path)).toEqual(["a.txt"]);
		const diff = (await (await get("diff?path=a.txt&staged=0")).json()) as GitDiff;
		expect(diff.newText).toBe("b\n");
		expect((await get("diff?path=..%2Fx&staged=0")).status).toBe(400);
		expect((await post("stage", { paths: ["missing.txt"] })).status).toBe(400);
		expect((await post("stage", { paths: ["a.txt"] })).status).toBe(200);
		expect((await post("hunk", { path: "a.txt", id: "deadbeef", action: "unstage" })).status).toBe(409);
		const commit = (await (await post("commit", { message: "fix: b" })).json()) as { sha: string };
		expect(commit.sha).toMatch(/^[0-9a-f]{40}$/);
		expect(((await (await get("last-message")).json()) as { message: string }).message).toBe("fix: b");
		const info = (await (await get("commit?rev=HEAD")).json()) as GitCommitInfo;
		expect(info.subject).toBe("fix: b");
		expect((await get("commit?rev=--all")).status).toBe(400);
		expect((await post("nope", {})).status).toBe(404);
	});
});

describe("per-turn review", () => {
	test("a work-tree snapshot includes untracked files, skips ignored ones and leaves the index alone", async () => {
		const dir = repoWith({ "a.txt": "a\n", ".gitignore": "out/\n" });
		writeFileSync(join(dir, "new.txt"), "n\n");
		mkdirSync(join(dir, "out"));
		writeFileSync(join(dir, "out/x"), "x");
		const repo = await GitRepo.open(dir);
		const tree = await repo.snapshotWorktree();
		expect(sh(dir, "ls-tree", "-r", "--name-only", tree).trim().split("\n")).toEqual([".gitignore", "a.txt", "new.txt"]);
		expect(sh(dir, "diff", "--cached", "--name-only")).toBe("");
	});

	test("changes and diffs between two turn trees, and from a turn to the work tree", async () => {
		const dir = repoWith({ "a.txt": lines(20), "gone.txt": "bye\n", "old.txt": lines(10, "keep") });
		const repo = await GitRepo.open(dir);
		const before = await repo.snapshotWorktree();
		writeFileSync(join(dir, "a.txt"), lines(20).replace("line 2\n", "LINE 2\n"));
		rmSync(join(dir, "gone.txt"));
		writeFileSync(join(dir, "added.txt"), "hi\n");
		sh(dir, "mv", "old.txt", "renamed.txt");
		const after = await repo.snapshotWorktree();
		const changes = await repo.reviewChanges(before, after);
		expect(changes.files.map(f => `${f.status} ${f.path}${f.origPath ? ` <- ${f.origPath}` : ""}`).sort()).toEqual([
			"A added.txt",
			"D gone.txt",
			"M a.txt",
			"R renamed.txt <- old.txt",
		]);
		const turnDiff = await repo.reviewDiff(before, after, "a.txt");
		expect(turnDiff.hunks).toHaveLength(1);
		expect(turnDiff.hunks.every(h => h.id === "")).toBe(true);
		expect(turnDiff.newText).toContain("LINE 2");
		const live = await repo.reviewDiff(before, "worktree", "a.txt");
		expect(live.hunks[0]!.id).not.toBe("");
		expect((await repo.reviewChanges(before, before)).files).toEqual([]);
		await expect(repo.reviewDiff(before, after, "untouched.txt")).rejects.toMatchObject({ status: 404 });
	});

	test("reverting files puts the work tree back to the turn's start without touching the index", async () => {
		const dir = repoWith({ "a.txt": "a\n", "gone.txt": "bye\n", "old.txt": "keep\n" });
		const repo = await GitRepo.open(dir);
		const before = await repo.snapshotWorktree();
		writeFileSync(join(dir, "a.txt"), "changed\n");
		rmSync(join(dir, "gone.txt"));
		writeFileSync(join(dir, "added.txt"), "hi\n");
		sh(dir, "mv", "old.txt", "renamed.txt");
		for (const path of ["a.txt", "gone.txt", "added.txt", "renamed.txt"]) await repo.revert(before, path);
		expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("a\n");
		expect(readFileSync(join(dir, "gone.txt"), "utf8")).toBe("bye\n");
		expect(readFileSync(join(dir, "old.txt"), "utf8")).toBe("keep\n");
		expect(() => readFileSync(join(dir, "added.txt"))).toThrow();
		expect(() => readFileSync(join(dir, "renamed.txt"))).toThrow();
		// git mv staged the rename; revert leaves the index as it was.
		expect(sh(dir, "diff", "--cached", "--name-status")).toContain("renamed.txt");
		expect((await repo.reviewChanges(before, "worktree")).files).toEqual([]);
		await expect(repo.revert(before, "a.txt")).rejects.toMatchObject({ status: 409 });
	});

	test("reverting one hunk undoes only that hunk; a stale hunk id is a 409", async () => {
		const dir = repoWith({ "a.txt": lines(30) });
		const repo = await GitRepo.open(dir);
		const before = await repo.snapshotWorktree();
		writeFileSync(join(dir, "a.txt"), lines(30).replace("line 2\n", "LINE 2\n").replace("line 28\n", "LINE 28\n"));
		const diff = await repo.reviewDiff(before, "worktree", "a.txt");
		expect(diff.hunks).toHaveLength(2);
		await repo.revert(before, "a.txt", diff.hunks[0]!.id);
		const content = readFileSync(join(dir, "a.txt"), "utf8");
		expect(content).toContain("line 2\n");
		expect(content).toContain("LINE 28\n");
		await expect(repo.revert(before, "a.txt", diff.hunks[0]!.id)).rejects.toMatchObject({ status: 409 });
	});

	test("a hunk revert leaves a mode change alone; a directory where a file was is refused", async () => {
		const dir = repoWith({ "run.sh": lines(10), config: "x=1\n" });
		const repo = await GitRepo.open(dir);
		const before = await repo.snapshotWorktree();
		writeFileSync(join(dir, "run.sh"), lines(10).replace("line 2\n", "LINE 2\n"));
		chmodSync(join(dir, "run.sh"), 0o755);
		rmSync(join(dir, "config"));
		mkdirSync(join(dir, "config"));
		writeFileSync(join(dir, "config/keep"), "k\n");
		const diff = await repo.reviewDiff(before, "worktree", "run.sh");
		await repo.revert(before, "run.sh", diff.hunks[0]!.id);
		expect(readFileSync(join(dir, "run.sh"), "utf8")).toBe(lines(10));
		expect(statSync(join(dir, "run.sh")).mode & 0o111).not.toBe(0);
		await expect(repo.revert(before, "config")).rejects.toMatchObject({ status: 409 });
		expect(readFileSync(join(dir, "config/keep"), "utf8")).toBe("k\n");
	});

	test("a side over the size limit is reported as too large without being read", async () => {
		const dir = repoWith({ "a.txt": "a\n" });
		const repo = await GitRepo.open(dir);
		const before = await repo.snapshotWorktree();
		writeFileSync(join(dir, "big.bin"), Buffer.alloc(1024 * 1024 + 1, 1));
		const diff = await repo.reviewDiff(before, "worktree", "big.bin");
		expect(diff.truncated).toBe(true);
		expect(diff.newText).toBe("");
	});

	test("tree ids are validated before git sees them", async () => {
		const dir = repoWith({ "a.txt": "a\n" });
		const repo = await GitRepo.open(dir);
		for (const bad of ["HEAD", "--all", "", "z".repeat(40), 42]) await expect(repo.resolveTree(bad)).rejects.toMatchObject({ status: 400 });
		await expect(repo.resolveTree("0".repeat(40))).rejects.toMatchObject({ status: 404 });
		const commit = sh(dir, "rev-parse", "HEAD").trim();
		await expect(repo.resolveTree(commit)).rejects.toMatchObject({ status: 404 });
	});

	test("a same-size rewrite in the same second as the index is still seen", async () => {
		const dir = repoWith({ "a.txt": "a\n" });
		// Only mtime, size and inode decide; ctime would differ from run to run.
		sh(dir, "config", "core.trustctime", "false");
		const T = 1_700_000_000.5;
		utimesSync(join(dir, "a.txt"), T, T);
		sh(dir, "update-index", "--refresh");
		// The index was written in the same second as a.txt's mtime, so git has to re-read
		// a.txt instead of trusting its cached stat.
		utimesSync(join(dir, ".git/index"), T, T);
		const repo = await GitRepo.open(dir);
		const before = await repo.snapshotWorktree();
		writeFileSync(join(dir, "a.txt"), "b\n");
		utimesSync(join(dir, "a.txt"), T, T);
		expect((await repo.reviewChanges(before, "worktree")).files.map(f => f.path)).toEqual(["a.txt"]);
	});

	test("review routes over HTTP", async () => {
		const gateway = await startGateway({ host: "127.0.0.1", port: 0, token: "tok", dataDir: join(tmp, "gw-review"), ompPath: FAKE_OMP, idleReapMs: 0 });
		try {
			const authed = { "x-gyre-token": "tok", "content-type": "application/json" };
			const dir = repoWith({ "a.txt": "a\n" });
			const { id } = (await (await fetch(`${gateway.url}/api/projects`, { method: "POST", headers: authed, body: JSON.stringify({ path: dir }) })).json()) as { id: string };
			const before = await (await GitRepo.open(dir)).snapshotWorktree();
			writeFileSync(join(dir, "a.txt"), "b\n");
			const base = `${gateway.url}/api/projects/${id}/review`;
			const files = await (await fetch(`${base}/files?from=${before}&to=worktree`, { headers: authed })).json();
			expect(files.files.map((f: { path: string }) => f.path)).toEqual(["a.txt"]);
			const diff = (await (await fetch(`${base}/diff?from=${before}&path=a.txt`, { headers: authed })).json()) as GitDiff;
			expect(diff.oldText).toBe("a\n");
			expect((await fetch(`${base}/files?from=nope`, { headers: authed })).status).toBe(400);
			const revert = await fetch(`${base}/revert`, { method: "POST", headers: authed, body: JSON.stringify({ from: before, path: "a.txt" }) });
			expect(revert.status).toBe(200);
			expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("a\n");
		} finally {
			await gateway.stop();
		}
	});
});

describe("workspace validation", () => {
	test("git panes, with or without a pinned revision, are saved; a non-string revision is rejected", () => {
		const ws = (pane: Record<string, unknown>) => ({ name: "w", updatedAt: 1, layout: { type: "pane", paneId: "g" }, panes: { g: { id: "g", ...pane } } });
		expect(validWorkspace(ws({ kind: "git", projectId: "p" }))).toBe(true);
		expect(validWorkspace(ws({ kind: "git", projectId: "p", revision: "HEAD~2" }))).toBe(true);
		expect(validWorkspace(ws({ kind: "git", projectId: "p", revision: 2 }))).toBe(false);
	});
});

describe("AI commit message (omp commit --legacy --dry-run)", () => {
	const OUT = "Staging all changes…\nReading staged changes…\n\nGenerated commit message:\nfeat(web): add git pane\n\n- one\n";

	test("parses the message and omp's validation warning", () => {
		expect(parseDryRun({ code: 0, stdout: OUT, stderr: "" })).toEqual({ message: "feat(web): add git pane\n\n- one", validationError: null });
		expect(parseDryRun({ code: 0, stdout: `\u001b[2m${OUT}\u001b[0m`, stderr: "Warning: generated message requires manual correction: summary too long\n" })).toEqual({
			message: "feat(web): add git pane\n\n- one",
			validationError: "summary too long",
		});
	});

	test("failures carry omp's last error line", () => {
		const error = (() => {
			try {
				parseDryRun({ code: 1, stdout: "Reading staged changes…\n", stderr: "stack…\nNo model available for commit\n" });
			} catch (e) {
				return e as GitError;
			}
		})();
		expect(error?.status).toBe(502);
		expect(error?.message).toContain("No model available for commit");
		expect(() => parseDryRun({ code: 0, stdout: "nothing useful", stderr: "" })).toThrow(/could not generate/);
	});

	test("refuses an empty index (omp would stage everything) and runs omp at the repository root", async () => {
		const dir = repoWith({ "a.txt": "a\n" });
		writeFileSync(join(dir, "a.txt"), "b\n");
		const repo = await GitRepo.open(dir);
		const calls: Array<{ args: string[]; cwd?: string }> = [];
		const omp = { run: async (args: string[], cwd?: string) => (calls.push({ args, cwd }), { code: 0, stdout: OUT, stderr: "" }) };
		await expect(generateCommitMessage(repo, omp)).rejects.toThrow(/stage changes/);
		expect(calls).toEqual([]);
		await repo.stage(["a.txt"]);
		expect((await generateCommitMessage(repo, omp)).message).toBe("feat(web): add git pane\n\n- one");
		expect(calls).toEqual([{ args: GENERATE_ARGS, cwd: repo.root }]);
	});
});
