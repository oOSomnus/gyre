#!/usr/bin/env bun
/**
 * Move Gyre to a new omp release.
 *
 *   bun scripts/bump-omp.ts            # match the installed `omp --version`
 *   bun scripts/bump-omp.ts 19.2.0     # a specific version
 *   bun scripts/bump-omp.ts --latest   # newest version on npm
 *
 * Steps: pin @oh-my-pi/pi-coding-agent (the gateway uses its RPC framing,
 * types and session listing), install, check the installed omp binary matches
 * the pin (gateway + Gyre omp extension), then run typecheck, extension tests,
 * gateway unit tests and the RPC + extension contract suites.
 * Exit code is non-zero if anything fails, so this can gate CI or a bot PR.
 */
import { $ } from "bun";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const pkgPath = join(root, "packages/gateway/package.json");
const PACKAGE = "@oh-my-pi/pi-coding-agent";

async function installedOmp(): Promise<string | null> {
	try {
		return (await $`omp --version`.quiet().text()).trim().replace(/^omp\//, "") || null;
	} catch {
		return null;
	}
}

const arg = process.argv[2];
let target: string | null;
if (arg === "--latest") target = (await $`npm view ${PACKAGE} version`.quiet().text()).trim();
else if (arg) target = arg;
else target = await installedOmp();
if (!target || !/^\d+\.\d+\.\d+/.test(target)) {
	console.error("Could not determine the omp version. Pass one explicitly: bun scripts/bump-omp.ts 19.2.0");
	process.exit(2);
}

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const previous = pkg.dependencies[PACKAGE];
pkg.dependencies[PACKAGE] = target;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`› ${PACKAGE}: ${previous} → ${target}`);
// The Gyre omp extension compiles against the same omp version.
const extPkgPath = join(root, "packages/omp-extension/package.json");
const extPkg = JSON.parse(readFileSync(extPkgPath, "utf8"));
extPkg.devDependencies[PACKAGE] = target;
writeFileSync(extPkgPath, `${JSON.stringify(extPkg, null, 2)}\n`);

const steps: Array<[string, () => Promise<unknown>]> = [
	["install", () => $`bun install`.cwd(root)],
	["typecheck gateway", () => $`bun x tsc -p .`.cwd(join(root, "packages/gateway"))],
	["typecheck web", () => $`bun x tsc -p .`.cwd(join(root, "packages/web"))],
	["typecheck omp extension", () => $`bun x tsc -p .`.cwd(join(root, "packages/omp-extension"))],
	["omp extension tests", () => $`bun test`.cwd(join(root, "packages/omp-extension"))],
	["gateway tests + omp contract", () => $`bun test`.cwd(join(root, "packages/gateway"))],
];

let failed = false;
for (const [name, run] of steps) {
	process.stdout.write(`› ${name}… `);
	try {
		await run();
		console.log("ok");
	} catch (error) {
		failed = true;
		console.log("FAILED");
		const out = error as { stdout?: Buffer; stderr?: Buffer };
		console.log(String(out.stdout ?? "").slice(-4000), String(out.stderr ?? "").slice(-4000));
		break;
	}
}

const binary = await installedOmp();
if (binary !== target) {
	console.warn(
		`\n! The omp binary on PATH is ${binary ?? "missing"}, but Gyre now pins ${target}.\n` +
			"  Upgrade omp (e.g. `omp update` or reinstall) so the contract tests ran against the pinned version.",
	);
}

console.log(failed ? "\n✗ Bump failed. Revert with git checkout packages/gateway/package.json bun.lock" : `\n✓ Gyre works with omp ${target}`);
process.exit(failed ? 1 : 0);
