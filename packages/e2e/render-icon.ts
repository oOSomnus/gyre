/**
 * Renders Gyre's official icon (the gyroscope mark on a Graphite tile) with the
 * same renderer the app uses, in headless Chromium.
 *
 *   bun packages/e2e/render-icon.ts            # writes the 1024px source + README icon
 *   cd apps/desktop && bunx tauri icon src-tauri/icons/icon-source.png -o <tmp>   # then copy the sizes in
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const root = join(import.meta.dir, "../..");
const executablePath =
	process.env.CHROMIUM_PATH ?? join(homedir(), ".cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell");

const entry = join(import.meta.dir, ".render-icon-entry.ts");
writeFileSync(entry, `import * as G from "../web/src/lib/gyro";\n(globalThis as Record<string, unknown>).Gyro = G;\n`);
const bundle = await Bun.build({ entrypoints: [entry], format: "iife", target: "browser" });
rmSync(entry);
if (!bundle.success) throw new Error(bundle.logs.join("\n"));
const gyroJs = await bundle.outputs[0]!.text();

const page = await (await chromium.launch({ executablePath })).newPage();
await page.setContent("<canvas id=c width=1024 height=1024></canvas>");
await page.addScriptTag({ content: gyroJs });
const dataUrl = await page.evaluate(() => {
	const G = (window as unknown as { Gyro: typeof import("../web/src/lib/gyro") }).Gyro;
	const canvas = document.getElementById("c") as HTMLCanvasElement;
	const ctx = canvas.getContext("2d")!;
	const S = 1024;
	const tile = (path: () => void) => {
		ctx.save();
		path();
		ctx.clip();
	};
	const rounded = () => {
		const r = 228, m = 40;
		ctx.beginPath();
		ctx.roundRect(m, m, S - 2 * m, S - 2 * m, r);
	};
	// Graphite tile with the halftone.
	tile(rounded);
	const bg = ctx.createLinearGradient(0, 0, 0, S);
	bg.addColorStop(0, "#1c2639");
	bg.addColorStop(1, "#0b101a");
	ctx.fillStyle = bg;
	ctx.fillRect(0, 0, S, S);
	ctx.fillStyle = "rgba(255,255,255,0.07)";
	for (let y = 10; y < S; y += 20) for (let x = 10; x < S; x += 20) {
		ctx.beginPath();
		ctx.arc(x, y, 3.2, 0, Math.PI * 2);
		ctx.fill();
	}
	const glow = ctx.createRadialGradient(S / 2, S * 0.48, 0, S / 2, S * 0.48, S * 0.42);
	glow.addColorStop(0, "rgba(42,208,224,0.30)");
	glow.addColorStop(1, "rgba(42,208,224,0)");
	ctx.fillStyle = glow;
	ctx.fillRect(0, 0, S, S);
	ctx.restore();
	// Hairline edge.
	rounded();
	ctx.strokeStyle = "rgba(255,255,255,0.10)";
	ctx.lineWidth = 4;
	ctx.stroke();

	// The mark, posed and lit as "working".
	const palette = { metal: [174, 189, 207] as [number, number, number], hi: [255, 255, 255] as [number, number, number], work: [42, 208, 224] as [number, number, number], alert: [255, 122, 47] as [number, number, number], steps: 0 };
	const motion = { a: [24, 58, 32] as [number, number, number], yaw: -18, spin: 20, v: [0, 0, 0, 0, 0] as [number, number, number, number, number] };
	const mark = document.createElement("canvas");
	mark.width = mark.height = 840;
	G.drawGyro(mark.getContext("2d")!, 840, motion, G.targetColors(palette, "working"), palette, true);
	ctx.shadowColor = "rgba(42,208,224,0.55)";
	ctx.shadowBlur = 28;
	ctx.drawImage(mark, (S - 840) / 2, (S - 840) / 2 + 26);
	return canvas.toDataURL("image/png");
});
const png = Buffer.from(dataUrl.split(",")[1]!, "base64");
writeFileSync(join(root, "apps/desktop/src-tauri/icons/icon-source.png"), png);
mkdirSync(join(root, "docs/assets"), { recursive: true });
const small = await page.evaluate(async src => {
	const img = new Image();
	img.src = src;
	await img.decode();
	const c = document.createElement("canvas");
	c.width = c.height = 256;
	const x = c.getContext("2d")!;
	x.imageSmoothingQuality = "high";
	x.drawImage(img, 0, 0, 256, 256);
	return c.toDataURL("image/png");
}, dataUrl);
writeFileSync(join(root, "docs/assets/gyre-icon.png"), Buffer.from(small.split(",")[1]!, "base64"));
console.log("wrote apps/desktop/src-tauri/icons/icon-source.png and docs/assets/gyre-icon.png");
process.exit(0);
