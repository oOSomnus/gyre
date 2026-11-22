/**
 * install.sh against local release fixtures, in a throwaway HOME: fresh install,
 * `gyre update`, checksum rejection and a failed launcher publish. The installer
 * must leave a launcher that matches a runnable release in every case.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INSTALLER = join(import.meta.dir, "../install.sh");
const OS = process.platform === "darwin" ? "darwin" : "linux";
const ARCH = process.arch === "arm64" ? "arm64" : "x64";
const supported = (process.platform === "linux" || process.platform === "darwin") && (process.arch === "x64" || process.arch === "arm64");

const root = mkdtempSync(join(tmpdir(), "gyre-install-test-"));
const home = join(root, "home");
const installDir = join(home, ".local/share/gyre");
const binDir = join(home, ".local/bin");
const launcher = join(binDir, "gyre");

function sha256(path: string): string {
	return new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
}

/** A release folder like the one GitHub serves: web tarball, manifest and SHA256SUMS. */
function release(version: string, opts: { corrupt?: boolean } = {}): string {
	const dir = join(root, `release-${version}${opts.corrupt ? "-corrupt" : ""}`);
	const stage = join(dir, "stage");
	mkdirSync(join(stage, "gyre"), { recursive: true });
	writeFileSync(join(stage, "gyre/gyre-gateway"), `#!/bin/sh\necho "gateway ${version} $*"\n`, { mode: 0o755 });
	const tarball = `gyre-web-${OS}-${ARCH}.tar.gz`;
	const tar = Bun.spawnSync(["tar", "-czf", join(dir, tarball), "-C", stage, "gyre"]);
	if (tar.exitCode !== 0) throw new Error(tar.stderr.toString());
	rmSync(stage, { recursive: true });
	writeFileSync(join(dir, "gyre-manifest.json"), JSON.stringify({ version, ompVersion: "0.0.0" }, null, 2));
	const tarballSum = opts.corrupt ? "0".repeat(64) : sha256(join(dir, tarball));
	writeFileSync(join(dir, "SHA256SUMS"), `${tarballSum}  ${tarball}\n${sha256(join(dir, "gyre-manifest.json"))}  gyre-manifest.json\n`);
	return `file://${dir}`;
}

function run(cmd: string[], base: string) {
	const result = Bun.spawnSync(cmd, {
		env: {
			HOME: home,
			// No omp, Bun or user tools: only what a fresh machine has.
			PATH: "/usr/bin:/bin",
			NO_COLOR: "1",
			TMPDIR: root,
			GYRE_INSTALL_DIR: installDir,
			GYRE_BIN_DIR: binDir,
			GYRE_RELEASE_BASE: base,
			GYRE_INSTALLER_URL: `file://${INSTALLER}`,
		},
		stdin: "ignore",
	});
	return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() };
}

const FLAGS = ["--no-omp", "--no-plannotator", "--yes"];
const install = (base: string) => run(["bash", INSTALLER, "--web", ...FLAGS], base);
const update = (base: string) => run([launcher, "update", ...FLAGS], base);
const startGyre = () => Bun.spawnSync([launcher, "--no-open"], { env: { PATH: "/usr/bin:/bin", HOME: home } }).stdout.toString().trim();
const launcherVersion = () => readFileSync(launcher, "utf8").match(/^GYRE_VERSION='([^']*)'/m)?.[1];
const leftovers = () => [`${installDir}.new`, `${installDir}.old`].filter(existsSync);

let v1: string;
let v2: string;
let v3: string;
let v3corrupt: string;
beforeAll(() => {
	mkdirSync(home, { recursive: true });
	v1 = release("0.1.0");
	v2 = release("0.2.0");
	v3 = release("0.3.0");
	v3corrupt = release("0.3.0", { corrupt: true });
});
afterAll(() => {
	if (existsSync(binDir)) chmodSync(binDir, 0o755);
	rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!supported)("install.sh", () => {
	test("fresh install publishes a launcher that starts the installed release", () => {
		const result = install(v1);
		expect(result.code, result.out).toBe(0);
		expect(startGyre()).toBe("gateway 0.1.0");
		expect(launcherVersion()).toBe("0.1.0");
		expect(leftovers()).toEqual([]);
	});

	test("`gyre update` replaces the release and the launcher together", () => {
		const result = update(v2);
		expect(result.code, result.out).toBe(0);
		expect(result.out).toContain("Updated Gyre 0.1.0 → 0.2.0");
		expect(startGyre()).toBe("gateway 0.2.0");
		expect(launcherVersion()).toBe("0.2.0");
		expect(leftovers()).toEqual([]);

		const again = update(v2);
		expect(again.code, again.out).toBe(0);
		expect(again.out).toContain("already up to date");
	});

	test("a checksum mismatch changes nothing", () => {
		const result = update(v3corrupt);
		expect(result.code).not.toBe(0);
		expect(result.out).toContain("checksum mismatch");
		expect(startGyre()).toBe("gateway 0.2.0");
		expect(launcherVersion()).toBe("0.2.0");
		expect(leftovers()).toEqual([]);
	});

	test.skipIf(process.getuid?.() === 0)("a launcher that cannot be published puts the previous release back", () => {
		chmodSync(binDir, 0o555);
		try {
			const result = install(v3);
			expect(result.code).not.toBe(0);
			expect(result.out).toContain("kept the previous install");
		} finally {
			chmodSync(binDir, 0o755);
		}
		expect(startGyre()).toBe("gateway 0.2.0");
		expect(launcherVersion()).toBe("0.2.0");
		expect(leftovers()).toEqual([]);
		expect(readFileSync(join(installDir, "gyre-gateway"), "utf8")).toContain("0.2.0");
	});
});
