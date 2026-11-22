/** The app's chat lifecycle, bound to the gateway client and the chat store. */
import type { PaneSpec } from "@gyre/protocol";
import { gateway } from "../lib/gateway";
import { createChatLifecycle, type ChatTarget } from "./chat-lifecycle-core";
import { forgetChat, useChats } from "./chats";

export const chatLifecycle = createChatLifecycle(
	{
		open: (projectId, opts) => gateway.openChat(projectId, opts),
		close: chatId => gateway.closeChat(chatId),
		subscribe: chatId => gateway.subscribeChat(chatId),
		onWelcome: listener => gateway.onWelcome(listener),
	},
	{
		current: chatId => useChats.getState().chats[chatId]?.info,
		setInfo: info => useChats.getState().setInfo(info),
		forget: forgetChat,
	},
);

/** Attach a chat pane to its omp process (idempotent; `force` restarts an exited chat). */
export function attachPane(pane: PaneSpec, force = false): void {
	if (!pane.projectId) return;
	void chatLifecycle.attach({ chatId: pane.id, projectId: pane.projectId, sessionPath: pane.sessionPath }, { force }).catch(() => undefined);
}

export function attachChat(target: ChatTarget, opts?: { force?: boolean }) {
	return chatLifecycle.attach(target, opts);
}

export function closeChat(chatId: string): void {
	chatLifecycle.close(chatId);
}

export function restartExitedChats(panes: Iterable<PaneSpec>): void {
	chatLifecycle.restartExited(panes);
}
