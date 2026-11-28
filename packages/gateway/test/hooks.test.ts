import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteHook, hookDiagnostics, listHooks, readHook, saveHook } from "../src/hooks";

const dir = mkdtempSync(join(tmpdir(), "gyre-hooks-"));
const agentDir = join(dir, "agent");
const projectPath = join(dir, "project");
const where = { agentDir, projectPath };
const HOOK = 'export default function (pi) {\n\tpi.on("tool_call", async () => undefined);\n}\n';
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a new hook is written where omp discovers it and listed with its tool", async () => {
	const saved = await saveHook({ ...where, scope: "project", phase: "pre", name: "bash.ts", content: HOOK, baseVersion: null });
	expect(saved.path).toBe(join(projectPath, ".omp/hooks/pre/bash.ts"));
	await saveHook({ ...where, scope: "user", phase: "post", name: "*.ts", content: HOOK, baseVersion: null });
	expect(listHooks(where).map(h => `${h.scope}:${h.phase}:${h.tool}`)).toEqual(["project:pre:bash", "user:post:*"]);
	expect(listHooks({ agentDir }).map(h => h.scope)).toEqual(["user"]);
});

test("saves are conditional on the version read", async () => {
	const hook = await readHook(where, "project", "pre", "bash.ts");
	expect(hook.content).toBe(HOOK);
	const next = `${HOOK}// v2\n`;
	await saveHook({ ...where, scope: "project", phase: "pre", name: "bash.ts", content: next, baseVersion: hook.version! });
	await expect(saveHook({ ...where, scope: "project", phase: "pre", name: "bash.ts", content: HOOK, baseVersion: hook.version! })).rejects.toMatchObject({
		status: 412,
	});
	await expect(saveHook({ ...where, scope: "project", phase: "pre", name: "bash.ts", content: HOOK, baseVersion: null })).rejects.toMatchObject({ status: 412 });
});

test("moving a hook to another phase or name removes the old file", async () => {
	const hook = await readHook(where, "project", "pre", "bash.ts");
	await saveHook({ ...where, scope: "project", phase: "post", name: "edit.ts", content: hook.content!, baseVersion: hook.version!, previous: { phase: "pre", name: "bash.ts" } });
	expect(existsSync(join(projectPath, ".omp/hooks/pre/bash.ts"))).toBe(false);
	expect(readFileSync(join(projectPath, ".omp/hooks/post/edit.ts"), "utf8")).toBe(hook.content!);
});

test("syntax errors and missing default exports are refused with diagnostics", async () => {
	expect(hookDiagnostics("a.ts", HOOK)).toEqual([]);
	expect(hookDiagnostics("a.ts", "export default function (pi) {")[0]).toMatch(/end of file/);
	expect(hookDiagnostics("a.ts", "const x = 1;")[0]).toMatch(/default export/);
	expect(hookDiagnostics("a.ts", "export default () => {\n\tconst a = ;\n}")[0]).toMatch(/^line 2:/);
	await expect(saveHook({ ...where, scope: "user", phase: "pre", name: "read.ts", content: "export default (", baseVersion: null })).rejects.toMatchObject({
		status: 422,
	});
	expect(existsSync(join(agentDir, "hooks/pre/read.ts"))).toBe(false);
});

test("names and phases cannot leave the hooks directories", async () => {
	for (const name of ["../x.ts", "a/b.ts", "x.sh", ".hidden.ts", "", "**.ts"]) {
		await expect(saveHook({ ...where, scope: "user", phase: "pre", name, content: HOOK, baseVersion: null })).rejects.toMatchObject({ status: 400 });
	}
	await expect(saveHook({ ...where, scope: "user", phase: "../..", name: "a.ts", content: HOOK, baseVersion: null })).rejects.toMatchObject({ status: 400 });
	await expect(saveHook({ agentDir, scope: "project", phase: "pre", name: "a.ts", content: HOOK, baseVersion: null })).rejects.toMatchObject({ status: 400 });
});

test("delete removes one hook and reports a missing one", () => {
	writeFileSync(join(agentDir, "hooks/post/gone.ts"), HOOK);
	deleteHook(where, "user", "post", "gone.ts");
	expect(existsSync(join(agentDir, "hooks/post/gone.ts"))).toBe(false);
	expect(() => deleteHook(where, "user", "post", "gone.ts")).toThrow(/not found/);
});
