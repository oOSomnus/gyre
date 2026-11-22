#!/usr/bin/env bun
/**
 * Build the desktop app:
 *   1. build the web UI (packages/web/dist, bundled as a Tauri resource)
 *   2. compile the gateway into a single binary and place it as the Tauri sidecar
 *   3. run `tauri build` (skipped with --sidecar-only, e.g. before `tauri dev`)
 */
import { $ } from "bun";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const sidecarOnly = process.argv.includes("--sidecar-only");

const triple = (await $`rustc -vV`.text()).match(/^host: (.+)$/m)?.[1];
if (!triple) throw new Error("could not determine the Rust host target triple (is rustc installed?)");

console.log("› building web UI");
await $`bun run build`.cwd(join(root, "packages/web"));

console.log("› compiling gateway");
await $`bun run build`.cwd(join(root, "packages/gateway"));
const binDir = join(root, "apps/desktop/src-tauri/binaries");
mkdirSync(binDir, { recursive: true });
const ext = process.platform === "win32" ? ".exe" : "";
copyFileSync(join(root, `packages/gateway/dist/gyre-gateway${ext}`), join(binDir, `gyre-gateway-${triple}${ext}`));
console.log(`  sidecar → apps/desktop/src-tauri/binaries/gyre-gateway-${triple}${ext}`);

if (!sidecarOnly) {
	console.log("› tauri build");
	// Extra args pass through, e.g. `--bundles deb`.
	const extra = process.argv.slice(2).filter(arg => arg !== "--sidecar-only");
	await $`./node_modules/.bin/tauri build ${extra}`.cwd(join(root, "apps/desktop"));
}
