/** Finding omp, and keeping bun on PATH so omp's `#!/usr/bin/env bun` works. */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isExecutable, pathWithBun, resolveOmp } from "../src/omp-path";

const home = "/home/u";
const existing = (...paths: string[]) => (p: string) => paths.includes(p);

describe("resolveOmp", () => {
	test("OMP_PATH wins", () => {
		expect(resolveOmp({ OMP_PATH: "/opt/omp", PATH: "" }, home, existing())).toBe("/opt/omp");
	});

	test("falls back to Bun's global bin folder, honouring BUN_INSTALL", () => {
		expect(resolveOmp({ PATH: "" }, home, existing("/home/u/.bun/bin/omp"))).toBe("/home/u/.bun/bin/omp");
		expect(resolveOmp({ PATH: "", BUN_INSTALL: "/b" }, home, existing("/b/bin/omp"))).toBe("/b/bin/omp");
		expect(resolveOmp({ PATH: "" }, home, existing())).toBeUndefined();
	});
});

describe("pathWithBun", () => {
	test("leaves PATH alone when bun is already on it", () => {
		const env = { PATH: "/usr/bin:/bin" };
		expect(pathWithBun(env, "/home/u/.bun/bin/omp", home, existing("/bin/bun", "/home/u/.bun/bin/bun"))).toBe("/usr/bin:/bin");
	});

	test("adds the folder holding omp when bun is next to it", () => {
		expect(pathWithBun({ PATH: "/usr/bin" }, "/home/u/.bun/bin/omp", home, existing("/home/u/.bun/bin/bun"))).toBe("/home/u/.bun/bin:/usr/bin");
	});

	test("adds Bun's bin folder when omp lives elsewhere", () => {
		expect(pathWithBun({ PATH: "/usr/bin" }, "/usr/local/bin/omp", home, existing("/home/u/.bun/bin/bun"))).toBe("/home/u/.bun/bin:/usr/bin");
		expect(pathWithBun({ PATH: "/usr/bin", BUN_INSTALL: "/b" }, undefined, home, existing("/b/bin/bun"))).toBe("/b/bin:/usr/bin");
	});

	test("returns PATH unchanged when bun is nowhere", () => {
		expect(pathWithBun({ PATH: "/usr/bin" }, "/usr/local/bin/omp", home, existing())).toBe("/usr/bin");
		expect(pathWithBun({}, undefined, home, existing())).toBeUndefined();
	});

	describe("only counts a bun that can run", () => {
		const root = mkdtempSync(join(tmpdir(), "gyre-omp-path-"));
		afterAll(() => rmSync(root, { recursive: true, force: true }));
		const bunIn = (dir: string, mode: number) => {
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "bun"), "#!/bin/sh\n");
			chmodSync(join(dir, "bun"), mode);
			return dir;
		};
		const onPath = bunIn(join(root, "path"), 0o644);
		const bunHome = bunIn(join(root, "home/.bun/bin"), 0o755);

		test("isExecutable rejects non-executable files and folders", () => {
			expect(isExecutable(join(onPath, "bun"))).toBe(false);
			expect(isExecutable(join(bunHome, "bun"))).toBe(true);
			expect(isExecutable(bunHome)).toBe(false);
		});

		test("adds the fallback folder when the bun on PATH is not executable", () => {
			expect(pathWithBun({ PATH: onPath }, undefined, join(root, "home"))).toBe(`${bunHome}:${onPath}`);
		});

		test("keeps PATH when it already has a runnable bun", () => {
			const runnablePath = bunIn(join(root, "runnable"), 0o755);
			expect(pathWithBun({ PATH: `${onPath}:${runnablePath}` }, undefined, join(root, "home"))).toBe(`${onPath}:${runnablePath}`);
		});
	});
});
