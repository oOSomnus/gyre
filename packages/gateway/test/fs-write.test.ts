import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeContained } from "../src/contained-file";
import { contentVersion, readText, writeText } from "../src/fs";
import { startGateway, type Gateway } from "../src/server";

const dir = mkdtempSync(join(tmpdir(), "gyre-fs-write-"));
const project = join(dir, "project");
const fake = join(import.meta.dir, "fixtures/fake-omp.ts");
let gateway: Gateway;
const headers = { "x-gyre-token": "tok", "content-type": "application/json" };

beforeAll(async () => {
	mkdirSync(join(project, "src"), { recursive: true });
	writeFileSync(join(project, "src/a.ts"), "export const a = 1;\n");
	writeFileSync(join(dir, "outside.txt"), "outside");
	gateway = await startGateway({ host: "127.0.0.1", port: 0, token: "tok", dataDir: join(dir, "data"), ompPath: fake });
});
afterAll(async () => {
	await gateway?.stop();
	rmSync(dir, { recursive: true, force: true });
});

test("a save with the version from the read replaces the file and returns the new version", async () => {
	const file = await readText(project, "src/a.ts");
	expect(file.version).toBe(contentVersion("export const a = 1;\n"));
	const saved = await writeText(project, "src/a.ts", "export const a = 2;\n", file.version!);
	expect(readFileSync(join(project, "src/a.ts"), "utf8")).toBe("export const a = 2;\n");
	expect(saved.version).toBe(contentVersion("export const a = 2;\n"));
	expect(readdirSync(join(project, "src")).filter(name => name.includes(".gyre-"))).toEqual([]);
});

test("a save against a stale version is a 412 carrying the current version", async () => {
	writeFileSync(join(project, "src/b.ts"), "one");
	const file = await readText(project, "src/b.ts");
	writeFileSync(join(project, "src/b.ts"), "changed elsewhere");
	await expect(writeText(project, "src/b.ts", "mine", file.version!)).rejects.toMatchObject({
		status: 412,
		data: { currentVersion: contentVersion("changed elsewhere") },
	});
	expect(readFileSync(join(project, "src/b.ts"), "utf8")).toBe("changed elsewhere");
});

test("saving keeps the file's permission bits", async () => {
	writeFileSync(join(project, "run.sh"), "#!/bin/sh\n");
	chmodSync(join(project, "run.sh"), 0o750);
	const file = await readText(project, "run.sh");
	await writeText(project, "run.sh", "#!/bin/sh\necho hi\n", file.version!);
	expect(statSync(join(project, "run.sh")).mode & 0o777).toBe(0o750);
});

test("a null base version creates a new file and refuses to overwrite one", async () => {
	await writeText(project, "src/new.ts", "fresh", null);
	expect(readFileSync(join(project, "src/new.ts"), "utf8")).toBe("fresh");
	await expect(writeText(project, "src/new.ts", "again", null)).rejects.toMatchObject({ status: 412 });
	await expect(writeText(project, "src/missing-dir/x.ts", "x", null)).rejects.toMatchObject({ status: 404 });
});

test("writes cannot leave the project through traversal, names or symlinks", async () => {
	await expect(writeText(project, "../outside.txt", "x", contentVersion("outside"))).rejects.toMatchObject({ status: 403 });
	await expect(writeText(project, "/etc/passwd", "x", null)).rejects.toMatchObject({ status: 400 });
	await expect(writeText(project, "src/..", "x", null)).rejects.toMatchObject({ status: 400 });
	symlinkSync(join(dir, "outside.txt"), join(project, "escape-link"));
	await expect(writeText(project, "escape-link", "x", contentVersion("outside"))).rejects.toMatchObject({ status: 403 });
	symlinkSync(dir, join(project, "escape-dir"));
	await expect(writeText(project, "escape-dir/new.txt", "x", null)).rejects.toMatchObject({ status: 403 });
	expect(readFileSync(join(dir, "outside.txt"), "utf8")).toBe("outside");
	expect(readdirSync(dir)).not.toContain("new.txt");
});

test("a symlink inside the project is saved at its target and stays a link", async () => {
	writeFileSync(join(project, "target.txt"), "t");
	symlinkSync(join(project, "target.txt"), join(project, "inner-link"));
	const file = await readText(project, "inner-link");
	await writeText(project, "inner-link", "t2", file.version!);
	expect(readFileSync(join(project, "target.txt"), "utf8")).toBe("t2");
	expect(statSync(join(project, "inner-link"), { throwIfNoEntry: false })).toBeDefined();
});

test("the contained writer refuses a directory swapped for an external symlink", () => {
	const root = join(dir, "race");
	mkdirSync(join(root, "child"), { recursive: true });
	rmSync(join(root, "child"), { recursive: true });
	symlinkSync(dir, join(root, "child"));
	expect(() => writeContained(root, join(root, "child"), "x.txt", Buffer.from("x"), { mode: "create" })).toThrow();
	expect(readdirSync(dir)).not.toContain("x.txt");
});

test("PUT /api/fs/write saves, reports conflicts and rejects malformed bodies", async () => {
	const created = await (await fetch(`${gateway.url}/api/projects`, { method: "POST", headers, body: JSON.stringify({ path: project }) })).json();
	const read = await (await fetch(`${gateway.url}/api/fs/read?projectId=${created.id}&path=src/a.ts`, { headers })).json();
	const put = (body: unknown) => fetch(`${gateway.url}/api/fs/write`, { method: "PUT", headers, body: JSON.stringify(body) });
	const ok = await put({ projectId: created.id, path: "src/a.ts", content: "x", baseVersion: read.version });
	expect(ok.status).toBe(200);
	const conflict = await put({ projectId: created.id, path: "src/a.ts", content: "y", baseVersion: read.version });
	expect(conflict.status).toBe(412);
	expect((await conflict.json()).currentVersion).toBe(contentVersion("x"));
	expect((await put({ projectId: created.id, path: "src/a.ts" })).status).toBe(400);
	const malformed = await fetch(`${gateway.url}/api/fs/write`, { method: "PUT", headers, body: "{" });
	expect(malformed.status).toBe(400);
});

test("the commit checks the file it replaces: a version committed meanwhile is put back, never lost", () => {
	const root = join(dir, "late");
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "f.txt"), "one\n");
	const base = contentVersion("one\n");
	const expectBase = (fd: number | null) => {
		if (fd === null || contentVersion(readFileSync(fd)) !== base) throw new Error("changed");
	};
	// Another writer commits after the caller's own check, just before this write's commit.
	writeFileSync(join(root, "f.txt"), "theirs\n");
	expect(() => writeContained(root, root, "f.txt", Buffer.from("mine\n"), { mode: "replace", verify: expectBase })).toThrow("changed");
	expect(readFileSync(join(root, "f.txt"), "utf8")).toBe("theirs\n");
	expect(readdirSync(root)).toEqual(["f.txt"]);
	// Unchanged: the new bytes land and nothing is left behind.
	writeFileSync(join(root, "f.txt"), "one\n");
	writeContained(root, root, "f.txt", Buffer.from("mine\n"), { mode: "replace", verify: expectBase });
	expect(readFileSync(join(root, "f.txt"), "utf8")).toBe("mine\n");
	expect(readdirSync(root)).toEqual(["f.txt"]);
	// Deleted meanwhile: the check sees no file, and nothing is created.
	rmSync(join(root, "f.txt"));
	expect(() => writeContained(root, root, "f.txt", Buffer.from("mine\n"), { mode: "replace", verify: expectBase })).toThrow("changed");
	expect(readdirSync(root)).toEqual([]);
	// A name near the byte limit still gets a temporary sibling.
	const long = "é".repeat(120);
	writeFileSync(join(root, long), "x");
	writeContained(root, root, long, Buffer.from("y"), { mode: "replace" });
	expect(readFileSync(join(root, long), "utf8")).toBe("y");
});

test("a create never replaces a file that appears meanwhile and leaves no temporary file", () => {
	const root = join(dir, "create");
	mkdirSync(root, { recursive: true });
	writeContained(root, root, "n.txt", Buffer.from("first"), { mode: "create" });
	expect(statSync(join(root, "n.txt")).mode & 0o777).toBe(0o666 & ~process.umask());
	expect(() => writeContained(root, root, "n.txt", Buffer.from("second"), { mode: "create" })).toThrow("file already exists");
	expect(readFileSync(join(root, "n.txt"), "utf8")).toBe("first");
	expect(readdirSync(root)).toEqual(["n.txt"]);
});
