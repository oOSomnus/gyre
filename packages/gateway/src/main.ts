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
 *   OMP_PATH       omp executable (default: "omp" on PATH, then common install folders)
 *   GYRE_OMP_ARGS  extra omp CLI args, space-separated (e.g. "--no-session" for tests)
 *   GYRE_OMP_EXTENSION  Gyre's omp extension (plan mode); "0" disables it
 *   GYRE_ALLOWED_HOSTS  extra Host names accepted for remote access, comma-separated ("*" = any)
 *   GYRE_PLAIN     "1" prints plain log lines even in a terminal (same as --plain)
 *
 * Flags:
 *   --open   also open the UI in the default browser (never done otherwise)
 *   --plain  no full-screen console
 *
 * In an interactive terminal the gateway shows a full-screen console: the URL
 * and status on a coloured bar, the log underneath (see console-ui.ts).
 * Otherwise (the desktop sidecar, pipes) it prints one line
 * `GYRE_READY {"url":...,"port":...,"token":...}` on stdout once listening,
 * for the desktop shell to pick up, and plain log lines on stderr.
 */
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type ConsoleUi, type LogLevel, startConsoleUi, wantsConsoleUi } from "./console-ui";
import { pathWithBun, resolveOmp } from "./omp-path";
import { startGateway } from "./server";

const dataDir = process.env.GYRE_DATA_DIR ?? join(homedir(), ".gyre");
mkdirSync(dataDir, { recursive: true });

const defaultWebDist = [join(dirname(process.execPath), "web"), join(import.meta.dir, "../../web/dist")].find(
	dir => Bun.file(join(dir, "index.html")).size > 0,
);

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
if (!token.trim()) throw new Error("GYRE_TOKEN must not be empty");
const extension = resolveExtension();
const ompPath = resolveOmp();
// Every omp spawn inherits process.env, so this lets omp find bun.
const path = pathWithBun(process.env, ompPath);
if (path) process.env.PATH = path;
const fullScreen = wantsConsoleUi();
let ui: ConsoleUi | undefined;
/** Lines logged while the gateway starts, shown once the console is up. */
const early: Array<{ level: LogLevel; text: string }> = [];
const log = (text: string, level: LogLevel = "info") => {
	if (ui) ui.log(level, text);
	else if (fullScreen) early.push({ level, text });
	else console.error(text);
};
const gateway = await startGateway({
	host: process.env.GYRE_HOST ?? "127.0.0.1",
	port: Number(process.env.GYRE_PORT ?? 7341),
	token,
	dataDir,
	webDist: process.env.GYRE_WEB_DIST ?? defaultWebDist,
	ompPath,
	ompArgs: process.env.GYRE_OMP_ARGS?.split(" ").filter(Boolean),
	extensions: extension ? [extension] : [],
	allowedHosts: process.env.GYRE_ALLOWED_HOSTS?.split(",")
		.map(h => h.trim())
		.filter(Boolean),
	log,
});

const openUrl = `${gateway.url}/#token=${encodeURIComponent(token)}`;
const openBrowser = () => {
	const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
	try {
		Bun.spawn([opener, openUrl], { stdout: "ignore", stderr: "ignore" }).unref();
		ui?.note("Opening the browser…");
	} catch {
		log(`Could not run ${opener}; open the URL above in a browser.`, "error");
	}
};

if (fullScreen) {
	ui = startConsoleUi({
		url: openUrl,
		status: () => gateway.status(),
		onQuit: () => void shutdown(),
		onOpen: openBrowser,
		initial: [{ level: "info", text: `Gyre gateway listening on ${gateway.url}` }, ...early],
	});
} else {
	console.log(`GYRE_READY ${JSON.stringify({ url: gateway.url, port: gateway.port, token })}`);
	console.error(`Gyre gateway listening on ${gateway.url}`);
	console.error(`Open Gyre: ${openUrl}`);
}
// The browser opens only when asked: `gyre --open`, or `o` in the console.
if (process.argv.includes("--open")) openBrowser();
if (!extension) log("Gyre omp extension not found: plan mode is unavailable", "warn");

let stopping = false;
const shutdown = async () => {
	if (stopping) return;
	stopping = true;
	ui?.setStopping();
	await gateway.stop();
	ui?.close();
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
