import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
	type ClientMessage,
	GATEWAY_VERSION,
	type PlanPrefs,
	type Project,
	type ServerMessage,
	type Workspace,
} from "@gyre/protocol";
import type { ServerWebSocket } from "bun";
import { ChatManager, type ChatManagerOptions, type Subscriber } from "./chats";
import { Store } from "./db";
import { FsAccessError, listDir, readText, resolveInside } from "./fs";
import { OmpCli, OmpCliError } from "./omp-cli";
import { OmpCommandError } from "./omp-process";
import { PtyManager, type PtyListener } from "./pty";
import { listSessions } from "./sessions";
import {
	deleteAgent,
	deleteMcp,
	listAgents,
	listMcp,
	type Scope,
	StudioError,
	saveAgent,
	saveMcp,
	setMcpEnabled,
} from "./studio";

export interface GatewayConfig {
	host: string;
	port: number;
	token: string;
	dataDir: string;
	webDist?: string;
	ompPath?: string;
	ompArgs?: string[];
	idleReapMs?: number;
	createProcess?: ChatManagerOptions["createProcess"];
	/** omp extensions loaded into every chat (Gyre's plan-mode extension). */
	extensions?: string[];
	/**
	 * Extra Host header names accepted besides loopback (remote access, e.g. a
	 * Tailscale name). "*" accepts any host; use only behind a trusted network.
	 */
	allowedHosts?: string[];
	/** Override the omp CLI wrapper (tests). */
	ompCli?: OmpCli;
}

interface SocketData {
	authed: boolean;
	subscriber: Subscriber;
	ptyListeners: Map<string, PtyListener>;
}

export interface Gateway {
	port: number;
	url: string;
	stop(): Promise<void>;
	chats: ChatManager;
	store: Store;
}

export async function detectOmpVersion(ompPath = "omp"): Promise<string | null> {
	try {
		const proc = Bun.spawn([ompPath, "--version"], { stdout: "pipe", stderr: "ignore" });
		const text = await new Response(proc.stdout).text();
		await proc.exited;
		return text.trim().replace(/^omp\//, "") || null;
	} catch {
		return null;
	}
}

export async function startGateway(config: GatewayConfig): Promise<Gateway> {
	mkdirSync(config.dataDir, { recursive: true });
	const store = new Store(join(config.dataDir, "gyre.db"));
	const planPrefsDir = join(config.dataDir, "plan-prefs");
	mkdirSync(planPrefsDir, { recursive: true });
	const planPrefsPath = (chatId: string) => join(planPrefsDir, `${chatId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
	const chats = new ChatManager({
		ompPath: config.ompPath,
		ompArgs: config.ompArgs,
		idleReapMs: config.idleReapMs,
		createProcess: config.createProcess,
		extensions: config.extensions,
		envFor: chatId => ({
			GYRE_PLAN_PREFS: planPrefsPath(chatId),
			// Plannotator's review page is embedded in a Gyre pane, not opened in a browser.
			PLANNOTATOR_BROWSER: "none",
			PLANNOTATOR_INBOX_TOOL: "0",
		}),
	});
	const ptys = new PtyManager();
	const ompCli = config.ompCli ?? new OmpCli(config.ompPath);
	const ompVersion = await detectOmpVersion(config.ompPath);
	const allowedHosts = new Set(config.allowedHosts ?? []);

	const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
		new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
	const fail = (message: string, status = 400) => json({ error: message }, status);

	const cookieToken = (req: Request) =>
		(req.headers.get("cookie") ?? "")
			.split(/;\s*/)
			.map(part => part.split("="))
			.find(([name]) => name === "gyre_token")?.[1];
	const authorized = (req: Request, url: URL) =>
		req.headers.get("x-gyre-token") === config.token ||
		url.searchParams.get("token") === config.token ||
		cookieToken(req) === config.token;
	const SESSION_COOKIE = `gyre_token=${config.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`;

	const projectOr404 = (id: string | null): Project => {
		const project = id ? store.getProject(id) : undefined;
		if (!project) throw new FsAccessError("unknown project", 404);
		return project;
	};

	const optionalProject = (id: string | null | undefined): Project | undefined => (id ? projectOr404(id) : undefined);
	const scopeOf = (value: unknown): Scope => (value === "project" ? "project" : "user");

	async function handleApi(req: Request, url: URL): Promise<Response> {
		const path = url.pathname;
		const method = req.method;
		try {
			if (path === "/api/health") return json({ ok: true, version: GATEWAY_VERSION, ompVersion });
			if (path === "/api/remote" && method === "GET") {
				return json({ host: config.host, port: server.port, allowedHosts: [...allowedHosts], loopbackOnly: isLoopbackHost(config.host) });
			}
			// UI-side errors (webviews without devtools report here).
			if (path === "/api/client-log" && method === "POST") {
				const body = (await req.json().catch(() => ({}))) as { level?: string; message?: string };
				console.error(`[ui:${body.level ?? "error"}] ${String(body.message ?? "").slice(0, 4000)}`);
				return json({ ok: true });
			}

			if (path === "/api/projects" && method === "GET") return json(store.listProjects());
			if (path === "/api/projects" && method === "POST") {
				const body = (await req.json()) as { path?: string; name?: string };
				if (!body.path) return fail("path is required");
				const abs = resolve(body.path.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
				if (!existsSync(abs) || !statSync(abs).isDirectory()) return fail(`not a directory: ${abs}`);
				return json(store.addProject(body.name?.trim() || basename(abs), abs));
			}
			const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
			if (projectMatch?.[1]) {
				if (method === "DELETE") {
					store.removeProject(projectMatch[1]);
					return json({ ok: true });
				}
				if (method === "PATCH") {
					const body = (await req.json()) as { name?: string };
					if (body.name) store.renameProject(projectMatch[1], body.name);
					return json(projectOr404(projectMatch[1]));
				}
			}

			if (path === "/api/workspaces" && method === "GET") return json(store.listWorkspaces());
			const wsMatch = path.match(/^\/api\/workspaces\/([^/]+)$/);
			if (wsMatch?.[1]) {
				if (method === "PUT") {
					const body = (await req.json()) as Workspace;
					return json(store.saveWorkspace({ ...body, id: wsMatch[1] }));
				}
				if (method === "DELETE") {
					store.removeWorkspace(wsMatch[1]);
					return json({ ok: true });
				}
			}

			if (path === "/api/settings" && method === "GET") return json(store.getKv("settings") ?? {});
			if (path === "/api/settings" && method === "PUT") {
				const body = await req.json();
				store.setKv("settings", body);
				return json(body);
			}

			if (path === "/api/sessions" && method === "GET") {
				const projectId = url.searchParams.get("projectId");
				const project = projectId ? projectOr404(projectId) : undefined;
				return json(await listSessions(project?.path));
			}

			if (path === "/api/fs/list" && method === "GET") {
				const project = projectOr404(url.searchParams.get("projectId"));
				return json(
					await listDir(project.path, url.searchParams.get("path") ?? "", url.searchParams.get("hidden") === "1"),
				);
			}
			if (path === "/api/fs/read" && method === "GET") {
				const project = projectOr404(url.searchParams.get("projectId"));
				return json(await readText(project.path, url.searchParams.get("path") ?? ""));
			}

			if (path === "/api/fs/stat" && method === "POST") {
				const body = (await req.json()) as { projectId?: string; paths?: string[] };
				const project = projectOr404(body.projectId ?? null);
				const result: Record<string, "file" | "dir"> = {};
				for (const rel of (body.paths ?? []).slice(0, 200)) {
					try {
						const abs = await resolveInside(project.path, rel.replace(/^\.\//, ""));
						const info = await stat(abs);
						result[rel] = info.isDirectory() ? "dir" : "file";
					} catch {}
				}
				return json(result);
			}

			// ---- chats / processes (task manager) ----
			if (path === "/api/chats" && method === "GET") return json([...chats.chats.values()].map(chat => chat.info));
			const chatMatch = path.match(/^\/api\/chats\/([^/]+)\/(restart|kill|plan-prefs)$/);
			if (chatMatch?.[1] && chatMatch[2]) {
				const chatId = decodeURIComponent(chatMatch[1]);
				if (chatMatch[2] === "restart" && method === "POST") {
					const chat = await chats.restart(chatId);
					return chat ? json(chat.info) : fail("unknown chat", 404);
				}
				if (chatMatch[2] === "kill" && method === "POST") {
					await chats.close(chatId);
					return json({ ok: true });
				}
				if (chatMatch[2] === "plan-prefs") {
					const file = planPrefsPath(chatId);
					if (method === "GET") {
						try {
							return json(JSON.parse(readFileSync(file, "utf8")) as PlanPrefs);
						} catch {
							return json({ role: "default", context: "compact" } satisfies PlanPrefs);
						}
					}
					if (method === "PUT") {
						const body = (await req.json()) as Partial<PlanPrefs>;
						const prefs: PlanPrefs = {
							role: typeof body.role === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(body.role) ? body.role : "default",
							context: body.context === "fresh" || body.context === "keep" ? body.context : "compact",
						};
						writeFileSync(file, JSON.stringify(prefs));
						return json(prefs);
					}
				}
			}
			const restartProject = path.match(/^\/api\/projects\/([^/]+)\/restart-chats$/);
			if (restartProject?.[1] && method === "POST") {
				const ids = [...chats.chats.values()].filter(c => c.info.projectId === restartProject[1]).map(c => c.info.chatId);
				for (const id of ids) await chats.restart(id);
				return json({ restarted: ids.length });
			}
			if (path === "/api/ptys" && method === "GET") return json(ptys.list());
			const ptyMatch = path.match(/^\/api\/ptys\/([^/]+)$/);
			if (ptyMatch?.[1] && method === "DELETE") {
				ptys.close(ptyMatch[1]);
				return json({ ok: true });
			}

			// ---- omp settings (allowlisted keys via the omp CLI) ----
			if (path === "/api/omp/config") {
				const key = url.searchParams.get("key") ?? "";
				const cwd = optionalProject(url.searchParams.get("projectId"))?.path;
				if (method === "GET") return json({ key, value: await ompCli.configGet(key, cwd) });
				if (method === "PUT") {
					const body = (await req.json()) as { key?: string; value?: unknown; projectId?: string };
					const value = await ompCli.configSet(body.key ?? "", body.value, optionalProject(body.projectId)?.path);
					return json({ key: body.key, value });
				}
				if (method === "DELETE") {
					await ompCli.configReset(key, cwd);
					return json({ ok: true });
				}
			}
			if (path === "/api/omp/skills" && method === "GET") {
				return json(await ompCli.skills(optionalProject(url.searchParams.get("projectId"))?.path));
			}

			// ---- Agent Studio ----
			if (path === "/api/agents") {
				const agentDir = await ompCli.agentDir();
				if (method === "GET") {
					const project = optionalProject(url.searchParams.get("projectId"));
					return json(listAgents({ agentDir, projectPath: project?.path, bundled: await ompCli.bundledAgents() }));
				}
				if (method === "PUT") {
					const body = (await req.json()) as {
						scope?: string;
						projectId?: string;
						name?: string;
						previousName?: string;
						frontmatter?: Record<string, unknown>;
						instructions?: string;
					};
					return json(
						saveAgent({
							scope: scopeOf(body.scope),
							agentDir,
							projectPath: optionalProject(body.projectId)?.path,
							name: body.name ?? "",
							previousName: body.previousName,
							frontmatter: body.frontmatter ?? {},
							instructions: body.instructions ?? "",
						}),
					);
				}
				if (method === "DELETE") {
					deleteAgent({
						scope: scopeOf(url.searchParams.get("scope")),
						agentDir,
						projectPath: optionalProject(url.searchParams.get("projectId"))?.path,
						name: url.searchParams.get("name") ?? "",
					});
					return json({ ok: true });
				}
			}

			// ---- MCP servers ----
			if (path === "/api/mcp" || path === "/api/mcp/enabled") {
				const agentDir = await ompCli.agentDir();
				if (path === "/api/mcp" && method === "GET") {
					return json(listMcp(agentDir, optionalProject(url.searchParams.get("projectId"))?.path));
				}
				if (path === "/api/mcp" && method === "PUT") {
					const body = (await req.json()) as { scope?: string; projectId?: string; name?: string; previousName?: string; config?: Record<string, unknown> };
					return json(
						saveMcp({
							scope: scopeOf(body.scope),
							agentDir,
							projectPath: optionalProject(body.projectId)?.path,
							name: body.name ?? "",
							previousName: body.previousName,
							config: body.config ?? {},
						}),
					);
				}
				if (path === "/api/mcp/enabled" && method === "POST") {
					const body = (await req.json()) as { scope?: string; projectId?: string; name?: string; enabled?: boolean };
					setMcpEnabled({
						scope: scopeOf(body.scope),
						agentDir,
						projectPath: optionalProject(body.projectId)?.path,
						name: body.name ?? "",
						enabled: body.enabled !== false,
					});
					return json({ ok: true });
				}
				if (path === "/api/mcp" && method === "DELETE") {
					deleteMcp({
						scope: scopeOf(url.searchParams.get("scope")),
						agentDir,
						projectPath: optionalProject(url.searchParams.get("projectId"))?.path,
						name: url.searchParams.get("name") ?? "",
					});
					return json({ ok: true });
				}
			}

			// ---- small UI-owned key/value records (drafts, preferences) ----
			const kvMatch = path.match(/^\/api\/kv\/(ui\.[A-Za-z0-9._-]{1,64})$/);
			if (kvMatch?.[1]) {
				if (method === "GET") return json(store.getKv(kvMatch[1]) ?? null);
				if (method === "PUT") {
					const body = await req.json();
					store.setKv(kvMatch[1], body);
					return json(body);
				}
			}

			return fail("not found", 404);
		} catch (error) {
			if (error instanceof FsAccessError) return fail(error.message, error.status);
			if (error instanceof OmpCliError || error instanceof StudioError) return fail(error.message, error.status);
			return fail(error instanceof Error ? error.message : String(error), 500);
		}
	}

	async function serveStatic(url: URL, trusted: boolean): Promise<Response> {
		if (!config.webDist) return new Response("Gyre gateway: web UI not built", { status: 404 });
		const root = resolve(config.webDist);
		const requested = resolve(root, `.${decodeURIComponent(url.pathname)}`);
		if (requested.startsWith(root) && requested !== root) {
			const file = Bun.file(requested);
			if (await file.exists()) return new Response(file);
		}
		// SPA fallback. Local (loopback) clients and remote clients that already
		// logged in get the token injected; anyone else sees the token login screen.
		const index = await Bun.file(join(root, "index.html")).text();
		const boot = `<script>window.__GYRE__=${JSON.stringify(trusted ? { token: config.token } : { remote: true })}</script>`;
		return new Response(index.replace("</head>", `${boot}</head>`), {
			headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
		});
	}

	async function handleMessage(ws: ServerWebSocket<SocketData>, message: ClientMessage): Promise<void> {
		const send = (msg: ServerMessage) => ws.send(JSON.stringify(msg));
		if (!ws.data.authed) {
			if (message.t === "hello" && message.token === config.token) {
				ws.data.authed = true;
				send({ t: "welcome", version: GATEWAY_VERSION, ompVersion });
			} else {
				send({ t: "error", message: "unauthorized" });
				ws.close(4401, "unauthorized");
			}
			return;
		}

		switch (message.t) {
			case "hello":
				return;
			case "open_chat": {
				try {
					const project = projectOr404(message.projectId);
					const chat = await chats.open({
						projectId: project.id,
						cwd: project.path,
						chatId: message.chatId,
						sessionPath: message.sessionPath,
						subscriber: ws.data.subscriber,
					});
					send({ t: "result", reqId: message.reqId, ok: true, data: chat.info });
				} catch (error) {
					send({ t: "result", reqId: message.reqId, ok: false, error: errorText(error) });
				}
				return;
			}
			case "subscribe": {
				const chat = chats.get(message.chatId);
				if (chat) chats.subscribe(chat, ws.data.subscriber);
				return;
			}
			case "close_chat":
				await chats.close(message.chatId);
				return;
			case "rpc": {
				const chat = chats.get(message.chatId);
				if (!chat || !chat.process.running) {
					send({ t: "result", reqId: message.reqId, ok: false, error: "chat is not running", code: "chat_not_running" });
					return;
				}
				try {
					const response = await chat.process.send(message.command, message.timeoutMs);
					if (response.success) send({ t: "result", reqId: message.reqId, ok: true, data: response.data ?? null });
					else
						send({
							t: "result",
							reqId: message.reqId,
							ok: false,
							error: response.error ?? "command failed",
							code: response.code,
						});
					if (message.command.type === "switch_session" || message.command.type === "new_session" || message.command.type === "fork") {
						const state = await chat.process.call<{ sessionFile?: string }>({ type: "get_state" }).catch(() => undefined);
						chat.setInfo({ sessionPath: state?.sessionFile });
					}
				} catch (error) {
					send({
						t: "result",
						reqId: message.reqId,
						ok: false,
						error: errorText(error),
						code: error instanceof OmpCommandError ? error.code : undefined,
					});
				}
				return;
			}
			case "ui_response": {
				const chat = chats.get(message.chatId);
				if (!chat) return;
				chats.resolveUi(chat, message.response.id);
				chat.process.respondUi(message.response);
				// Tell other subscribers the dialog is gone.
				chat.broadcast({
					t: "frame",
					chatId: message.chatId,
					frame: { type: "extension_ui_request", id: `mc_resolved_${message.response.id}`, method: "cancel", targetId: message.response.id },
				});
				return;
			}
			case "pty_open": {
				try {
					const project = projectOr404(message.projectId);
					let ptyId = "";
					const pending: string[] = [];
					const listener: PtyListener = {
						data: data => (ptyId ? send({ t: "pty_data", ptyId, data }) : pending.push(data)),
						exit: code => {
							ws.data.ptyListeners.delete(ptyId);
							send({ t: "pty_exit", ptyId, code });
						},
					};
					const opened = ptys.open({
						key: message.key,
						projectId: project.id,
						cwd: project.path,
						cols: message.cols,
						rows: message.rows,
						listener,
					});
					ptyId = opened.ptyId;
					const previous = ws.data.ptyListeners.get(ptyId);
					if (previous && previous !== listener) ptys.detach(ptyId, previous);
					ws.data.ptyListeners.set(ptyId, listener);
					send({ t: "result", reqId: message.reqId, ok: true, data: { ptyId, reused: opened.reused, cols: opened.cols, rows: opened.rows } });
					for (const data of pending.splice(0)) send({ t: "pty_data", ptyId, data });
				} catch (error) {
					send({ t: "result", reqId: message.reqId, ok: false, error: errorText(error) });
				}
				return;
			}
			case "pty_input":
				ptys.write(message.ptyId, message.data);
				return;
			case "pty_resize":
				ptys.resize(message.ptyId, message.cols, message.rows);
				return;
			case "pty_detach": {
				const listener = ws.data.ptyListeners.get(message.ptyId);
				if (listener) ptys.detach(message.ptyId, listener);
				ws.data.ptyListeners.delete(message.ptyId);
				return;
			}
			case "pty_close":
				ptys.close(message.ptyId);
				return;
		}
	}

	const isAllowedHost = (hostName: string) =>
		LOOPBACK_HOSTS.has(hostName) || hostName === config.host || allowedHosts.has(hostName) || allowedHosts.has("*");

	const server: ReturnType<typeof Bun.serve<SocketData, never>> = Bun.serve<SocketData, never>({
		hostname: config.host,
		port: config.port,
		idleTimeout: 120,
		async fetch(req, srv) {
			const url = new URL(req.url);
			// DNS-rebinding guard: only answer requests addressed to loopback names.
			const hostName = (req.headers.get("host") ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
			if (DEBUG) console.error(`[http] ${req.method} ${url.pathname} host=${hostName} upgrade=${req.headers.get("upgrade") ?? "-"}`);
			if (!isAllowedHost(hostName)) return new Response("forbidden host", { status: 403 });
			if (url.pathname === "/ws") {
				const ok = srv.upgrade(req, { data: { authed: false, subscriber: { send: () => {} }, ptyListeners: new Map() } });
				return ok ? undefined : new Response("upgrade failed", { status: 400 });
			}
			// Remote login: exchange the token for an HttpOnly session cookie.
			if (url.pathname === "/api/login" && req.method === "POST") {
				const body = (await req.json().catch(() => ({}))) as { token?: string };
				if (body.token !== config.token) return fail("invalid token", 401);
				return json({ ok: true, token: config.token }, 200, { "set-cookie": SESSION_COOKIE });
			}
			if (url.pathname.startsWith("/api/")) {
				if (url.pathname !== "/api/health" && !authorized(req, url)) return fail("unauthorized", 401);
				return handleApi(req, url);
			}
			const peer = srv.requestIP(req)?.address ?? "";
			const trusted = (isLoopbackAddress(peer) && LOOPBACK_HOSTS.has(hostName)) || cookieToken(req) === config.token;
			return serveStatic(url, trusted);
		},
		websocket: {
			maxPayloadLength: 64 * 1024 * 1024,
			open(ws) {
				if (DEBUG) console.error("[ws] open");
				ws.data.subscriber = { send: msg => ws.send(JSON.stringify(msg)) };
				ws.data.ptyListeners = new Map();
			},
			message(ws, raw) {
				let message: ClientMessage;
				try {
					message = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)) as ClientMessage;
				} catch {
					ws.send(JSON.stringify({ t: "error", message: "malformed message" } satisfies ServerMessage));
					return;
				}
				if (DEBUG) console.error(`[ws] message ${message.t}`);
				void handleMessage(ws, message);
			},
			close(ws, code) {
				if (DEBUG) console.error(`[ws] close ${code}`);
				chats.unsubscribeAll(ws.data.subscriber);
				// Terminals keep running for the pane to reattach; just stop streaming to this socket.
				for (const [ptyId, listener] of ws.data.ptyListeners) ptys.detach(ptyId, listener);
				ws.data.ptyListeners.clear();
			},
		},
	});

	const port = server.port ?? config.port;
	return {
		port,
		url: `http://${config.host}:${port}`,
		chats,
		store,
		async stop() {
			ptys.closeAll();
			await chats.closeAll();
			server.stop(true);
			store.close();
		},
	};
}

const DEBUG = process.env.GYRE_DEBUG === "1";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "tauri.localhost"]);

function isLoopbackAddress(address: string): boolean {
	return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

function isLoopbackHost(host: string): boolean {
	return host === "localhost" || host === "::1" || host.startsWith("127.");
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
