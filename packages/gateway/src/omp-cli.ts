/**
 * Thin wrappers over omp's own CLI (`omp config`, `omp skill`, `omp agents`).
 *
 * Gyre never writes omp's config.yml itself: `omp config set` validates
 * values against omp's setting registry and running RPC processes pick the
 * change up through omp's config file watcher. Keys are allowlisted so the UI
 * cannot rewrite arbitrary settings.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class OmpCliError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

/** Settings the UI may read and write. Exact keys, or prefixes ending in ".". */
const CONFIG_ALLOW = [
	"modelRoles",
	"modelRoleStorage",
	"task.agentModelOverrides",
	"task.disabledAgents",
	"enabledProviders",
	"disabledProviders",
	"mcp.",
	"skills.",
	"plan.",
	"tools.approvalMode",
];

export function configKeyAllowed(key: string): boolean {
	return CONFIG_ALLOW.some(rule => (rule.endsWith(".") ? key.startsWith(rule) : key === rule || key.startsWith(`${rule}.`)));
}

export class OmpCli {
	#agentDir: string | undefined;
	#bundledAgents: Array<{ name: string; file: string; content: string }> | undefined;

	constructor(private readonly ompPath = "omp") {}

	async run(args: string[], cwd?: string, timeoutMs = 20_000): Promise<{ code: number; stdout: string; stderr: string }> {
		const proc = Bun.spawn([this.ompPath, ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
			env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
		});
		const timer = setTimeout(() => proc.kill(), timeoutMs);
		const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		clearTimeout(timer);
		return { code, stdout, stderr };
	}

	async json<T>(args: string[], cwd?: string): Promise<T> {
		const result = await this.run([...args, "--json"], cwd);
		if (result.code !== 0) throw new OmpCliError(stripAnsi(result.stderr || result.stdout).trim() || `omp ${args[0]} failed`);
		try {
			return JSON.parse(result.stdout) as T;
		} catch {
			throw new OmpCliError(`unexpected output from omp ${args.join(" ")}`, 500);
		}
	}

	/** omp's active agent directory (respects profiles and PI_CODING_AGENT_DIR). */
	async agentDir(): Promise<string> {
		if (this.#agentDir) return this.#agentDir;
		const result = await this.run(["config", "path"]);
		const dir = stripAnsi(result.stdout).trim().split("\n").pop()?.trim();
		if (result.code !== 0 || !dir) throw new OmpCliError("could not determine omp's agent directory", 500);
		this.#agentDir = dir;
		return dir;
	}

	async configGet(key: string, cwd?: string): Promise<unknown> {
		if (!configKeyAllowed(key)) throw new OmpCliError(`setting not allowed: ${key}`, 403);
		const result = await this.run(["config", "get", key, "--json"], cwd);
		if (result.code !== 0) throw new OmpCliError(stripAnsi(result.stderr || result.stdout).trim());
		const text = result.stdout.trim();
		if (!text) return null;
		try {
			const parsed = JSON.parse(text) as unknown;
			// `config get --json` may wrap the value as { key, value }.
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "value" in parsed && "key" in parsed) {
				return (parsed as { value: unknown }).value;
			}
			return parsed;
		} catch {
			return text;
		}
	}

	async configSet(key: string, value: unknown, cwd?: string): Promise<unknown> {
		if (!configKeyAllowed(key)) throw new OmpCliError(`setting not allowed: ${key}`, 403);
		const text = typeof value === "string" ? value : JSON.stringify(value);
		const result = await this.run(["config", "set", key, text, "--json"], cwd);
		if (result.code !== 0) throw new OmpCliError(stripAnsi(result.stderr || result.stdout).trim() || "omp config set failed");
		try {
			return (JSON.parse(result.stdout) as { value?: unknown }).value;
		} catch {
			return value;
		}
	}

	async configReset(key: string, cwd?: string): Promise<void> {
		if (!configKeyAllowed(key)) throw new OmpCliError(`setting not allowed: ${key}`, 403);
		const result = await this.run(["config", "reset", key], cwd);
		if (result.code !== 0) throw new OmpCliError(stripAnsi(result.stderr || result.stdout).trim() || "omp config reset failed");
	}

	async skills(cwd?: string): Promise<unknown> {
		return this.json<unknown>(["skill", "list"], cwd);
	}

	/** omp's bundled task agents, unpacked once into a temp dir so they match the installed omp. */
	async bundledAgents(): Promise<Array<{ name: string; file: string; content: string }>> {
		if (this.#bundledAgents) return this.#bundledAgents;
		const dir = mkdtempSync(join(tmpdir(), "gyre-agents-"));
		try {
			const result = await this.run(["agents", "unpack", "--dir", dir, "--force"]);
			if (result.code !== 0) return [];
			this.#bundledAgents = readdirSync(dir)
				.filter(f => f.endsWith(".md"))
				.map(f => ({ name: f.replace(/\.md$/, ""), file: f, content: readFileSync(join(dir, f), "utf8") }));
			return this.#bundledAgents;
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
}

export function stripAnsi(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes
	return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}
