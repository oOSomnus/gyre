import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_FORM, formProblems, generateHook, HOOK_TEMPLATES, type HookForm, phaseFor, suggestedName } from "../src/lib/hook-templates";

const dir = mkdtempSync(join(tmpdir(), "gyre-hook-gen-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>;
/** Load a generated module the way omp does (default export gets the hook API) and capture its handlers. */
async function load(code: string) {
	const file = join(dir, `hook-${n++}.ts`);
	writeFileSync(file, code);
	const handlers = new Map<string, Handler>();
	const calls: { exec: unknown[][]; notify: string[]; sent: unknown[] } = { exec: [], notify: [], sent: [] };
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		exec: async (...args: unknown[]) => {
			calls.exec.push(args);
			return { stdout: "lint ok\n", stderr: "", code: 0, killed: false };
		},
		sendMessage: (message: unknown) => calls.sent.push(message),
	};
	(await import(file)).default(pi);
	const ctx = (confirmAnswer = true) => ({
		hasUI: true,
		cwd: "/project",
		ui: { confirm: async () => confirmAnswer, notify: (message: string) => calls.notify.push(message) },
	});
	return { handlers, calls, ctx };
}

const form = (patch: Partial<HookForm>): HookForm => ({ ...EMPTY_FORM, ...patch });

test("a block hook stops matching tool calls and lets the rest through", async () => {
	const { handlers, ctx } = await load(generateHook(form({ action: "block", tools: "bash", match: "rm -rf", message: "no" })));
	const handler = handlers.get("tool_call")!;
	expect(await handler({ toolName: "bash", input: { command: "rm -rf /" } }, ctx())).toEqual({ block: true, reason: "no" });
	expect(await handler({ toolName: "bash", input: { command: "ls" } }, ctx())).toBeUndefined();
	expect(await handler({ toolName: "edit", input: { command: "rm -rf /" } }, ctx())).toBeUndefined();
});

test("a confirm hook blocks when the user declines", async () => {
	const { handlers, ctx } = await load(generateHook(form({ action: "confirm", tools: "", message: "ok?" })));
	const handler = handlers.get("tool_call")!;
	expect(await handler({ toolName: "write", input: {} }, ctx(true))).toBeUndefined();
	expect(await handler({ toolName: "write", input: {} }, ctx(false))).toMatchObject({ block: true });
});

test("a command hook runs with a timeout and can send its output to the agent", async () => {
	const code = generateHook(form({ trigger: "agent_end", action: "command", command: "bun run lint", timeoutSeconds: 5, sendOutput: true, variables: [{ name: "TEAM", value: "core" }] }));
	expect(code).toContain('const TEAM = "core";');
	const { handlers, calls, ctx } = await load(code);
	await handlers.get("agent_end")!({}, ctx());
	expect(calls.exec[0]).toEqual(["sh", ["-c", "bun run lint"], { cwd: "/project", timeout: 5000 }]);
	expect(JSON.stringify(calls.sent[0])).toContain("lint ok");
});

test("values with quotes and backslashes are embedded as literals", async () => {
	const { handlers, calls, ctx } = await load(generateHook(form({ trigger: "turn_end", action: "notify", message: 'say "hi" \\ `now` ${x}' })));
	await handlers.get("turn_end")!({}, ctx());
	expect(calls.notify).toEqual(['say "hi" \\ `now` ${x}']);
});

test("form problems catch invalid patterns, names and impossible combinations", () => {
	expect(formProblems(EMPTY_FORM)).toEqual([]);
	expect(formProblems(form({ match: "(" }))).toHaveLength(1);
	expect(formProblems(form({ action: "command", command: " " }))).toHaveLength(1);
	expect(formProblems(form({ trigger: "agent_end", action: "block" }))).toHaveLength(1);
	expect(formProblems(form({ variables: [{ name: "1bad", value: "" }] }))).toHaveLength(1);
	// Names that would make the generated module fail to parse.
	expect(formProblems(form({ variables: [{ name: "TOOLS", value: "" }] }))).toHaveLength(1);
	expect(formProblems(form({ variables: [{ name: "class", value: "" }] }))).toHaveLength(1);
	expect(formProblems(form({ variables: [{ name: "A", value: "" }, { name: "A", value: "" }] }))).toHaveLength(1);
	// TOOLS is only declared for tool triggers.
	expect(formProblems(form({ trigger: "agent_end", action: "notify", variables: [{ name: "TOOLS", value: "" }] }))).toEqual([]);
});

test("phase and suggested names follow the trigger and tool", () => {
	expect(phaseFor("tool_call")).toBe("pre");
	expect(phaseFor("agent_end")).toBe("post");
	expect(suggestedName(form({ tools: "bash" }))).toBe("bash.ts");
	expect(suggestedName(form({ trigger: "agent_end", action: "command" }))).toBe("run-on-agent-end.ts");
});

test("every template loads as a hook module", async () => {
	for (const template of HOOK_TEMPLATES) {
		const { handlers } = await load(template.content);
		expect(handlers.size).toBeGreaterThan(0);
	}
});
