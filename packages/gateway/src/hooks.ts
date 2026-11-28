/**
 * omp hook modules for Hook Studio. omp discovers `<configDir>/hooks/{pre,post}/<tool>.ts`
 * (or `.js`, base name `*` for every tool) in the user agent directory and in the project's
 * `.omp`, imports each as a module whose default export receives the hook API, and loads them
 * when a chat starts. Saves are conditional on the version read and checked for syntax first.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { HookFile, HookPhase } from "@gyre/protocol";
import { contentVersion, FsAccessError, readText, writeText } from "./fs";
import { type Scope, StudioError } from "./studio";

const HOOK_NAME = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63}|\*)\.(ts|js)$/;
const PHASES: HookPhase[] = ["pre", "post"];

export interface HookLocation {
	agentDir: string;
	projectPath?: string;
}

export function hooksDir(scope: Scope, where: HookLocation): string {
	if (scope === "user") return join(where.agentDir, "hooks");
	if (!where.projectPath) throw new StudioError("a project is required for project hooks");
	return join(where.projectPath, ".omp", "hooks");
}

const phaseOf = (value: unknown): HookPhase => {
	if (value === "pre" || value === "post") return value;
	throw new StudioError("phase must be pre or post");
};

function checkName(name: unknown): string {
	if (typeof name !== "string" || !HOOK_NAME.test(name)) {
		throw new StudioError("hook file names are a tool name (or *) ending in .ts or .js, e.g. bash.ts");
	}
	return name;
}

const toolOf = (name: string) => name.slice(0, name.lastIndexOf("."));

export function listHooks(where: HookLocation): HookFile[] {
	const result: HookFile[] = [];
	const scopes: Scope[] = where.projectPath ? ["project", "user"] : ["user"];
	for (const scope of scopes) {
		for (const phase of PHASES) {
			const dir = join(hooksDir(scope, where), phase);
			if (!existsSync(dir)) continue;
			for (const name of readdirSync(dir).sort()) {
				if (!HOOK_NAME.test(name)) continue;
				const path = join(dir, name);
				try {
					if (!statSync(path).isFile()) continue;
				} catch {
					continue;
				}
				result.push({ scope, phase, name, tool: toolOf(name), path });
			}
		}
	}
	return result;
}

export async function readHook(where: HookLocation, scope: Scope, phase: unknown, name: unknown): Promise<HookFile> {
	const p = phaseOf(phase);
	const n = checkName(name);
	const dir = join(hooksDir(scope, where), p);
	const file = await readText(dir, n);
	return { scope, phase: p, name: n, tool: toolOf(n), path: join(dir, n), content: file.content, version: file.version };
}

/** Syntax errors in a hook module, as messages; empty when it parses. */
export function hookDiagnostics(name: string, content: string): string[] {
	try {
		new Bun.Transpiler({ loader: name.endsWith(".js") ? "js" : "ts" }).transformSync(content);
	} catch (error) {
		// Bun throws a BuildMessage (or an AggregateError of them) with a source position.
		type Message = { message?: string; position?: { line?: number; column?: number } | null };
		const messages: Message[] = (error as { errors?: Message[] }).errors ?? [error as Message];
		return messages.map(m => (m.position?.line ? `line ${m.position.line}:${m.position.column ?? 0} ${m.message}` : String(m.message ?? error)));
	}
	return /export\s+default/.test(content) ? [] : ["a hook module must have a default export: export default function (pi) { … }"];
}

export interface SaveHook extends HookLocation {
	scope: Scope;
	phase: unknown;
	name: unknown;
	content: unknown;
	/** Version from the read; null creates a new hook. */
	baseVersion: unknown;
	/** The hook's previous file, when renaming or moving it. */
	previous?: { phase: unknown; name: unknown };
}

export class HookSyntaxError extends StudioError {
	constructor(readonly diagnostics: string[]) {
		super(`the hook does not parse: ${diagnostics[0]}`, 422);
	}
}

export async function saveHook(input: SaveHook): Promise<HookFile> {
	const phase = phaseOf(input.phase);
	const name = checkName(input.name);
	if (typeof input.content !== "string") throw new StudioError("content is required");
	if (input.baseVersion !== null && typeof input.baseVersion !== "string") throw new StudioError("baseVersion must be a version or null");
	const diagnostics = hookDiagnostics(name, input.content);
	if (diagnostics.length) throw new HookSyntaxError(diagnostics);
	const root = hooksDir(input.scope, input);
	const dir = join(root, phase);
	mkdirSync(dir, { recursive: true });
	const previous = input.previous ? { phase: phaseOf(input.previous.phase), name: checkName(input.previous.name) } : undefined;
	const moving = previous && (previous.phase !== phase || previous.name !== name);
	if (!moving || !previous) {
		const result = await writeText(dir, name, input.content, input.baseVersion);
		return { scope: input.scope, phase, name, tool: toolOf(name), path: join(dir, name), content: input.content, version: result.version };
	}
	// A moved hook is created at its new name, then the old file is removed, provided the
	// old file is still the version the editor opened (checked before and after the create,
	// so a stale move leaves a newer source intact and removes the copy it made).
	const source = join(root, previous.phase, previous.name);
	const sourceVersion = typeof input.baseVersion === "string" ? input.baseVersion : undefined;
	if (sourceVersion) checkVersion(source, sourceVersion);
	const result = await writeText(dir, name, input.content, null);
	if (sourceVersion) {
		try {
			checkVersion(source, sourceVersion);
		} catch (error) {
			rmSync(join(dir, name), { force: true });
			throw error;
		}
	}
	rmSync(source, { force: true });
	return { scope: input.scope, phase, name, tool: toolOf(name), path: join(dir, name), content: input.content, version: result.version };
}

/** Throws a 412 unless the hook file at `path` still has `version`. */
function checkVersion(path: string, version: string): void {
	let bytes: Buffer;
	try {
		bytes = readFileSync(path);
	} catch {
		throw new FsAccessError("the hook was deleted since it was opened", 412, { currentVersion: null });
	}
	const current = contentVersion(bytes);
	if (current !== version) throw new FsAccessError("the hook changed on disk since it was opened", 412, { currentVersion: current });
}

/** Delete a hook; with `baseVersion`, only if it is still the version the caller read. */
export function deleteHook(where: HookLocation, scope: Scope, phase: unknown, name: unknown, baseVersion?: string | null): void {
	const path = join(hooksDir(scope, where), phaseOf(phase), checkName(name));
	if (!existsSync(path)) throw new StudioError("hook not found", 404);
	if (baseVersion) checkVersion(path, baseVersion);
	rmSync(path);
}
