/**
 * install.sh against local release fixtures, in a throwaway HOME: fresh install,
 * `gyre update`, checksum rejection, a failed launcher publish and recovery from a
 * run that stopped mid-replacement. The installer must leave a launcher that matches
 * a runnable release in every case. Each test sets up its own starting install.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

const tarballOf = (base: string) => join(base.replace(/^file:\/\//, ""), `gyre-web-${OS}-${ARCH}.tar.gz`);

/** Unpack a fixture release's web folder to `dest`, as a swap would leave it. */
function unpackTo(base: string, dest: string) {
	const scratch = mkdtempSync(join(root, "unpack-"));
	const tar = Bun.spawnSync(["tar", "-xzf", tarballOf(base), "-C", scratch]);
	if (tar.exitCode !== 0) throw new Error(tar.stderr.toString());
	renameSync(join(scratch, "gyre"), dest);
	rmSync(scratch, { recursive: true });
}

function run(cmd: string[], base: string, installPath = installDir) {
	const result = Bun.spawnSync(cmd, {
		env: {
			HOME: home,
			// No omp, Bun or user tools: only what a fresh machine has.
			PATH: "/usr/bin:/bin",
			NO_COLOR: "1",
			TMPDIR: root,
			GYRE_INSTALL_DIR: installPath,
			GYRE_BIN_DIR: binDir,
			GYRE_RELEASE_BASE: base,
			GYRE_INSTALLER_URL: `file://${INSTALLER}`,
		},
		stdin: "ignore",
	});
	return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() };
}

const FLAGS = ["--no-omp", "--no-plannotator", "--yes"];
const install = (base: string, installPath?: string) => run(["bash", INSTALLER, "--web", ...FLAGS], base, installPath);
const update = (base: string) => run([launcher, "update", ...FLAGS], base);
const startGyre = () => Bun.spawnSync([launcher, "--no-open"], { env: { PATH: "/usr/bin:/bin", HOME: home } }).stdout.toString().trim();
const launcherVersion = () => readFileSync(launcher, "utf8").match(/^GYRE_VERSION='([^']*)'/m)?.[1];
const leftovers = () => [`${installDir}.new`, `${installDir}.old`, `${installDir}.old.version`].filter(existsSync);

/** A clean HOME with `base` installed. */
function startFrom(base: string) {
	if (existsSync(binDir)) chmodSync(binDir, 0o755);
	rmSync(join(home, ".local"), { recursive: true, force: true });
	const result = install(base);
	expect(result.code, result.out).toBe(0);
}

/** Run `fn` with the launcher's folder read-only, so publishing the launcher fails. */
function withReadOnlyBin<T>(fn: () => T): T {
	chmodSync(binDir, 0o555);
	try {
		return fn();
	} finally {
		chmodSync(binDir, 0o755);
	}
}

const canMakeReadOnly = process.getuid?.() !== 0;

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
		rmSync(join(home, ".local"), { recursive: true, force: true });
		const result = install(v1);
		expect(result.code, result.out).toBe(0);
		expect(startGyre()).toBe("gateway 0.1.0");
		expect(launcherVersion()).toBe("0.1.0");
		expect(leftovers()).toEqual([]);
	});

	test("`gyre update` replaces the release and the launcher together", () => {
		startFrom(v1);
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
		startFrom(v2);
		const result = update(v3corrupt);
		expect(result.code).not.toBe(0);
		expect(result.out).toContain("checksum mismatch");
		expect(startGyre()).toBe("gateway 0.2.0");
		expect(launcherVersion()).toBe("0.2.0");
		expect(leftovers()).toEqual([]);
	});

	test.skipIf(!canMakeReadOnly)("a launcher that cannot be published puts the previous release back", () => {
		startFrom(v2);
		const result = withReadOnlyBin(() => install(v3));
		expect(result.code).not.toBe(0);
		expect(result.out).toContain("kept the previous install");
		expect(startGyre()).toBe("gateway 0.2.0");
		expect(launcherVersion()).toBe("0.2.0");
		expect(leftovers()).toEqual([]);
		expect(readFileSync(join(installDir, "gyre-gateway"), "utf8")).toContain("0.2.0");
	});

	test.skipIf(!canMakeReadOnly)("after a run stopped before republishing the launcher, the recorded release comes back", () => {
		startFrom(v1);
		// What a run that died between the swap and the launcher publish leaves behind.
		writeFileSync(`${installDir}.old.version`, "0.1.0\n");
		renameSync(installDir, `${installDir}.old`);
		unpackTo(v2, installDir);
		expect(launcherVersion()).toBe("0.1.0");

		const result = withReadOnlyBin(() => install(v3));
		expect(result.code).not.toBe(0);
		expect(startGyre()).toBe("gateway 0.1.0");
		expect(launcherVersion()).toBe("0.1.0");
		expect(leftovers()).toEqual([]);
	});

	test.skipIf(!canMakeReadOnly)("after a run stopped just after republishing the launcher, the stale backup is dropped", () => {
		startFrom(v1);
		// The launcher already records 0.2.0; only removing the 0.1.0 backup was left to do.
		writeFileSync(`${installDir}.old.version`, "0.1.0\n");
		renameSync(installDir, `${installDir}.old`);
		unpackTo(v2, installDir);
		writeFileSync(launcher, readFileSync(launcher, "utf8").replace("GYRE_VERSION='0.1.0'", "GYRE_VERSION='0.2.0'"));

		const result = withReadOnlyBin(() => install(v3));
		expect(result.code).not.toBe(0);
		expect(startGyre()).toBe("gateway 0.2.0");
		expect(launcherVersion()).toBe("0.2.0");
		expect(leftovers()).toEqual([]);
	});

	test("an install folder given with a trailing slash is replaced in place", () => {
		startFrom(v1);
		const result = install(v2, `${installDir}/`);
		expect(result.code, result.out).toBe(0);
		expect(startGyre()).toBe("gateway 0.2.0");
		expect(existsSync(join(installDir, ".new")) || existsSync(join(installDir, ".old"))).toBe(false);
		expect(leftovers()).toEqual([]);
	});
});
