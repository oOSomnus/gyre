#!/usr/bin/env bun
/**
 * Build the browser ("web") release artifacts that install.sh downloads:
 *
 *   dist/release/gyre-web-<os>-<arch>.tar.gz   gyre/{gyre-gateway, web/, omp-extension/src/}
 *   dist/release/gyre-manifest.json            {version, ompVersion}
 *   dist/release/gyre-icon.png                 app icon (desktop entry for the AppImage)
 *   dist/release/SHA256SUMS
 *
 * The layout is the one packages/gateway/src/main.ts resolves next to its own
 * binary, so the unpacked folder runs with no environment variables.
 *
 *   bun scripts/build-release.ts                     # every target
 *   bun scripts/build-release.ts --target linux-x64  # one target (repeatable)
 *   bun scripts/build-release.ts --skip-web          # reuse packages/web/dist
 */
import { $ } from "bun";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ALL_TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"] as const;
type Target = (typeof ALL_TARGETS)[number];

const root = join(import.meta.dir, "..");
const out = join(root, "dist/release");
const args = process.argv.slice(2);
const targets: Target[] = args.flatMap((arg, i) => (arg === "--target" ? [args[i + 1] as Target] : []));
for (const target of targets) if (!ALL_TARGETS.includes(target)) throw new Error(`unknown target ${target}; expected one of ${ALL_TARGETS.join(", ")}`);
const selected = targets.length ? targets : [...ALL_TARGETS];

const tauriConf = JSON.parse(readFileSync(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8")) as { version: string };
const gatewayPkg = JSON.parse(readFileSync(join(root, "packages/gateway/package.json"), "utf8")) as { dependencies: Record<string, string> };
const version = process.env.GYRE_VERSION?.replace(/^v/, "") || tauriConf.version;
const ompVersion = gatewayPkg.dependencies["@oh-my-pi/pi-coding-agent"];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

if (!args.includes("--skip-web")) {
	console.log("› building web UI");
	await $`bun run build`.cwd(join(root, "packages/web"));
}
const webDist = join(root, "packages/web/dist");
if (!existsSync(join(webDist, "index.html"))) throw new Error("packages/web/dist is missing; build the web UI first");

for (const target of selected) {
	console.log(`› gateway for ${target}`);
	const stage = join(out, `stage-${target}`, "gyre");
	mkdirSync(stage, { recursive: true });
	await $`bun build --compile --target=bun-${target} src/main.ts --outfile ${join(stage, "gyre-gateway")} --external omp-legacy-pi-modules`.cwd(
		join(root, "packages/gateway"),
	);
	cpSync(webDist, join(stage, "web"), { recursive: true });
	cpSync(join(root, "packages/omp-extension/src"), join(stage, "omp-extension/src"), { recursive: true });
	writeFileSync(join(stage, "VERSION"), `${version}\n`);
	const archive = `gyre-web-${target}.tar.gz`;
	await $`tar -czf ${join(out, archive)} -C ${join(out, `stage-${target}`)} gyre`;
	rmSync(join(out, `stage-${target}`), { recursive: true, force: true });
	console.log(`  → dist/release/${archive}`);
}

// The installer's desktop entry uses it for the AppImage.
cpSync(join(root, "docs/assets/gyre-icon.png"), join(out, "gyre-icon.png"));
writeFileSync(join(out, "gyre-manifest.json"), `${JSON.stringify({ version, ompVersion }, null, 2)}\n`);

/** Checksums for everything in dist/release (the release workflow regenerates them after adding desktop bundles). */
function writeChecksums(dir: string): void {
	const lines = readdirSync(dir)
		.filter(name => name !== "SHA256SUMS")
		.sort()
		.map(name => `${new Bun.CryptoHasher("sha256").update(readFileSync(join(dir, name))).digest("hex")}  ${name}`);
	writeFileSync(join(dir, "SHA256SUMS"), `${lines.join("\n")}\n`);
}
writeChecksums(out);
console.log(`› release ${version} (omp ${ompVersion}) in dist/release`);
