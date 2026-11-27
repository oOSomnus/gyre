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
	let holdHistory = false;
	let heldHistory: { reqId: string } | undefined;
	let holdModels = false;
	let heldModels: { reqId: string } | undefined;
	const closedPtyKeys: string[] = [];
	const closedChats: string[] = [];
	const subagentLevels: string[] = [];
	const send = (message: ServerMessage) => socket.send(JSON.stringify(message));
	const info = (chatId = "chat") => ({ chatId, projectId: registered.id, cwd: project, status: "ready" as const, generation: "one", sessionPath: currentSession });
	const result = (message: { reqId: string }, data: unknown) => send({ t: "result", reqId: message.reqId, ok: true, data });
	await page.routeWebSocket("**/ws", route => {
		socket = route;
		route.onMessage(raw => {
			const message = JSON.parse(String(raw)) as ClientMessage;
			if (message.t === "hello") send({ t: "welcome", version: "0.2.0", ompVersion: "19.1.0" });
			if (message.t === "subscribe") send({ t: "chat_replay", chat: info(message.chatId) });
			if (message.t === "open_chat") {
				send({ t: "chat_replay", chat: info(message.chatId) });
				result(message, info(message.chatId));
			}
			if (message.t === "close_chat") closedChats.push(message.chatId);
			if (message.t === "ui_response") answers.push(message);
			if (message.t === "pty_close_key") closedPtyKeys.push(message.key);
			if (message.t === "pty_open") {
				ptyOpens++;
				result(message, { ptyId: "terminal", attachmentId: message.reqId, reused: ptyOpens > 1 });
			}
			if (message.t !== "rpc") return;
			switch (message.command.type) {
				case "get_state":
					result(message, { sessionFile: currentSession, isSettled: true, isStreaming: false });
					break;
				case "get_messages":
					if (holdHistory) { heldHistory = message; break; }
					result(message, { messages: [] });
					break;
				case "get_model_picker":
					if (holdModels) { heldModels = message; break; }
					result(message, { rows: [{ provider: "test", id: "model-a", name: "Model A" }] });
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
				case "set_subagent_subscription":
					subagentLevels.push(String(message.command.level));
					result(message, { level: message.command.level });
					break;
				case "get_subagent_messages":
					result(message, {
						nextByte: 10,
						reset: false,
						messages: message.command.fromByte ? [] : [{ role: "user", content: "Find the auth entry point", timestamp: 1 }],
					});
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
	/**
	 * Arm a one-shot observer for the next fetch matching `urlPart` and `method`.
	 * `processed()` then resolves only after the app has read that response's body
	 * (the app's `api()` reads with `response.json()`), its continuations have run,
	 * and two frames have rendered: proof the client handled it, not just that the
	 * route was fulfilled.
	 */
	const armProcessed = (urlPart: string, method: string) =>
		page.evaluate(
			([urlPart, method]) => {
				const w = window as any;
				const original = window.fetch;
				w.__processed = new Promise<void>(resolve => {
					window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
						const response = await original(input, init);
						const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
						const verb = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
						if (!url.includes(urlPart) || verb !== method) return response;
						window.fetch = original;
						const json = response.json.bind(response);
						response.json = async () => {
							try {
								return await json();
							} finally {
								setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
							}
						};
						return response;
					};
				});
			},
			[urlPart, method] as const,
		);
	const processed = () => page.evaluate(() => (window as any).__processed as Promise<void>);
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
	await step("sibling subagents without indexes retain their independent identities", async () => {
		for (const id of ["one", "two"]) await apply({ type: "subagent_lifecycle", payload: { id, parentToolCallId: "same-parent", status: "running" } });
		const keys = await page.evaluate(() => Object.keys((window as any).__gyre.useChats.getState().chats.chat.subagents));
		assert(keys.includes("one") && keys.includes("two"), "unindexed sibling subagent was removed");
	});
	await step("a sub-agent pane streams its messages and tool calls live, like a chat", async () => {
		const subEvent = (event: Record<string, unknown>) => send({ t: "frame", chatId: "chat", frame: { type: "subagent_event", payload: { id: "scout-native", event } } });
		await page.evaluate(() =>
			(window as any).__gyre.useApp.getState().addPane({ id: "sub-pane", kind: "subagent", chatId: "chat", ref: "scout-native", subagentId: "scout-native" }),
		);
		const pane = page.locator('[data-pane="sub-pane"]');
		await pane.getByText("Find the auth entry point").waitFor();
		const level = async (want: string) => {
			for (let i = 0; i < 100 && subagentLevels.at(-1) !== want; i++) await Bun.sleep(20);
		};
		await level("events");
		assert(subagentLevels.at(-1) === "events", `sub-agent pane did not subscribe to events: ${subagentLevels}`);
		const call = { type: "toolCall", id: "sub-call", name: "grep", arguments: { pattern: "login" } };
		subEvent({ type: "agent_start" });
		subEvent({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "Searching for" }] } });
		subEvent({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Searching for login handlers" }] } });
		await pane.getByText("Searching for login handlers").waitFor();
		subEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Searching for login handlers" }, call], timestamp: 2 } });
		subEvent({ type: "tool_execution_start", toolCallId: "sub-call", toolName: "grep", args: call.arguments });
		await pane.locator(".gy-card.tool").first().waitFor();
		assert(await pane.locator(".gy-card.tool .animate-spin").count(), "running sub-agent tool card shows no spinner");
		await pane.screenshot({ path: join(scratch, "review-subagent.png") });
		subEvent({ type: "tool_execution_end", toolCallId: "sub-call", toolName: "grep", result: { content: [{ type: "text", text: "src/auth.ts:42" }] } });
		await page.waitForFunction(() => !document.querySelector('[data-pane="sub-pane"] .gy-card.tool .animate-spin'));
		const leaked = await page.evaluate(() => (window as any).__gyre.useChats.getState().chats.chat.frames.some((f: any) => f.frame.type === "subagent_event"));
		assert(!leaked, "sub-agent events landed in the chat's frame log");
		await page.evaluate(() => (window as any).__gyre.useApp.getState().closePane("sub-pane"));
		await page.waitForFunction(() => !document.querySelector('[data-pane="sub-pane"]'));
		await level("progress");
		assert(subagentLevels.at(-1) === "progress", `closing the last sub-agent pane kept events on: ${subagentLevels}`);
	});
	await step("streaming chat frames preserve focus inside extension forms", async () => {
		await apply({ type: "extension_ui_request", id: "focus-form", method: "form", html: '<form><input name="answer"></form>' });
		const input = chat.locator('[data-dialog-id="focus-form"] input[name="answer"]');
		await input.fill("keep typing");
		await input.focus();
		await apply({ type: "notice", level: "info", message: "background update" });
		assert(await input.evaluate(el => el === document.activeElement), "chat update blurred the form");
	});
	await step("Escape closes a palette without cancelling a pending chat confirmation", async () => {
		await apply({ type: "extension_ui_request", id: "modal-confirm", method: "confirm", title: "Still pending" });
		await page.evaluate(() => { const app = (window as any).__gyre.useApp.getState(); app.focusPane("chat"); app.openPalette("", "global"); });
		await page.getByRole("dialog").waitFor();
		await page.keyboard.press("Escape");
		await page.getByRole("dialog").waitFor({ state: "hidden" });
		assert(!answers.some(m => m.response.id === "modal-confirm"), "palette Escape cancelled confirmation");
	});
	await step("remote Markdown images require an explicit navigation", async () => {
		const requests: string[] = [];
		page.on("request", req => { if (req.url().includes("remote-image.invalid")) requests.push(req.url()); });
		await apply({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "![Private image](https://remote-image.invalid/pixel?data=private)" }] } });
		await chat.getByRole("link", { name: "Open image: Private image" }).waitFor();
		assert(await chat.locator('img[src*="remote-image.invalid"]').count() === 0, "remote image auto-rendered");
		assert(requests.length === 0, "remote image triggered a request");
	});
	await step("a Mermaid block recovers after an incomplete streamed diagram", async () => {
		await apply({ type: "message_update", messageId: "streamed-mermaid", message: { role: "assistant", content: [{ type: "text", text: "```mermaid\ngraph TD; A-->\n```" }] } });
		const block = chat.locator(".gy-code").filter({ hasText: "diagram" }).last();
		await block.locator("pre").waitFor();
		await apply({ type: "message_end", messageId: "streamed-mermaid", message: { role: "assistant", content: [{ type: "text", text: "```mermaid\ngraph TD; A-->B\n```" }] } });
		await block.locator("svg").waitFor();
		assert(await block.locator("pre").count() === 0, "stale Mermaid error remained");
	});
	await step("table copy actions remain focusable without hover", async () => {
		await apply({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "| Column |\n|---|\n| Value |" }] } });
		const button = chat.locator('button[data-jump="copy-md"]').last();
		await button.focus();
		assert(await button.evaluate(el => el === document.activeElement && getComputedStyle(el.parentElement!).opacity === "1"), "table copy unavailable from keyboard focus");
	});
	await step("AltGraph text entry does not open the model picker", async () => {
		const consumed = await page.evaluate(() => !window.dispatchEvent(new KeyboardEvent("keydown", { key: "µ", code: "KeyM", ctrlKey: true, altKey: true, bubbles: true, cancelable: true })));
		assert(!consumed, "AltGraph key was prevented");
		assert(await page.getByRole("dialog").count() === 0, "AltGraph opened a modal");
	});
	await step("model results disappear as soon as their query changes", async () => {
		await page.evaluate(() => (window as any).__gyre.useApp.getState().openModelPicker("chat"));
		await page.getByRole("option", { name: /Model A/ }).waitFor();
		holdModels = true;
		await page.getByPlaceholder("Search models · provider/ to filter · @ for roles").fill("different");
		assert(await page.getByRole("option", { name: /Model A/ }).count() === 0, "old-query row remains selectable");
		await until(() => Boolean(heldModels));
		result(heldModels!, { rows: [] });
		holdModels = false;
		await page.keyboard.press("Escape");
	});
	await step("delayed history cannot restore messages after a successful new session", async () => {
		holdHistory = true;
		heldHistory = undefined;
		send({ t: "chat_replay", chat: info() });
		await until(() => Boolean(heldHistory));
		await composer.fill("/new");
		await composer.press("Enter");
		await page.waitForFunction(() => (window as any).__gyre.useChats.getState().chats.chat.items.every((i: any) => i.kind !== "message"));
		result(heldHistory!, { messages: [{ role: "assistant", content: [{ type: "text", text: "obsolete history" }] }] });
		holdHistory = false;
		await page.waitForTimeout(80);
		assert(await chat.getByText("obsolete history", { exact: true }).count() === 0, "old history restored after session change");
	});
	await step("editor injection is consumed once across mobile remounts", async () => {
		await apply({ type: "extension_ui_request", method: "set_editor_text", text: "one-time injection" });
		await page.waitForFunction(() => !(window as any).__gyre.useChats.getState().chats.chat.editorInject);
		assert(await composer.inputValue() === "one-time injection", "new injection not applied");
		await page.setViewportSize({ width: 390, height: 844 });
		await page.evaluate(() => (window as any).__gyre.useApp.getState().addPane({ id: "injection-settings", kind: "settings" }));
		await page.locator('[data-pane="injection-settings"]').waitFor();
		await page.evaluate(() => (window as any).__gyre.useApp.getState().focusPane("chat"));
		await composer.waitFor();
		assert(await composer.inputValue() === "", "consumed injection reappeared");
		await page.evaluate(() => (window as any).__gyre.useApp.getState().closePane("injection-settings"));
		await page.setViewportSize({ width: 1440, height: 1000 });
	});
	await step("failed preference saves recover and decisions include the displayed revision", async () => {
		let failLoad = true;
		let puts = 0;
		await page.route("**/api/chats/chat/plan-prefs", route => {
			if (route.request().method() === "GET" && failLoad) return route.fulfill({ status: 503, json: { error: "prefs offline" } });
			if (route.request().method() === "PUT" && ++puts === 1) return route.fulfill({ status: 503, json: { error: "save offline" } });
			return route.fulfill({ json: { role: "default", context: "keep" } });
		});
		await apply({ type: "extension_ui_request", method: "setWidget", widgetKey: "gyre.plan", widgetLines: [JSON.stringify({ phase: "reviewing", revision: 7, planContent: "# Reviewed plan", updatedAt: 1 })] });
		await page.getByRole("button", { name: "Retry preferences" }).waitFor();
		failLoad = false;
		await page.getByRole("button", { name: "Retry preferences" }).click();
		await page.getByTestId("plan-role").selectOption("slow");
		await page.getByText("save offline", { exact: true }).waitFor();
		await page.getByTestId("plan-approve").click();
		await until(() => prompts.some(m => String(m.command.message).includes('"revision":7')));
		assert(puts === 2, "failed preference save blocked a later action");
		await page.unroute("**/api/chats/chat/plan-prefs");
		await page.evaluate(() => { const app = (window as any).__gyre.useApp.getState(); for (const pane of Object.values(app.activeWorkspace().panes) as any[]) if (pane.kind === "plan") app.closePane(pane.id); });
	});
	const otherProject = gateway.store.addProject("Other project", scratch);
	await page.evaluate(projects => (window as any).__gyre.useApp.setState({ projects }), gateway.store.listProjects());
	await step("MCP project switches discard obsolete rows and edit forms", async () => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		let waiting = false;
		let hold = true;
		await page.route("**/api/mcp?**", async route => {
			const projectId = new URL(route.request().url()).searchParams.get("projectId");
			if (projectId === registered.id && hold) { waiting = true; await gate; }
			await route.fulfill({ json: [{ name: projectId === registered.id ? "server-A" : "server-B", scope: "project", enabled: true, config: { command: "example" } }] });
		});
		await armProcessed(`projectId=${registered.id}`, "GET");
		await page.evaluate(() => (window as any).__gyre.useApp.getState().addPane({ id: "mcp-review", kind: "settings", section: "mcp" }));
		const pane = page.locator('[data-pane="mcp-review"]');
		await until(() => waiting);
		await pane.locator("select").first().selectOption(otherProject.id);
		await pane.locator('[data-mcp="server-B"]').waitFor();
		release();
		await processed();
		hold = false;
		assert(await pane.locator('[data-mcp="server-A"]').count() === 0, "late A rows replaced B");
		await pane.locator("select").first().selectOption(registered.id);
		await pane.locator('[data-mcp="server-A"]').getByRole("button", { name: "Edit", exact: true }).click();
		await pane.getByTestId("mcp-name").waitFor();
		await pane.locator("select").first().selectOption(otherProject.id);
		await pane.locator('[data-mcp="server-B"]').waitFor();
		assert(await pane.getByTestId("mcp-name").count() === 0, "A form survived project switch");
		await page.evaluate(() => (window as any).__gyre.useApp.getState().closePane("mcp-review"));
		await page.unroute("**/api/mcp?**");
	});
	await step("new project agent drafts restore only in their owning project", async () => {
		gateway.store.setKv("ui.agentDrafts", {});
		await page.route("**/api/agents?**", route => route.fulfill({ json: [] }));
		await page.evaluate(projectId => (window as any).__gyre.useApp.getState().addPane({ id: "studio-review", kind: "studio", projectId }), registered.id);
		const pane = page.locator('[data-pane="studio-review"]');
		await pane.getByRole("button", { name: "New agent", exact: true }).last().click();
		await pane.getByTestId("agent-name").fill("draft-only-A");
		await pane.getByTestId("agent-description").fill("A's unsent draft");
		await pane.locator('select').filter({ has: page.locator('option[value="project"]') }).selectOption("project");
		await pane.getByRole("button", { name: "Save draft" }).click();
		await pane.getByText("Draft saved (not yet visible to omp).").waitFor();
		await pane.locator("select").first().selectOption(otherProject.id);
		await pane.getByRole("button", { name: "New agent", exact: true }).last().click();
		assert(await pane.getByTestId("agent-name").inputValue() === "", "A project draft restored into B");
		await pane.locator("select").first().selectOption(registered.id);
		await pane.getByRole("button", { name: "New agent", exact: true }).last().click();
		await page.waitForFunction(() => (document.querySelector('[data-testid="agent-name"]') as HTMLInputElement)?.value === "draft-only-A");
		await page.evaluate(() => (window as any).__gyre.useApp.getState().closePane("studio-review"));
		await page.unroute("**/api/agents?**");
	});
	await step("published agent identity survives cleanup failure and retry does not republish", async () => {
		let agentWrites = 0;
		let failCleanup = true;
		await page.route("**/api/agents**", route => {
			if (route.request().method() === "PUT") { agentWrites++; return route.fulfill({ json: { name: "published", scope: "project" } }); }
			return route.fulfill({ json: [] });
		});
		await page.route("**/api/kv/ui.agentDrafts", route => {
			if (route.request().method() === "PUT" && failCleanup) { failCleanup = false; return route.fulfill({ status: 503, json: { error: "draft store unavailable" } }); }
			return route.continue();
		});
		// A saved draft, so publishing has something to clean up (and the injected failure is reached).
		gateway.store.setKv("ui.agentDrafts", {
			"new:user": { name: "published", description: "New agent", scope: "user", model: "", thinking: "", tools: null, spawns: "", instructions: "", savedAt: 1 },
		});
		await page.evaluate(projectId => (window as any).__gyre.useApp.getState().addPane({ id: "publish-review", kind: "studio", projectId }), otherProject.id);
		const pane = page.locator('[data-pane="publish-review"]');
		await pane.getByRole("button", { name: "New agent", exact: true }).last().click();
		await pane.getByTestId("agent-name").fill("published");
		await pane.getByTestId("agent-description").fill("New agent");
		await pane.getByTestId("publish-agent").click();
		await pane.getByText("Published; draft cleanup failed:", { exact: false }).waitFor();
		await pane.locator(".gy-section").filter({ hasText: "Edit published" }).first().waitFor();
		assert(await pane.getByTestId("publish-agent").isDisabled(), "failed cleanup invites a duplicate publication");
		await pane.getByRole("button", { name: "Retry draft cleanup" }).click();
		await pane.getByText("Published; draft cleanup completed.").waitFor();
		assert(agentWrites === 1, "cleanup retry rewrote the agent file");
		await page.evaluate(() => (window as any).__gyre.useApp.getState().closePane("publish-review"));
		await page.unroute("**/api/agents**");
		await page.unroute("**/api/kv/ui.agentDrafts");
	});
	await step("late publication cleanup cannot replace another project's agent list", async () => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		let waiting = false;
		await page.route("**/api/agents**", route => {
			if (route.request().method() === "PUT") return route.fulfill({ json: {} });
			const projectId = new URL(route.request().url()).searchParams.get("projectId");
			const name = projectId === registered.id ? "agent-A" : "agent-B";
			return route.fulfill({ json: [{ name, scope: "project", frontmatter: { description: name }, instructions: "prompt" }] });
		});
		await page.route("**/api/kv/ui.agentDrafts", async route => {
			if (route.request().method() === "PUT") { waiting = true; await gate; await route.fulfill({ json: {} }); return; }
			return route.continue();
		});
		// agent-A has a saved draft, so its publication ends with a (gated) cleanup write.
		gateway.store.setKv("ui.agentDrafts", {
			[`project:${registered.id}:agent-A`]: {
				name: "agent-A",
				description: "agent-A",
				scope: "project",
				model: "",
				thinking: "",
				tools: null,
				spawns: "",
				instructions: "prompt",
				previousName: "agent-A",
				savedAt: 1,
			},
		});
		await page.evaluate(projectId => (window as any).__gyre.useApp.getState().addPane({ id: "late-publish", kind: "studio", projectId }), registered.id);
		const pane = page.locator('[data-pane="late-publish"]');
		await pane.getByRole("button", { name: "agent-A", exact: false }).click();
		await armProcessed("/api/kv/ui.agentDrafts", "PUT");
		await pane.getByTestId("publish-agent").click();
		await until(() => waiting);
		await pane.locator("select").first().selectOption(otherProject.id);
		await pane.getByRole("button", { name: "agent-B", exact: false }).click();
		release();
		await processed();
		await pane.locator(".gy-section").filter({ hasText: "Edit agent-B" }).first().waitFor();
		assert(await pane.getByTestId("agent-name").inputValue() === "agent-B", "A publish changed B editor identity");
		assert(await pane.getByRole("button", { name: "agent-A", exact: false }).count() === 0, "A publish replaced B's list");
		await page.evaluate(() => (window as any).__gyre.useApp.getState().closePane("late-publish"));
		await page.unroute("**/api/agents**");
		await page.unroute("**/api/kv/ui.agentDrafts");
	});
	await step("closing an inactive workspace's pane removes it from the owning workspace", async () => {
		const removed = await page.evaluate(() => {
			const app = (window as any).__gyre.useApp.getState();
			app.addPane({ id: "failed-fork", kind: "message" });
			app.createWorkspace("Other workspace");
			const other = (window as any).__gyre.useApp.getState().activeWorkspaceId;
			app.closePane("failed-fork");
			const removed = !(window as any).__gyre.useApp.getState().workspaces.find((ws: any) => ws.id === "review").panes["failed-fork"];
			app.switchWorkspace("review");
			app.deleteWorkspace(other);
			return removed;
		});
		assert(removed, "pane survived in its inactive owner");
	});
	await step("tool-only graph lanes and hidden assistant rows never overlap", async () => {
		await page.evaluate(() => (window as any).__gyre.useChats.getState().patch("chat", { items: [], toolResults: {}, subagents: {} }));
		for (let i = 0; i < 2; i++) await apply({ type: "message_end", message: { role: "assistant", content: [
			...(i ? [{ type: "text", text: "Assistant reply" }] : []),
			{ type: "toolCall", id: `graph-${i}-one`, name: "read", arguments: {} },
			{ type: "toolCall", id: `graph-${i}-two`, name: "read", arguments: {} },
		] } });
		await page.evaluate(() => (window as any).__gyre.useApp.getState().addPane({ id: "graph-review", kind: "graph", chatId: "chat" }));
		const pane = page.locator('[data-pane="graph-review"]');
		await pane.locator('.react-flow__node[data-id="tgraph-0-one"]').waitFor();
		await pane.getByRole("button", { name: "Assistant", exact: true }).click();
		await page.waitForTimeout(80);
		const positions = await pane.locator('.react-flow__node[data-id^="tgraph-"]').evaluateAll(nodes => nodes.map(n => (n as HTMLElement).style.transform));
		assert(positions.length === 4 && new Set(positions).size === 4, `overlapping tool lanes: ${positions}`);
		await page.evaluate(() => (window as any).__gyre.useApp.getState().closePane("graph-review"));
	});
	await step("conflict reload closes terminal resources removed by the saved layout", async () => {
		await page.evaluate(projectId => (window as any).__gyre.useApp.getState().addPane({ id: "removed-terminal", kind: "terminal", projectId }), registered.id);
		await page.locator('[data-pane="removed-terminal"]').waitFor();
		// Let the local pane save, then replace that layout in another client.
		await until(() => Boolean(gateway.store.listWorkspaces().find(ws => ws.id === "review")?.panes["removed-terminal"]));
		const previous = gateway.store.listWorkspaces().find(ws => ws.id === "review")!;
		gateway.store.saveWorkspace({ ...previous, panes: { chat: previous.panes.chat! }, layout: { type: "pane", paneId: "chat" }, focusedPaneId: "chat", hidden: [], floating: {} });
		await page.evaluate(() => (window as any).__gyre.useApp.getState().renameWorkspace("review", "Conflict test"));
		await until(() => closedPtyKeys.includes("removed-terminal"));
		await page.waitForFunction(() => !(window as any).__gyre.useApp.getState().workspaces.find((ws: any) => ws.id === "review")?.panes["removed-terminal"]);
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
	await step("a closed chat stays closed and stops counting as needing you", async () => {
		const badge = () => page.locator('[data-jump="needs-you"] .gy-badge').textContent();
		const before = Number(await badge());
		await page.evaluate(projectId => (window as any).__gyre.useApp.getState().addPane({ id: "closing-chat", kind: "chat", projectId }), registered.id);
		await page.waitForFunction(() => (window as any).__gyre.useChats.getState().chats["closing-chat"]?.info.status === "ready");
		const dialog = (id: string) => ({ t: "frame", chatId: "closing-chat", frame: { type: "extension_ui_request", id, method: "confirm", title: "Still there?", message: "" } }) as const;
		send(dialog("closing-dialog"));
		await page.waitForFunction(n => document.querySelector('[data-jump="needs-you"] .gy-badge')?.textContent === String(n), before + 1);
		await page.locator('[data-pane="closing-chat"] [data-jump="close"]').click();
		await until(() => closedChats.includes("closing-chat"));
		// What the gateway sends after close_chat stops omp: the exit broadcast, and a straggling frame.
		send({ t: "chat", chat: { ...info("closing-chat"), status: "exited" } });
		send(dialog("late-dialog"));
		await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 150)));
		assert(!(await page.evaluate(() => "closing-chat" in (window as any).__gyre.useChats.getState().chats)), "a closed chat was brought back by a late message");
		assert(Number(await badge()) === before, "a closed chat still counts as needing you");
	});

	assert(errors.length === 0, errors.join("; "));
	console.log(`${passed} review browser checks passed. Artifacts: ${scratch}`);
} finally {
	await browser.close();
	await gateway.stop();
}
