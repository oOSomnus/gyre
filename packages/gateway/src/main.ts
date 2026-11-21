#!/usr/bin/env bun
/**
 * Gyre gateway entry point.
 *
 * Env:
 *   GYRE_HOST      bind address (default 127.0.0.1; keep it loopback)
 *   GYRE_PORT      port (default 7341; 0 = pick a free port)
 *   GYRE_TOKEN     auth token (default: random per start)
 *   GYRE_DATA_DIR  product state directory (default ~/.gyre)
 *   GYRE_WEB_DIST  built web UI directory to serve
 *   OMP_PATH           omp executable (default "omp" on PATH)
 *   GYRE_OMP_ARGS  extra omp CLI args, space-separated (e.g. "--no-session" for tests)
 *   GYRE_OMP_EXTENSION  Gyre's omp extension (plan mode); "0" disables it
 *   GYRE_ALLOWED_HOSTS  extra Host names accepted for remote access, comma-separated ("*" = any)
 *
 * Prints one line `GYRE_READY {"url":...,"port":...,"token":...}` on stdout
 * once listening, for the desktop shell to pick up.
 */
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { startGateway } from "./server";

const dataDir = process.env.GYRE_DATA_DIR ?? join(homedir(), ".gyre");
mkdirSync(dataDir, { recursive: true });

const defaultWebDist = [
	join(dirname(process.execPath), "web"),
	join(import.meta.dir, "../../web/dist"),
].find(dir => Bun.file(join(dir, "index.html")).size > 0);

/**
 * Find omp. Desktop launchers often start apps without the user's shell PATH,
 * so fall back to the usual install locations.
 */
function resolveOmp(): string | undefined {
	if (process.env.OMP_PATH) return process.env.OMP_PATH;
	const onPath = Bun.which("omp");
	if (onPath) return onPath;
	const home = homedir();
	return [join(home, ".bun/bin/omp"), join(home, ".local/bin/omp"), "/usr/local/bin/omp", "/opt/homebrew/bin/omp"].find(p => existsSync(p));
}

/** Gyre's omp extension: the desktop bundle ships it next to the binary; dev uses the repo copy. */
function resolveExtension(): string | undefined {
	const env = process.env.GYRE_OMP_EXTENSION;
	if (env === "0") return undefined;
	if (env) return env;
	return [join(dirname(process.execPath), "omp-extension", "src", "index.ts"), join(import.meta.dir, "../../omp-extension/src/index.ts")].find(p =>
		existsSync(p),
	);
}

const token = process.env.GYRE_TOKEN ?? crypto.randomUUID();
const extension = resolveExtension();
const gateway = await startGateway({
	host: process.env.GYRE_HOST ?? "127.0.0.1",
	port: Number(process.env.GYRE_PORT ?? 7341),
	token,
	dataDir,
	webDist: process.env.GYRE_WEB_DIST ?? defaultWebDist,
	ompPath: resolveOmp(),
	ompArgs: process.env.GYRE_OMP_ARGS?.split(" ").filter(Boolean),
	extensions: extension ? [extension] : [],
	allowedHosts: process.env.GYRE_ALLOWED_HOSTS?.split(",").map(h => h.trim()).filter(Boolean),
});

console.log(`GYRE_READY ${JSON.stringify({ url: gateway.url, port: gateway.port, token })}`);
console.error(`Gyre gateway listening on ${gateway.url}  (open ${gateway.url}/#token=${token})`);
if (!extension) console.error("Gyre omp extension not found: plan mode is unavailable");

let stopping = false;
const shutdown = async () => {
	if (stopping) return;
	stopping = true;
	await gateway.stop();
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// Desktop shell closes our stdin when it exits; treat that as shutdown.
if (process.env.GYRE_EXIT_ON_STDIN_CLOSE === "1") {
	void (async () => {
		for await (const _ of Bun.stdin.stream()) {
		}
		await shutdown();
	})();
}
