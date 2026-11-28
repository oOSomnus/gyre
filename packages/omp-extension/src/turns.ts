/**
 * Per-turn snapshots for Gyre's Review pane. omp awaits extension handlers for
 * `agent_start` and `agent_end`, so a git tree of the work tree taken in them brackets
 * exactly what one agent run changed, whatever started the run (a prompt, a follow-up,
 * a background job waking the agent). Trees are written with a temporary index (the real
 * index is untouched), kept alive by refs under `refs/gyre/turns/<session>/`, and listed
 * in `<git common dir>/gyre/turns/<session>.json`. The list is published as the
 * `gyre.turns` widget. A failed snapshot is recorded on its turn and never blocks the agent.
 */
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TurnRecord, TURNS_WIDGET_KEY, type TurnsState } from "@gyre/protocol";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export const MAX_TURNS = 30;
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const SNAPSHOT_TIMEOUT_MS = 10_000;
const PROMPT_CHARS = 200;

interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

const REPO_LOCATION_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_NAMESPACE", "GIT_PREFIX"];

export async function git(cwd: string, args: string[], env: Record<string, string> = {}, timeoutMs = SNAPSHOT_TIMEOUT_MS, input?: string): Promise<GitResult> {
	const base: Record<string, string | undefined> = { ...process.env };
	for (const name of REPO_LOCATION_VARS) delete base[name];
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
		stdout: "pipe",
		stderr: "pipe",
		env: { ...base, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", ...env },
	});
	const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
	try {
		const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		return { code: proc.signalCode === "SIGKILL" ? -1 : code, stdout, stderr: proc.signalCode === "SIGKILL" ? `git ${args[0]} timed out` : stderr };
	} finally {
		clearTimeout(timer);
	}
}

export interface Repo {
	root: string;
	/** This work tree's git dir (holds its index). */
	gitDir: string;
	/** Shared git dir (refs and Gyre's turn lists). */
	commonDir: string;
}

export async function findRepo(cwd: string): Promise<Repo | null> {
	const result = await git(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"]);
	if (result.code !== 0) return null;
	const [root, gitDir, commonDir] = result.stdout.trim().split("\n");
	return root && gitDir && commonDir ? { root, gitDir, commonDir } : null;
}

/** The work tree as a tree object (ignored files excluded), via a temporary index. */
export async function snapshot(repo: Repo): Promise<string> {
	const index = join(tmpdir(), `gyre-turn-${process.pid}-${randomBytes(6).toString("hex")}`);
	try {
		try {
			copyFileSync(join(repo.gitDir, "index"), index);
		} catch {}
		const env = { GIT_INDEX_FILE: index };
		const add = await git(repo.root, ["add", "-A", "--", "."], env);
		if (add.code !== 0) throw new Error(add.stderr.trim() || "git add failed");
		const tree = await git(repo.root, ["write-tree"], env);
		const sha = tree.stdout.trim();
		if (tree.code !== 0 || !sha) throw new Error(tree.stderr.trim() || "git write-tree failed");
		return sha;
	} finally {
		rmSync(index, { force: true });
	}
}

/** A session id safe for a ref name and a file name. */
export const sessionKey = (id: string) =>
	id
		.replace(/[^A-Za-z0-9._-]/g, "_")
		.replace(/\.{2,}/g, "_")
		.replace(/^\.|\.$|\.lock$/g, "_")
		.slice(0, 120) || "session";

const listFile = (repo: Repo, key: string) => join(repo.commonDir, "gyre", "turns", `${key}.json`);
const refBase = (key: string) => `refs/gyre/turns/${key}`;

export function loadTurns(repo: Repo, key: string): TurnRecord[] {
	try {
		const turns = (JSON.parse(readFileSync(listFile(repo, key), "utf8")) as { turns?: unknown }).turns;
		return Array.isArray(turns) ? (turns as TurnRecord[]).filter(t => t && typeof t.n === "number") : [];
	} catch {
		return [];
	}
}

function saveTurns(repo: Repo, key: string, turns: TurnRecord[]): void {
	const file = listFile(repo, key);
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(`${file}.tmp`, JSON.stringify({ turns }));
	// Rename for an atomic replace; a reader never sees half a list.
	renameSync(`${file}.tmp`, file);
}

/** Apply `update-ref --stdin` lines in the repository `cwd` selects; throws if git refuses. */
async function updateRefs(repo: Repo, lines: string[]): Promise<void> {
	if (!lines.length) return;
	const result = await git(repo.root, ["update-ref", "--stdin"], {}, SNAPSHOT_TIMEOUT_MS, `${lines.join("\n")}\n`);
	if (result.code !== 0) throw new Error(result.stderr.trim() || "git update-ref failed");
}

/** Remove turn lists (and their refs) of sessions untouched for `ttlMs`. */
export async function pruneSessions(repo: Repo, keep: string, ttlMs = SESSION_TTL_MS, now = Date.now()): Promise<void> {
	const dir = join(repo.commonDir, "gyre", "turns");
	let names: string[];
	try {
		names = readdirSync(dir).filter(n => n.endsWith(".json"));
	} catch {
		return;
	}
	for (const name of names) {
		const key = name.slice(0, -5);
		if (key === keep) continue;
		const file = join(dir, name);
		try {
			if (now - statSync(file).mtimeMs < ttlMs) continue;
		} catch {
			continue;
		}
		// The list file is how a later pass finds the session, so it goes only once its refs have.
		const refs = await git(repo.root, ["for-each-ref", "--format=%(refname)", `${refBase(key)}/`]);
		if (refs.code !== 0) continue;
		try {
			await updateRefs(repo, refs.stdout.split("\n").filter(Boolean).map(ref => `delete ${ref}`));
		} catch {
			continue;
		}
		rmSync(file, { force: true });
	}
}

export interface TurnRecorder {
	repo: Repo;
	key: string;
	turns: TurnRecord[];
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Save the list; a failure is recorded on `turn`, so Review shows it instead of losing it. */
function persist(rec: TurnRecorder, turn: TurnRecord): void {
	try {
		saveTurns(rec.repo, rec.key, rec.turns);
	} catch (error) {
		turn.error = `${turn.error ? `${turn.error}; ` : ""}could not save the turn list: ${message(error)}`;
	}
}

/** Record the start of a run: snapshot the "before" tree. */
export async function beginTurn(rec: TurnRecorder, prompt: string, now = Date.now()): Promise<TurnRecord> {
	const turn: TurnRecord = { n: (rec.turns.at(-1)?.n ?? 0) + 1, prompt: prompt.trim().slice(0, PROMPT_CHARS), startedAt: now };
	try {
		const tree = await snapshot(rec.repo);
		// Published only once a ref keeps it from garbage collection.
		await updateRefs(rec.repo, [`update ${refBase(rec.key)}/${turn.n}-before ${tree}`]);
		turn.before = tree;
	} catch (error) {
		turn.error = message(error);
	}
	rec.turns = [...rec.turns, turn];
	const dropped = rec.turns.slice(0, Math.max(0, rec.turns.length - MAX_TURNS));
	rec.turns = rec.turns.slice(-MAX_TURNS);
	// Refs of dropped turns that fail to go only cost space; a later drop retries nothing,
	// but the session's refs all go when it is pruned.
	await updateRefs(rec.repo, dropped.flatMap(t => [`delete ${refBase(rec.key)}/${t.n}-before`, `delete ${refBase(rec.key)}/${t.n}-after`])).catch(() => {});
	persist(rec, turn);
	return turn;
}

/** Record the end of the latest open run: snapshot the "after" tree. */
export async function endTurn(rec: TurnRecorder, now = Date.now()): Promise<TurnRecord | undefined> {
	const turn = rec.turns.at(-1);
	if (!turn || turn.endedAt !== undefined) return undefined;
	turn.endedAt = now;
	if (turn.before) {
		try {
			const tree = await snapshot(rec.repo);
			await updateRefs(rec.repo, [`update ${refBase(rec.key)}/${turn.n}-after ${tree}`]);
			turn.after = tree;
		} catch (error) {
			turn.error = message(error);
		}
	}
	rec.turns = [...rec.turns];
	persist(rec, turn);
	return turn;
}

export function registerTurns(pi: ExtensionAPI): void {
	let ctx: ExtensionContext | undefined;
	let rec: TurnRecorder | undefined;
	let unavailable: string | undefined;
	let sessionId = "";
	let pendingPrompt = "";
	/** Snapshots run one after another, so an end never races the next start. */
	let queue: Promise<unknown> = Promise.resolve();
	const isMain = (c: ExtensionContext | undefined) => !!c && (c as { agent?: { kind?: string } }).agent?.kind !== "sub";
	const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
		const next = queue.catch(() => {}).then(work);
		queue = next;
		return next;
	};

	const publish = () => {
		if (!ctx?.hasUI) return;
		const state: TurnsState = { sessionId, turns: rec?.turns ?? [], ...(unavailable ? { unavailable } : {}) };
		try {
			ctx.ui.setWidget(TURNS_WIDGET_KEY, [JSON.stringify(state)]);
		} catch (error) {
			pi.logger.warn("gyre turns: publish failed", { error: String(error) });
		}
	};

	const attach = (c: ExtensionContext) =>
		enqueue(async () => {
			ctx = c;
			sessionId = c.sessionManager.getSessionId?.() ?? "session";
			const repo = await findRepo(c.cwd);
			if (!repo) {
				rec = undefined;
				unavailable = "Review needs a git repository: turns are recorded as git trees.";
				publish();
				return;
			}
			unavailable = undefined;
			const key = sessionKey(sessionId);
			rec = { repo, key, turns: loadTurns(repo, key) };
			publish();
			void pruneSessions(repo, key).catch(() => {});
		});

	pi.on("session_start", (_event, c) => {
		if (isMain(c)) void attach(c);
	});
	pi.on("session_switch", (_event, c) => {
		if (isMain(c)) void attach(c);
	});
	pi.on("session_branch", (_event, c) => {
		if (isMain(c)) void attach(c);
	});
	pi.on("before_agent_start", event => {
		pendingPrompt = typeof event.prompt === "string" ? event.prompt : "";
		return undefined;
	});
	pi.on("agent_start", async (_event, c) => {
		if (!isMain(c)) return;
		ctx = c;
		const prompt = pendingPrompt;
		pendingPrompt = "";
		if (!rec && !unavailable) await attach(c);
		await enqueue(async () => {
			if (!rec) return;
			await beginTurn(rec, prompt);
			publish();
		}).catch(error => pi.logger.warn("gyre turns: start snapshot failed", { error: String(error) }));
	});
	// Returned so omp waits for the "after" snapshot before later agent_end handlers (another
	// extension's hook could otherwise write a file into this turn's tree).
	pi.on("agent_end", (_event, c) => {
		if (!isMain(c)) return;
		ctx = c;
		return enqueue(async () => {
			if (!rec) return;
			if (await endTurn(rec)) publish();
		}).catch(error => pi.logger.warn("gyre turns: end snapshot failed", { error: String(error) }));
	});
}
