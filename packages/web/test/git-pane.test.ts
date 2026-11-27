/** Git pane helpers and the `/git` local command. */
import { describe, expect, test } from "bun:test";
import type { GitFile, PaneSpec, Workspace } from "@gyre/protocol";
import { codeInfo, countLabel, groupFiles, hunkNewStart, nextSelection, splitPath, statusCode } from "../src/lib/git";

// The stores read browser globals when they load; give them just enough.
const g = globalThis as Record<string, unknown>;
const memoryStorage = () => {
	const m = new Map<string, string>();
	return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};
g.location ??= new URL("http://localhost/");
g.history ??= { replaceState() {} };
g.localStorage ??= memoryStorage();
g.sessionStorage ??= memoryStorage();
g.window ??= globalThis;
// Workspace saves go nowhere.
g.fetch = async () => new Response("{}", { headers: { "content-type": "application/json" } });

const file = (path: string, index: string, worktree: string, extra: Partial<GitFile> = {}): GitFile => ({ path, index, worktree, untracked: false, ...extra });

describe("git helpers", () => {
	test("groups: staged, changes (a file with both is in both), conflicts and untracked", () => {
		const groups = groupFiles({
			files: [
				file("a", "M", "."),
				file("b", ".", "M"),
				file("both", "M", "M"),
				file("new", "?", "?", { untracked: true }),
				file("c", "U", "U", { conflicted: true }),
			],
		});
		expect(groups.staged.map(f => f.path)).toEqual(["a", "both"]);
		expect(groups.changes.map(f => f.path)).toEqual(["b", "both", "new"]);
		expect(groups.conflicts.map(f => f.path)).toEqual(["c"]);
	});

	test("status letters, labels, counts and paths", () => {
		expect(statusCode(file("x", "A", "M"), "staged")).toBe("A");
		expect(statusCode(file("x", "A", "M"), "changes")).toBe("M");
		expect(statusCode(file("x", "?", "?", { untracked: true }), "changes")).toBe("U");
		expect(codeInfo("D").label).toBe("Deleted");
		expect(codeInfo("Z")).toEqual({ label: "Z", color: "var(--muted)" });
		expect(countLabel({ added: 3, removed: 1 })).toBe("+3 −1");
		expect(countLabel({ binary: true })).toBe("binary");
		expect(countLabel(undefined)).toBe("");
		expect(splitPath("src/lib/git.ts")).toEqual({ name: "git.ts", dir: "src/lib" });
		expect(splitPath("README.md")).toEqual({ name: "README.md", dir: "" });
	});

	test("hunk positions", () => {
		expect(hunkNewStart("@@ -10,4 +12,6 @@ function x()")).toBe(12);
		expect(hunkNewStart("@@ -1 +1 @@")).toBe(1);
		expect(hunkNewStart("@@@ -1,2 -1,2 +1,3 @@@")).toBe(1);
	});

	test("selection follows a file that moved between groups and clears when it is gone", () => {
		const groups = groupFiles({ files: [file("a", "M", ".")] });
		expect(nextSelection(groups, { path: "a", side: "staged" })).toEqual({ path: "a", side: "staged" });
		expect(nextSelection(groups, { path: "a", side: "changes" })).toEqual({ path: "a", side: "staged" });
		expect(nextSelection(groups, { path: "gone", side: "changes" })).toBeNull();
		expect(nextSelection(groups, null)).toBeNull();
	});
});

describe("/git local command", () => {
	async function setup(ompCommands: Array<{ name: string; source: string }> = []) {
		const { useApp } = await import("../src/store/app");
		const { useChats } = await import("../src/store/chats");
		const chatPane: PaneSpec = { id: "chat1", kind: "chat", projectId: "p1" };
		const ws: Workspace = { id: "w1", name: "Main", panes: { chat1: chatPane }, layout: { type: "pane", paneId: "chat1" }, updatedAt: 1 };
		useApp.setState({ workspaces: [ws], activeWorkspaceId: "w1" });
		useChats.setState({ chats: {} });
		useChats.getState().setInfo({ chatId: "chat1", projectId: "p1", cwd: "/p1", status: "ready" });
		useChats.setState(s => ({ chats: { chat1: { ...s.chats.chat1!, commands: ompCommands } } }));
		const { findLocalCommand, localCommands } = await import("../src/chat/localCommands");
		const gitPanes = () => Object.values(useApp.getState().activeWorkspace()?.panes ?? {}).filter(p => p.kind === "git");
		return { useApp, findLocalCommand, localCommands, gitPanes };
	}

	test("opens a Git pane for the chat's project next to the chat, and reuses it", async () => {
		const { findLocalCommand, gitPanes, useApp } = await setup();
		await findLocalCommand("chat1", "/git")!();
		expect(gitPanes()).toMatchObject([{ kind: "git", projectId: "p1" }]);
		expect(gitPanes()[0]!.revision).toBeUndefined();
		expect(useApp.getState().activeWorkspace()?.focusedPaneId).toBe(gitPanes()[0]!.id);
		await findLocalCommand("chat1", "/git")!();
		expect(gitPanes()).toHaveLength(1);
	});

	test("a revision argument opens a pinned pane; option-like arguments are refused", async () => {
		const { findLocalCommand, gitPanes } = await setup();
		await findLocalCommand("chat1", "/git HEAD~2")!();
		expect(gitPanes().map(p => p.revision)).toEqual(["HEAD~2"]);
		await findLocalCommand("chat1", "/git --all")!();
		expect(gitPanes()).toHaveLength(1);
	});

	test("omp's own /git wins if omp ever advertises it over RPC", async () => {
		const { findLocalCommand, localCommands } = await setup([{ name: "git", source: "builtin" }]);
		expect(findLocalCommand("chat1", "/git")).toBeUndefined();
		expect(localCommands([{ name: "git", source: "builtin" }]).some(c => c.name === "git")).toBe(false);
		expect(localCommands([]).some(c => c.name === "git")).toBe(true);
	});
});
