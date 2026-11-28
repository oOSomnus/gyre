/** Traffic-light status of a pane, shared by frames, the minimap and the hidden bar. */
import type { PaneSpec } from "@gyre/protocol";
import type { ChatState } from "../store/chats";
import { runningJobCount } from "./jobs";

export type PaneStatus = "running" | "waiting" | "error" | "idle" | "none";

export function chatStatus(chat: ChatState | undefined): PaneStatus {
	if (!chat) return "none";
	if (chat.info.status === "exited") return "error";
	if (chat.info.status === "starting") return "running";
	if (chat.pendingUi.length > 0 || chat.plan?.phase === "reviewing") return "waiting";
	if (chat.busy) return "running";
	const last = [...chat.items].reverse().find(item => item.kind === "message" && item.message.role === "assistant");
	if (last?.kind === "message" && last.message.stopReason === "error") return "error";
	return "idle";
}

export function paneStatus(pane: PaneSpec, chats: Record<string, ChatState>): PaneStatus {
	if (pane.kind === "chat") return chatStatus(chats[pane.id]);
	if (pane.kind === "jobs") return runningJobCount(chats) > 0 ? "running" : "none";
	if (pane.chatId) {
		const s = chatStatus(chats[pane.chatId]);
		return pane.kind === "plan" && chats[pane.chatId]?.plan?.phase === "reviewing" ? "waiting" : s;
	}
	return "none";
}

export const STATUS_LABEL: Record<PaneStatus, string> = {
	running: "running",
	waiting: "needs you",
	error: "error",
	idle: "done",
	none: "",
};
