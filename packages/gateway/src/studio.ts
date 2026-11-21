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

export function listAgents(params: {
	agentDir: string;
	projectPath?: string;
	bundled: Array<{ name: string; content: string }>;
}): AgentFile[] {
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
	const path = join(dir, `${name}.md`);
	const frontmatter = { ...params.frontmatter, name, description };
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, renderAgentMarkdown(frontmatter, params.instructions));
	renameSync(tmp, path);
	if (params.previousName && params.previousName !== name && AGENT_NAME.test(params.previousName)) {
		rmSync(join(dir, `${params.previousName}.md`), { force: true });
	}
	return { name, scope: params.scope, path, frontmatter, instructions: params.instructions };
}

export function deleteAgent(params: { scope: Scope; agentDir: string; projectPath?: string; name: string }): void {
	if (!AGENT_NAME.test(params.name)) throw new StudioError("invalid agent name");
	rmSync(join(agentDirFor(params.scope, params.agentDir, params.projectPath), `${params.name}.md`), { force: true });
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
	if (params.previousName && params.previousName !== name) delete servers[params.previousName];
	servers[name] = config;
	writeMcp(path, { ...file, mcpServers: servers });
	return { name, scope: params.scope, config, enabled: config.enabled !== false };
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
	writeMcp(path, { ...file, mcpServers: servers });
}
