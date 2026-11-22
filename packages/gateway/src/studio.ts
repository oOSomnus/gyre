/**
 * File-backed omp configuration the UI edits directly: task agents
 * (`<agentDir>/agents/*.md`, `<project>/.omp/agents/*.md`) and MCP servers
 * (`<agentDir>/mcp.json`, `<project>/.omp/mcp.json`). Paths are fixed by omp's
 * layout; names are validated so nothing escapes those directories.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export class StudioError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

export type Scope = "user" | "project";

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export interface AgentFile {
	name: string;
	scope: Scope | "bundled";
	path?: string;
	frontmatter: Record<string, unknown>;
	instructions: string;
	/** A same-named agent with higher precedence hides this one. */
	shadowed?: boolean;
}

const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESERVED_AGENT_NAMES = new Set(["main", "sub"]);

export function parseAgentMarkdown(text: string): { frontmatter: Record<string, unknown>; instructions: string } {
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) return { frontmatter: {}, instructions: text };
	let frontmatter: Record<string, unknown> = {};
	try {
		const parsed = Bun.YAML.parse(match[1] ?? "");
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) frontmatter = parsed as Record<string, unknown>;
	} catch {
		frontmatter = {};
	}
	return { frontmatter, instructions: (match[2] ?? "").replace(/^\n+/, "") };
}

export function renderAgentMarkdown(frontmatter: Record<string, unknown>, instructions: string): string {
	const clean = Object.fromEntries(
		Object.entries(frontmatter).filter(([, v]) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0)),
	);
	const yaml = Bun.YAML.stringify(clean, null, 2).trimEnd();
	return `---\n${yaml}\n---\n\n${instructions.trim()}\n`;
}

function agentDirFor(scope: Scope, agentDir: string, projectPath?: string): string {
	if (scope === "user") return join(agentDir, "agents");
	if (!projectPath) throw new StudioError("projectId is required for project agents");
	return join(projectPath, ".omp", "agents");
}

function readAgentDir(dir: string, scope: Scope): AgentFile[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter(f => f.endsWith(".md"))
		.map(f => {
			const path = join(dir, f);
			const { frontmatter, instructions } = parseAgentMarkdown(readFileSync(path, "utf8"));
			return { name: String(frontmatter.name ?? f.replace(/\.md$/, "")), scope, path, frontmatter, instructions };
		});
}

export function listAgents(params: { agentDir: string; projectPath?: string; bundled: Array<{ name: string; content: string }> }): AgentFile[] {
	const project = params.projectPath ? readAgentDir(join(params.projectPath, ".omp", "agents"), "project") : [];
	const user = readAgentDir(join(params.agentDir, "agents"), "user");
	const bundled: AgentFile[] = params.bundled.map(b => {
		const { frontmatter, instructions } = parseAgentMarkdown(b.content);
		return { name: String(frontmatter.name ?? b.name), scope: "bundled", frontmatter, instructions };
	});
	// omp precedence: project, then user, then bundled; first match wins by name.
	const seen = new Set<string>();
	return [...project, ...user, ...bundled].map(agent => {
		const shadowed = seen.has(agent.name);
		seen.add(agent.name);
		return shadowed ? { ...agent, shadowed } : agent;
	});
}

export function saveAgent(params: {
	scope: Scope;
	agentDir: string;
	projectPath?: string;
	name: string;
	frontmatter: Record<string, unknown>;
	instructions: string;
	previousName?: string;
}): AgentFile {
	const name = params.name.trim();
	if (!AGENT_NAME.test(name)) throw new StudioError("agent names use letters, digits, '.', '_' or '-' (max 64)");
	if (RESERVED_AGENT_NAMES.has(name)) throw new StudioError(`"${name}" is reserved by omp`);
	const description = String(params.frontmatter.description ?? "").trim();
	if (!description) throw new StudioError("description is required");
	const dir = agentDirFor(params.scope, params.agentDir, params.projectPath);
	mkdirSync(dir, { recursive: true });
	const definitions = readAgentDir(dir, params.scope);
	const existing = definitions.filter(a => a.name === (params.previousName ?? name));
	if (existing.length > 1) throw new StudioError("ambiguous agent name; remove duplicate definitions first", 409);
	const previousPath = existing[0]?.path;
	const path = (!params.previousName || params.previousName === name) && previousPath ? previousPath : join(dir, `${name}.md`);
	if (definitions.some(a => a.path !== previousPath && (a.name === name || a.path === path)) || (path !== previousPath && existsSync(path)))
		throw new StudioError("an agent with that name or backing path already exists", 409);
	const frontmatter = { ...params.frontmatter, name, description };
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, renderAgentMarkdown(frontmatter, params.instructions));
	renameSync(tmp, path);
	if (previousPath && previousPath !== path) {
		rmSync(previousPath, { force: true });
	}
	return { name, scope: params.scope, path, frontmatter, instructions: params.instructions };
}

export function deleteAgent(params: { scope: Scope; agentDir: string; projectPath?: string; name: string }): void {
	if (!AGENT_NAME.test(params.name)) throw new StudioError("invalid agent name");
	const matches = readAgentDir(agentDirFor(params.scope, params.agentDir, params.projectPath), params.scope).filter(a => a.name === params.name);
	if (matches.length > 1) throw new StudioError("ambiguous agent name; remove duplicate definitions first", 409);
	if (matches[0]?.path) rmSync(matches[0].path, { force: true });
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

export interface McpServerEntry {
	name: string;
	scope: Scope;
	config: Record<string, unknown>;
	enabled: boolean;
}

const MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;

function mcpPath(scope: Scope, agentDir: string, projectPath?: string): string {
	if (scope === "user") return join(agentDir, "mcp.json");
	if (!projectPath) throw new StudioError("projectId is required for project MCP servers");
	return join(projectPath, ".omp", "mcp.json");
}

interface McpFile {
	mcpServers?: Record<string, Record<string, unknown>>;
	disabledServers?: string[];
	[key: string]: unknown;
}

function readMcp(path: string): McpFile {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as McpFile) : {};
	} catch {
		throw new StudioError(`${path} is not valid JSON; fix it by hand first`, 409);
	}
}

function writeMcp(path: string, data: McpFile): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
	renameSync(tmp, path);
}

export function listMcp(agentDir: string, projectPath?: string): McpServerEntry[] {
	const out: McpServerEntry[] = [];
	const scopes: Scope[] = projectPath ? ["project", "user"] : ["user"];
	for (const scope of scopes) {
		const file = readMcp(mcpPath(scope, agentDir, projectPath));
		const disabled = new Set(scope === "user" ? (file.disabledServers ?? []) : []);
		for (const [name, config] of Object.entries(file.mcpServers ?? {})) {
			out.push({ name, scope, config, enabled: config.enabled !== false && !disabled.has(name) });
		}
	}
	return out;
}

export function saveMcp(params: {
	scope: Scope;
	agentDir: string;
	projectPath?: string;
	name: string;
	config: Record<string, unknown>;
	previousName?: string;
}): McpServerEntry {
	const name = params.name.trim();
	if (!MCP_NAME.test(name)) throw new StudioError("server names use letters, digits, '.', '_' or '-' (max 48)");
	const config = { ...params.config };
	const type = String(config.type ?? (config.url ? "http" : "stdio"));
	if (!["stdio", "http", "sse"].includes(type)) throw new StudioError("type must be stdio, http or sse");
	config.type = type;
	if (type === "stdio" && !String(config.command ?? "").trim()) throw new StudioError("command is required for stdio servers");
	if (type !== "stdio") {
		try {
			new URL(String(config.url ?? ""));
		} catch {
			throw new StudioError("a valid url is required for http/sse servers");
		}
	}
	const path = mcpPath(params.scope, params.agentDir, params.projectPath);
	const file = readMcp(path);
	const servers = { ...(file.mcpServers ?? {}) };
	if (params.previousName && params.previousName !== name) {
		if (Object.hasOwn(servers, name)) throw new StudioError("an MCP server with that name already exists", 409);
		delete servers[params.previousName];
	}
	const old = file.mcpServers?.[params.previousName ?? name] ?? {};
	const merged = { ...old, ...config };
	for (const key of ["command", "args", "url", "auth"]) if (!(key in config)) delete merged[key];
	const oldHeaders = old.headers && typeof old.headers === "object" ? (old.headers as Record<string, unknown>) : {};
	const headers = Object.fromEntries(Object.entries(oldHeaders).filter(([key]) => key.toLowerCase() !== "authorization"));
	Object.assign(headers, config.headers ?? {});
	if (Object.keys(headers).length) merged.headers = headers;
	else delete merged.headers;
	servers[name] = merged;
	const disabledServers = file.disabledServers?.map(n => (n === params.previousName ? name : n));
	writeMcp(path, { ...file, disabledServers, mcpServers: servers });
	return { name, scope: params.scope, config: merged, enabled: merged.enabled !== false && !(params.scope === "user" && disabledServers?.includes(name)) };
}

export function setMcpEnabled(params: { scope: Scope; agentDir: string; projectPath?: string; name: string; enabled: boolean }): void {
	const path = mcpPath(params.scope, params.agentDir, params.projectPath);
	const file = readMcp(path);
	const server = file.mcpServers?.[params.name];
	if (!server) throw new StudioError(`no MCP server named ${params.name}`, 404);
	const next: McpFile = { ...file, mcpServers: { ...file.mcpServers, [params.name]: { ...server } } };
	const entry = next.mcpServers?.[params.name] as Record<string, unknown>;
	if (params.enabled) delete entry.enabled;
	else entry.enabled = false;
	if (params.scope === "user" && params.enabled && next.disabledServers) {
		next.disabledServers = next.disabledServers.filter(n => n !== params.name);
	}
	writeMcp(path, next);
}

export function deleteMcp(params: { scope: Scope; agentDir: string; projectPath?: string; name: string }): void {
	const path = mcpPath(params.scope, params.agentDir, params.projectPath);
	const file = readMcp(path);
	if (!file.mcpServers?.[params.name]) return;
	const servers = { ...file.mcpServers };
	delete servers[params.name];
	writeMcp(path, { ...file, disabledServers: file.disabledServers?.filter(n => n !== params.name), mcpServers: servers });
}
