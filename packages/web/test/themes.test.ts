import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildItems, newMotion, parseColor, stepMotion, targetColors, type GyroPalette, type GyroState } from "../src/lib/gyro";
import { DEFAULT_THEME, isThemeId, THEME_ORDER, THEMES } from "../src/lib/themes";

const css = readFileSync(join(import.meta.dir, "../src/styles.css"), "utf8");
function tokensOf(id: string): Set<string> {
	const start = css.indexOf(`[data-theme="${id}"] {`);
	expect(start).toBeGreaterThanOrEqual(0);
	const body = css.slice(start, css.indexOf("\n}", start));
	return new Set([...body.matchAll(/(--[a-z0-9-]+):/g)].map(m => m[1]!));
}

describe("themes", () => {
	test("registry and ids", () => {
		expect(THEME_ORDER).toEqual(["graphite", "riso", "phosphor", "dune", "dusk"]);
		expect(DEFAULT_THEME).toBe("graphite");
		for (const id of THEME_ORDER) expect(isThemeId(id)).toBe(true);
		for (const bad of ["paper", "night", "", null, 42]) expect(isThemeId(bad)).toBe(false);
	});

	test("every theme defines the same CSS tokens", () => {
		const reference = tokensOf(DEFAULT_THEME);
		expect(reference.size).toBeGreaterThan(80);
		for (const id of THEME_ORDER) expect([...tokensOf(id)].sort()).toEqual([...reference].sort());
		for (const needed of ["--halftone", "--radius", "--gy-metal", "--gy-work", "--gy-alert", "--k-chat-a", "--st-waiting"]) expect(reference.has(needed)).toBe(true);
	});

	test("components use tokens, not literal colours", () => {
		const components = css.slice(css.indexOf("@layer components"));
		const literals = components.split("\n").filter(line => /#[0-9a-fA-F]{3,8}\b/.test(line) && !line.includes("#ffffff;"));
		expect(literals).toEqual([]);
	});
});

describe("gyroscope", () => {
	const palette: GyroPalette = { metal: parseColor("#aebdcf"), hi: [255, 255, 255], work: parseColor("#2ad0e0"), alert: parseColor("rgb(255, 122, 47)"), steps: 0 };

	test("parses token colours", () => {
		expect(parseColor("#fff")).toEqual([255, 255, 255]);
		expect(parseColor(" #2ad0e0 ")).toEqual([42, 208, 224]);
		expect(parseColor("rgb(1 2 3 / 0.5)")).toEqual([1, 2, 3]);
	});

	for (const state of ["idle", "working", "needs"] as GyroState[]) {
		test(`builds a depth-sorted frame (${state})`, () => {
			const motion = newMotion(1);
			for (let i = 0; i < 30; i++) stepMotion(motion, state, 1 / 60);
			const items = buildItems(motion, targetColors(palette, state), palette, 80, true);
			expect(items.length).toBeGreaterThan(100);
			for (let i = 1; i < items.length; i++) expect(items[i]!.z).toBeGreaterThanOrEqual(items[i - 1]!.z);
		});
	}

	test("needs-you stops the outer ring facing the viewer", () => {
		const motion = newMotion(2);
		for (let i = 0; i < 600; i++) stepMotion(motion, "needs", 1 / 60);
		const facing = ((motion.yaw + motion.a[0]) % 180 + 180) % 180;
		expect(Math.min(facing, 180 - facing)).toBeLessThan(1);
		expect(Math.abs(motion.v[0])).toBeLessThan(0.5);
	});

	test("working spins the rotor much faster than idle", () => {
		const idle = newMotion(0);
		const busy = newMotion(0);
		for (let i = 0; i < 240; i++) {
			stepMotion(idle, "idle", 1 / 60);
			stepMotion(busy, "working", 1 / 60);
		}
		expect(busy.v[4]).toBeGreaterThan(idle.v[4] * 5);
	});
});
