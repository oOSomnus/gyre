/**
 * Global keyboard shortcuts and keyboard mode. Dialog Alt+digit handling lives
 * in DialogCard; jump-mark keys live in JumpMarks.
 */
import { type Direction, focusedChatId, openChatPane, paneIdsInOrder, useApp } from "../store/app";
import { closePaneAndResources, numberedPanes } from "../store/actions";

export const SHORTCUT_HELP: Array<{ title: string; keys: Array<[string, string]> }> = [
	{
		title: "Everywhere",
		keys: [
			["Alt X", "Command palette: global actions and omp commands (also Ctrl K)"],
			["Alt C", "Actions for the focused pane"],
			["Alt W", "Marks: label every link, table, image and button; type a label to act"],
			["Alt M", "Keyboard mode (pane management, below)"],
			["Ctrl M", "Model picker for the focused chat; again to switch between models and roles"],
			["Alt ← ↑ → ↓", "Move focus between panes"],
			["Alt Z", "Maximize / restore the focused pane"],
			["Alt R", "Review the focused chat's changes turn by turn"],
			["Ctrl Shift Enter", "New chat beside the focused pane"],
			["Alt Shift 1…9", "Switch workspace"],
			["Alt 1…9", "Answer the newest dialog in the focused chat"],
			["Esc", "Stop the agent (in the composer) · close overlays"],
			["Enter / Alt Enter", "While working: steer / queue a follow-up"],
		],
	},
	{
		title: "Keyboard mode (Alt M)",
		keys: [
			["W A S D", "Move focus up / left / down / right"],
			["Shift W A S D", "Swap the focused pane with its neighbour"],
			["Ctrl W A S D", "Resize: move the focused pane's edge"],
			["Q E", "Previous / next workspace"],
			["1…9", "Jump to the numbered pane"],
			["H", "Hide the focused pane"],
			["F", "Float / dock the focused pane"],
			["Z", "Maximize / restore"],
			["X", "Close the focused pane"],
			["N T", "New chat / new terminal"],
			["Esc", "Leave keyboard mode"],
		],
	},
];

function paneRects(): Array<{ id: string; rect: DOMRect }> {
	return [...document.querySelectorAll<HTMLElement>("[data-pane]")]
		.filter(el => !el.closest("[data-testid=hidden-bar]"))
		.map(el => ({ id: el.dataset.pane ?? "", rect: el.getBoundingClientRect() }));
}

/** The nearest pane in a direction (geometric, like a tiling WM). */
export function neighbour(dir: Direction): string | null {
	const current = useApp.getState().activeWorkspace()?.focusedPaneId;
	const rects = paneRects();
	const from = rects.find(r => r.id === current)?.rect;
	if (!from) return rects[0]?.id ?? null;
	const cx = from.left + from.width / 2;
	const cy = from.top + from.height / 2;
	let best: { id: string; score: number } | null = null;
	for (const { id, rect } of rects) {
		if (id === current) continue;
		const x = rect.left + rect.width / 2;
		const y = rect.top + rect.height / 2;
		const ok =
			(dir === "left" && rect.right <= from.left + 2) ||
			(dir === "right" && rect.left >= from.right - 2) ||
			(dir === "up" && rect.bottom <= from.top + 2) ||
			(dir === "down" && rect.top >= from.bottom - 2);
		if (!ok) continue;
		const primary = dir === "left" || dir === "right" ? Math.abs(x - cx) : Math.abs(y - cy);
		const secondary = dir === "left" || dir === "right" ? Math.abs(y - cy) : Math.abs(x - cx);
		const score = primary + secondary * 2;
		if (!best || score < best.score) best = { id, score };
	}
	return best?.id ?? null;
}

function moveFocus(dir: Direction) {
	const id = neighbour(dir);
	if (id) useApp.getState().focusPane(id);
}

const WASD: Record<string, Direction> = { w: "up", a: "left", s: "down", d: "right" };

function newPane(kind: "chat" | "terminal") {
	const app = useApp.getState();
	const ws = app.activeWorkspace();
	const focused = ws?.focusedPaneId ? ws.panes[ws.focusedPaneId] : undefined;
	app.addPane({ kind, projectId: focused?.projectId ?? app.projects[0]?.id });
}

function handleKbdMode(event: KeyboardEvent): boolean {
	const app = useApp.getState();
	const ws = app.activeWorkspace();
	const focused = ws?.focusedPaneId;
	const key = event.key.toLowerCase();
	const isKey = (letter: string) => key === letter || event.code === `Key${letter.toUpperCase()}`;
	const physical = event.code.startsWith("Key") ? event.code.slice(3).toLowerCase() : "";
	const dir = WASD[key] ?? WASD[physical];
	if (key === "escape" || key === "enter" || (event.altKey && isKey("m"))) {
		app.setKbdMode(false);
		return true;
	}
	if (event.altKey || event.metaKey) return false;
	if (dir) {
		if (event.ctrlKey && focused) app.resizePane(focused, dir);
		else if (event.shiftKey && focused) {
			const other = neighbour(dir);
			if (other && paneIdsInOrder(ws?.layout ?? null).includes(other)) app.swapPanes(focused, other);
		} else moveFocus(dir);
		return true;
	}
	if (event.ctrlKey) return false;
	if (/^[1-9]$/.test(key)) {
		const id = numberedPanes(ws)[Number(key) - 1];
		if (id) app.focusPane(id);
		return true;
	}
	switch (/^[a-z]$/.test(key) ? key : physical || key) {
		case "q":
			app.cycleWorkspace(-1);
			return true;
		case "e":
			app.cycleWorkspace(1);
			return true;
		case "h":
			if (focused) app.hidePane(focused);
			return true;
		case "f":
			if (focused) ws?.floating?.[focused] ? app.dockPane(focused) : app.floatPane(focused);
			return true;
		case "z":
			if (focused) app.toggleMaximize(focused);
			return true;
		case "x": {
			const pane = focused ? ws?.panes[focused] : undefined;
			if (pane) closePaneAndResources(pane);
			return true;
		}
		case "n":
			newPane("chat");
			return true;
		case "t":
			newPane("terminal");
			return true;
	}
	// Swallow other printable keys so they don't type into the focused composer.
	return key.length === 1;
}

export function installShortcuts(): () => void {
	const onKey = (event: KeyboardEvent) => {
		const app = useApp.getState();
		if (app.jumpMode) return;
		const stop = () => {
			event.preventDefault();
			event.stopPropagation();
		};
		if (app.kbdMode) {
			if (handleKbdMode(event)) stop();
			return;
		}
		const key = event.key.toLowerCase();
		const isKey = (letter: string) => key === letter || event.code === `Key${letter.toUpperCase()}`;
		if (event.getModifierState("AltGraph") || (event.ctrlKey && event.altKey)) return;
		const mod = (event.ctrlKey || event.metaKey) && !event.altKey;

		if ((mod && !event.shiftKey && isKey("k")) || (event.altKey && !mod && !event.shiftKey && isKey("x"))) {
			stop();
			app.paletteOpen ? app.closePalette() : app.openPalette("", "global");
			return;
		}
		if (event.altKey && !mod && !event.shiftKey && isKey("c")) {
			stop();
			app.paletteOpen ? app.closePalette() : app.openPalette("", "pane");
			return;
		}
		if (mod && !event.shiftKey && isKey("m")) {
			if (app.modelPickerChatId) {
				// Already open: switch between the model view and the role view.
				stop();
				app.setModelPickerView(app.modelPickerView === "models" ? "roles" : "models");
				return;
			}
			const chatId = focusedChatId();
			if (chatId) {
				stop();
				app.openModelPicker(chatId);
			}
			return;
		}
		if (event.altKey && !mod && (isKey("w") || isKey("j"))) {
			stop();
			app.setJumpMode(true);
			return;
		}
		if (event.altKey && !mod && !event.shiftKey && isKey("m")) {
			stop();
			app.setKbdMode(true);
			return;
		}
		if (event.altKey && !mod && key.startsWith("arrow")) {
			stop();
			moveFocus(key.slice(5) as Direction);
			return;
		}
		if (event.altKey && !mod && !event.shiftKey && isKey("r")) {
			const chatId = focusedChatId();
			if (chatId) {
				stop();
				openChatPane("review", chatId);
			}
			return;
		}
		if (event.altKey && !mod && isKey("z")) {
			const id = app.activeWorkspace()?.focusedPaneId;
			if (id) {
				stop();
				app.toggleMaximize(id);
			}
			return;
		}
		if (mod && event.shiftKey && key === "enter") {
			stop();
			newPane("chat");
			return;
		}
		if (event.altKey && event.shiftKey && /^digit[1-9]$/.test(event.code.toLowerCase())) {
			const ws = app.workspaces[Number(event.code.slice(5)) - 1];
			if (ws) {
				stop();
				app.switchWorkspace(ws.id);
			}
		}
	};
	// Capture phase so app shortcuts win over focused widgets (xterm, Monaco).
	window.addEventListener("keydown", onKey, true);
	return () => window.removeEventListener("keydown", onKey, true);
}

export { paneIdsInOrder };
