/** omp setup status, the folder browser and project removal. */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowseListing, HealthInfo, ServerMessage } from "@gyre/protocol";
import { detectOmpStatus, type Gateway, OMP_SETUP_CODE, startGateway } from "../src/server";

const FAKE_OMP = join(import.meta.dir, "fixtures/fake-omp.ts");
const tmp = mkdtempSync(join(tmpdir(), "gyre-setup-"));
const authed = { "x-gyre-token": "tok", "content-type": "application/json" };

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error("timed out");
		await Bun.sleep(10);
	}
}

let gateway: Gateway | undefined;
afterEach(async () => {
	await gateway?.stop();
	gateway = undefined;
	delete process.env.FAKE_NO_MODELS;
});

const start = async (name: string) => {
	gateway = await startGateway({ host: "127.0.0.1", port: 0, token: "tok", dataDir: join(tmp, name), ompPath: FAKE_OMP, idleReapMs: 0 });
	return gateway;
};

async function connect(gw: Gateway) {
	const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/ws`);
	const messages: ServerMessage[] = [];
	ws.onmessage = e => messages.push(JSON.parse(String(e.data)));
	await new Promise(resolve => (ws.onopen = resolve));
	ws.send(JSON.stringify({ t: "hello", token: "tok" }));
	await until(() => messages.some(m => m.t === "welcome"));
	const request = async (message: Record<string, unknown>) => {
		const reqId = crypto.randomUUID();
		ws.send(JSON.stringify({ ...message, reqId }));
		await until(() => messages.some(m => m.t === "result" && m.reqId === reqId));
		return messages.find(m => m.t === "result" && m.reqId === reqId) as Extract<ServerMessage, { t: "result" }>;
	};
	return { ws, request };
}

async function addProject(gw: Gateway, path: string) {
	mkdirSync(path, { recursive: true });
	return (await (await fetch(`${gw.url}/api/projects`, { method: "POST", headers: authed, body: JSON.stringify({ path }) })).json()) as { id: string };
}

describe("omp setup status", () => {
	test("detectOmpStatus: missing, no models, models, and a failing check", async () => {
		const cli = (code: number, stdout: string, stderr = "") => ({ run: async () => ({ code, stdout, stderr }) });
		expect(await detectOmpStatus(cli(0, ""), null)).toBe("missing");
		expect(await detectOmpStatus(cli(0, '{"models":[]}'), "1.0")).toBe("no-models");
		expect(await detectOmpStatus(cli(0, '{"models":[{"id":"m"}]}'), "1.0")).toBe("ok");
		expect(await detectOmpStatus(cli(1, "", "No models available."), "1.0")).toBe("no-models");
		expect(await detectOmpStatus(cli(2, "", "boom"), "1.0")).toBe("unknown");
		expect(await detectOmpStatus({ run: async () => Promise.reject(new Error("x")) }, "1.0")).toBe("unknown");
	});

	test("without a provider, chats are refused with a setup code until a re-check finds one", async () => {
		process.env.FAKE_NO_MODELS = "1";
		const gw = await start("no-models");
		const project = await addProject(gw, join(tmp, "p-no-models"));
		const { ws, request } = await connect(gw);
		const refused = await request({ t: "open_chat", projectId: project.id });
		expect(refused.ok).toBe(false);
		expect(!refused.ok && refused.code).toBe(OMP_SETUP_CODE);
		expect(((await (await fetch(`${gw.url}/api/health`)).json()) as HealthInfo).ompStatus).toBe("no-models");

		delete process.env.FAKE_NO_MODELS;
		const rechecked = (await (await fetch(`${gw.url}/api/omp/recheck`, { method: "POST", headers: authed })).json()) as HealthInfo;
		expect(rechecked.ompStatus).toBe("ok");
		const opened = await request({ t: "open_chat", projectId: project.id });
		expect(opened.ok).toBe(true);
		ws.close();
	});
});

describe("folder browser", () => {
	test("lists directories only, marks git repos, hides dot folders unless asked", async () => {
		const gw = await start("browse");
		const root = join(tmp, "browse-root");
		mkdirSync(join(root, "repo/.git"), { recursive: true });
		mkdirSync(join(root, "plain"), { recursive: true });
		mkdirSync(join(root, ".hidden"), { recursive: true });
		writeFileSync(join(root, "file.txt"), "x");
		symlinkSync(join(root, "plain"), join(root, "link-to-plain"));
		const listing = (await (await fetch(`${gw.url}/api/fs/browse?path=${encodeURIComponent(root)}`, { headers: authed })).json()) as BrowseListing;
		expect(listing.path).toBe(root);
		expect(listing.parent).toBe(tmp);
		expect(listing.entries.map(e => e.name)).toEqual(["link-to-plain", "plain", "repo"]);
		expect(listing.entries.find(e => e.name === "repo")?.isGitRepo).toBe(true);
		const hidden = (await (await fetch(`${gw.url}/api/fs/browse?hidden=1&path=${encodeURIComponent(root)}`, { headers: authed })).json()) as BrowseListing;
		expect(hidden.entries.map(e => e.name)).toContain(".hidden");
		expect((await fetch(`${gw.url}/api/fs/browse?path=relative/dir`, { headers: authed })).status).toBe(400);
		expect((await fetch(`${gw.url}/api/fs/browse?path=${encodeURIComponent(join(root, "missing"))}`, { headers: authed })).status).toBe(404);
		expect((await fetch(`${gw.url}/api/fs/browse?path=${encodeURIComponent(join(root, "file.txt"))}`, { headers: authed })).status).toBe(400);
		expect((await fetch(`${gw.url}/api/fs/browse`)).status).toBe(401);
	});
});

describe("project removal", () => {
	test("reports usage, stops the project's chats, and 404s for unknown projects", async () => {
		const gw = await start("remove");
		const project = await addProject(gw, join(tmp, "p-remove"));
		const other = await addProject(gw, join(tmp, "p-keep"));
		const { ws, request } = await connect(gw);
		const opened = await request({ t: "open_chat", projectId: project.id });
		const kept = await request({ t: "open_chat", projectId: other.id });
		expect(opened.ok && kept.ok).toBe(true);
		const usage = await (await fetch(`${gw.url}/api/projects/${project.id}/usage`, { headers: authed })).json();
		expect(usage).toEqual({ chats: 1, terminals: 0 });

		const removed = await fetch(`${gw.url}/api/projects/${project.id}`, { method: "DELETE", headers: authed });
		expect(removed.status).toBe(200);
		expect((await removed.json()).stopped).toEqual({ chats: 1, terminals: 0 });
		const chats = (await (await fetch(`${gw.url}/api/chats`, { headers: authed })).json()) as Array<{ projectId: string }>;
		expect(chats.map(c => c.projectId)).toEqual([other.id]);
		const projects = (await (await fetch(`${gw.url}/api/projects`, { headers: authed })).json()) as Array<{ id: string }>;
		expect(projects.map(p => p.id)).toEqual([other.id]);
		expect((await fetch(`${gw.url}/api/projects/${project.id}`, { method: "DELETE", headers: authed })).status).toBe(404);
		ws.close();
	});
});
