/** Local review regression checks. Build first; makes no model calls. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type WebSocketRoute } from "playwright-core";
import { startGateway } from "../gateway/src/server";
import type { ClientMessage, ServerMessage } from "@gyre/protocol";

const root = join(import.meta.dir, "../..");
const scratch = mkdtempSync(join(tmpdir(), "gyre-browser-"));
const project = join(import.meta.dir, "fixtures/demo-project");
const gateway = await startGateway({
	host: "127.0.0.1",
	port: 0,
	token: "e2e",
	dataDir: scratch,
	webDist: join(root, "packages/web/dist"),
	ompPath: process.env.OMP_PATH,
	ompArgs: ["--no-session"],
	extensions: [join(root, "packages/omp-extension/src/index.ts")],
});
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const errors: string[] = [];
let passed = 0;
const assert = (ok: unknown, message: string) => {
	if (!ok) throw new Error(message);
};
const step = async (name: string, run: () => Promise<void>) => {
	await run();
	passed++;
	console.log(`PASS ${name}`);
};
try {
	const smoke = Bun.spawn([process.execPath, join(import.meta.dir, "run.ts")], {
		env: { ...process.env, GYRE_URL: gateway.url, GYRE_TOKEN: "e2e", E2E_OUT: join(scratch, "smoke") },
		stdout: "inherit",
		stderr: "inherit",
	});
	assert((await smoke.exited) === 0, "existing browser smoke suite failed");
	for (const ws of gateway.store.listWorkspaces()) gateway.store.removeWorkspace(ws.id);
	const registered = gateway.store.addProject("Review", project);
	gateway.store.saveWorkspace({
		id: "review",
		name: "Review",
		panes: { chat: { id: "chat", kind: "chat", projectId: registered.id } },
		layout: { type: "pane", paneId: "chat" },
		focusedPaneId: "chat",
		updatedAt: 1,
	});
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	page.on("pageerror", error => errors.push(error.message));
	let socket: WebSocketRoute;
	let currentSession = "original";
	let ptyOpens = 0;
	let prompts: Extract<ClientMessage, { t: "rpc" }>[] = [];
	const answers: Extract<ClientMessage, { t: "ui_response" }>[] = [];
	let holdPrompts = false;
	let cancelSession = false;
	const send = (message: ServerMessage) => socket.send(JSON.stringify(message));
	const info = () => ({ chatId: "chat", projectId: registered.id, cwd: project, status: "ready" as const, generation: "one", sessionPath: currentSession });
	const result = (message: { reqId: string }, data: unknown) => send({ t: "result", reqId: message.reqId, ok: true, data });
	await page.routeWebSocket("**/ws", route => {
		socket = route;
		route.onMessage(raw => {
			const message = JSON.parse(String(raw)) as ClientMessage;
			if (message.t === "hello") send({ t: "welcome", version: "0.2.0", ompVersion: "19.1.0" });
			if (message.t === "subscribe") send({ t: "chat_replay", chat: info() });
			if (message.t === "open_chat") {
				send({ t: "chat_replay", chat: info() });
				result(message, info());
			}
			if (message.t === "ui_response") answers.push(message);
			if (message.t === "pty_open") {
				ptyOpens++;
				result(message, { ptyId: "terminal", reused: ptyOpens > 1 });
			}
			if (message.t !== "rpc") return;
			switch (message.command.type) {
				case "get_state":
					result(message, { sessionFile: currentSession, isSettled: true, isStreaming: false });
					break;
				case "get_messages":
					result(message, { messages: [] });
					break;
				case "get_available_commands":
					result(message, { commands: [{ name: "gyre-plan" }, { name: "plan" }] });
					break;
				case "new_session":
					if (!cancelSession) currentSession = "fresh";
					result(message, { cancelled: cancelSession });
					break;
				case "prompt":
					prompts.push(message);
					if (!holdPrompts) result(message, { agentInvoked: false });
					break;
				case "get_subagents":
					result(message, []);
					break;
				default:
					result(message, {});
			}
		});
	});
	await page.goto(gateway.url);
	await page.locator('[data-pane="chat"] textarea').waitFor();
	const chat = page.locator('[data-pane="chat"]');
	const composer = chat.locator("textarea");
	const apply = async (frame: Record<string, unknown>) =>
		page.evaluate(frame => {
			(window as any).__gyre.useChats.getState().apply("chat", frame);
		}, frame);
	const until = async (check: () => boolean) => {
		const end = Date.now() + 5000;
		while (!check()) {
			if (Date.now() > end) throw new Error("timed out");
			await Bun.sleep(10);
		}
	};

	await step("composer blocks duplicate Enter and preserves a newer draft", async () => {
		holdPrompts = true;
		prompts = [];
		await composer.fill("submitted A");
		await composer.press("Enter");
		await until(() => prompts.length === 1);
		await composer.fill("new draft B");
		await composer.press("Enter");
		assert(prompts.length === 1, "duplicate prompt admitted");
		result(prompts[0]!, {});
		holdPrompts = false;
		await page.waitForFunction(() => !(document.querySelector('[data-pane="chat"] button[data-jump="send"]') as HTMLButtonElement)?.disabled);
		assert((await composer.inputValue()) === "new draft B", "new draft lost");
	});
	await step("ask preserves multiSelect choices and hides forbidden custom input", async () => {
		await apply({
			type: "extension_ui_request",
			id: "ask-regression",
			method: "ask",
			title: "Choices",
			questions: [{ id: "q", question: "Choose", multiSelect: true, allowCustom: false, options: ["First", "Second"] }],
		});
		const dialog = chat.locator('[data-dialog-id="ask-regression"]');
		await dialog.getByRole("button", { name: /First/ }).click();
		await dialog.getByRole("button", { name: /Second/ }).click();
		assert((await dialog.getByPlaceholder("Other (free text)…").count()) === 0, "forbidden custom input rendered");
		await dialog.getByRole("button", { name: "Submit answers" }).click();
		await until(() => answers.some(m => m.response.id === "ask-regression"));
		const answer = answers.find(m => m.response.id === "ask-regression")!.response as any;
		assert(answer.answers[0].selectedOptions.join(",") === "First,Second", "multiSelect lost an answer");
	});
	await step("form fields cannot shadow native submission APIs", async () => {
		await apply({
			type: "extension_ui_request",
			id: "form-regression",
			method: "form",
			title: "Form",
			html: '<form><input name="requestSubmit" value="one"><input name="reportValidity" value="two"><input name="elements" value="three"></form>',
		});
		const dialog = chat.locator('[data-dialog-id="form-regression"]');
		await dialog.getByRole("button", { name: "Submit", exact: true }).click();
		await until(() => answers.some(m => m.response.id === "form-regression"));
		const answer = answers.find(m => m.response.id === "form-regression")!.response as any;
		assert(answer.data.requestSubmit === "one" && answer.data.elements === "three", "shadowed form values lost");
	});
	await step("Escape dismisses a choice before aborting the composer", async () => {
		await apply({ type: "extension_ui_request", id: "escape-regression", method: "confirm", title: "Dismiss me" });
		await composer.focus();
		await composer.press("Escape");
		await until(() => answers.some(m => m.response.id === "escape-regression"));
		assert((answers.find(m => m.response.id === "escape-regression")!.response as any).cancelled, "Escape did not dismiss");
	});
	await step("cancelled new-session command retains the transcript and dialogs", async () => {
		await composer.fill("");
		await apply({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Retain this transcript" }], timestamp: 1 } });
		await apply({ type: "extension_ui_request", id: "retain-dialog", method: "input", title: "Retain dialog" });
		cancelSession = true;
		await composer.fill("/new");
		await composer.press("Enter");
		await chat.getByText("New session was cancelled by an extension.", { exact: false }).waitFor();
		assert((await chat.getByText("Retain this transcript", { exact: true }).count()) === 1, "cancelled session cleared transcript");
		assert((await chat.locator('[data-dialog-id="retain-dialog"]').count()) === 1, "cancelled session cleared dialog");
		cancelSession = false;
	});
	await step("reconnect drops answered dialogs and reattaches terminal output", async () => {
		await page.evaluate(projectId => (window as any).__gyre.useApp.getState().addPane({ id: "terminal-pane", kind: "terminal", projectId }), registered.id);
		await until(() => ptyOpens === 1);
		socket.close();
		await until(() => ptyOpens >= 2);
		await page.waitForFunction(() => (window as any).__gyre.useChats.getState().chats.chat.pendingUi.length === 0);
		send({ t: "pty_data", ptyId: "terminal", data: "reconnected-output\r\n" });
		await page.getByText("reconnected-output", { exact: false }).waitFor();
	});
	await step("task cards handle missing subagents and inherited tool names", async () => {
		await apply({
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "task-call", name: "task", arguments: { tasks: [{ agent: "scout", description: "Fallback task description" }] } },
					{ type: "toolCall", id: "unknown", name: "constructor", arguments: {} },
				],
				timestamp: 2,
			},
		});
		await page.getByText("Fallback task description", { exact: true }).waitFor();
		assert(errors.length === 0, `render errors: ${errors.join("; ")}`);
	});
	await step("physical Option shortcuts work with non-Latin event.key", async () => {
		await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "µ", code: "KeyM", altKey: true, bubbles: true })));
		await page.getByTestId("kbd-mode").waitFor();
		await page.keyboard.press("Escape");
	});
	await step("phone layout exposes pane close and menu actions", async () => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.locator('button[aria-label="Close pane"]').waitFor();
		await page.screenshot({ path: join(scratch, "review-phone.png") });
		const closedSave = page.waitForResponse(response => response.request().method() === "PUT" && response.url().includes("/api/workspaces/") && response.ok());
		await page.locator('button[aria-label="Close pane"]').click();
		await page.waitForFunction(() => !(window as any).__gyre.useApp.getState().workspaces.some((ws: any) => ws.panes["terminal-pane"]));
		await page.setViewportSize({ width: 1440, height: 1000 });
		await page.screenshot({ path: join(scratch, "review-desktop.png") });
		await closedSave;
	});
	await step("lifecycle and nested progress identities merge into one cancelable subagent", async () => {
		await apply({ type: "subagent_lifecycle", payload: { id: "scout-native", parentToolCallId: "task-call", index: 0, agent: "scout", status: "running" } });
		await apply({
			type: "subagent_progress",
			payload: { parentToolCallId: "task-call", index: 0, agent: "scout", progress: { id: "scout-native", status: "running", description: "Native scout" } },
		});
		const keys = await page.evaluate(() => Object.keys((window as any).__gyre.useChats.getState().chats.chat.subagents));
		assert(keys.join(",") === "scout-native", `duplicate or composite subagent identities: ${keys}`);
	});
	await step("a stale workspace save reloads the remote layout and suppresses edits during resync", async () => {
		const previous = gateway.store.listWorkspaces().find(ws => ws.id === "review")!;
		gateway.store.saveWorkspace({ ...previous, name: "Remote layout" });
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		let requested = false;
		await page.route("**/api/workspaces", async route => {
			requested = true;
			await gate;
			await route.fulfill({ json: gateway.store.listWorkspaces() });
		});
		try {
			await page.evaluate(() => (window as any).__gyre.useApp.getState().renameWorkspace("review", "Stale local layout"));
			await until(() => requested);
			await page.evaluate(() => (window as any).__gyre.useApp.getState().renameWorkspace("review", "Edit during resync"));
			release();
			await page.waitForFunction(() => (window as any).__gyre.useApp.getState().workspaces.find((ws: any) => ws.id === "review")?.name === "Remote layout");
			// Negative contract: no stale debounced PUT may run after the resync.
			await Bun.sleep(600);
			assert(gateway.store.listWorkspaces().find(ws => ws.id === "review")?.name === "Remote layout", "resync allowed a stale queued write");
		} finally {
			release();
			await page.unroute("**/api/workspaces");
		}
	});
	await step("deleting a workspace cancels its pending save instead of recreating it", async () => {
		const removed = page.waitForResponse(response => response.request().method() === "DELETE" && response.url().includes("/api/workspaces/") && response.ok());
		const id = await page.evaluate(() => {
			const app = (window as any).__gyre.useApp.getState();
			app.createWorkspace("Temporary");
			const id = (window as any).__gyre.useApp.getState().activeWorkspaceId;
			app.renameWorkspace(id, "Pending save");
			app.deleteWorkspace(id);
			return id;
		});
		await removed;
		await Bun.sleep(600);
		assert(!gateway.store.listWorkspaces().some(ws => ws.id === id), "deleted workspace was recreated");
	});

	assert(errors.length === 0, errors.join("; "));
	console.log(`${passed} review browser checks passed. Artifacts: ${scratch}`);
} finally {
	await browser.close();
	await gateway.stop();
}
