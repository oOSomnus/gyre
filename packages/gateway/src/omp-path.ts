import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

/** The variables used here: PATH, OMP_PATH, BUN_INSTALL. */
type Env = Record<string, string | undefined>;

const bunBin = (env: Env, home: string) => join(env.BUN_INSTALL ?? join(home, ".bun"), "bin");

/**
 * Find omp. Desktop launchers often start apps without the user's shell PATH,
 * so fall back to the usual install locations.
 */
export function resolveOmp(env: Env = process.env, home = homedir(), exists: (path: string) => boolean = existsSync): string | undefined {
	if (env.OMP_PATH) return env.OMP_PATH;
	const onPath = Bun.which("omp", { PATH: env.PATH ?? "" });
	if (onPath) return onPath;
	return [join(bunBin(env, home), "omp"), join(home, ".local/bin/omp"), "/usr/local/bin/omp", "/opt/homebrew/bin/omp"].find(p => exists(p));
}

/**
 * omp is a Bun script (`#!/usr/bin/env bun`), so `bun` must be on PATH whenever
 * omp runs. Returns PATH with bun's folder in front when PATH lacks it (same
 * desktop-launcher case as above), or PATH unchanged.
 */
export function pathWithBun(env: Env, ompPath: string | undefined, home = homedir(), exists: (path: string) => boolean = existsSync): string | undefined {
	const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
	if (dirs.some(dir => exists(join(dir, "bun")))) return env.PATH;
	const dir = [ompPath && dirname(ompPath), bunBin(env, home)].find(d => d && exists(join(d, "bun")));
	return dir ? [dir, ...dirs].join(delimiter) : env.PATH;
}
