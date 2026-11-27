/**
 * Contract tests against the REAL omp binary on PATH (or OMP_PATH).
 * They pin the parts of omp's RPC protocol Gyre relies on, so an omp
 * upgrade that changes them fails here instead of in the UI. No model calls.
 * Skipped when omp is not installed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isKnownUiMethod, UI_CANCEL_METHOD, UI_DIALOG_METHODS, UI_PRESENTATION_METHODS } from "@gyre/protocol";
import { OmpProcess } from "../src/omp-process";
import { detectOmpVersion } from "../src/server";
import { listSessions } from "../src/sessions";

const ompPath = process.env.OMP_PATH ?? "omp";
const version = await detectOmpVersion(ompPath);
const cwd = mkdtempSync(join(tmpdir(), "gyre-contract-"));

describe.skipIf(!version)(`omp ${version ?? "(missing)"} RPC contract`, () => {
	const frames: Array<{ type: string; [key: string]: unknown }> = [];
	let proc: OmpProcess;

	beforeAll(async () => {
		proc = new OmpProcess({ cwd, ompPath, args: ["--no-session"], onFrame: f => frames.push(f), onExit: () => {} });
		await proc.start();
	}, 90_000);
	afterAll(async () => {
		await proc?.stop();
	});

	test("ready frame advertises protocol v2 and negotiation succeeds", () => {
		expect(proc.ready?.supportedProtocolVersions).toContain(2);
		expect(proc.protocolVersion).toBe(2);
	});

	test("get_state exposes the fields the status bar reads", async () => {
		const state = await proc.call<Record<string, unknown>>({ type: "get_state" });
		for (const key of ["model", "thinkingLevel", "isStreaming", "sessionId", "contextUsage", "tokensPerSecond", "queuedMessageCount"]) {
			expect(state).toHaveProperty(key);
		}
	});

	test("get_session_stats returns token and context usage", async () => {
		const stats = await proc.call<{ tokens: Record<string, number>; contextUsage: Record<string, number> }>({ type: "get_session_stats" });
		expect(stats.tokens).toHaveProperty("input");
		expect(stats.tokens).toHaveProperty("cacheRead");
		expect(stats).toHaveProperty("contextUsage");
	});

	test("get_available_commands lists slash commands with name and source", async () => {
		const data = await proc.call<{ commands: Array<{ name: string; source: string }> }>({ type: "get_available_commands" });
		expect(data.commands.length).toBeGreaterThan(10);
		for (const cmd of data.commands.slice(0, 20)) {
			expect(typeof cmd.name).toBe("string");
			expect(typeof cmd.source).toBe("string");
		}
	});

	test("get_model_picker returns rows with provider and id", async () => {
		const data = await proc.call<{ rows: Array<{ provider: string; id: string }> }>({ type: "get_model_picker", limit: 5 }, 60_000);
		expect(Array.isArray(data.rows)).toBe(true);
		for (const row of data.rows) {
			expect(typeof row.provider).toBe("string");
			expect(typeof row.id).toBe("string");
		}
		// Longer than the 60s call: bun's 5s default kills omp mid-call and fails every later test.
	}, 90_000);

	test("set_ask_dialog is accepted", async () => {
		const response = await proc.send({ type: "set_ask_dialog", enabled: true });
		expect(response.success).toBe(true);
	});

	test("local slash commands complete without invoking the agent and emit command_output", async () => {
		const data = await proc.call<{ agentInvoked: boolean }>({ type: "prompt", message: "/session" });
		expect(data.agentInvoked).toBe(false);
		const start = Date.now();
		while (!frames.some(f => f.type === "command_output") && Date.now() - start < 10_000) await Bun.sleep(50);
		const output = frames.find(f => f.type === "command_output");
		expect(typeof output?.text).toBe("string");
	});

	test("unknown commands fail with a response, not a crash", async () => {
		const response = await proc.send({ type: "gyre_contract_unknown" });
		expect(response.success).toBe(false);
		expect(proc.running).toBe(true);
	});

	test("session listing API is importable and returns summaries", async () => {
		const sessions = await listSessions(cwd);
		expect(Array.isArray(sessions)).toBe(true);
	});
});

const EXTENSION = join(import.meta.dir, "../../omp-extension/src/index.ts");

describe.skipIf(!version)(`omp ${version ?? "(missing)"} + Gyre extension contract`, () => {
	const frames: Array<{ type: string; [key: string]: unknown }> = [];
	let proc: OmpProcess;

	beforeAll(async () => {
		proc = new OmpProcess({
			cwd,
			ompPath,
			args: ["-e", EXTENSION, "--no-session"],
			env: { PLANNOTATOR_BROWSER: "none", PLANNOTATOR_INBOX_TOOL: "0" },
			onFrame: f => frames.push(f),
			onExit: () => {},
		});
		await proc.start();
	}, 90_000);
	afterAll(async () => {
		await proc?.stop();
	});

	const planWidgets = () =>
		frames.filter(f => f.type === "extension_ui_request" && f.method === "setWidget" && f.widgetKey === "gyre.plan") as Array<{ widgetLines?: string[] }>;

	test("the extension registers /plan and /gyre-plan as extension commands", async () => {
		const data = await proc.call<{ commands?: Array<{ name: string; source: string }> } | Array<{ name: string; source: string }>>({ type: "get_available_commands" });
		const commands = Array.isArray(data) ? data : (data.commands ?? []);
		expect(commands.find(c => c.name === "plan")?.source).toBe("extension");
		expect(commands.find(c => c.name === "gyre-plan")?.source).toBe("extension");
	});

	test("/plan publishes planning state and activates submit_plan without a model call; toggling restores", async () => {
		const response = await proc.send({ type: "prompt", message: "/plan" });
		expect(response.success).toBe(true);
		const start = Date.now();
		while (!planWidgets().some(w => w.widgetLines?.[0]?.includes('"planning"')) && Date.now() - start < 10_000) await Bun.sleep(50);
		const state = JSON.parse(planWidgets().at(-1)?.widgetLines?.[0] ?? "{}");
		expect(state.phase).toBe("planning");
		const tools = await proc.call<{ dumpTools?: Array<{ name: string }> }>({ type: "get_state" });
		expect(tools.dumpTools?.some(t => t.name === "submit_plan")).toBe(true);
		await proc.send({ type: "prompt", message: "/plan" });
		const t2 = Date.now();
		while (planWidgets().at(-1)?.widgetLines && Date.now() - t2 < 10_000) await Bun.sleep(50);
		expect(planWidgets().at(-1)?.widgetLines).toBeUndefined();
		const after = await proc.call<{ dumpTools?: Array<{ name: string }> }>({ type: "get_state" });
		expect(after.dumpTools?.some(t => t.name === "submit_plan")).toBe(false);
	});

	test("model roles: the picker lists role rows for '@'", async () => {
		const picker = await proc.call<{ rows: Array<{ role?: string }> }>({ type: "get_model_picker", query: "@", limit: 50 });
		expect(Array.isArray(picker.rows)).toBe(true);
	});

	test("set_model accepts a role argument", async () => {
		const picker = await proc.call<{ rows: Array<{ provider: string; id: string; role?: string }> }>({ type: "get_model_picker", query: "", limit: 1 });
		const row = picker.rows[0];
		if (!row) return; // no authenticated providers on this machine
		const response = await proc.send({ type: "set_model", provider: row.provider, modelId: row.id, role: "default" });
		expect(response.success).toBe(true);
	});
});

describe.skipIf(!version)("omp CLI surfaces used by settings", () => {
	test("`omp config get modelRoles --json` and `omp config path` work", async () => {
		const { OmpCli } = await import("../src/omp-cli");
		const cli = new OmpCli(ompPath);
		const roles = await cli.configGet("modelRoles");
		expect(roles === null || typeof roles === "object").toBe(true);
		expect((await cli.agentDir()).length).toBeGreaterThan(0);
	});

	test("omp's native plan-mode prompt still exists (Gyre's adapted copy tracks it)", async () => {
		const path = join(import.meta.dir, "../node_modules/@oh-my-pi/pi-coding-agent/src/prompts/system/plan-mode-active.md");
		const alt = join(import.meta.dir, "../../../node_modules/@oh-my-pi/pi-coding-agent/src/prompts/system/plan-mode-active.md");
		const file = Bun.file((await Bun.file(path).exists()) ? path : alt);
		const text = await file.text();
		expect(text).toContain("local://<slug>-plan.md");
		expect(text).toContain("propose");
	});
});

describe("extension UI request methods (pinned omp source)", () => {
	test("every method omp can send is classified explicitly by Gyre", async () => {
		// Read omp's own type for `extension_ui_request` so a new method fails here (and in the
		// daily "latest omp" CI job) instead of falling back to a generic dialog unnoticed.
		const rel = "@oh-my-pi/pi-coding-agent/src/modes/rpc/rpc-types.ts";
		const path = join(import.meta.dir, "../node_modules", rel);
		const alt = join(import.meta.dir, "../../../node_modules", rel);
		const source = await Bun.file((await Bun.file(path).exists()) ? path : alt).text();
		const start = source.indexOf("export type RpcExtensionUIRequest");
		expect(start).toBeGreaterThan(-1);
		const end = source.indexOf("export ", start + 1);
		const union = source.slice(start, end === -1 ? undefined : end);
		const methods = [...new Set([...union.matchAll(/method:\s*"([A-Za-z_]+)"/g)].map(m => m[1] as string))].sort();
		expect(methods.length).toBeGreaterThan(0);
		expect(methods.filter(method => !isKnownUiMethod(method))).toEqual([]);
		// And Gyre does not classify methods omp no longer sends.
		expect([...UI_DIALOG_METHODS, ...UI_PRESENTATION_METHODS, UI_CANCEL_METHOD].sort()).toEqual(methods);
	});
});

describe.skipIf(!version)("Git pane: omp's commit-message generator", () => {
	test("`omp commit` still has --legacy, --dry-run and --no-changelog, and refuses a repo with nothing to commit without a model call", async () => {
		const { OmpCli } = await import("../src/omp-cli");
		const cli = new OmpCli(ompPath);
		const help = await cli.run(["commit", "--help"]);
		for (const flag of ["--legacy", "--dry-run", "--no-changelog"]) expect(help.stdout + help.stderr).toContain(flag);
		const repo = mkdtempSync(join(tmpdir(), "gyre-contract-git-"));
		Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
		const result = await cli.run(["commit", "--legacy", "--dry-run", "--no-changelog"], repo, 60_000);
		expect(result.stdout).not.toContain("Generated commit message:");
		expect(result.stderr).toContain("No changes to commit");
	}, 90_000);
});
