/**
 * Cross-pane actions and the in-memory registries they share (not persisted):
 * pane lifecycle, composing into a chat from elsewhere, and transcript actions
 * (view, review, fork, open image/file).
 */
import type { PaneSpec, Workspace } from "@gyre/protocol";
import type { Terminal } from "@xterm/xterm";
import { gateway } from "../lib/gateway";
import type { AgentMessage } from "../lib/omp";
import { textOf } from "../lib/omp";
import { openChatPane, paneIdsInOrder, useApp } from "./app";
import { attachChat, closeChat } from "./chat-lifecycle";
import { loadHistory, resetTranscript, useChats } from "./chats";

// ---------------------------------------------------------------- registries

export const terminalCloser = new Map<string, () => void>();
/** Live terminals by pane id, so actions can read the selection. */
export const terminals = new Map<string, Terminal>();
/** Images opened in image panes, by ref. Data URLs are too big to persist in workspaces. */
export const images = new Map<string, { src: string; name?: string }>();
/** Panes holding unsaved edits (pane id -> what is unsaved), checked before closing them. */
export const unsavedPanes = new Map<string, string>();
/** Message snapshots opened in message panes ("view" / "review"), by ref. */
export const snapshots = new Map<string, { text: string; role: string; model?: string; timestamp?: number }>();

// ---------------------------------------------------------------- pane lifecycle

export function closePaneResources(pane: PaneSpec): void {
	if (pane.kind === "chat") closeChat(pane.id);
	if (pane.kind === "terminal") {
		terminalCloser.get(pane.id)?.();
		if (pane.projectId) gateway.send({ t: "pty_close_key", key: pane.id, projectId: pane.projectId });
		terminalCloser.delete(pane.id);
	}
}

export function closePaneAndResources(pane: PaneSpec): void {
	const unsaved = unsavedPanes.get(pane.id);
	if (unsaved && !confirm(`${unsaved} has unsaved changes. Close it and discard them?`)) return;
	unsavedPanes.delete(pane.id);
	closePaneResources(pane);
	useApp.getState().closePane(pane.id);
}

/** Order used by keyboard-mode numbers: docked panes in layout order, then floating. */
export function numberedPanes(ws: Workspace | null | undefined): string[] {
	if (!ws) return [];
	return [
		...paneIdsInOrder(ws.layout),
		...Object.entries(ws.floating ?? {})
			.sort((a, b) => a[1].z - b[1].z)
			.map(([id]) => id),
	];
}

// ---------------------------------------------------------------- composing into a chat

export function targetChatPane(projectId?: string): string | null {
	const ws = useApp.getState().activeWorkspace();
	if (!ws) return null;
	const focused = ws.focusedPaneId ? ws.panes[ws.focusedPaneId] : undefined;
	if (focused?.kind === "chat") return focused.id;
	if (focused?.chatId) return focused.chatId;
	const chats = Object.values(ws.panes).filter(p => p.kind === "chat");
	const recent = (ids: typeof chats) => ids.sort((a, b) => (ws.lastFocus?.[b.id] ?? 0) - (ws.lastFocus?.[a.id] ?? 0))[0];
	return (recent(chats.filter(p => p.projectId === projectId)) ?? recent(chats))?.id ?? null;
}

/** Insert text into a chat's composer and focus that chat (does not send). */
export function sendToChat(text: string, projectId?: string): boolean {
	const chatId = targetChatPane(projectId);
	if (!chatId) return false;
	const chat = useChats.getState().chats[chatId];
	if (!chat) return false;
	useChats.getState().patch(chatId, { editorInject: { text, nonce: Date.now(), append: true } });
	useApp.getState().revealPane(chatId);
	return true;
}

// ---------------------------------------------------------------- transcript actions

export function viewMessage(chatId: string, message: AgentMessage, mode: "view" | "review" = "view"): void {
	const ref = `m${message.timestamp ?? Date.now()}-${message.role}`;
	snapshots.set(ref, { text: textOf(message.content), role: message.role, model: message.model, timestamp: message.timestamp });
	openChatPane("message", chatId, { ref, section: mode });
}

/** Send an edited version of an assistant reply back to the agent. */
export async function sendReview(chatId: string, original: string, revised: string): Promise<void> {
	const message = `I reviewed and edited your previous reply. Treat my version as authoritative and continue from it.\n\n<original>\n${original}\n</original>\n\n<revised>\n${revised}\n</revised>`;
	const busy = useChats.getState().chats[chatId]?.busy;
	await gateway.rpc(chatId, busy ? { type: "prompt", message, streamingBehavior: "followUp" } : { type: "prompt", message });
}

interface Entry {
	type: string;
	id: string;
	message?: AgentMessage;
}

/** Fork the conversation at `message` into a new chat pane (the original chat is untouched). */
export async function forkAtMessage(chatId: string, message: AgentMessage): Promise<void> {
	const app = useApp.getState();
	const chat = useChats.getState().chats[chatId];
	const sessionPath = chat?.info.sessionPath;
	if (!chat || !sessionPath) throw new Error("This chat has no saved session to fork");
	const { entries } = await gateway.rpc<{ entries: Entry[] }>(chatId, { type: "get_entries" }, 60_000);
	const entry = [...entries].reverse().find(e => e.type === "message" && e.message?.role === message.role && e.message?.timestamp === message.timestamp);
	if (!entry) throw new Error("Could not find this message in the session history");
	const source = app.workspaces.flatMap(ws => Object.values(ws.panes)).find(p => p.id === chatId);
	const paneId = app.addPane({ kind: "chat", projectId: source?.projectId, sessionPath, title: undefined }, { nextTo: chatId, direction: "row" });
	try {
		// Shares the open with the new pane's own attach.
		await attachChat({ chatId: paneId, projectId: source?.projectId ?? chat.info.projectId, sessionPath });
		await gateway.rpc(paneId, { type: "fork", entryId: entry.id }, 120_000);
		resetTranscript(paneId);
		await loadHistory(paneId);
		const state = await gateway.rpc<{ sessionFile?: string }>(paneId, { type: "get_state" });
		if (state.sessionFile) useApp.getState().updatePane(paneId, { sessionPath: state.sessionFile });
	} catch (error) {
		closePaneAndResources({ id: paneId, kind: "chat" });
		throw error;
	}
}

/** Show an image at actual size in its own pane. */
export function openImage(chatId: string | undefined, src: string, name?: string): void {
	const ref = `img${Date.now()}`;
	images.set(ref, { src, name });
	if (chatId) openChatPane("image", chatId, { ref, title: name });
	else useApp.getState().addPane({ kind: "image", ref, title: name });
}

/** Open a project file in a file pane next to the chat. */
export function openFile(projectId: string | undefined, path: string): void {
	const app = useApp.getState();
	if (!projectId) return;
	const existing = Object.values(app.activeWorkspace()?.panes ?? {}).find(p => p.kind === "file" && p.projectId === projectId);
	if (existing) {
		app.updatePane(existing.id, { filePath: path });
		app.revealPane(existing.id);
		return;
	}
	app.addPane({ kind: "file", projectId, filePath: path });
}
