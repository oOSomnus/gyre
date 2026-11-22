import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "@gyre/protocol";
import { ChatManager, type Subscriber } from "../src/chats";
import { configKeyAllowed, OmpCli } from "../src/omp-cli";
import { OmpCommandError, OmpProcess } from "../src/omp-process";
import { type Gateway, startGateway } from "../src/server";
import { deleteMcp, listAgents, listMcp, parseAgentMarkdown, renderAgentMarkdown, saveAgent, saveMcp, setMcpEnabled, StudioError } from "../src/studio";

const FAKE_OMP = join(import.meta.dir, "fixtures/fake-omp.ts");
const tmp = mkdtempSync(join(tmpdir(), "gyre-test-"));
const settingsTmp = mkdtempSync(join(tmpdir(), "gyre-settings-"));

afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
	rmSync(settingsTmp, { recursive: true, force: true });
});

function collector() {
	const messages: ServerMessage[] = [];
	const subscriber: Subscriber = { send: m => messages.push(m) };
	const frames = () => messages.flatMap(m => (m.t === "frame" ? [m.frame] : []));
	return { messages, subscriber, frames };
}

async function until(check: () => boolean, timeoutMs = 5000) {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
		await Bun.sleep(20);
	}
}

describe("OmpProcess", () => {
	test("negotiates protocol v2, correlates responses and reassembles chunked frames", async () => {
		const frames: unknown[] = [];
		const proc = new OmpProcess({ cwd: tmp, ompPath: FAKE_OMP, onFrame: f => frames.push(f), onExit: () => {} });
		const ready = await proc.start();
		expect(ready.type).toBe("ready");
		expect(proc.protocolVersion).toBe(2);

		const state = await proc.call<{ sessionId: string }>({ type: "get_state" });
		expect(state.sessionId).toBe("s1");

		// 1.5 MB exceeds the 1 MiB physical frame limit, so it arrives as rpc_chunk frames.
		const big = await proc.call<{ blob: string }>({ type: "big" });
		expect(big.blob.length).toBe(1_500_000);

		await expect(proc.call({ type: "does_not_exist" })).rejects.toBeInstanceOf(OmpCommandError);
		await proc.stop();
		expect(proc.running).toBe(false);
	});
});

describe("ChatManager", () => {
	test("streams frames, tracks pending dialogs, replays them, and round-trips answers", async () => {
		const manager = new ChatManager({ ompPath: FAKE_OMP, idleReapMs: 0 });
		const a = collector();
		const chat = await manager.open({ projectId: "p1", cwd: tmp, subscriber: a.subscriber });
		expect(chat.info.status).toBe("ready");
		expect(chat.info.sessionPath).toBe("/tmp/fake-session.jsonl");

		const ack = await chat.process.call<{ agentInvoked: boolean }>({ type: "prompt", message: "hi" });
		expect(ack.agentInvoked).toBe(true);
		await until(() => chat.pendingUi.has("ui1"));
		expect(chat.busy).toBe(true);
		expect(a.frames().map(f => f.type)).toContain("message_update");

		// A late subscriber (e.g. a reloaded page) gets the open dialog replayed.
		const b = collector();
		manager.subscribe(chat, b.subscriber);
		expect(b.frames().some(f => f.type === "extension_ui_request" && f.id === "ui1")).toBe(true);

		manager.resolveUi(chat, "ui1");
		chat.process.respondUi({ id: "ui1", value: "Green" });
		await until(() => a.frames().some(f => f.type === "session_settled"));
		expect(a.frames().some(f => f.type === "notice" && f.message === "picked=Green")).toBe(true);
		expect(chat.busy).toBe(false);
		expect(chat.pendingUi.size).toBe(0);

		await manager.closeAll();
	});

	test("reports a failed start without throwing", async () => {
		const manager = new ChatManager({ ompPath: join(tmp, "missing-omp") });
		const chat = await manager.open({ projectId: "p1", cwd: tmp });
		expect(chat.info.status).toBe("exited");
		expect(chat.info.error).toBeTruthy();
	});
});

describe("HTTP + WebSocket gateway", () => {
	let gateway: Gateway;
	const project = join(tmp, "project");

	beforeAll(async () => {
		mkdirSync(join(project, "src"), { recursive: true });
		writeFileSync(join(project, "src/a.ts"), "export const a = 1;\n");
		writeFileSync(join(tmp, "secret.txt"), "outside");
		gateway = await startGateway({ host: "127.0.0.1", port: 0, token: "tok", dataDir: tmp, ompPath: FAKE_OMP, idleReapMs: 0 });
	});
	afterAll(async () => {
		await gateway.stop();
	});

	const authed = { "x-gyre-token": "tok", "content-type": "application/json" };

	test("requires the token and a loopback Host header", async () => {
		expect((await fetch(`${gateway.url}/api/projects`)).status).toBe(401);
		expect((await fetch(`${gateway.url}/api/projects`, { headers: { ...authed, host: "evil.example" } })).status).toBe(403);
		expect((await fetch(`${gateway.url}/api/health`)).status).toBe(200);
	});

	test("projects, file listing and traversal protection", async () => {
		const bad = await fetch(`${gateway.url}/api/projects`, { method: "POST", headers: authed, body: JSON.stringify({ path: join(tmp, "nope") }) });
		expect(bad.status).toBe(400);
		const created = await (await fetch(`${gateway.url}/api/projects`, { method: "POST", headers: authed, body: JSON.stringify({ path: project }) })).json();
		expect(created.name).toBe("project");

		const list = await (await fetch(`${gateway.url}/api/fs/list?projectId=${created.id}&path=src`, { headers: authed })).json();
		expect(list.map((e: { name: string }) => e.name)).toEqual(["a.ts"]);
		const file = await (await fetch(`${gateway.url}/api/fs/read?projectId=${created.id}&path=src/a.ts`, { headers: authed })).json();
		expect(file.content).toContain("export const a");

		const escape = await fetch(`${gateway.url}/api/fs/read?projectId=${created.id}&path=../secret.txt`, { headers: authed });
		expect(escape.status).toBe(403);
	});

	test("websocket: rejects bad tokens, opens chats and forwards rpc", async () => {
		const bad = new WebSocket(`ws://127.0.0.1:${gateway.port}/ws`);
		const closed = new Promise<number>(resolve => (bad.onclose = e => resolve(e.code)));
		bad.onopen = () => bad.send(JSON.stringify({ t: "hello", token: "wrong" }));
		expect(await closed).toBe(4401);

		const registered = await (await fetch(`${gateway.url}/api/projects`, { method: "POST", headers: authed, body: JSON.stringify({ path: project }) })).json();
		const projects = [registered];
		const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}/ws`);
		const messages: ServerMessage[] = [];
		ws.onmessage = e => messages.push(JSON.parse(String(e.data)));
		await new Promise(resolve => (ws.onopen = resolve));
		ws.send(JSON.stringify({ t: "hello", token: "tok" }));
		await until(() => messages.some(m => m.t === "welcome"));

		ws.send(JSON.stringify({ t: "open_chat", reqId: "o1", projectId: projects[0].id }));
		await until(() => messages.some(m => m.t === "result" && m.reqId === "o1"));
		const opened = messages.find(m => m.t === "result" && m.reqId === "o1");
		expect(opened && opened.t === "result" && opened.ok).toBe(true);
		const chatId = opened && opened.t === "result" && opened.ok ? (opened.data as { chatId: string }).chatId : "";

		ws.send(JSON.stringify({ t: "rpc", reqId: "r1", chatId, command: { type: "get_available_commands" } }));
		await until(() => messages.some(m => m.t === "result" && m.reqId === "r1"));
		const commands = messages.find(m => m.t === "result" && m.reqId === "r1");
		expect(commands && commands.t === "result" && commands.ok && (commands.data as { commands: unknown[] }).commands.length).toBe(1);

		ws.send(JSON.stringify({ t: "rpc", reqId: "r2", chatId, command: { type: "bogus" } }));
		await until(() => messages.some(m => m.t === "result" && m.reqId === "r2"));
		const failed = messages.find(m => m.t === "result" && m.reqId === "r2");
		expect(failed && failed.t === "result" && !failed.ok && failed.code).toBe("unknown_command");
		ws.close();
	});
});

// ---------------------------------------------------------------- settings, studio files, remote access

describe("omp config allowlist", () => {
	test("only UI-managed keys are allowed", () => {
		expect(configKeyAllowed("modelRoles")).toBe(true);
		expect(configKeyAllowed("modelRoles.smol")).toBe(true);
		expect(configKeyAllowed("task.agentModelOverrides")).toBe(true);
		expect(configKeyAllowed("mcp.enableProjectConfig")).toBe(true);
		expect(configKeyAllowed("enabledProviders")).toBe(true);
		expect(configKeyAllowed("task.maxConcurrency")).toBe(false);
		expect(configKeyAllowed("providers.openai.apiKey")).toBe(false);
		expect(configKeyAllowed("modelRolesX")).toBe(false);
	});
});

describe("Agent Studio files", () => {
	const agentDir = join(settingsTmp, "agent");
	const project = join(settingsTmp, "proj");

	test("frontmatter round-trips", () => {
		const text = renderAgentMarkdown({ name: "x", description: "Does x", tools: ["read", "grep"], model: "@smol", empty: "" }, "Be brief.");
		const parsed = parseAgentMarkdown(text);
		expect(parsed.frontmatter).toEqual({ name: "x", description: "Does x", tools: ["read", "grep"], model: "@smol" });
		expect(parsed.instructions.trim()).toBe("Be brief.");
	});

	test("save validates names and descriptions and confines files", () => {
		expect(() => saveAgent({ scope: "user", agentDir, name: "../evil", frontmatter: { description: "d" }, instructions: "" })).toThrow(StudioError);
		expect(() => saveAgent({ scope: "user", agentDir, name: "main", frontmatter: { description: "d" }, instructions: "" })).toThrow(/reserved/);
		expect(() => saveAgent({ scope: "user", agentDir, name: "ok", frontmatter: {}, instructions: "" })).toThrow(/description/);
		expect(() => saveAgent({ scope: "project", agentDir, name: "ok", frontmatter: { description: "d" }, instructions: "" })).toThrow(/projectId/);
		const saved = saveAgent({
			scope: "user",
			agentDir,
			name: "reviewer",
			frontmatter: { description: "Strict review", model: "@slow" },
			instructions: "Review hard.",
		});
		expect(saved.path).toBe(join(agentDir, "agents", "reviewer.md"));
		expect(readFileSync(saved.path ?? "", "utf8")).toContain('model: "@slow"');
	});

	test("rename removes the old file; list applies omp precedence", () => {
		saveAgent({ scope: "user", agentDir, name: "reviewer", frontmatter: { description: "Old" }, instructions: "" });
		expect(existsSync(join(agentDir, "agents", "reviewer.md"))).toBe(true);
		saveAgent({ scope: "user", agentDir, name: "reviewer2", previousName: "reviewer", frontmatter: { description: "Renamed" }, instructions: "" });
		expect(existsSync(join(agentDir, "agents", "reviewer.md"))).toBe(false);
		mkdirSync(project, { recursive: true });
		saveAgent({ scope: "project", agentDir, projectPath: project, name: "scout", frontmatter: { description: "Project scout" }, instructions: "" });
		const list = listAgents({
			agentDir,
			projectPath: project,
			bundled: [{ name: "scout", content: "---\nname: scout\ndescription: Bundled scout\n---\nbody" }],
		});
		const scouts = list.filter(a => a.name === "scout");
		expect(scouts.map(a => [a.scope, Boolean(a.shadowed)])).toEqual([
			["project", false],
			["bundled", true],
		]);
		expect(list.some(a => a.name === "reviewer2" && a.scope === "user")).toBe(true);
	});

	test("MCP servers: save, enable/disable, delete, preserving other keys", () => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ $schema: "x", mcpServers: { keep: { type: "stdio", command: "keep" } } }));
		expect(() => saveMcp({ scope: "user", agentDir, name: "bad name", config: { command: "x" } })).toThrow(StudioError);
		expect(() => saveMcp({ scope: "user", agentDir, name: "web", config: { type: "http", url: "not a url" } })).toThrow(/url/);
		saveMcp({ scope: "user", agentDir, name: "gh", config: { command: "npx", args: ["-y", "gh-mcp"] } });
		setMcpEnabled({ scope: "user", agentDir, name: "gh", enabled: false });
		let list = listMcp(agentDir);
		expect(list.find(s => s.name === "gh")?.enabled).toBe(false);
		expect(list.find(s => s.name === "gh")?.config.type).toBe("stdio");
		setMcpEnabled({ scope: "user", agentDir, name: "gh", enabled: true });
		deleteMcp({ scope: "user", agentDir, name: "keep" });
		list = listMcp(agentDir);
		expect(list.map(s => [s.name, s.enabled])).toEqual([["gh", true]]);
		expect(JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8")).$schema).toBe("x");
	});
});

describe("ChatManager: extensions, per-chat env and restart", () => {
	test("passes extensions and per-chat env to omp, and restarts on the same chat id", async () => {
		const manager = new ChatManager({
			ompPath: FAKE_OMP,
			extensions: ["/path/to/ext.ts"],
			envFor: chatId => ({ GYRE_PLAN_PREFS: `/prefs/${chatId}.json`, PLANNOTATOR_BROWSER: "none" }),
		});
		const messages: ServerMessage[] = [];
		const subscriber: Subscriber = { send: m => messages.push(m) };
		const chat = await manager.open({ projectId: "p", cwd: settingsTmp, chatId: "c1", subscriber });
		const env = await chat.process.call<{ planPrefs: string; browser: string; argv: string[] }>({ type: "get_env" });
		expect(env.planPrefs).toBe("/prefs/c1.json");
		expect(env.browser).toBe("none");
		expect(env.argv).toContain("-e");
		expect(env.argv).toContain("/path/to/ext.ts");
		const restarted = await manager.restart("c1");
		expect(restarted?.info.chatId).toBe("c1");
		expect(restarted?.info.status).toBe("ready");
		expect(restarted?.subscribers.has(subscriber)).toBe(true);
		expect(restarted?.process).not.toBe(chat.process);
		await manager.closeAll();
	});
});

class FakeCli extends OmpCli {
	store: Record<string, unknown> = { modelRoles: { smol: "a/b" } };
	override async configGet(key: string) {
		if (!configKeyAllowed(key)) return super.configGet(key);
		return this.store[key] ?? null;
	}
	override async configSet(key: string, value: unknown) {
		if (!configKeyAllowed(key)) return super.configSet(key, value);
		this.store[key] = value;
		return value;
	}
	override async agentDir() {
		return join(settingsTmp, "agent-gw");
	}
	override async bundledAgents() {
		return [];
	}
}

describe("Gateway: settings, plan prefs, remote access and terminals", () => {
	let gateway: Gateway;
	const web = join(settingsTmp, "web");
	const project = join(settingsTmp, "gwproject");
	const authed = { "x-gyre-token": "tok", "content-type": "application/json" };
	const cli = new FakeCli();

	beforeAll(async () => {
		mkdirSync(web, { recursive: true });
		mkdirSync(join(project, "src"), { recursive: true });
		writeFileSync(join(project, "src/a.ts"), "x");
		writeFileSync(join(web, "index.html"), "<html><head></head><body></body></html>");
		gateway = await startGateway({
			host: "127.0.0.1",
			port: 0,
			token: "tok",
			dataDir: join(settingsTmp, "data"),
			webDist: web,
			ompPath: FAKE_OMP,
			idleReapMs: 0,
			allowedHosts: ["laptop.tailnet.ts.net"],
			ompCli: cli,
		});
	});
	afterAll(async () => {
		await gateway.stop();
	});

	test("omp config: allowlisted keys read/write, others refused", async () => {
		const got = await (await fetch(`${gateway.url}/api/omp/config?key=modelRoles`, { headers: authed })).json();
		expect(got.value).toEqual({ smol: "a/b" });
		const put = await fetch(`${gateway.url}/api/omp/config`, {
			method: "PUT",
			headers: authed,
			body: JSON.stringify({ key: "modelRoles", value: { plan: "x/y" } }),
		});
		expect(put.status).toBe(200);
		expect(cli.store.modelRoles).toEqual({ plan: "x/y" });
		const refused = await fetch(`${gateway.url}/api/omp/config?key=providers.openai.apiKey`, { headers: authed });
		expect(refused.status).toBe(403);
	});

	test("plan prefs are sanitized and reach the chat's omp process", async () => {
		const bad = await (
			await fetch(`${gateway.url}/api/chats/c9/plan-prefs`, { method: "PUT", headers: authed, body: JSON.stringify({ role: "../x", context: "weird" }) })
		).json();
		expect(bad).toEqual({ role: "default", context: "compact" });
		const good = await (
			await fetch(`${gateway.url}/api/chats/c9/plan-prefs`, { method: "PUT", headers: authed, body: JSON.stringify({ role: "slow", context: "fresh" }) })
		).json();
		expect(good).toEqual({ role: "slow", context: "fresh" });
		const created = await (await fetch(`${gateway.url}/api/projects`, { method: "POST", headers: authed, body: JSON.stringify({ path: project }) })).json();
		const chat = await gateway.chats.open({ projectId: created.id, cwd: project, chatId: "c9" });
		const env = await chat.process.call<{ planPrefs: string; inbox: string }>({ type: "get_env" });
		expect(JSON.parse(readFileSync(env.planPrefs, "utf8"))).toEqual({ role: "slow", context: "fresh" });
		expect(env.inbox).toBe("0");
		const stat = await (
			await fetch(`${gateway.url}/api/fs/stat`, {
				method: "POST",
				headers: authed,
				body: JSON.stringify({ projectId: created.id, paths: ["src/a.ts", "src", "nope.ts", "../secret"] }),
			})
		).json();
		expect(stat).toEqual({ "src/a.ts": "file", src: "dir" });
	});

	test("agents and kv endpoints", async () => {
		const saved = await fetch(`${gateway.url}/api/agents`, {
			method: "PUT",
			headers: authed,
			body: JSON.stringify({ scope: "user", name: "helper", frontmatter: { description: "Helps" }, instructions: "Help." }),
		});
		expect(saved.status).toBe(200);
		const list = await (await fetch(`${gateway.url}/api/agents`, { headers: authed })).json();
		expect(list.map((a: { name: string }) => a.name)).toContain("helper");
		const invalid = await fetch(`${gateway.url}/api/agents`, {
			method: "PUT",
			headers: authed,
			body: JSON.stringify({ scope: "user", name: "a b", frontmatter: { description: "x" } }),
		});
		expect(invalid.status).toBe(400);
		await fetch(`${gateway.url}/api/kv/ui.agentDrafts`, { method: "PUT", headers: authed, body: JSON.stringify({ a: 1 }) });
		expect(await (await fetch(`${gateway.url}/api/kv/ui.agentDrafts`, { headers: authed })).json()).toEqual({ a: 1 });
		expect((await fetch(`${gateway.url}/api/kv/settings`, { headers: authed })).status).toBe(404);
	});

	test("remote access: allowed hosts, no token in the page, login cookie", async () => {
		// Remote host name: allowed, but the page carries no token.
		const page = await (await fetch(`${gateway.url}/`, { headers: { host: "laptop.tailnet.ts.net" } })).text();
		expect(page).not.toContain('"tok"');
		expect(page).toContain('"remote":true');
		expect((await fetch(`${gateway.url}/`, { headers: { host: "evil.example" } })).status).toBe(403);
		// Local page gets the token.
		expect(await (await fetch(`${gateway.url}/`)).text()).toContain('"token":"tok"');
		// Login exchanges the token for a cookie that authorizes the API and the page.
		expect((await fetch(`${gateway.url}/api/login`, { method: "POST", body: JSON.stringify({ token: "nope" }) })).status).toBe(401);
		const login = await fetch(`${gateway.url}/api/login`, { method: "POST", body: JSON.stringify({ token: "tok" }) });
		const cookie = login.headers.get("set-cookie") ?? "";
		expect(cookie).toContain("HttpOnly");
		const pair = cookie.split(";")[0] ?? "";
		expect((await fetch(`${gateway.url}/api/projects`, { headers: { cookie: pair } })).status).toBe(200);
		const remotePage = await (await fetch(`${gateway.url}/`, { headers: { host: "laptop.tailnet.ts.net", cookie: pair } })).text();
		expect(remotePage).toContain('"token":"tok"');
	});

	test("terminals survive detach and replay scrollback on reattach", async () => {
		const registered = await (await fetch(`${gateway.url}/api/projects`, { method: "POST", headers: authed, body: JSON.stringify({ path: project }) })).json();
		const projects = [registered];
		const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}/ws`);
		const inbox: ServerMessage[] = [];
		ws.onmessage = e => inbox.push(JSON.parse(String(e.data)));
		await new Promise(resolve => (ws.onopen = resolve));
		ws.send(JSON.stringify({ t: "hello", token: "tok" }));
		await until(() => inbox.some(m => m.t === "welcome"));
		ws.send(JSON.stringify({ t: "pty_open", reqId: "p1", projectId: projects[0].id, cols: 80, rows: 20, key: "pane-1" }));
		await until(() => inbox.some(m => m.t === "result" && m.reqId === "p1"));
		const first = inbox.find(m => m.t === "result" && m.reqId === "p1") as { data: { ptyId: string; reused: boolean } };
		expect(first.data.reused).toBe(false);
		ws.send(JSON.stringify({ t: "pty_input", ptyId: first.data.ptyId, data: "printf 'gy-%s\\n' 42\n" }));
		await until(() => inbox.some(m => m.t === "pty_data" && m.data.includes("gy-42")));
		ws.send(JSON.stringify({ t: "pty_detach", ptyId: first.data.ptyId }));
		inbox.length = 0;
		ws.send(JSON.stringify({ t: "pty_open", reqId: "p2", projectId: projects[0].id, cols: 100, rows: 20, key: "pane-1" }));
		await until(() => inbox.some(m => m.t === "result" && m.reqId === "p2"));
		const second = inbox.find(m => m.t === "result" && m.reqId === "p2") as { data: { ptyId: string; reused: boolean; cols: number } };
		expect(second.data).toMatchObject({ ptyId: first.data.ptyId, reused: true, cols: 80 });
		await until(() => inbox.some(m => m.t === "pty_data" && m.data.includes("gy-42")));
		const listed = await (await fetch(`${gateway.url}/api/ptys`, { headers: authed })).json();
		expect(listed.map((p: { key: string }) => p.key)).toContain("pane-1");
		ws.send(JSON.stringify({ t: "pty_close", ptyId: first.data.ptyId }));
		await until(() => inbox.some(m => m.t === "pty_exit"));
		ws.close();
	});
});
