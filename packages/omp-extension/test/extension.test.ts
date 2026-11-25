import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import gyrePlanMode, { isDestructiveCommand, isLocalUrl, PLAN_WIDGET_KEY, roleThinking, SUBMIT_TOOL, targetPaths } from "../src/index";

type Handler = (event: any, ctx: any) => any;

interface Model {
	provider: string;
	id: string;
}

function makeHarness(opts: { plannotator?: boolean; holdSends?: boolean; throwSends?: boolean } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "gy-ext-"));
	let sessionFile = join(dir, "session.jsonl");
	const localDir = join(dir, "session", "local");
	require("node:fs").mkdirSync(localDir, { recursive: true });
	const prefsFile = join(dir, "prefs.json");

	const models: Record<string, Model> = {
		"@plan": { provider: "p", id: "planner" },
		"@slow": { provider: "p", id: "thinker" },
		"@default": { provider: "p", id: "worker" },
	};
	let current: Model = { provider: "p", id: "start" };
	let activeTools = ["read", "bash", "edit", "write", "ask"];
	let thinking = "medium";
	const handlers = new Map<string, Handler[]>();
	const busHandlers = new Map<string, Array<(data: unknown) => void>>();
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const tools = new Map<string, any>();
	const widgets: Array<string[] | undefined> = [];
	const userMessages: string[] = [];
	const customMessages: any[] = [];
	const notices: string[] = [];
	const calls: string[] = [];
	let plannotatorRequests = 0;
	/** omp's modelRoles, as `omp config get modelRoles --json` reports them. */
	const roles: Record<string, unknown> = {};
	const execCalls: string[][] = [];
	/** Like omp, a held sendUserMessage resolves only when the run it started ends. */
	const heldSends: Array<() => void> = [];

	const ctx: any = {
		hasUI: true,
		cwd: dir,
		agent: { kind: "main", id: "Main" },
		localProtocolOptions: undefined,
		sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "s1", getArtifactsDir: () => sessionFile.replace(/\.jsonl$/, "") },
		get model() {
			return current;
		},
		models: { resolve: (spec: string) => models[spec], current: () => current },
		ui: {
			setWidget: (key: string, lines: string[] | undefined) => key === PLAN_WIDGET_KEY && widgets.push(lines),
			notify: (message: string) => notices.push(message),
		},
		abort: () => {
			calls.push("abort");
		},
		compact: async () => {
			calls.push("compact");
		},
		newSession: async (options?: { setup?: (manager: { getArtifactsDir(): string }) => Promise<void> }) => {
			calls.push("newSession");
			sessionFile = join(dir, "fresh.jsonl");
			await options?.setup?.({ getArtifactsDir: () => join(dir, "fresh"), getSessionId: () => "s2" } as any);
			return { cancelled: false };
		},
	};

	const pi: any = {
		zod: { object: (s: unknown) => s, string: () => ({ describe: () => ({}) }) },
		logger: { warn() {}, debug() {} },
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		events: {
			on: (channel: string, handler: (data: unknown) => void) => {
				busHandlers.set(channel, [...(busHandlers.get(channel) ?? []), handler]);
				return () => {};
			},
			emit: (channel: string, data: any) => {
				if (channel === "plannotator:request") plannotatorRequests += 1;
				if (channel === "plannotator:request" && opts.plannotator) {
					data.respond({ status: "handled", result: { status: "pending", reviewId: "rv1" } });
					for (const h of busHandlers.get("plannotator:session-opened") ?? []) {
						h({ id: "pn-1", action: "plan-review", url: "http://localhost:1234", reviewId: "rv1", requestId: data.requestId });
					}
				}
			},
		},
		registerCommand: (name: string, options: any) => commands.set(name, options.handler),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		getActiveTools: () => activeTools,
		setActiveTools: async (names: string[]) => {
			activeTools = names;
		},
		getThinkingLevel: () => thinking,
		setThinkingLevel: (level: string) => {
			thinking = level;
		},
		setModel: async (model: Model) => {
			current = model;
			return true;
		},
		sendUserMessage: (text: string) => {
			if (opts.throwSends) throw new Error("agent is busy");
			userMessages.push(text);
			return opts.holdSends ? new Promise<void>(resolve => heldSends.push(resolve)) : Promise.resolve();
		},
		exec: async (command: string, args: string[]) => {
			execCalls.push([command, ...args]);
			return { stdout: JSON.stringify({ key: "modelRoles", value: roles }), stderr: "", code: 0, killed: false };
		},
		sendMessage: (message: any) => customMessages.push(message),
	};

	gyrePlanMode(pi);

	const emit = async (name: string, event: any = {}) => {
		let result: any;
		for (const h of handlers.get(name) ?? []) result = (await h({ type: name, ...event }, ctx)) ?? result;
		return result;
	};
	const bus = (channel: string, data: unknown) => {
		for (const h of busHandlers.get(channel) ?? []) h(data);
	};
	const lastState = () => {
		const lines = widgets.at(-1);
		return lines ? JSON.parse(lines[0] ?? "{}") : { phase: "idle" };
	};
	const writePlan = (name: string, text: string) => writeFileSync(join(localDir, name), text);
	const submit = (plan: string, title = "T", id = "c1") => tools.get(SUBMIT_TOOL).execute(id, { plan, title }, undefined, undefined, ctx);
	const toolEnd = (toolCallId: string, isError = false) => emit("tool_execution_end", { toolName: SUBMIT_TOOL, toolCallId, isError, result: {} });
	const setPrefs = (prefs: object) => {
		writeFileSync(prefsFile, JSON.stringify(prefs));
		process.env.GYRE_PLAN_PREFS = prefsFile;
	};

	return {
		dir,
		ctx,
		commands,
		tools,
		emit,
		bus,
		lastState,
		writePlan,
		submit,
		toolEnd,
		setPrefs,
		userMessages,
		customMessages,
		notices,
		calls,
		roles,
		execCalls,
		/** End every held run. */
		endRuns: () => {
			for (const resolve of heldSends.splice(0)) resolve();
		},
		get plannotatorRequests() {
			return plannotatorRequests;
		},
		get activeTools() {
			return activeTools;
		},
		get model() {
			return current;
		},
		get thinking() {
			return thinking;
		},
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

let h: ReturnType<typeof makeHarness>;
afterEach(() => {
	h?.cleanup();
	delete process.env.GYRE_PLAN_PREFS;
});

describe("helpers", () => {
	test("local urls and path extraction", () => {
		expect(isLocalUrl("local://x-plan.md")).toBe(true);
		expect(isLocalUrl("src/x.ts")).toBe(false);
		expect(targetPaths({ path: "a.ts", edits: [{ path: "local://b.md" }] })).toEqual(["a.ts", "local://b.md"]);
		expect(targetPaths({ patch: "*** Update File: src/a.ts\n@@" })).toEqual(["src/a.ts"]);
		expect(targetPaths({ input: "*** Begin Patch\n[local://x-plan.md#E8F1]\nPUT 4.=4:\n+text" })).toEqual(["local://x-plan.md"]);
		expect(targetPaths({ input: "*** Begin Patch\n[src/app.ts#AB12]\nPUT 1:\n+x" })).toEqual(["src/app.ts"]);
	});
	test("destructive commands", () => {
		expect(isDestructiveCommand("rm -rf build")).toBe(true);
		expect(isDestructiveCommand("echo hi > out.txt")).toBe(true);
		expect(isDestructiveCommand("git commit -m x")).toBe(true);
		expect(isDestructiveCommand("ls -la && git status 2>&1")).toBe(false);
		expect(isDestructiveCommand("grep -rn foo src | head")).toBe(false);
	});
});

describe("role effort", () => {
	test("roleThinking takes the matched pattern's level, ignoring inherit and routing suffixes", () => {
		expect(roleThinking("p/planner:high", { provider: "p", id: "planner" })).toBe("high");
		expect(roleThinking("p/planner", { provider: "p", id: "planner" })).toBeUndefined();
		expect(roleThinking("p/planner:inherit", { provider: "p", id: "planner" })).toBeUndefined();
		expect(roleThinking("p/a:low, p/planner:xhigh", { provider: "p", id: "planner" })).toBe("xhigh");
		expect(roleThinking(["p/a:low", "p/planner:auto"], { provider: "p", id: "planner" })).toBe("auto");
		expect(roleThinking("openrouter/z/glm@cerebras:max", { provider: "openrouter", id: "z/glm" })).toBe("max");
		expect(roleThinking("planner:off", { provider: "p", id: "planner" })).toBe("off");
		expect(roleThinking("p/a:low, anthropic/opus@default:high", { provider: "anthropic", id: "opus@default" })).toBe("high");
		expect(roleThinking(undefined, { provider: "p", id: "planner" })).toBeUndefined();
	});
});

describe("plan mode", () => {
	beforeEach(() => {
		h = makeHarness();
	});

	test("enter switches to the plan role, activates submit_plan; cancel restores", async () => {
		await h.commands.get("plan")?.("", h.ctx);
		expect(h.model.id).toBe("planner");
		expect(h.activeTools).toContain(SUBMIT_TOOL);
		expect(h.lastState().phase).toBe("planning");
		await h.commands.get("plan")?.("", h.ctx);
		expect(h.model.id).toBe("start");
		expect(h.activeTools).not.toContain(SUBMIT_TOOL);
		expect(h.lastState().phase).toBe("idle");
	});

	test("enter applies the plan role's effort with its model, even when the model is unchanged; cancel restores both", async () => {
		h.roles.plan = "p/planner:high";
		await h.commands.get("plan")?.("", h.ctx);
		expect(h.model.id).toBe("planner");
		expect(h.thinking).toBe("high");
		await h.commands.get("plan")?.("", h.ctx);
		expect(h.model.id).toBe("start");
		expect(h.thinking).toBe("medium");
		// The plan role uses the model already selected: only the effort changes.
		const resolve = h.ctx.models.resolve;
		h.ctx.models.resolve = (spec: string) => (spec === "@plan" ? { provider: "p", id: "start" } : resolve(spec));
		h.roles.plan = "p/start:low";
		await h.commands.get("plan")?.("", h.ctx);
		expect(h.model.id).toBe("start");
		expect(h.thinking).toBe("low");
		await h.commands.get("plan")?.("", h.ctx);
		expect(h.thinking).toBe("medium");
	});

	test("a role without an explicit effort keeps the current effort", async () => {
		h.roles.plan = "p/planner";
		await h.commands.get("plan")?.("", h.ctx);
		expect(h.model.id).toBe("planner");
		expect(h.thinking).toBe("medium");
	});

	test("approval switches to the chosen role's model and effort", async () => {
		h.roles.plan = "p/planner:high";
		h.roles.slow = "p/thinker:xhigh";
		h.setPrefs({ role: "slow", context: "keep" });
		await h.commands.get("plan")?.("", h.ctx);
		h.writePlan("x-plan.md", "p");
		await h.submit("local://x-plan.md");
		await h.commands.get("gyre-plan")?.(JSON.stringify({ action: "approve", revision: h.lastState().revision }), h.ctx);
		expect(h.model.id).toBe("thinker");
		expect(h.thinking).toBe("xhigh");
		expect(h.execCalls.at(-1)).toEqual(["omp", "config", "get", "modelRoles", "--json"]);
	});

	test("enter with a prompt sends it", async () => {
		await h.commands.get("plan")?.("add a cache", h.ctx);
		expect(h.userMessages).toEqual(["add a cache"]);
	});

	test("guard blocks working-tree writes and destructive bash, allows local://", async () => {
		await h.commands.get("plan")?.("", h.ctx);
		expect((await h.emit("tool_call", { toolName: "write", input: { path: "src/a.ts", content: "x" } }))?.block).toBe(true);
		expect(await h.emit("tool_call", { toolName: "write", input: { path: "local://a-plan.md", content: "x" } })).toBeUndefined();
		expect((await h.emit("tool_call", { toolName: "edit", input: {} }))?.block).toBe(true);
		expect((await h.emit("tool_call", { toolName: "bash", input: { command: "rm -rf /" } }))?.block).toBe(true);
		expect(await h.emit("tool_call", { toolName: "bash", input: { command: "ls" } })).toBeUndefined();
	});

	test("guard is off outside plan mode", async () => {
		expect(await h.emit("tool_call", { toolName: "write", input: { path: "src/a.ts", content: "x" } })).toBeUndefined();
	});

	test("context hook injects hidden plan instructions only while planning", async () => {
		expect(await h.emit("context", { messages: [] })).toBeUndefined();
		await h.commands.get("plan")?.("", h.ctx);
		const result = await h.emit("context", { messages: [] });
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0].display).toBe(false);
		expect(result.messages[0].content).toContain("submit_plan");
	});

	test("reminds when a planning run ends without a decision, at most 3 times", async () => {
		await h.commands.get("plan")?.("", h.ctx);
		for (let i = 0; i < 5; i++) {
			await h.emit("agent_start");
			await h.emit("agent_end");
		}
		expect(h.customMessages).toHaveLength(3);
		await h.emit("agent_start");
		await h.emit("tool_call", { toolName: "ask", input: {} });
		await h.emit("agent_end");
		expect(h.customMessages).toHaveLength(3);
	});

	test("submit_plan requires an existing local:// file", async () => {
		await h.commands.get("plan")?.("", h.ctx);
		expect((await h.submit("plan.md")).details.ok).toBe(false);
		expect((await h.submit("local://missing-plan.md")).details.ok).toBe(false);
		h.writePlan("x-plan.md", "# Plan\n- step");
		const ok = await h.submit("local://x-plan.md", "X");
		expect(ok.details.ok).toBe(true);
		const state = h.lastState();
		expect(state.phase).toBe("reviewing");
		expect(state.planContent).toContain("step");
		expect(state.revision).toBe(1);
		expect(state.reviewUrl).toBeUndefined();
	});

	test("a successful submit_plan ends the run once its result is recorded", async () => {
		await h.commands.get("plan")?.("", h.ctx);
		await h.emit("agent_start");
		h.writePlan("x-plan.md", "# Plan");
		await h.submit("local://x-plan.md", "X", "call-1");
		expect(h.calls).toEqual([]);
		await h.toolEnd("call-1");
		expect(h.calls).toEqual(["abort"]);
		// A replayed end event does not abort again.
		await h.toolEnd("call-1");
		expect(h.calls).toEqual(["abort"]);
		expect(h.lastState().phase).toBe("reviewing");
		expect(h.lastState().revision).toBe(1);
		await h.emit("agent_end");
		expect(h.customMessages).toHaveLength(0);
	});

	test("a failed submit_plan does not end the run", async () => {
		await h.commands.get("plan")?.("", h.ctx);
		await h.submit("local://missing-plan.md", "X", "call-1");
		await h.toolEnd("call-1");
		await h.toolEnd("call-1", true);
		expect(h.calls).toEqual([]);
		expect(h.lastState().phase).toBe("planning");
	});

	test("an unchanged resubmission keeps the open review; a changed plan becomes a new revision", async () => {
		await h.commands.get("plan")?.("", h.ctx);
		h.writePlan("x-plan.md", "v1");
		await h.submit("local://x-plan.md", "X", "call-1");
		const again = await h.submit("local://x-plan.md", "X", "call-2");
		expect(again.details).toMatchObject({ ok: true, duplicate: true, revision: 1 });
		expect(h.lastState().revision).toBe(1);
		expect(h.plannotatorRequests).toBe(1);
		await h.toolEnd("call-2");
		expect(h.calls).toEqual(["abort"]);
		h.writePlan("x-plan.md", "v2");
		const changed = await h.submit("local://x-plan.md", "X", "call-3");
		expect(changed.details.duplicate).toBeUndefined();
		expect(h.lastState().revision).toBe(2);
		expect(h.plannotatorRequests).toBe(2);
	});

	test("refine sends feedback and returns to planning; resubmission bumps the revision", async () => {
		await h.commands.get("plan")?.("", h.ctx);
		h.writePlan("x-plan.md", "v1");
		await h.submit("local://x-plan.md");
		await h.commands.get("gyre-plan")?.(JSON.stringify({ action: "refine", revision: h.lastState().revision, feedback: "split step 2" }), h.ctx);
		expect(h.lastState().phase).toBe("planning");
		expect(h.userMessages.at(-1)).toContain("split step 2");
		h.writePlan("x-plan.md", "v2");
		await h.submit("local://x-plan.md");
		expect(h.lastState().revision).toBe(2);
	});

	test("the feedback run can resubmit while its sendUserMessage is still pending", async () => {
		h.cleanup();
		h = makeHarness({ holdSends: true });
		await h.commands.get("plan")?.("", h.ctx);
		h.writePlan("x-plan.md", "v1");
		await h.submit("local://x-plan.md");
		// The refine command must return although the feedback run (and so sendUserMessage) has not ended.
		await h.commands.get("gyre-plan")?.(JSON.stringify({ action: "refine", revision: 1, feedback: "start from main" }), h.ctx);
		expect(h.userMessages.at(-1)).toContain("start from main");
		h.writePlan("x-plan.md", "v2");
		const again = await h.submit("local://x-plan.md", "T", "call-2");
		expect(again.details.ok).toBe(true);
		expect(h.lastState()).toMatchObject({ phase: "reviewing", revision: 2 });
		h.endRuns();
	});

	test("a send that throws synchronously is reported and resets an approved plan", async () => {
		h.cleanup();
		h = makeHarness({ throwSends: true });
		h.setPrefs({ role: "default", context: "keep" });
		await h.commands.get("plan")?.("", h.ctx);
		h.writePlan("x-plan.md", "p");
		await h.submit("local://x-plan.md");
		await h.commands.get("gyre-plan")?.(JSON.stringify({ action: "approve", revision: 1 }), h.ctx);
		await Promise.resolve();
		expect(h.notices.at(-1)).toContain("Could not start the approved plan: agent is busy");
		expect(h.lastState()).toMatchObject({ phase: "idle", error: "Could not start the approved plan: agent is busy" });
	});

	test("an approval whose run is still going does not block later decisions", async () => {
		h.cleanup();
		h = makeHarness({ holdSends: true });
		h.setPrefs({ role: "default", context: "keep" });
		await h.commands.get("plan")?.("", h.ctx);
		h.writePlan("x-plan.md", "p");
		await h.submit("local://x-plan.md");
		await h.commands.get("gyre-plan")?.(JSON.stringify({ action: "approve", revision: 1 }), h.ctx);
		expect(h.lastState().phase).toBe("executing");
		await h.emit("agent_start");
		await h.emit("agent_end");
		expect(h.lastState().phase).toBe("idle");
		await h.commands.get("plan")?.("", h.ctx);
		expect(h.lastState().phase).toBe("planning");
		h.endRuns();
	});

	test("approve with role + compact: restores tools, switches role model, compacts, sends the plan", async () => {
		h.setPrefs({ role: "slow", context: "compact" });
		await h.commands.get("plan")?.("", h.ctx);
		h.writePlan("x-plan.md", "# The plan");
		await h.submit("local://x-plan.md");
		await h.commands.get("gyre-plan")?.(JSON.stringify({ action: "approve", revision: h.lastState().revision, feedback: "use bun" }), h.ctx);
		expect(h.activeTools).not.toContain(SUBMIT_TOOL);
		expect(h.model.id).toBe("thinker");
		expect(h.calls).toEqual(["compact"]);
		const prompt = h.userMessages.at(-1) ?? "";
		expect(prompt).toContain("Plan approved.");
		expect(prompt).toContain("# The plan");
		expect(prompt).toContain("use bun");
		expect(h.lastState().phase).toBe("executing");
		await h.emit("agent_start");
		await h.emit("agent_end");
		expect(h.lastState().phase).toBe("idle");
	});

	test("approval rejects a plan changed after review and allows a newly submitted revision", async () => {
		h.setPrefs({ role: "default", context: "keep" });
		await h.commands.get("plan")?.("", h.ctx);
		h.writePlan("x-plan.md", "reviewed");
		await h.submit("local://x-plan.md");
		h.writePlan("x-plan.md", "unreviewed");
		await h.commands.get("gyre-plan")?.(JSON.stringify({ action: "approve", revision: h.lastState().revision }), h.ctx);
		expect(h.lastState().phase).toBe("reviewing");
		expect(h.lastState().error).toContain("changed after submission");
		expect(h.userMessages).toEqual([]);
		expect(h.activeTools).toContain(SUBMIT_TOOL);
		await h.submit("local://x-plan.md");
		await h.commands.get("gyre-plan")?.(JSON.stringify({ action: "approve", revision: h.lastState().revision }), h.ctx);
		expect(h.userMessages.at(-1)).toContain("unreviewed");
	});

	test("approve and refine reject a decision for an older displayed revision", async () => {
		await h.commands.get("plan")?.("", h.ctx);
		h.writePlan("x-plan.md", "v1");
		await h.submit("local://x-plan.md");
		const displayed = h.lastState().revision;
		h.writePlan("x-plan.md", "v2");
		await h.submit("local://x-plan.md");
		for (const action of ["approve", "refine"]) {
			await h.commands.get("gyre-plan")?.(JSON.stringify({ action, revision: displayed }), h.ctx);
			expect(h.lastState().phase).toBe("reviewing");
			expect(h.lastState().error).toContain("plan changed");
			expect(h.userMessages).toEqual([]);
		}
	});

	test("a failed fresh-session setup cannot compact or execute without the plan copy", async () => {
		h.setPrefs({ role: "default", context: "fresh" });
		await h.commands.get("plan")?.("", h.ctx);
		h.writePlan("x-plan.md", "reviewed");
		await h.submit("local://x-plan.md");
		// A file in place of the artifact directory makes the real copy fail.
		writeFileSync(join(h.dir, "fresh"), "not a directory");
		await h.commands.get("gyre-plan")?.(JSON.stringify({ action: "approve", revision: h.lastState().revision }), h.ctx);
		expect(h.calls).toEqual(["newSession"]);
		expect(h.lastState().phase).toBe("reviewing");
		expect(h.lastState().error).toBeTruthy();
		expect(h.userMessages).toEqual([]);
		expect(h.activeTools).toContain(SUBMIT_TOOL);
		// While the new session cannot hold the plan, a keep retry fails rather than advertising a dead path.
		h.setPrefs({ role: "default", context: "keep" });
		await h.commands.get("gyre-plan")?.(JSON.stringify({ action: "approve", revision: h.lastState().revision }), h.ctx);
		expect(h.lastState().phase).toBe("reviewing");
		expect(h.userMessages).toEqual([]);
		// omp already switched sessions; once it is writable, a retry copies and sends the reviewed plan.
		rmSync(join(h.dir, "fresh"));
		await h.commands.get("gyre-plan")?.(JSON.stringify({ action: "approve", revision: h.lastState().revision }), h.ctx);
		expect(h.lastState().error).toBeUndefined();
		expect(h.userMessages.at(-1)).toContain("Plan approved.");
		expect(h.userMessages.at(-1)).toContain("reviewed");
		expect(readFileSync(join(h.dir, "fresh/local/x-plan.md"), "utf8")).toBe("reviewed");
	});

	test("keep approval after a session switch copies the reviewed plan into the current session", async () => {
		h.setPrefs({ role: "default", context: "keep" });
		await h.commands.get("plan")?.("", h.ctx);
		h.writePlan("x-plan.md", "reviewed");
		await h.submit("local://x-plan.md");
		// Simulate omp having moved to another session (e.g. a failed fresh setup) before the decision.
		await h.ctx.newSession();
		await h.commands.get("gyre-plan")?.(JSON.stringify({ action: "approve", revision: h.lastState().revision }), h.ctx);
		expect(h.userMessages.at(-1)).toContain("local://x-plan.md");
		expect(readFileSync(join(h.dir, "fresh/local/x-plan.md"), "utf8")).toBe("reviewed");
	});

	test("local plan content may contain example patch headers without granting nonlocal edits", async () => {
		await h.commands.get("plan")?.("", h.ctx);
		const allowed = await h.emit("tool_call", { toolName: "write", input: { path: "local://x-plan.md", content: "*** Update File: src/app.ts" } });
		expect(allowed?.block).not.toBe(true);
		const blocked = await h.emit("tool_call", { toolName: "apply_patch", input: { patch: "*** Update File: src/app.ts" } });
		expect(blocked?.block).toBe(true);
		const shell = await h.emit("tool_call", { toolName: "bash", input: { command: "python3 -c 'print(42)'" } });
		expect(shell?.block).not.toBe(true);
	});

	test("approve with fresh context starts a new session; keep does neither", async () => {
		h.setPrefs({ role: "default", context: "fresh" });
		await h.commands.get("plan")?.("", h.ctx);
		h.writePlan("x-plan.md", "p");
		await h.submit("local://x-plan.md");
		await h.commands.get("gyre-plan")?.(JSON.stringify({ action: "approve", revision: h.lastState().revision }), h.ctx);
		expect(h.calls).toEqual(["newSession"]);
		expect(readFileSync(join(h.dir, "fresh/local/x-plan.md"), "utf8")).toBe("p");
		expect(h.model.id).toBe("worker");
		expect(h.userMessages.at(-1)).not.toContain("History usable");

		h.cleanup();
		h = makeHarness();
		h.setPrefs({ role: "default", context: "keep" });
		await h.commands.get("plan")?.("", h.ctx);
		h.writePlan("x-plan.md", "p");
		await h.submit("local://x-plan.md");
		await h.commands.get("gyre-plan")?.(JSON.stringify({ action: "approve", revision: h.lastState().revision }), h.ctx);
		expect(h.calls).toEqual([]);
		expect(h.userMessages.at(-1)).toContain("History usable");
	});
});

describe("plannotator", () => {
	beforeEach(() => {
		h = makeHarness({ plannotator: true });
	});

	test("submission opens a plannotator review and publishes its url", async () => {
		await h.commands.get("plan")?.("", h.ctx);
		h.writePlan("x-plan.md", "p");
		await h.submit("local://x-plan.md");
		await Bun.sleep(5);
		const state = h.lastState();
		expect(state.reviewUrl).toBe("http://localhost:1234");
		expect(state.reviewId).toBe("rv1");
	});

	test("review results drive refine/approve; stale or replayed results are ignored", async () => {
		h.setPrefs({ role: "default", context: "keep" });
		await h.commands.get("plan")?.("", h.ctx);
		h.writePlan("x-plan.md", "p");
		await h.submit("local://x-plan.md");
		await Bun.sleep(5);
		h.bus("plannotator:review-result", { reviewId: "other", approved: true });
		await Bun.sleep(5);
		expect(h.lastState().phase).toBe("reviewing");
		h.bus("plannotator:review-result", { reviewId: "rv1", approved: false, feedback: "more tests" });
		await Bun.sleep(5);
		expect(h.lastState().phase).toBe("planning");
		expect(h.userMessages.at(-1)).toContain("more tests");
		await h.submit("local://x-plan.md");
		await Bun.sleep(5);
		h.bus("plannotator:review-result", { reviewId: "rv1", approved: true });
		h.bus("plannotator:review-result", { reviewId: "rv1", approved: true });
		await Bun.sleep(10);
		expect(h.userMessages.filter(m => m.startsWith("Plan approved."))).toHaveLength(1);
	});

	test("a review closed without a decision falls back to the Gyre card", async () => {
		await h.commands.get("plan")?.("", h.ctx);
		h.writePlan("x-plan.md", "p");
		await h.submit("local://x-plan.md");
		await Bun.sleep(5);
		h.bus("plannotator:session-closed", { reviewId: "rv1", outcome: "closed" });
		expect(h.lastState().reviewUrl).toBeUndefined();
		expect(h.lastState().phase).toBe("reviewing");
	});
});
