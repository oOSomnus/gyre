/**
 * End-to-end smoke test: drives the real UI in Chromium against a running
 * gateway (which drives a real omp). No model calls are made unless
 * E2E_LIVE=1, which adds one real model turn at the end.
 *
 *   GYRE_URL=http://127.0.0.1:7399 GYRE_TOKEN=e2e \
 *   E2E_OUT=/tmp/shots bun run.ts
 *
 * Uses fixtures/demo-project by default (override with E2E_PROJECT). Its
 * `.omp/extensions/gyre-e2e.ts` registers `/pick-color` (select) and
 * `/confirm-demo` (confirm) so real omp dialogs can be exercised.
 * Start the gateway with GYRE_OMP_ARGS=--no-session and a fresh
 * GYRE_DATA_DIR so the run starts from the welcome screen.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";

const url = process.env.GYRE_URL ?? "http://127.0.0.1:7399";
const token = process.env.GYRE_TOKEN ?? "e2e";
const project = process.env.E2E_PROJECT ?? join(import.meta.dir, "fixtures/demo-project");
const out = process.env.E2E_OUT ?? "e2e-out";
mkdirSync(out, { recursive: true });

const executablePath =
	process.env.CHROMIUM_PATH;

const results: Array<{ step: string; ok: boolean; detail?: string }> = [];
async function step(name: string, fn: () => Promise<void>) {
	try {
		await fn();
		results.push({ step: name, ok: true });
		console.log(`✓ ${name}`);
	} catch (error) {
		await page.screenshot({ path: join(out, `fail-${results.length}.png`) }).catch(() => undefined);
		results.push({ step: name, ok: false, detail: String((error as Error).message).split("\n")[0] });
		console.log(`✗ ${name}: ${String((error as Error).message).split("\n")[0]}`);
	}
}
const shot = (page: Page, name: string) => page.screenshot({ path: join(out, `${name}.png`) });

const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors: string[] = [];
page.on("console", msg => msg.type() === "error" && consoleErrors.push(msg.text()));
page.on("pageerror", err => consoleErrors.push(String(err)));

await step("loads and authenticates", async () => {
	await page.goto(`${url}/#token=${token}`);
	await page.getByText("Gyre", { exact: true }).first().waitFor({ timeout: 15_000 });
});

await step("adds a project via the welcome dialog", async () => {
	const pathInput = page.getByPlaceholder("~/workspace/my-app");
	if (await pathInput.isVisible({ timeout: 3000 }).catch(() => false)) {
		await shot(page, "01-welcome");
		await pathInput.fill(project);
		await page.getByTestId("add-project-submit").click();
	}
	await page.locator("[data-composer]").first().waitFor({ timeout: 15_000 });
});

await step("chat becomes ready (omp started)", async () => {
	await page.locator("[data-composer]:not([disabled])").first().waitFor({ timeout: 60_000 });
	await page.getByText("What are we building?").waitFor({ timeout: 30_000 });
	await shot(page, "02-chat-ready");
});

await step("/clear and /new run in Gyre, not as a prompt", async () => {
	const composer = page.locator("[data-composer]").first();
	await composer.click();
	await composer.fill("/cle");
	await page.locator("button", { hasText: "/clear" }).filter({ hasText: "gyre" }).first().waitFor({ timeout: 10_000 });
	await composer.fill("/clear");
	await composer.press("Enter");
	await page.getByText("Context cleared.").first().waitFor({ timeout: 15_000 });
	if ((await composer.inputValue()) !== "") throw new Error("composer not emptied");
	const leaked = await page.locator(".gy-card", { hasText: "/clear" }).count();
	if (leaked > 0) throw new Error("/clear was sent to the model as a prompt");
	await composer.fill("/new");
	await composer.press("Enter");
	await page.waitForFunction(() => (document.querySelector("[data-composer]") as HTMLTextAreaElement | null)?.value === "", null, { timeout: 5_000 });
	await page.locator("[data-composer]:not([disabled])").first().waitFor({ timeout: 30_000 });
	if ((await page.locator(".gy-card", { hasText: "/new" }).count()) > 0) throw new Error("/new was sent as a prompt");
	await shot(page, "02b-clear");
});

await step("slash autocomplete lists omp commands", async () => {
	const composer = page.locator("[data-composer]").first();
	await composer.click();
	await composer.fill("/");
	await page.locator("button", { hasText: "/session" }).first().waitFor({ timeout: 10_000 });
	await composer.fill("/pick");
	await page.getByText("/pick-color").first().waitFor({ timeout: 10_000 });
	await shot(page, "03-slash");
	await composer.fill("");
});

await step("builtin slash command renders command output", async () => {
	const composer = page.locator("[data-composer]").first();
	await composer.fill("/session");
	await composer.press("Enter");
	await page.getByText("command output").first().waitFor({ timeout: 15_000 });
	await shot(page, "04-command-output");
});

await step("select dialog answered with Alt+2", async () => {
	const composer = page.locator("[data-composer]").first();
	await composer.fill("/pick-color");
	await composer.press("Enter");
	await page.getByText("Pick a color", { exact: true }).waitFor({ timeout: 15_000 });
	await shot(page, "05-select-dialog");
	await page.keyboard.press("Alt+2");
	await page.getByText("picked=Green").waitFor({ timeout: 10_000 });
});

await step("confirm dialog answered by click", async () => {
	const composer = page.locator("[data-composer]").first();
	await composer.fill("/confirm-demo");
	await composer.press("Enter");
	await page.getByText("Ship it to production?").waitFor({ timeout: 15_000 });
	await page.locator("[data-dialog-id] button", { hasText: "Yes" }).click();
	await page.getByText("confirmed=true").waitFor({ timeout: 10_000 });
	await shot(page, "06-dialogs-answered");
});

await step("command palette opens with omp commands", async () => {
	await page.keyboard.press("Control+k");
	await page.getByPlaceholder(/Type a command/).waitFor({ timeout: 5000 });
	await page.getByText(/omp commands \(\d+\)/).waitFor({ timeout: 5000 });
	await shot(page, "07-palette");
	await page.keyboard.press("Escape");
});

await step("model picker lists models from omp", async () => {
	await page.locator("[data-composer]").first().click();
	await page.keyboard.press("Control+m");
	await page.getByPlaceholder(/Search models/).waitFor({ timeout: 5000 });
	await page.locator("[cmdk-item]").first().waitFor({ timeout: 30_000 });
	await shot(page, "08-model-picker");
	await page.keyboard.press("Escape");
});

await step("terminal pane runs a shell", async () => {
	await page.keyboard.press("Control+k");
	await page.getByPlaceholder(/Type a command/).fill("New terminal");
	await page.keyboard.press("Enter");
	await page.locator(".xterm").first().waitFor({ timeout: 10_000 });
	await page.waitForTimeout(1500);
	await page.locator(".xterm").first().click();
	await page.keyboard.type("echo gyre-$((40+2))\n");
	await page.getByText("gyre-42").first().waitFor({ timeout: 10_000 });
	await shot(page, "09-terminal");
});

await step("file pane shows project files in Monaco", async () => {
	await page.keyboard.press("Control+k");
	await page.getByPlaceholder(/Type a command/).fill("Files");
	await page.keyboard.press("Enter");
	const pane = page.locator('[data-pane][data-kind="file"]').last();
	await pane.getByRole("button", { name: "src", exact: true }).click();
	await pane.getByRole("button", { name: "app.ts", exact: true }).click();
	await page.locator(".monaco-editor").first().waitFor({ timeout: 15_000 });
	await page.getByText("export function add").first().waitFor({ timeout: 10_000 });
	await shot(page, "10-files");
});

await step("jump marks label actionable elements", async () => {
	await page.keyboard.press("Alt+j");
	await page.locator(".gy-mark").first().waitFor({ timeout: 5000 });
	const count = await page.locator(".gy-mark").count();
	if (count < 5) throw new Error(`only ${count} marks`);
	await shot(page, "11-jump-marks");
	await page.keyboard.press("Escape");
});

const THEME_IDS = ["graphite", "carbon", "riso", "blacklight", "greenbar", "phosphor", "dune", "dusk"] as const;
const LABELS: Record<(typeof THEME_IDS)[number], string> = {
	graphite: "Graphite",
	carbon: "Carbon",
	riso: "Riso",
	blacklight: "Blacklight",
	greenbar: "Greenbar",
	phosphor: "Phosphor",
	dune: "Dune",
	dusk: "Dusk",
};

await step("each theme applies (palette)", async () => {
	if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== "graphite") throw new Error("default theme is not graphite");
	for (const id of THEME_IDS) {
		await page.keyboard.press("Control+k");
		await page.getByPlaceholder(/Type a command/).fill(`Theme: ${LABELS[id]}`);
		await page.keyboard.press("Enter");
		await page.waitForFunction(t => document.documentElement.dataset.theme === t, id, { timeout: 3000 });
		await page.locator("header canvas").first().waitFor({ timeout: 3000 });
		await page.waitForTimeout(400);
		await shot(page, `12-theme-${id}`);
	}
});

await step("theme persists across reload", async () => {
	await page.keyboard.press("Control+k");
	await page.getByPlaceholder(/Type a command/).fill("Theme: Riso");
	await page.keyboard.press("Enter");
	await page.reload();
	await page.locator("[data-composer]").first().waitFor({ timeout: 30_000 });
	if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== "riso") throw new Error("theme not restored");
	await page.keyboard.press("Control+k");
	await page.getByPlaceholder(/Type a command/).fill("Theme: Graphite");
	await page.keyboard.press("Enter");
	await page.waitForFunction(() => document.documentElement.dataset.theme === "graphite");
});

// ---------------------------------------------------------------- v0.2 features

type Mc = { useApp: { getState(): any }; useChats: { getState(): any } };
const chatIdOf = () =>
	page.evaluate(() => {
		const mc = (window as unknown as { __gyre: Mc }).__gyre;
		const ws = mc.useApp.getState().activeWorkspace();
		return Object.values(ws.panes as Record<string, { id: string; kind: string }>).find(p => p.kind === "chat")?.id ?? "";
	});

await step("gyroscope reflects agent state", async () => {
	const gyro = page.locator("header .gy-gyro").first();
	const stateIs = (want: string) => page.waitForFunction(w => document.querySelector("header .gy-gyro")?.getAttribute("data-state") === w, want, { timeout: 5000 });
	await stateIs("idle");
	const chatId = await chatIdOf();
	await page.evaluate(id => (window as unknown as { __gyre: Mc }).__gyre.useChats.getState().patch(id, { busy: true }), chatId);
	await stateIs("working");
	await page.evaluate(
		id => (window as unknown as { __gyre: Mc }).__gyre.useChats.getState().apply(id, { type: "extension_ui_request", id: "fake-gyro", method: "confirm", title: "Gyro test?", message: "" }),
		chatId,
	);
	await stateIs("needs");
	await page.waitForTimeout(900);
	await gyro.screenshot({ path: join(out, "12-gyro-needs.png") });
	await page.evaluate(id => (window as unknown as { __gyre: Mc }).__gyre.useChats.getState().patch(id, { busy: false, pendingUi: [] }), chatId);
	await stateIs("idle");
});

await step("plan mode toggles from the chat strip (Gyre omp extension)", async () => {
	const chat = page.locator('[data-pane][data-kind="chat"]').first();
	await chat.locator('[data-jump="plan-mode"]').click();
	await page.getByText("Plan mode · planning").first().waitFor({ timeout: 15_000 });
	await shot(page, "14-plan-mode");
	await chat.locator('[data-jump="plan-mode"]').click();
	await page.getByText("Plan mode · planning").first().waitFor({ state: "detached", timeout: 15_000 });
});

await step("submitted plan opens the review pane with role/context choices", async () => {
	const chatId = await chatIdOf();
	await page.evaluate(id => {
		const mc = (window as unknown as { __gyre: Mc }).__gyre;
		const state = { phase: "reviewing", title: "Add caching", planFilePath: "local://cache-plan.md", planContent: "# Add caching\n\n## Approach\n\n1. Add an LRU cache.\n\n## Verification\n\n- bun test", revision: 1, updatedAt: Date.now() };
		mc.useChats.getState().apply(id, { type: "extension_ui_request", id: "fake-plan", method: "setWidget", widgetKey: "gyre.plan", widgetLines: [JSON.stringify(state)] });
	}, chatId);
	const planPane = page.locator('[data-pane][data-kind="plan"]');
	await planPane.waitFor({ timeout: 5000 });
	await planPane.getByTestId("plan-role").waitFor();
	await planPane.getByText("Add an LRU cache.").waitFor();
	await planPane.getByTestId("plan-context").selectOption("fresh");
	await shot(page, "15-plan-review");
	// Back to idle without sending anything to omp.
	await page.evaluate(id => {
		const mc = (window as unknown as { __gyre: Mc }).__gyre;
		mc.useChats.getState().apply(id, { type: "extension_ui_request", id: "fake-plan-2", method: "setWidget", widgetKey: "gyre.plan" });
	}, chatId);
	await planPane.locator('[data-jump="close"]').click();
});

await step("KaTeX and file links render in replies", async () => {
	const chatId = await chatIdOf();
	await page.evaluate(id => {
		const mc = (window as unknown as { __gyre: Mc }).__gyre;
		mc.useChats.getState().apply(id, {
			type: "message_end",
			messageId: "fake-math",
			message: { role: "assistant", timestamp: Date.now(), content: [{ type: "text", text: "Energy: $$E = mc^2$$ see `src/app.ts` and\n\n| a | b |\n|---|---|\n| 1 | 2 |" }] },
		});
	}, chatId);
	await page.locator(".katex").first().waitFor({ timeout: 5000 });
	await page.locator(".gy-file-link", { hasText: "src/app.ts" }).first().waitFor({ timeout: 5000 });
	await shot(page, "16-katex");
});

await step("marks offer actions for a table", async () => {
	await page.keyboard.press("Alt+w");
	await page.locator(".gy-mark").first().waitFor({ timeout: 5000 });
	const label = await page.evaluate(() => {
		const table = document.querySelector("[data-jump-kind=table]")?.getBoundingClientRect();
		if (!table) return null;
		const marks = [...document.querySelectorAll<HTMLElement>(".gy-mark")];
		const near = marks.find(m => Math.abs(m.getBoundingClientRect().left - (table.left - 4)) < 3 && Math.abs(m.getBoundingClientRect().top - Math.max(0, table.top - 6)) < 3);
		return near?.textContent ?? null;
	});
	if (!label) throw new Error("no mark on the table");
	await page.keyboard.type(label);
	await page.getByTestId("jump-menu").getByText("Copy as Markdown").waitFor({ timeout: 3000 });
	await shot(page, "17-marks-menu");
	await page.keyboard.press("Escape");
	await page.keyboard.press("Escape");
});

await step("pane palette (Alt+C) lists actions for the focused pane", async () => {
	await page.locator('[data-pane][data-kind="chat"] [data-composer]').first().click();
	await page.keyboard.press("Alt+c");
	await page.getByPlaceholder("Actions for the focused pane…").waitFor({ timeout: 3000 });
	await page.getByText("Float above the grid").waitFor();
	await page.keyboard.press("Escape");
});

await step("auto-tiling hides panes that do not fit and the hidden bar restores them", async () => {
	for (let i = 0; i < 5; i++) {
		await page.evaluate(() => {
			const mc = (window as unknown as { __gyre: Mc }).__gyre;
			const app = mc.useApp.getState();
			app.addPane({ kind: "settings" });
		});
	}
	await page.getByTestId("hidden-bar").waitFor({ timeout: 5000 });
	await shot(page, "18-hidden-bar");
	const chip = page.locator("[data-hidden-pane]").first();
	const id = await chip.getAttribute("data-hidden-pane");
	await chip.click();
	await page.locator(`[data-pane="${id}"]`).waitFor({ timeout: 5000 });
});

await step("keyboard mode: numbers, float/dock, hide", async () => {
	await page.keyboard.press("Alt+m");
	await page.getByTestId("kbd-mode").waitFor();
	await page.locator(".gy-pane-number").first().waitFor();
	await page.keyboard.press("1");
	await page.keyboard.press("f");
	const floating = await page.evaluate(() => {
		const mc = (window as unknown as { __gyre: Mc }).__gyre;
		const ws = mc.useApp.getState().activeWorkspace();
		return Object.keys(ws.floating ?? {}).length;
	});
	if (floating < 1) throw new Error("pane did not float");
	await shot(page, "19-floating");
	await page.keyboard.press("f");
	await page.keyboard.press("Escape");
	// Clean up the settings panes added above.
	await page.evaluate(() => {
		const mc = (window as unknown as { __gyre: Mc }).__gyre;
		const app = mc.useApp.getState();
		for (const pane of Object.values(app.activeWorkspace().panes as Record<string, { id: string; kind: string }>)) if (pane.kind === "settings") app.closePane(pane.id);
	});
});

await step("settings: models & roles lists omp's roles", async () => {
	await page.evaluate(() => (window as unknown as { __gyre: Mc }).__gyre.useApp.getState().addPane({ kind: "settings", section: "roles" }));
	await page.getByTestId("role-edit-plan").waitFor({ timeout: 10_000 });
	await page.getByTestId("role-edit-task").waitFor();
	await shot(page, "20-roles");
	await page.locator('[data-pane][data-kind="settings"] [data-jump="close"]').last().click();
});

await step("phone layout shows one pane with a tab strip", async () => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForTimeout(400);
	await shot(page, "21-phone");
	const tabs = await page.locator("nav .gy-chrome-btn").count();
	if (tabs < 1) throw new Error("no pane tabs");
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.waitForTimeout(400);
});

await step("layout persists across reload", async () => {
	const before = await page.locator("[data-pane]").count();
	const workspaceId = await page.evaluate(() => (window as unknown as { __gyre: Mc }).__gyre.useApp.getState().activeWorkspaceId);
	const saved = page.waitForResponse(
		response =>
			response.request().method() === "PUT" &&
			response.url().endsWith(`/api/workspaces/${workspaceId}`) &&
			response.ok() &&
			String(response.request().postDataJSON()?.name ?? "").endsWith(" saved"),
	);
	await page.evaluate(() => {
		const app = (window as unknown as { __gyre: Mc }).__gyre.useApp.getState();
		const ws = app.activeWorkspace();
		app.renameWorkspace(ws.id, `${ws.name} saved`);
	});
	await saved;
	await page.reload();
	await page.locator("[data-pane]").first().waitFor({ timeout: 15_000 });
	const after = await page.locator("[data-pane]").count();
	if (after !== before) throw new Error(`panes before=${before} after=${after}`);
	// The chat re-attaches to the same live omp process (no restart).
	await page.locator("[data-composer]:not([disabled])").first().waitFor({ timeout: 20_000 });
	if (await page.getByText("omp is not running").isVisible()) throw new Error("chat process was lost on reload");
	await shot(page, "13-after-reload");
});

// Optional: one real model turn (costs a few tokens on the configured provider).
// Enable with E2E_LIVE=1; checks streaming text, thinking and tool cards.
if (process.env.E2E_LIVE === "1") {
	await step("live turn with a real model (E2E_LIVE=1)", async () => {
		const composer = page.locator("[data-composer]:not([disabled])").first();
		await composer.waitFor({ timeout: 60_000 });
		await composer.click();
		await composer.fill("Use the bash tool to run `ls src`, then read src/app.ts and reply in one short sentence describing what it exports.");
		await composer.press("Enter");
		await page.locator(".gy-card.tool").first().waitFor({ timeout: 120_000 });
		await shot(page, "20-live-tool");
		// Wait for the turn to settle (the chat strip returns to idle).
		await page.getByText("idle", { exact: true }).first().waitFor({ timeout: 180_000 });
		await page.waitForTimeout(800);
		await shot(page, "21-live-done");
		if ((await page.locator(".gy-card.assistant").count()) < 1) throw new Error("no assistant reply");
	});
}

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
if (consoleErrors.length) console.log(`console errors (${consoleErrors.length}):\n  ${consoleErrors.slice(0, 10).join("\n  ")}`);
process.exit(failed.length ? 1 : 0);
