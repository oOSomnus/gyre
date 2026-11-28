import { afterAll, beforeAll, expect, test, spyOn } from "bun:test";
import { closeSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage, Workspace } from "@gyre/protocol";
import { ChatManager } from "../src/chats";
import { openContained } from "../src/contained-file";
import { listDir, readText, resolveInside } from "../src/fs";
import { OmpCli } from "../src/omp-cli";
import { PtyManager } from "../src/pty";
import { startGateway, type Gateway } from "../src/server";
import { deleteAgent, deleteMcp, listMcp, saveAgent, saveMcp } from "../src/studio";
import { validClientMessage, validWorkspace } from "../src/validation";

const dir = mkdtempSync(join(tmpdir(), "gyre-review-"));
const project = join(dir, "project");
const web = join(dir, "dist");
const fake = join(import.meta.dir, "fixtures/fake-omp.ts");
let gateway: Gateway;
const headers = { "x-gyre-token": "padded==", "content-type": "application/json" };
const request = (path: string, method = "GET", body?: unknown) =>
	fetch(`${gateway.url}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const until = async (check: () => boolean) => {
	const end = Date.now() + 3000;
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out");
		await Bun.sleep(10);
	}
};

beforeAll(async () => {
	mkdirSync(project);
	mkdirSync(web);
	mkdirSync(join(dir, "dist-private"));
	writeFileSync(join(project, "inside.txt"), "inside");
	writeFileSync(join(dir, "outside.txt"), "outside");
	writeFileSync(join(web, "index.html"), "<head></head><body>app</body>");
	writeFileSync(join(dir, "dist-private/secret.txt"), "private");
	gateway = await startGateway({ host: "127.0.0.1", port: 0, token: "padded==", dataDir: join(dir, "data"), ompPath: fake, webDist: web });
});
afterAll(async () => {
	await gateway?.stop();
	rmSync(dir, { recursive: true, force: true });
});

test("malformed unauthenticated frames return errors and leave gateway serving requests", async () => {
	const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}/ws`);
	const messages: ServerMessage[] = [];
	socket.onmessage = e => messages.push(JSON.parse(String(e.data)));
	await new Promise(resolve => {
		socket.onopen = resolve;
	});
	for (const bad of ["null", "[]", "1", '"text"', "{}", '{"t":"rpc"}', "{"]) socket.send(bad);
	await until(() => messages.length === 7);
	expect(messages.every(m => m.t === "error" && m.message === "malformed message")).toBe(true);
	socket.send(JSON.stringify({ t: "hello", token: "padded==" }));
	await until(() => messages.some(m => m.t === "welcome"));
	expect((await request("/api/projects")).status).toBe(200);
	socket.close();
});

test("cookie-only access preserves Base64 padding", async () => {
	const login = await request("/api/login", "POST", { token: "padded==" });
	const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
	expect((await fetch(`${gateway.url}/api/projects`, { headers: { cookie } })).status).toBe(200);
});

test("invalid workspace updates and stale clients cannot overwrite a saved layout", async () => {
	const workspace: Workspace = { id: "w", name: "original", panes: {}, layout: null, updatedAt: 1 };
	const first = await (await request("/api/workspaces/w", "PUT", workspace)).json();
	expect(first.revision).toBe(1);
	expect((await request("/api/workspaces/w", "PUT", { ...first, panes: null, floating: { p: {} } })).status).toBe(400);
	expect((await request("/api/workspaces/w", "PUT", { ...workspace, name: "stale" })).status).toBe(409);
	const saved = await (await request("/api/workspaces")).json();
	expect(saved[0].name).toBe("original");
	const second = await request("/api/workspaces/w", "PUT", { ...first, name: "new" });
	expect(second.status).toBe(200);
	await request("/api/workspaces/w", "DELETE");
	expect((await request("/api/workspaces/w", "PUT", { ...first, revision: 2 })).status).toBe(409);
});

test("static requests cannot read a sibling directory or an external symlink", async () => {
	symlinkSync(join(dir, "outside.txt"), join(web, "link.txt"));
	for (const path of ["/%2e%2e%2fdist-private/secret.txt", "/link.txt"]) {
		const response = await fetch(`${gateway.url}${path}`);
		expect(response.status).toBe(403);
		expect(await response.text()).not.toContain("outside");
	}
});

test("project reads preserve safe symlinks and do not disclose external-link metadata", async () => {
	symlinkSync(join(project, "inside.txt"), join(project, "safe-link"));
	symlinkSync(join(dir, "outside.txt"), join(project, "unsafe-link"));
	expect((await readText(project, "safe-link")).content).toBe("inside");
	await expect(readText(project, "unsafe-link")).rejects.toMatchObject({ status: 403 });
	expect((await listDir(project, "")).map(e => e.name)).not.toContain("unsafe-link");
	expect(await resolveInside("/", project)).toBe(project);
	await expect(resolveInside(join(dir, "missing-root"), "x")).rejects.toMatchObject({ status: 404 });
});

test("a symlink replacement after pathname validation cannot change the opened content", async () => {
	const root = join(dir, "race");
	mkdirSync(root);
	mkdirSync(join(root, "child"));
	writeFileSync(join(root, "child/data"), "checked");
	const checked = await resolveInside(root, "child/data");
	renameSync(join(root, "child"), join(root, "original"));
	symlinkSync(dir, join(root, "child"));
	expect(() => openContained(root, checked)).toThrow();
	// Reading the opened descriptor is independent of a later leaf replacement.
	rmSync(join(root, "child"));
	renameSync(join(root, "original"), join(root, "child"));
	const fd = openContained(root, checked);
	try {
		renameSync(checked, `${checked}.old`);
		symlinkSync(join(dir, "outside.txt"), checked);
		expect(readFileSync(fd, "utf8")).toBe("checked");
	} finally {
		closeSync(fd);
	}
});

test("project-scoped settings mutations are refused before running the global writer", async () => {
	const registered = await (await request("/api/projects", "POST", { path: project })).json();
	expect((await request("/api/omp/config", "PUT", { projectId: registered.id, key: "modelRoles", value: {} })).status).toBe(400);
	expect((await request(`/api/omp/config?projectId=${registered.id}&key=modelRoles`, "DELETE")).status).toBe(400);
});

test("chat preference filenames do not collide for punctuation variants", async () => {
	await request("/api/chats/review.a/plan-prefs", "PUT", { role: "slow", context: "fresh" });
	await request("/api/chats/review_a/plan-prefs", "PUT", { role: "default", context: "keep" });
	expect(await (await request("/api/chats/review.a/plan-prefs")).json()).toEqual({ role: "slow", context: "fresh" });
});

test("CLI timeout settles even when the executable ignores SIGTERM", async () => {
	const before = Date.now();
	await expect(new OmpCli(process.execPath).run(["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], undefined, 60)).rejects.toMatchObject({
		status: 504,
	});
	expect(Date.now() - before).toBeLessThan(1500);
});

test("MCP editing preserves hidden fields, clears auth and transfers disabled-list membership", () => {
	const agentDir = join(dir, "agents");
	mkdirSync(agentDir);
	writeFileSync(
		join(agentDir, "mcp.json"),
		JSON.stringify({
			disabledServers: ["old"],
			mcpServers: {
				old: {
					type: "http",
					url: "https://example.test",
					enabled: false,
					env: { A: "B" },
					headers: { Authorization: "Bearer old", Custom: "keep" },
					auth: { type: "oauth" },
				},
			},
		}),
	);
	const result = saveMcp({ scope: "user", agentDir, name: "new", previousName: "old", config: { type: "http", url: "https://example.test/new" } });
	expect(result.enabled).toBe(false);
	expect(result.config).toMatchObject({ env: { A: "B" }, headers: { Custom: "keep" }, enabled: false });
	expect(result.config.auth).toBeUndefined();
	deleteMcp({ scope: "user", agentDir, name: "new" });
	saveMcp({ scope: "user", agentDir, name: "new", config: { command: "example", args: ["/home/A B"] } });
	expect(listMcp(agentDir)[0]).toMatchObject({ enabled: true, config: { args: ["/home/A B"] } });
});

test("agent edit, rename and deletion use the listed backing file", () => {
	const agentDir = join(dir, "backing");
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	writeFileSync(join(agentDir, "agents/helper.md"), "---\nname: reviewer\ndescription: review\n---\nold");
	saveAgent({ scope: "user", agentDir, name: "reviewer", previousName: "reviewer", frontmatter: { description: "review" }, instructions: "edited" });
	expect(readFileSync(join(agentDir, "agents/helper.md"), "utf8")).toContain("edited");
	saveAgent({ scope: "user", agentDir, name: "renamed", previousName: "reviewer", frontmatter: { description: "review" }, instructions: "renamed" });
	expect(() => readFileSync(join(agentDir, "agents/helper.md"))).toThrow();
	deleteAgent({ scope: "user", agentDir, name: "renamed" });
	expect(() => readFileSync(join(agentDir, "agents/renamed.md"))).toThrow();
});

test("an old idle reaper cannot close a replacement chat with the same id", async () => {
	const manager = new ChatManager({ ompPath: fake, idleReapMs: 120 });
	const subscriber = { send() {} };
	try {
		const old = await manager.open({ chatId: "same", projectId: "p", cwd: project, subscriber });
		manager.unsubscribeAll(subscriber);
		await old.process.stop();
		const next = await manager.open({ chatId: "same", projectId: "p", cwd: project, subscriber: { send() {} } });
		await Bun.sleep(160);
		expect(manager.get("same")).toBe(next);
		expect(next.process.running).toBe(true);
	} finally {
		await manager.closeAll();
	}
});

test("PTY keys are project-scoped and explicit close notifies only once", async () => {
	const manager = new PtyManager();
	let exits = 0;
	const listener = {
		data() {},
		exit() {
			exits++;
		},
	};
	try {
		const a = manager.open({ key: "same", projectId: "a", cwd: project, cols: 80, rows: 24, listener });
		const b = manager.open({ key: "same", projectId: "b", cwd: project, cols: 80, rows: 24, listener });
		expect(a.ptyId).not.toBe(b.ptyId);
		manager.close(a.ptyId);
		await until(() => exits === 1);
		await Bun.sleep(30);
		expect(exits).toBe(1);
		expect(manager.list().map(p => p.projectId)).toEqual(["b"]);
	} finally {
		await manager.closeAll();
	}
});

test("a process exiting during initialization is never reported ready", async () => {
	const manager = new ChatManager({ ompPath: fake, envFor: () => ({ FAKE_EXIT_DURING_STATE: "1" }) });
	try {
		const chat = await manager.open({ projectId: "p", cwd: project });
		expect(chat.info.status).toBe("exited");
		expect(chat.process.running).toBe(false);
	} finally {
		await manager.closeAll();
	}
});

test("restart reads the active session and excludes subscribers disconnected during close", async () => {
	const manager = new ChatManager({ ompPath: fake, idleReapMs: 0 });
	const subscriber = { send() {} };
	let release!: () => void;
	const gate = new Promise<void>(resolve => {
		release = resolve;
	});
	try {
		const chat = await manager.open({ chatId: "restart", projectId: "p", cwd: project, subscriber });
		await chat.process.call({ type: "switch_session", sessionPath: "/tmp/current.jsonl" });
		const stop = chat.process.stop.bind(chat.process);
		const spy = spyOn(chat.process, "stop").mockImplementation(async () => {
			await gate;
			await stop();
		});
		const restart = manager.restart("restart");
		await until(() => !manager.get("restart"));
		manager.unsubscribeAll(subscriber);
		release();
		const next = await restart;
		spy.mockRestore();
		expect(next?.info.sessionPath).toBe("/tmp/current.jsonl");
		expect(next?.subscribers.size).toBe(0);
	} finally {
		release();
		await manager.closeAll();
	}
});

test("fake omp preserves dialog answers split inside a UTF-8 code point", async () => {
	const child = Bun.spawn([fake], { stdin: "pipe", stdout: "pipe", stderr: "ignore", cwd: project });
	let output = "";
	const decoder = new TextDecoder();
	const reading = (async () => {
		for await (const chunk of child.stdout) output += decoder.decode(chunk, { stream: true });
	})();
	try {
		child.stdin.write('{"id":"test","type":"prompt","message":"hello"}\n');
		child.stdin.flush();
		await until(() => output.includes('"id":"ui1"'));
		const answer = Buffer.from(JSON.stringify({ type: "extension_ui_response", id: "ui1", value: "💡" }) + "\n");
		const cut = answer.indexOf(Buffer.from("💡")) + 2;
		child.stdin.write(answer.subarray(0, cut));
		child.stdin.flush();
		await Bun.sleep(10);
		child.stdin.write(answer.subarray(cut));
		child.stdin.flush();
		await until(() => output.includes("picked=💡"));
		expect(output).not.toContain("�");
	} finally {
		child.stdin.end();
		await child.exited;
		await reading;
	}
});

test("agent renames reject logical-name and backing-path collisions without changing either file", () => {
	const agentDir = join(dir, "rename-agents");
	const agents = join(agentDir, "agents");
	mkdirSync(agents, { recursive: true });
	writeFileSync(join(agents, "source.md"), "---\nname: source\ndescription: source\n---\nsource instructions");
	writeFileSync(join(agents, "custom.md"), "---\nname: occupied\ndescription: occupied\n---\nkeep");
	writeFileSync(join(agents, "destination.md"), "---\nname: different\ndescription: different\n---\nkeep path");
	for (const name of ["occupied", "destination"]) {
		expect(() => saveAgent({ scope: "user", agentDir, previousName: "source", name, frontmatter: { description: "new" }, instructions: "overwrite" }))
			.toThrow("already exists");
	}
	expect(readFileSync(join(agents, "source.md"), "utf8")).toContain("source instructions");
	expect(readFileSync(join(agents, "custom.md"), "utf8")).toContain("keep");
	expect(readFileSync(join(agents, "destination.md"), "utf8")).toContain("keep path");
});

test("MCP renames cannot replace another server and project enabled state is consistent", () => {
	const agentDir = join(dir, "rename-mcp");
	mkdirSync(agentDir);
	for (const name of ["old", "new"]) saveMcp({ scope: "user", agentDir, name, config: { command: name } });
	expect(() => saveMcp({ scope: "user", agentDir, name: "new", previousName: "old", config: { command: "overwrite" } })).toThrow("already exists");
	expect(listMcp(agentDir).map(s => [s.name, s.config.command])).toEqual([["old", "old"], ["new", "new"]]);
	mkdirSync(join(agentDir, ".omp"));
	writeFileSync(join(agentDir, ".omp/mcp.json"), JSON.stringify({ disabledServers: ["server"], mcpServers: {} }));
	const saved = saveMcp({ scope: "project", agentDir, projectPath: agentDir, name: "server", config: { command: "cmd" } });
	expect(saved.enabled).toBe(true);
	expect(listMcp(agentDir, agentDir).find(s => s.scope === "project")?.enabled).toBe(saved.enabled);
});

test("terminal dimensions and duplicate workspace leaves are rejected at the boundary", () => {
	for (const size of [0, -1, 1.5, 65536, Infinity]) {
		for (const dimension of ["cols", "rows"]) {
			const dimensions = { cols: 80, rows: 24, [dimension]: size };
			expect(validClientMessage({ t: "pty_open", reqId: "x", projectId: "p", ...dimensions })).toBe(false);
			expect(validClientMessage({ t: "pty_resize", ptyId: "x", ...dimensions })).toBe(false);
		}
	}
	expect(validClientMessage({ t: "pty_resize", ptyId: "x", cols: 1, rows: 65535 })).toBe(true);
	const leaf = { type: "pane", paneId: "p" };
	const workspace = { name: "duplicate", updatedAt: 1, panes: { p: { id: "p", kind: "chat" } }, layout: { type: "split", direction: "row", sizes: [50, 50], children: [leaf, leaf] } };
	expect(validWorkspace(workspace)).toBe(false);
	expect(validWorkspace({ ...workspace, layout: leaf })).toBe(true);
});

test("deleted workspace identities cannot be recreated by a delayed initial save", async () => {
	const ws = { name: "old", panes: {}, layout: null, updatedAt: 1 };
	expect((await request("/api/workspaces/deleted-generation", "PUT", ws)).status).toBe(200);
	await request("/api/workspaces/deleted-generation", "DELETE");
	expect((await request("/api/workspaces/deleted-generation", "PUT", ws)).status).toBe(409);
	expect((await request("/api/workspaces/deleted-generation", "PUT", { ...ws, revision: 1 })).status).toBe(409);
	expect((await request("/api/workspaces/new-generation", "PUT", ws)).status).toBe(200);
});

test("a missing configured web root returns 404", async () => {
	const server = await startGateway({ host: "127.0.0.1", port: 0, token: "test", dataDir: join(dir, "missing-ui-data"), ompPath: fake, webDist: join(dir, "missing-ui") });
	try {
		expect((await fetch(server.url)).status).toBe(404);
	} finally {
		await server.stop();
	}
});

test("every stop caller waits for teardown, even when a cleanup branch fails", async () => {
	const server = await startGateway({ host: "127.0.0.1", port: 0, token: "test", dataDir: join(dir, "stop-data"), ompPath: fake });
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const close = spyOn(server.chats, "closeAll").mockImplementation(async () => { await gate; throw new Error("waitpid failed"); });
	const storeClose = spyOn(server.store, "close");
	const first = server.stop();
	const second = server.stop();
	expect(first).toBe(second);
	expect(storeClose).not.toHaveBeenCalled();
	release();
	await Promise.all([first, second]);
	expect(storeClose).toHaveBeenCalledTimes(1);
	close.mockRestore();
	storeClose.mockRestore();
});

test("concurrent browser assignment patches merge against the latest saved map", async () => {
	const cli = new OmpCli(fake);
	let assignments: Record<string, string> = { existing: "p/original" };
	const get = spyOn(cli, "configGet").mockImplementation(async () => ({ ...assignments }));
	const set = spyOn(cli, "configSet").mockImplementation(async (_key, value) => {
		await Bun.sleep(20);
		assignments = value as Record<string, string>;
		return value;
	});
	const server = await startGateway({ host: "127.0.0.1", port: 0, token: "padded==", dataDir: join(dir, "assignments"), ompPath: fake, ompCli: cli });
	try {
		const patch = (name: string, value: string | null) => fetch(`${server.url}/api/omp/config`, { method: "PATCH", headers, body: JSON.stringify({ key: "task.agentModelOverrides", name, value }) });
		expect((await Promise.all([patch("plan", "p/planner"), patch("task", "p/worker")])).every(r => r.ok)).toBe(true);
		expect(assignments).toEqual({ existing: "p/original", plan: "p/planner", task: "p/worker" });
		await patch("plan", null);
		expect(assignments).toEqual({ existing: "p/original", task: "p/worker" });
	} finally {
		await server.stop();
		get.mockRestore();
		set.mockRestore();
	}
});

test("restart leaves a chat closed while its state was being read", async () => {
	const manager = new ChatManager({ ompPath: fake, idleReapMs: 0 });
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	try {
		const chat = await manager.open({ chatId: "closed-during-restart", projectId: "p", cwd: project });
		const call = spyOn(chat.process, "call").mockImplementation(async <T>() => { await gate; return { sessionFile: "/tmp/active.jsonl" } as T; });
		const restarting = manager.restart(chat.info.chatId);
		await manager.close(chat.info.chatId);
		release();
		expect(await restarting).toBeUndefined();
		call.mockRestore();
		expect(manager.get(chat.info.chatId)).toBeUndefined();
	} finally {
		release();
		await manager.closeAll();
	}
});

test("restart transfers subscribers arriving during the state refresh", async () => {
	const manager = new ChatManager({ ompPath: fake, idleReapMs: 0 });
	const late = { send() {}, connected: true };
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	try {
		const chat = await manager.open({ chatId: "late-subscriber", projectId: "p", cwd: project });
		const call = spyOn(chat.process, "call").mockImplementation(async <T>() => { await gate; return { sessionFile: "/tmp/active.jsonl" } as T; });
		const restarting = manager.restart(chat.info.chatId);
		manager.subscribe(chat, late);
		release();
		const next = await restarting;
		call.mockRestore();
		expect(next?.subscribers.has(late)).toBe(true);
		expect(chat.subscribers.size).toBe(0);
	} finally {
		release();
		await manager.closeAll();
	}
});

test("a superseded PTY attachment cannot detach its replacement on the same socket", async () => {
	const registered = await (await request("/api/projects", "POST", { path: project })).json();
	const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}/ws`);
	const messages: ServerMessage[] = [];
	socket.onmessage = e => messages.push(JSON.parse(String(e.data)));
	await new Promise(resolve => { socket.onopen = resolve; });
	try {
		socket.send(JSON.stringify({ t: "hello", token: "padded==" }));
		await until(() => messages.some(m => m.t === "welcome"));
		const open = async (reqId: string) => {
			socket.send(JSON.stringify({ t: "pty_open", reqId, projectId: registered.id, key: "remount", cols: 80, rows: 24 }));
			await until(() => messages.some(m => m.t === "result" && m.reqId === reqId));
			const response = messages.find(m => m.t === "result" && m.reqId === reqId) as Extract<ServerMessage, { t: "result" }>;
			if (!response.ok) throw new Error(response.error);
			return response.data as { ptyId: string; attachmentId: string };
		};
		const first = await open("first");
		const next = await open("next");
		expect(next.ptyId).toBe(first.ptyId);
		socket.send(JSON.stringify({ t: "pty_detach", ...first }));
		socket.send(JSON.stringify({ t: "pty_input", ptyId: next.ptyId, data: "printf 'still attached\\n'\r" }));
		await until(() => messages.some(m => m.t === "pty_data" && m.data.includes("still attached")));
		const inventory = await (await request("/api/ptys")).json();
		expect(inventory.find((p: { ptyId: string }) => p.ptyId === next.ptyId)?.attached).toBe(1);
		socket.send(JSON.stringify({ t: "pty_detach", ...next }));
		const attachedCount = async () => ((await (await request("/api/ptys")).json()) as Array<{ ptyId: string; attached: number }>).find(p => p.ptyId === next.ptyId)?.attached;
		const deadline = Date.now() + 3000;
		while ((await attachedCount()) !== 0) {
			if (Date.now() > deadline) throw new Error("PTY still attached after detach");
			await Bun.sleep(10);
		}
		const detached = await (await request("/api/ptys")).json();
		expect(detached.find((p: { ptyId: string }) => p.ptyId === next.ptyId)?.attached).toBe(0);
		socket.send(JSON.stringify({ t: "pty_close", ptyId: next.ptyId }));
	} finally {
		socket.close();
	}
});

test("the app page, which carries the token, cannot be framed by another site", async () => {
	const response = await fetch(`${gateway.url}/`);
	expect(response.headers.get("x-frame-options")).toBe("DENY");
	expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
});
