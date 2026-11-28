import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreviewProxies, previewTarget } from "../src/preview";
import { startGateway, type Gateway } from "../src/server";

const dir = mkdtempSync(join(tmpdir(), "gyre-preview-"));
const fake = join(import.meta.dir, "fixtures/fake-omp.ts");
let gateway: Gateway;
let devServer: ReturnType<typeof Bun.serve>;
const seen: Array<{ path: string; cookie: string | null; origin: string | null; host: string | null }> = [];

beforeAll(async () => {
	// A stand-in dev server: echoes requests, redirects to its own address, and echoes WebSocket messages.
	devServer = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req, server) {
			const url = new URL(req.url);
			seen.push({ path: url.pathname + url.search, cookie: req.headers.get("cookie"), origin: req.headers.get("origin"), host: req.headers.get("host") });
			if (url.pathname === "/hmr" && server.upgrade(req, { data: undefined })) return undefined;
			if (url.pathname === "/redirect") return new Response(null, { status: 302, headers: { location: `http://localhost:${server.port}/landed` } });
			if (req.method === "POST") return req.text().then(body => new Response(`posted ${body}`));
			return new Response(`<h1>dev ${url.pathname}</h1>`, { headers: { "content-type": "text/html" } });
		},
		websocket: {
			message: (ws, message) => {
				ws.send(`echo ${message}`);
			},
		},
	});
	gateway = await startGateway({ host: "127.0.0.1", port: 0, token: "tok", dataDir: join(dir, "data"), ompPath: fake });
});
afterAll(async () => {
	await gateway?.stop();
	devServer?.stop(true);
	rmSync(dir, { recursive: true, force: true });
});

const headers = { "x-gyre-token": "tok", "content-type": "application/json" };
const openPreview = async (url: string, paneId = "pane-1") =>
	(await (await fetch(`${gateway.url}/api/preview`, { method: "POST", headers, body: JSON.stringify({ url, paneId }) })).json()) as { url: string; port: number; error?: string };

/** Follow the one-time link and return the session cookie it sets. */
async function login(link: string): Promise<string> {
	const response = await fetch(link, { redirect: "manual" });
	expect(response.status).toBe(302);
	expect(response.headers.get("location")).not.toContain("gyre_preview");
	return response.headers.get("set-cookie")!.split(";")[0]!;
}

test("only http URLs on localhost can be proxied", () => {
	expect(previewTarget("http://localhost:5173/app?x=1#top")).toEqual({ port: 5173, path: "/app?x=1#top" });
	expect(previewTarget("http://127.0.0.1/").port).toBe(80);
	for (const bad of ["https://localhost:1", "http://example.com:80", "http://10.0.0.1:3000", "file:///etc/passwd", "nope"]) expect(() => previewTarget(bad)).toThrow();
});

test("the one-time link sets a cookie; requests without it are refused; the link cannot be reused", async () => {
	const { url } = await openPreview(`http://localhost:${devServer.port}/page`);
	expect(url).toContain("gyre_preview=");
	expect((await fetch(url.replace(/\?.*/, ""))).status).toBe(401);
	const cookie = await login(url);
	const page = await fetch(url.replace(/\?.*/, ""), { headers: { cookie } });
	expect(await page.text()).toBe("<h1>dev /page</h1>");
	expect((await fetch(url, { redirect: "manual" })).status).toBe(401);
});

test("HTTP is proxied without Gyre cookies, with the dev server's own host, origin and redirects", async () => {
	const { url } = await openPreview(`http://localhost:${devServer.port}/`);
	const base = url.replace(/\/\?.*/, "");
	const cookie = await login(url);
	seen.length = 0;
	const posted = await fetch(`${base}/api?q=1`, { method: "POST", body: "hello", headers: { cookie: `${cookie}; gyre_token=tok; app=1`, origin: base } });
	expect(await posted.text()).toBe("posted hello");
	expect(seen[0]).toEqual({ path: "/api?q=1", cookie: "app=1", origin: `http://localhost:${devServer.port}`, host: `localhost:${devServer.port}` });
	const redirect = await fetch(`${base}/redirect`, { headers: { cookie }, redirect: "manual" });
	expect(redirect.headers.get("location")).toBe("/landed");
});

test("WebSockets (hot reload) are bridged both ways", async () => {
	const { url } = await openPreview(`http://localhost:${devServer.port}/`);
	const cookie = await login(url);
	const wsUrl = url.replace(/^http/, "ws").replace(/\/\?.*/, "/hmr");
	const socket = new WebSocket(wsUrl, { headers: { cookie } } as never);
	const reply = await new Promise<string>((resolve, reject) => {
		socket.onopen = () => socket.send("ping");
		socket.onmessage = event => resolve(String(event.data));
		socket.onerror = () => reject(new Error("socket error"));
	});
	expect(reply).toBe("echo ping");
	socket.close();
});

test("a proxy stops when the last pane holding it lets go", async () => {
	const proxies = new PreviewProxies({ hostname: "127.0.0.1", isAllowedHost: () => true });
	const a = proxies.open(devServer.port!, "a");
	proxies.open(devServer.port!, "b");
	proxies.release("a");
	expect(proxies.list()).toHaveLength(1);
	proxies.release("b");
	expect(proxies.list()).toEqual([]);
	await expect(fetch(`http://127.0.0.1:${a.port}/`)).rejects.toThrow();
	proxies.stop();
});

test("bad targets are rejected over HTTP; nothing listening is a 502", async () => {
	const bad = await fetch(`${gateway.url}/api/preview`, { method: "POST", headers, body: JSON.stringify({ url: "http://example.com", paneId: "p" }) });
	expect(bad.status).toBe(400);
	const dead = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
	const deadPort = dead.port;
	dead.stop(true);
	const { url } = await openPreview(`http://localhost:${deadPort}/`, "dead-pane");
	const cookie = await login(url);
	expect((await fetch(url.replace(/\?.*/, ""), { headers: { cookie } })).status).toBe(502);
	await fetch(`${gateway.url}/api/preview?paneId=dead-pane`, { method: "DELETE", headers });
});

test("cookie-authenticated writes from another origin are refused; the UI's token header still works", async () => {
	const host = new URL(gateway.url).host;
	const cookieHeaders = { cookie: "gyre_token=tok", "content-type": "application/json" };
	const crossOrigin = await fetch(`${gateway.url}/api/projects`, { method: "POST", headers: { ...cookieHeaders, origin: "http://127.0.0.1:5999" }, body: JSON.stringify({ path: dir }) });
	expect(crossOrigin.status).toBe(403);
	const sameOrigin = await fetch(`${gateway.url}/api/projects`, { method: "POST", headers: { ...cookieHeaders, origin: `http://${host}` }, body: JSON.stringify({ path: dir }) });
	expect(sameOrigin.status).toBe(200);
	const withToken = await fetch(`${gateway.url}/api/projects`, { method: "POST", headers: { ...headers, origin: "http://127.0.0.1:5999" }, body: JSON.stringify({ path: dir }) });
	expect(withToken.status).toBe(200);
	expect((await fetch(`${gateway.url}/api/projects`, { headers: { ...cookieHeaders, origin: "http://127.0.0.1:5999" } })).status).toBe(200);
});
