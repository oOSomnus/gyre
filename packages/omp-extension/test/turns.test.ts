import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TURNS_WIDGET_KEY, type TurnsState } from "@gyre/protocol";
import { beginTurn, endTurn, findRepo, git, loadTurns, MAX_TURNS, pruneSessions, registerTurns, sessionKey, snapshot, type TurnRecorder } from "../src/turns";

const tmp = mkdtempSync(join(tmpdir(), "gyre-turns-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let counter = 0;

async function repo(files: Record<string, string> = { "a.txt": "a\n", ".gitignore": "ignored/\n" }) {
	const dir = join(tmp, `r${++counter}`);
	mkdirSync(dir, { recursive: true });
	const run = (...args: string[]) => git(dir, args, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
	await run("init", "-q", "-b", "main");
	await run("config", "user.email", "t@example.com");
	await run("config", "user.name", "T");
	for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
	await run("add", "-A");
	await run("commit", "-q", "-m", "init");
	return { dir, run };
}

const lsTree = async (dir: string, tree: string) => (await git(dir, ["ls-tree", "-r", "--name-only", tree])).stdout.trim().split("\n");

test("a snapshot holds tracked and untracked files but not ignored ones, and leaves the index alone", async () => {
	const { dir, run } = await repo();
	writeFileSync(join(dir, "new.txt"), "n\n");
	mkdirSync(join(dir, "ignored"));
	writeFileSync(join(dir, "ignored/x"), "x");
	const r = (await findRepo(dir))!;
	const tree = await snapshot(r);
	expect(await lsTree(dir, tree)).toEqual([".gitignore", "a.txt", "new.txt"]);
	expect((await run("status", "--porcelain")).stdout).toContain("?? new.txt");
});

test("begin and end bracket one run with refs that keep the trees alive", async () => {
	const { dir } = await repo();
	const r = (await findRepo(dir))!;
	const rec: TurnRecorder = { repo: r, key: "s1", turns: [] };
	const turn = await beginTurn(rec, "  change a  ");
	writeFileSync(join(dir, "a.txt"), "changed\n");
	await endTurn(rec);
	expect(turn).toMatchObject({ n: 1, prompt: "change a" });
	expect(rec.turns[0]!.before).not.toBe(rec.turns[0]!.after);
	const refs = (await git(dir, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/gyre/turns/s1/"])).stdout;
	expect(refs).toContain(`refs/gyre/turns/s1/1-before ${rec.turns[0]!.before}`);
	expect(refs).toContain(`refs/gyre/turns/s1/1-after ${rec.turns[0]!.after}`);
	expect(loadTurns(r, "s1")).toEqual(rec.turns);
	expect(await endTurn(rec)).toBeUndefined();
});

test("only the last turns are kept, and dropped turns lose their refs", async () => {
	const { dir } = await repo();
	const r = (await findRepo(dir))!;
	const rec: TurnRecorder = { repo: r, key: "s2", turns: [] };
	for (let i = 0; i < MAX_TURNS + 2; i++) {
		await beginTurn(rec, `t${i}`);
		await endTurn(rec);
	}
	expect(rec.turns).toHaveLength(MAX_TURNS);
	expect(rec.turns[0]!.n).toBe(3);
	const refs = (await git(dir, ["for-each-ref", "--format=%(refname)", "refs/gyre/turns/s2/"])).stdout;
	expect(refs).not.toContain("/1-before");
	expect(refs).toContain(`/${MAX_TURNS + 2}-after`);
});

test("a snapshot failure is recorded on the turn instead of throwing", async () => {
	const rec: TurnRecorder = { repo: { root: join(tmp, "missing"), gitDir: join(tmp, "missing/.git"), commonDir: join(tmp, "missing-common") }, key: "s3", turns: [] };
	mkdirSync(join(tmp, "missing-common"), { recursive: true });
	const turn = await beginTurn(rec, "x");
	expect(turn.error).toBeTruthy();
	expect(turn.before).toBeUndefined();
});

test("stale sessions are pruned with their refs; the current one is kept", async () => {
	const { dir } = await repo();
	const r = (await findRepo(dir))!;
	for (const key of ["old", "current"]) {
		const rec: TurnRecorder = { repo: r, key, turns: [] };
		await beginTurn(rec, key);
		await endTurn(rec);
	}
	const oldFile = join(r.commonDir, "gyre/turns/old.json");
	const past = new Date(Date.now() - 30 * 24 * 3600 * 1000);
	utimesSync(oldFile, past, past);
	utimesSync(join(r.commonDir, "gyre/turns/current.json"), past, past);
	await pruneSessions(r, "current");
	expect(loadTurns(r, "old")).toEqual([]);
	expect(loadTurns(r, "current")).toHaveLength(1);
	const refs = (await git(dir, ["for-each-ref", "--format=%(refname)", "refs/gyre/turns/"])).stdout;
	expect(refs).not.toContain("/old/");
	expect(refs).toContain("/current/");
});

test("session ids become safe ref components", () => {
	expect(sessionKey("abc-123_x.y")).toBe("abc-123_x.y");
	expect(sessionKey("../a b/c..d.lock")).not.toMatch(/\.\.|\/| |\.lock$/);
	expect(sessionKey("")).toBe("session");
});

type Handler = (event: unknown, ctx: unknown) => unknown;
function harness(cwd: string) {
	const handlers = new Map<string, Handler[]>();
	const widgets: TurnsState[] = [];
	const pi = { on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]), logger: { warn() {} } };
	const ctx = {
		hasUI: true,
		cwd,
		agent: { kind: "main" },
		sessionManager: { getSessionId: () => "sess" },
		ui: { setWidget: (key: string, lines?: string[]) => key === TURNS_WIDGET_KEY && lines && widgets.push(JSON.parse(lines[0]!)) },
	};
	registerTurns(pi as never);
	const emit = async (name: string, event: unknown = {}) => {
		for (const h of handlers.get(name) ?? []) await h(event, ctx);
	};
	return { emit, widgets };
}

test("the extension snapshots around each run and publishes the turn list", async () => {
	const { dir } = await repo();
	const h = harness(dir);
	await h.emit("session_start");
	await h.emit("before_agent_start", { prompt: "edit a" });
	await h.emit("agent_start");
	writeFileSync(join(dir, "a.txt"), "edited\n");
	// agent_end resolves only once the "after" snapshot is taken and published.
	await h.emit("agent_end");
	const state = h.widgets.at(-1)!;
	expect(state.sessionId).toBe("sess");
	expect(state.turns[0]).toMatchObject({ n: 1, prompt: "edit a" });
	const { before, after } = state.turns[0]!;
	expect(before).toMatch(/^[0-9a-f]{40}/);
	expect(after).toMatch(/^[0-9a-f]{40}/);
	expect(before).not.toBe(after);
	const saved = JSON.parse(readFileSync(join(dir, ".git/gyre/turns/sess.json"), "utf8")).turns;
	expect(saved).toHaveLength(1);
	expect(saved[0]).toMatchObject({ before, after });
});

test("outside a git repository the widget says why review is unavailable", async () => {
	const dir = join(tmp, "plain");
	mkdirSync(dir);
	const h = harness(dir);
	await h.emit("session_start");
	const end = Date.now() + 3000;
	while (!h.widgets.length && Date.now() < end) await Bun.sleep(10);
	expect(h.widgets.at(-1)?.unavailable).toMatch(/git repository/);
	await h.emit("agent_start");
	await h.emit("agent_end");
	expect(h.widgets.at(-1)?.turns).toEqual([]);
});
