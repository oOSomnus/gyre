import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
	type ClientMessage,
	GATEWAY_VERSION,
	type HealthInfo,
	type OmpStatus,
	type PlanPrefs,
	type Project,
	type ProjectUsage,
	type ServerMessage,
	type Workspace,
} from "@gyre/protocol";
import type { ServerWebSocket } from "bun";
import { ChatManager, type ChatManagerOptions, isSubagentLevel, type Subscriber } from "./chats";
import { Store, WorkspaceConflictError } from "./db";
import { validWorkspace, validClientMessage } from "./validation";
import { isContained, openContained } from "./contained-file";
import { closeSync, fstatSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { browseDirs, expandHome, FsAccessError, listDir, readText, resolveInside, writeText } from "./fs";
import { OmpCli, OmpCliError } from "./omp-cli";
import { OmpCommandError } from "./omp-process";
import { PtyManager, type PtyListener } from "./pty";
import { GitError, GitRepo } from "./git";
import { generateCommitMessage } from "./commit-message";
import { listSessions } from "./sessions";
import { deleteHook, HookSyntaxError, listHooks, readHook, saveHook } from "./hooks";
import { deleteAgent, deleteMcp, listAgents, listMcp, type Scope, StudioError, saveAgent, saveMcp, setMcpEnabled } from "./studio";

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
	/** Lifecycle log lines (omp checks, browser connections, chat starts and exits). */
	log?: (line: string) => void;
}

interface SocketData {
	authed: boolean;
	subscriber: Subscriber;
	ptyListeners: Map<string, PtyListener & { attachmentId: string }>;
	/** This socket's latest in-flight `open_chat` per chat id. */
	opening: Map<string, PendingOpen>;
}

/** An in-flight open; `cancelled` when this socket closed the chat before it finished starting. */
interface PendingOpen {
	cancelled: boolean;
}

/** A snapshot of what the gateway is doing, for the console's status bar. */
export interface GatewayStatus {
	version: string;
	ompVersion: string | null;
	ompStatus: OmpStatus;
	/** Authenticated browser connections. */
	clients: number;
	/** Running chats (omp processes) and how many of them are working. */
	chats: number;
	busy: number;
	terminals: number;
}

export interface Gateway {
	port: number;
	url: string;
	status(): GatewayStatus;
	stop(): Promise<void>;
	chats: ChatManager;
	store: Store;
}

export async function detectOmpVersion(ompPath = "omp"): Promise<string | null> {
	try {
		const result = await new OmpCli(ompPath).run(["--version"], undefined, 5000);
		return result.code === 0 ? result.stdout.trim().replace(/^omp\//, "") || null : null;
	} catch {
		return null;
	}
}

/** omp prints this and exits when no provider is configured. */
export const NO_MODELS_PATTERN = /No models available/i;

/** Whether omp can run chats: it must exist and list at least one usable model. */
export async function detectOmpStatus(cli: Pick<OmpCli, "run">, ompVersion: string | null): Promise<OmpStatus> {
	if (ompVersion === null) return "missing";
	try {
		const result = await cli.run(["models", "--json"], undefined, 30_000);
		if (result.code !== 0) return NO_MODELS_PATTERN.test(result.stderr + result.stdout) ? "no-models" : "unknown";
		const parsed = JSON.parse(result.stdout) as { models?: unknown };
		if (!Array.isArray(parsed.models)) return "unknown";
		return parsed.models.length > 0 ? "ok" : "no-models";
	} catch {
		return "unknown";
	}
}

/** Error code on `open_chat` results when omp cannot start chats until it is set up. */
export const OMP_SETUP_CODE = "omp_setup";

const SETUP_MESSAGE: Partial<Record<OmpStatus, string>> = {
	missing: "omp is not installed. Install it, then press Re-check.",
	"no-models": "omp has no model provider configured. Add one (e.g. run `omp login`), then press Re-check.",
};

class OmpSetupError extends Error {
	readonly code = OMP_SETUP_CODE;
}

export async function startGateway(config: GatewayConfig): Promise<Gateway> {
	if (!config.token.trim()) throw new Error("gateway token must not be empty");
	let stopping = false;
	let stopPromise: Promise<void> | undefined;
	let configWrites: Promise<unknown> = Promise.resolve();
	const writeConfig = <T>(operation: () => Promise<T>): Promise<T> => {
		const next = configWrites.catch(() => {}).then(operation);
		configWrites = next;
		return next;
	};
	const inFlight = new Set<Promise<unknown>>();
	const track = <T>(work: Promise<T>): Promise<T> => {
		inFlight.add(work);
		void work.finally(() => inFlight.delete(work)).catch(() => {});
		return work;
	};
	const log = config.log ?? (() => {});
	let clients = 0;
	mkdirSync(config.dataDir, { recursive: true });
	const store = new Store(join(config.dataDir, "gyre.db"));
	const planPrefsDir = join(config.dataDir, "plan-prefs");
	mkdirSync(planPrefsDir, { recursive: true });
	const planPrefsPath = (chatId: string) => join(planPrefsDir, `${new Bun.CryptoHasher("sha256").update(chatId).digest("hex")}.json`);
	const chats = new ChatManager({
		ompPath: config.ompPath,
		ompArgs: config.ompArgs,
		idleReapMs: config.idleReapMs,
		createProcess: config.createProcess,
		extensions: config.extensions,
		log,
		envFor: chatId => ({
			GYRE_PLAN_PREFS: planPrefsPath(chatId),
			// The extension reads role selectors (model + effort) through the same omp.
			GYRE_OMP_PATH: config.ompPath,
			// Plannotator's review page is embedded in a Gyre pane, not opened in a browser.
			PLANNOTATOR_BROWSER: "none",
			PLANNOTATOR_INBOX_TOOL: "0",
		}),
		// A chat that dies because omp has no provider means setup is needed again.
		onExit: (code, stderrTail) => {
			if (code !== 0 && NO_MODELS_PATTERN.test(stderrTail)) ompStatus = "no-models";
		},
	});
	const ptys = new PtyManager();
	const ompCli = config.ompCli ?? new OmpCli(config.ompPath);
	let ompVersion = await detectOmpVersion(config.ompPath);
	let ompStatus: OmpStatus = ompVersion === null ? "missing" : "checking";
	/** Re-run the omp checks (startup, and "Re-check" after the user installs omp or adds a provider). */
	const checkOmp = async (): Promise<OmpStatus> => {
		ompVersion = await detectOmpVersion(config.ompPath);
		ompStatus = await detectOmpStatus(ompCli, ompVersion);
		log(ompVersion === null ? "omp not found: install omp, then use Re-check in Gyre" : `omp ${ompVersion}: ${ompStatus === "ok" ? "ready" : ompStatus}`);
		return ompStatus;
	};
	// Listing models takes seconds; do not hold up startup for it.
	let ompCheck = checkOmp();
	const health = (): HealthInfo => ({ ok: true, version: GATEWAY_VERSION, ompVersion, ompStatus });
	/** Chats need a working omp; fail fast with guidance rather than spawning omp to watch it exit. */
	const requireOmpReady = async () => {
		const status = ompStatus === "checking" ? await ompCheck : ompStatus;
		const message = SETUP_MESSAGE[status];
		if (message) throw new OmpSetupError(message);
	};
	const allowedHosts = new Set(config.allowedHosts ?? []);

	const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
		new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
	const fail = (message: string, status = 400) => json({ error: message }, status);

	const cookieToken = (req: Request) =>
		(req.headers.get("cookie") ?? "")
			.split(/;\s*/)
			.map(part => {
				const at = part.indexOf("=");
				return [part.slice(0, at), part.slice(at + 1)];
			})
			.find(([name]) => name === "gyre_token")?.[1];
	const authorized = (req: Request, url: URL) =>
		req.headers.get("x-gyre-token") === config.token || url.searchParams.get("token") === config.token || cookieToken(req) === config.token;
	const SESSION_COOKIE = `gyre_token=${config.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`;

	const projectOr404 = (id: string | null): Project => {
		const project = id ? store.getProject(id) : undefined;
		if (!project) throw new FsAccessError("unknown project", 404);
		return project;
	};

	const optionalProject = (id: string | null | undefined): Project | undefined => (id ? projectOr404(id) : undefined);
	const projectUsage = (projectId: string): ProjectUsage => ({
		chats: [...chats.chats.values()].filter(chat => chat.info.projectId === projectId && chat.info.status !== "exited").length,
		terminals: ptys.list().filter(pty => pty.projectId === projectId).length,
	});
	const scopeOf = (value: unknown): Scope => (value === "project" ? "project" : "user");

	async function handleApi(req: Request, url: URL): Promise<Response> {
		const path = url.pathname;
		const method = req.method;
		try {
			if (path === "/api/health") return json(health());
			if (path === "/api/omp/recheck" && method === "POST") {
				ompCheck = checkOmp();
				await ompCheck;
				return json(health());
			}
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
				const abs = resolve(expandHome(body.path.trim()));
				if (!existsSync(abs) || !statSync(abs).isDirectory()) return fail(`not a directory: ${abs}`);
				return json(store.addProject(body.name?.trim() || basename(abs), abs));
			}
			const usageMatch = path.match(/^\/api\/projects\/([^/]+)\/usage$/);
			if (usageMatch?.[1] && method === "GET") return json(projectUsage(projectOr404(usageMatch[1]).id));
			const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
			if (projectMatch?.[1]) {
				if (method === "DELETE") {
					// Removing a project stops its chats and terminals; files on disk are untouched.
					const project = projectOr404(projectMatch[1]);
					const stopped = projectUsage(project.id);
					for (const pty of ptys.list()) if (pty.projectId === project.id) ptys.close(pty.ptyId);
					await Promise.allSettled(
						[...chats.chats.values()].filter(chat => chat.info.projectId === project.id).map(chat => chats.close(chat.info.chatId)),
					);
					store.removeProject(project.id);
					return json({ ok: true, stopped });
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
					const body: unknown = await req.json();
					if (!validWorkspace(body)) return fail("invalid workspace layout", 400);
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

			if (path === "/api/fs/browse" && method === "GET") {
				return json(await browseDirs(url.searchParams.get("path"), url.searchParams.get("hidden") === "1"));
			}
			if (path === "/api/fs/list" && method === "GET") {
				const project = projectOr404(url.searchParams.get("projectId"));
				return json(await listDir(project.path, url.searchParams.get("path") ?? "", url.searchParams.get("hidden") === "1"));
			}
			if (path === "/api/fs/read" && method === "GET") {
				const project = projectOr404(url.searchParams.get("projectId"));
				return json(await readText(project.path, url.searchParams.get("path") ?? ""));
			}
			if (path === "/api/fs/write" && method === "PUT") {
				const body = (await req.json()) as { projectId?: string; path?: unknown; content?: unknown; baseVersion?: unknown };
				const project = projectOr404(body.projectId ?? null);
				if (typeof body.path !== "string" || typeof body.content !== "string") return fail("path and content are required");
				if (body.baseVersion !== null && typeof body.baseVersion !== "string") return fail("baseVersion must be a version string or null");
				return json(await writeText(project.path, body.path, body.content, body.baseVersion));
			}

			if (path === "/api/fs/stat" && method === "POST") {
				const body = (await req.json()) as { projectId?: string; paths?: string[] };
				const project = projectOr404(body.projectId ?? null);
				const result: Record<string, "file" | "dir"> = {};
				for (const rel of (body.paths ?? []).slice(0, 200)) {
					try {
						const abs = await resolveInside(project.path, rel.replace(/^\.\//, ""));
						const fd = openContained(await realpath(project.path), abs);
						try {
							result[rel] = fstatSync(fd).isDirectory() ? "dir" : "file";
						} finally {
							closeSync(fd);
						}
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
				const failed: string[] = [];
				for (const id of ids) {
					try {
						if ((await chats.restart(id))?.info.status !== "ready") failed.push(id);
					} catch {
						failed.push(id);
					}
				}
				return json({ restarted: ids.length - failed.length, failed });
			}
			// ---- Git pane ----
			const gitMatch = path.match(/^\/api\/projects\/([^/]+)\/git\/([a-z-]+)$/);
			if (gitMatch?.[1] && gitMatch[2]) {
				const repo = await GitRepo.open(projectOr404(gitMatch[1]).path);
				const action = gitMatch[2];
				if (method === "GET") {
					if (action === "status") return json(await repo.status());
					if (action === "diff") {
						const revision = url.searchParams.get("rev") || undefined;
						return json(await repo.diff(url.searchParams.get("path") ?? "", { staged: url.searchParams.get("staged") === "1", revision }));
					}
					if (action === "commit") return json(await repo.show(url.searchParams.get("rev") ?? ""));
					if (action === "last-message") return json({ message: await repo.lastCommitMessage() });
				}
				if (method === "POST") {
					const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
					if (action === "stage") await repo.stage(body.paths);
					else if (action === "unstage") await repo.unstage(body.paths);
					else if (action === "discard") await repo.discard(body.paths);
					else if (action === "hunk") await repo.applyHunk(String(body.path ?? ""), String(body.id ?? ""), body.action as never);
					else if (action === "commit") return json(await repo.commit(body.message, { amend: body.amend === true }));
					else if (action === "generate-message") return json(await generateCommitMessage(repo, ompCli));
					else return fail("unknown git action", 404);
					return json({ ok: true });
				}
				return fail("unknown git action", 404);
			}
			// ---- Review pane (per-turn snapshots from Gyre's omp extension) ----
			const reviewMatch = path.match(/^\/api\/projects\/([^/]+)\/review\/(files|diff|revert)$/);
			if (reviewMatch?.[1] && reviewMatch[2]) {
				const repo = await GitRepo.open(projectOr404(reviewMatch[1]).path);
				const action = reviewMatch[2];
				if (method === "GET" && action === "files") return json(await repo.reviewChanges(url.searchParams.get("from"), url.searchParams.get("to") ?? "worktree"));
				if (method === "GET" && action === "diff") {
					return json(await repo.reviewDiff(url.searchParams.get("from"), url.searchParams.get("to") ?? "worktree", url.searchParams.get("path") ?? ""));
				}
				if (method === "POST" && action === "revert") {
					const body = (await req.json()) as { from?: unknown; path?: unknown; hunkId?: unknown };
					await repo.revert(body.from, body.path, body.hunkId ?? undefined);
					return json({ ok: true });
				}
				return fail("unknown review action", 404);
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
					if (body.projectId) return fail("Project-scoped settings writes are not supported by omp; edit global settings instead.", 400);
					const value = await writeConfig(() => ompCli.configSet(body.key ?? "", body.value));
					return json({ key: body.key, value });
				}
				if (method === "PATCH") {
					const body = (await req.json()) as { key?: string; name?: string; value?: unknown; projectId?: string };
					if (
						body.projectId || !["modelRoles", "task.agentModelOverrides"].includes(body.key ?? "") ||
						typeof body.name !== "string" || !body.name || (body.value !== null && typeof body.value !== "string")
					)
						return fail("invalid assignment", 400);
					const value = await writeConfig(async () => {
						const current = await ompCli.configGet(body.key!);
						if (current !== null && current !== undefined && (typeof current !== "object" || Array.isArray(current)))
							throw new OmpCliError("saved assignments are not a map", 409);
						const assignments = { ...(current as Record<string, string> | null) };
						if (body.value) Object.defineProperty(assignments, body.name!, { value: body.value, enumerable: true, configurable: true, writable: true });
						else delete assignments[body.name!];
						await ompCli.configSet(body.key!, assignments);
						return assignments;
					});
					return json({ key: body.key, value });
				}
				if (method === "DELETE") {
					if (cwd) return fail("Project-scoped settings resets are not supported by omp; edit global settings instead.", 400);
					await writeConfig(() => ompCli.configReset(key));
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

			// ---- Hook Studio ----
			if (path === "/api/hooks" || path === "/api/hooks/file") {
				const agentDir = await ompCli.agentDir();
				if (path === "/api/hooks" && method === "GET") {
					return json(listHooks({ agentDir, projectPath: optionalProject(url.searchParams.get("projectId"))?.path }));
				}
				if (path === "/api/hooks/file" && method === "GET") {
					const where = { agentDir, projectPath: optionalProject(url.searchParams.get("projectId"))?.path };
					return json(await readHook(where, scopeOf(url.searchParams.get("scope")), url.searchParams.get("phase"), url.searchParams.get("name")));
				}
				if (path === "/api/hooks" && method === "PUT") {
					const body = (await req.json()) as Record<string, unknown>;
					const previous = body.previous as { phase?: unknown; name?: unknown } | undefined;
					return json(
						await saveHook({
							agentDir,
							projectPath: optionalProject(typeof body.projectId === "string" ? body.projectId : null)?.path,
							scope: scopeOf(body.scope),
							phase: body.phase,
							name: body.name,
							content: body.content,
							baseVersion: body.baseVersion === undefined ? null : body.baseVersion,
							previous: previous && typeof previous === "object" ? { phase: previous.phase, name: previous.name } : undefined,
						}),
					);
				}
				if (path === "/api/hooks" && method === "DELETE") {
					const where = { agentDir, projectPath: optionalProject(url.searchParams.get("projectId"))?.path };
					deleteHook(where, scopeOf(url.searchParams.get("scope")), url.searchParams.get("phase"), url.searchParams.get("name"));
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
				const key = kvMatch[1];
				if (method === "GET") return json(store.getKv(key) ?? null, 200, { etag: store.kvEtag(key) });
				if (method === "PUT") {
					const body = await req.json();
					// Optimistic concurrency: `If-Match: <etag from GET>` writes only if nobody changed the record since.
					const ifMatch = req.headers.get("if-match");
					if (ifMatch) {
						const etag = store.setKvIfMatch(key, body, ifMatch);
						if (!etag) return json({ error: "the record changed since it was read" }, 412, { etag: store.kvEtag(key) });
						return json(body, 200, { etag });
					}
					store.setKv(key, body);
					return json(body, 200, { etag: store.kvEtag(key) });
				}
			}

			return fail("not found", 404);
		} catch (error) {
			if (error instanceof WorkspaceConflictError) return fail(error.message, 409);
			if (error instanceof FsAccessError) return json({ error: error.message, ...error.data }, error.status);
			if (error instanceof HookSyntaxError) return json({ error: error.message, diagnostics: error.diagnostics }, error.status);
			if (error instanceof SyntaxError) return fail("malformed JSON body", 400);
			if (error instanceof OmpCliError || error instanceof StudioError || error instanceof GitError) return fail(error.message, error.status);
			return fail(error instanceof Error ? error.message : String(error), 500);
		}
	}

	async function serveStatic(url: URL, trusted: boolean): Promise<Response> {
		if (!config.webDist) return new Response("Gyre gateway: web UI not built", { status: 404 });
		let root: string;
		try {
			root = await realpath(config.webDist);
		} catch {
			return fail("web UI root unavailable", 404);
		}
		const requested = resolve(root, `.${decodeURIComponent(url.pathname)}`);
		if (!isContained(root, requested)) return fail("forbidden path", 403);
		if (requested !== root) {
			let fd: number | undefined;
			try {
				const canonical = await realpath(requested);
				if (!isContained(root, canonical)) return fail("forbidden path", 403);
				fd = openContained(root, canonical);
				if (fstatSync(fd).isFile()) {
					const file = Bun.file(fd);
					return new Response(await file.arrayBuffer(), { headers: { "content-type": Bun.file(requested).type } });
				}
			} catch {
				/* Missing assets use the SPA fallback. */
			} finally {
				if (fd !== undefined) closeSync(fd);
			}
		}
		// SPA fallback. Local (loopback) clients and remote clients that already
		// logged in get the token injected; anyone else sees the token login screen.
		let index: string;
		let indexFd: number | undefined;
		try {
			indexFd = openContained(root, await realpath(join(root, "index.html")));
			index = await Bun.file(indexFd).text();
		} catch {
			return fail("web UI index unavailable", 404);
		} finally {
			if (indexFd !== undefined) closeSync(indexFd);
		}
		const boot = `<script>window.__GYRE__=${JSON.stringify(trusted ? { token: config.token } : { remote: true })}</script>`;
		return new Response(index.replace("</head>", `${boot}</head>`), {
			headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
		});
	}

	async function handleMessage(ws: ServerWebSocket<SocketData>, message: ClientMessage): Promise<void> {
		if (stopping) return;
		const send = (msg: ServerMessage) => ws.send(JSON.stringify(msg));
		if (!ws.data.authed) {
			if (message.t === "hello" && message.token === config.token) {
				ws.data.authed = true;
				clients += 1;
				log(`Browser connected (${clients} open)`);
				send({ t: "welcome", version: GATEWAY_VERSION, ompVersion, ompStatus });
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
				// A newer open for the same chat replaces the older one's claim, so cancelling the
				// older open can never stop the process a newer attachment is using.
				const pending: PendingOpen = { cancelled: false };
				if (message.chatId) ws.data.opening.set(message.chatId, pending);
				try {
					const project = projectOr404(message.projectId);
					await requireOmpReady();
					const chat = await chats.open({
						projectId: project.id,
						cwd: project.path,
						chatId: message.chatId,
						sessionPath: message.sessionPath,
						subscriber: ws.data.subscriber,
					});
					if (pending.cancelled) {
						// close_chat arrived while this open was starting: stop what it started,
						// unless a newer open for the same chat now owns that process.
						const latest = !message.chatId || ws.data.opening.get(message.chatId) === pending;
						if (latest && chats.get(chat.info.chatId) === chat) await chats.close(chat.info.chatId);
						send({ t: "result", reqId: message.reqId, ok: false, error: "chat was closed" });
						return;
					}
					send({ t: "result", reqId: message.reqId, ok: true, data: chat.info });
				} catch (error) {
					send({ t: "result", reqId: message.reqId, ok: false, error: errorText(error), code: error instanceof OmpSetupError ? error.code : undefined });
				} finally {
					if (message.chatId && ws.data.opening.get(message.chatId) === pending) ws.data.opening.delete(message.chatId);
				}
				return;
			}
			case "subscribe": {
				const chat = chats.get(message.chatId);
				if (chat) chats.subscribe(chat, ws.data.subscriber);
				return;
			}
			case "close_chat": {
				const pending = ws.data.opening.get(message.chatId);
				if (pending) pending.cancelled = true;
				await chats.close(message.chatId);
				return;
			}
			case "rpc": {
				const chat = chats.get(message.chatId);
				if (!chat || !chat.process.running) {
					send({ t: "result", reqId: message.reqId, ok: false, error: "chat is not running", code: "chat_not_running" });
					return;
				}
				try {
					const command = message.command;
					// Several UIs share one omp level: the gateway decides it from what each asked for.
					const response =
						command.type === "set_subagent_subscription" && isSubagentLevel(command.level)
							? await chats.setSubagentLevel(chat, ws.data.subscriber, command.level, message.timeoutMs)
							: await chat.process.send(command, message.timeoutMs);
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
						if (state) chat.setInfo({ sessionPath: state.sessionFile });
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
					const attachmentId = message.reqId;
					const listener: PtyListener & { attachmentId: string } = {
						attachmentId,
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
					send({ t: "result", reqId: message.reqId, ok: true, data: { ptyId, attachmentId, reused: opened.reused, cols: opened.cols, rows: opened.rows } });
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
				if (listener?.attachmentId === message.attachmentId) {
					ptys.detach(message.ptyId, listener);
					ws.data.ptyListeners.delete(message.ptyId);
				}
				return;
			}
			case "pty_close_key":
				ptys.closeByKey(message.key, message.projectId);
				return;
			case "pty_close":
				ptys.close(message.ptyId);
				return;
		}
	}

	const isAllowedHost = (hostName: string) => LOOPBACK_HOSTS.has(hostName) || hostName === config.host || allowedHosts.has(hostName) || allowedHosts.has("*");

	const server: ReturnType<typeof Bun.serve<SocketData, never>> = Bun.serve<SocketData, never>({
		hostname: config.host,
		port: config.port,
		idleTimeout: 120,
		async fetch(req, srv) {
			if (stopping) return fail("gateway is shutting down", 503);
			const url = new URL(req.url);
			// DNS-rebinding guard: only answer requests addressed to loopback names.
			const hostName = (req.headers.get("host") ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
			if (DEBUG) console.error(`[http] ${req.method} ${url.pathname} host=${hostName} upgrade=${req.headers.get("upgrade") ?? "-"}`);
			if (!isAllowedHost(hostName)) return new Response("forbidden host", { status: 403 });
			if (url.pathname === "/ws") {
				const ok = srv.upgrade(req, { data: { authed: false, subscriber: { send: () => {} }, ptyListeners: new Map(), opening: new Map() } });
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
				return track(handleApi(req, url));
			}
			const peer = srv.requestIP(req)?.address ?? "";
			const trusted = (isLoopbackAddress(peer) && LOOPBACK_HOSTS.has(hostName)) || cookieToken(req) === config.token;
			return track(serveStatic(url, trusted));
		},
		websocket: {
			maxPayloadLength: 64 * 1024 * 1024,
			open(ws) {
				if (DEBUG) console.error("[ws] open");
				ws.data.subscriber = { connected: true, send: msg => ws.send(JSON.stringify(msg)) };
				ws.data.ptyListeners = new Map();
			},
			message(ws, raw) {
				let message: ClientMessage;
				try {
					const parsed: unknown = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
					if (!validClientMessage(parsed)) throw new Error("malformed message");
					message = parsed;
				} catch {
					ws.send(JSON.stringify({ t: "error", message: "malformed message" } satisfies ServerMessage));
					return;
				}
				if (DEBUG) console.error(`[ws] message ${message.t}`);
				void track(handleMessage(ws, message)).catch(error => {
					console.error("WebSocket dispatch failed:", errorText(error));
					ws.send(JSON.stringify({ t: "error", message: "message dispatch failed" }));
				});
			},
			close(ws, code) {
				if (DEBUG) console.error(`[ws] close ${code}`);
				if (ws.data.authed) {
					clients -= 1;
					if (!stopping) log(`Browser disconnected (${clients} open)`);
				}
				ws.data.subscriber.connected = false;
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
		url: `http://${config.host.includes(":") ? `[${config.host}]` : config.host}:${port}`,
		chats,
		store,
		status: () => {
			const running = [...chats.chats.values()].filter(chat => chat.info.status !== "exited");
			return {
				version: GATEWAY_VERSION,
				ompVersion,
				ompStatus,
				clients,
				chats: running.length,
				busy: running.filter(chat => chat.busy).length,
				terminals: ptys.ptys.size,
			};
		},
		stop() {
			if (stopPromise) return stopPromise;
			stopping = true;
			chats.stopping = true;
			server.stop(true);
			ompCli.stop();
			stopPromise = (async () => {
				await Promise.allSettled([ptys.closeAll(), chats.closeAll()]);
				await Promise.allSettled([...inFlight]);
				store.close();
			})();
			return stopPromise;
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
